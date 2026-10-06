const crypto = require('crypto');
const fs = require('fs');
'use strict';
const { GraasSession, GraasError, loadOrCreateKey, commit } = require('./graasSession.cjs');

class GovernanceViolation extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GovernanceViolation';
    this.governance = true;
    Object.assign(this, extra);
  }
}

const INTEGRITY = new Set(['hash_mismatch', 'step_mismatch', 'float_in_result', 'bad_signature',
  'identity_mismatch', 'stale_prev_hash', 'policy_denied']);
const isGovernance = (e) => e instanceof GraasError && ([401, 403, 409, 410].includes(e.status) || INTEGRITY.has(e.code));

let cachedKey = null;
function sessionFromEnv() {
  cachedKey = cachedKey || loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE || '.kernel-key.pem' });
  return new GraasSession({ privateKeyPem: cachedKey });
}

function assertPortable(v, path) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`"${path}" is a fractional number: send integer minor units (e.g. kobo) or a string`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => assertPortable(x, `${path}[${i}]`));
  if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => assertPortable(x, `${path}.${k}`));
  throw new Error(`"${path}" has unsupported type ${typeof v}`);
}

function buildPayload(rt, inputMap, context, who) {
  if (!inputMap || typeof inputMap !== 'object' || !Object.keys(inputMap).length) {
    throw new GovernanceViolation(`[O-Lang GOVERNANCE] external resolver "${who}" must declare manifest.inputMap; refusing to send the whole workflow context to an agent`);
  }
  const payload = {};
  for (const [key, ctxPath] of Object.entries(inputMap)) {
    const value = rt.getNested(context, ctxPath);
    if (value === undefined) throw new Error(`external resolver "${who}": context has no value at "${ctxPath}"`);
    assertPortable(value, key);
    payload[key] = value;
  }
  return payload;
}

function install(RuntimeAPI) {
  const proto = RuntimeAPI.prototype;
  if (proto.__graasInstalled) return;
  proto.__graasInstalled = true;

  const originalExecute = proto.executeWorkflow;
  
  proto._graasFail = function(e, ctx) {
    if (!isGovernance(e)) return e;
    this._createAuditEntry('governance_violation', {
      type: 'rejected_by_gateway', ...ctx.audit, code: e.code, detail: e.detail || null, severity: 'critical',
    });
    return new GovernanceViolation(`[O-Lang GOVERNANCE] ${ctx.what} refused by the GRaaS gateway: ${e.message}`, { code: e.code });
  };

  proto._callExternalResolver = async function(resolver, action, context) {
    const m = resolver.manifest || {};
    const name = resolver.resolverName;
    const s = this.graas;
    if (!s) {
      throw new GovernanceViolation(`[O-Lang GOVERNANCE] external resolver "${name}" invoked without a GRaaS session; direct agent calls are disabled`);
    }
    const agentId = m.agentId || name;
    if (!m.capability) {
      throw new GovernanceViolation(`[O-Lang GOVERNANCE] external resolver "${name}" must declare manifest.capability`);
    }
    const payload = buildPayload(this, m.inputMap, context, name);
    let result;
    try {
      result = await s.delegate(agentId, m.capability, payload);
    } catch (e) {
      throw this._graasFail(e, { what: `delegation to "${agentId}" (${m.capability})`, audit: { agentId, capability: m.capability } });
    }
    this._createAuditEntry('external_resolver_delegated', {
      agentId, capability: m.capability, gateway_verified: true, gateway_chain_head: s.head,
      payload_commitment: commit(payload), severity: 'info',
    });

  // --- GRaaS: Ed25519 Audit Signing ---
  if (result && result.__audit) {
    const auditData = {
      execution_hash: result.__audit.executionHash,
      merkle_root: result.__audit.merkleRoot,
      steps_executed: result.__audit.stepsExecuted,
      workflow: result.__audit.workflowName || 'unknown',
      timestamp: new Date().toISOString()
    };
    const sortedKeys = Object.keys(auditData).sort();
    const dataToSign = JSON.stringify(auditData, sortedKeys);
    
    const keyFile = process.env.OLANG_AUDIT_PRIVATE_KEY || '.keys/audit.private.pem';
    try {
      const privateKey = fs.readFileSync(keyFile, 'utf8');
      const signature = crypto.sign(null, Buffer.from(dataToSign), privateKey).toString('base64');
      result.__audit.signature = signature;
      result.__audit.timestamp = auditData.timestamp;
      result.__audit.workflowName = auditData.workflow;
    } catch (e) {
      console.warn('[O-Lang] Failed to sign audit log:', e.message);
    }
  }
  return result;
  };

  proto._callLocalResolver = async function(resolver, action, context) {
    const g = resolver && resolver.graas;
    if (!g) return resolver(action, context);
    const s = this.graas;
    if (!s) {
      if (process.env.GRAAS_REQUIRED === 'true') {
        throw new GovernanceViolation(`[O-Lang GOVERNANCE] governed resolver "${resolver.resolverName}" ran without a GRaaS session`);
      }
      return resolver(action, context);
    }
    const cap = typeof g.capability === 'function' ? g.capability(action, context) : g.capability;
    if (!cap) return resolver(action, context);
    const audit = { resolver: resolver.resolverName, capability: cap };
    if (g.authorize) {
      try { await s.authorize(cap); }
      catch (e) { throw this._graasFail(e, { what: `action "${cap}"`, audit }); }
    }
    const input = g.input ? g.input(action, context) : { action };
    let result;
    try {
      result = await resolver(action, context);
    } catch (e) {
      try { await s.rawStep(cap, commit(input), commit({ error: e.name || 'Error' }), 'failed'); } catch (_) { /* best effort */ }
      throw e;
    }
    if (result === undefined || result === null) return result;
    try {
      await s.rawStep(cap, commit(input), commit(g.output ? g.output(result) : result), 'success');
    } catch (e) {
      this._createAuditEntry('governance_violation', { type: 'unrecorded_side_effect', ...audit, severity: 'critical' });
      throw this._graasFail(e, { what: `recording "${cap}"`, audit });
    }
    this._createAuditEntry('graas_step_recorded', { ...audit, gateway_chain_head: s.head, severity: 'info' });

  // --- GRaaS: Ed25519 Audit Signing ---
  if (result && result.__audit) {
    const auditData = {
      execution_hash: result.__audit.executionHash,
      merkle_root: result.__audit.merkleRoot,
      steps_executed: result.__audit.stepsExecuted,
      workflow: result.__audit.workflowName || 'unknown',
      timestamp: new Date().toISOString()
    };
    const sortedKeys = Object.keys(auditData).sort();
    const dataToSign = JSON.stringify(auditData, sortedKeys);
    
    const keyFile = process.env.OLANG_AUDIT_PRIVATE_KEY || '.keys/audit.private.pem';
    try {
      const privateKey = fs.readFileSync(keyFile, 'utf8');
      const signature = crypto.sign(null, Buffer.from(dataToSign), privateKey).toString('base64');
      result.__audit.signature = signature;
      result.__audit.timestamp = auditData.timestamp;
      result.__audit.workflowName = auditData.workflow;
    } catch (e) {
      console.warn('[O-Lang] Failed to sign audit log:', e.message);
    }
  }
  return result;
  };

  proto.executeWorkflow = async function(workflow, inputs, agentResolver) {
    const cfg = agentResolver && agentResolver.graas;
    if (!cfg) {
      if (process.env.GRAAS_REQUIRED === 'true') {
        throw new GovernanceViolation('[O-Lang GOVERNANCE] GRAAS_REQUIRED=true but no graas config was supplied');
      }
      return originalExecute.call(this, workflow, inputs, agentResolver);
    }
    if (!cfg.contractId && !cfg.session) throw new GovernanceViolation('[O-Lang GOVERNANCE] graas.contractId is required');
    const session = cfg.session || sessionFromEnv();
    try {
      await session.start(cfg.contractId, { workflow: String(workflow.name), inputsCommitment: commit(inputs || {}) });
    } catch (e) {
      throw new GovernanceViolation(`[O-Lang GOVERNANCE] could not open a GRaaS execution (${e.message}); refusing to run ungoverned`);
    }
    this.graas = session;
    let result, error;
    try { result = await originalExecute.call(this, workflow, inputs, agentResolver); }
    catch (e) { error = e; }
    
    let bundle = null;
    try {
      const started = this.auditLog.find((x) => x.event === 'workflow_started');
      await session.anchor({
        kernelChainHead: this.previousHash,
        kernelEntries: this.auditLog.length,
        kernelVersion: String(started?.details?.kernel_version || 'unknown'),
      });
      bundle = await session.finalize(error ? 'workflow_error' : undefined);
      this._createAuditEntry('graas_certificate_issued', {
        execution_id: session.executionId, status: bundle.certificate.status,
        chain_root: bundle.certificate.chainRoot, severity: 'info',
      });
    } catch (e) {
      this._createAuditEntry('graas_finalize_failed', { error: e.message, severity: 'critical' });
      if (!error) error = new GovernanceViolation(`[O-Lang GOVERNANCE] could not finalize the GRaaS execution: ${e.message}`);
    } finally {
      this.graas = null;
    }
    if (error) { if (bundle) error.graas = bundle; throw error; }
    if (cfg.strict !== false && bundle.certificate.status === 'FAILED') {
      const err = new GovernanceViolation(`[O-Lang GOVERNANCE] GRaaS certificate status FAILED (${bundle.certificate.failure || 'contract outcome not met'})`);
      err.graas = bundle; err.partialResult = result;
      throw err;
    }
    result.__audit = { ...(result.__audit || {}), graas: bundle };

  // --- GRaaS: Ed25519 Audit Signing ---
  if (result && result.__audit) {
    const auditData = {
      execution_hash: result.__audit.executionHash,
      merkle_root: result.__audit.merkleRoot,
      steps_executed: result.__audit.stepsExecuted,
      workflow: result.__audit.workflowName || 'unknown',
      timestamp: new Date().toISOString()
    };
    const sortedKeys = Object.keys(auditData).sort();
    const dataToSign = JSON.stringify(auditData, sortedKeys);
    
    const keyFile = process.env.OLANG_AUDIT_PRIVATE_KEY || '.keys/audit.private.pem';
    try {
      const privateKey = fs.readFileSync(keyFile, 'utf8');
      const signature = crypto.sign(null, Buffer.from(dataToSign), privateKey).toString('base64');
      result.__audit.signature = signature;
      result.__audit.timestamp = auditData.timestamp;
      result.__audit.workflowName = auditData.workflow;
    } catch (e) {
      console.warn('[O-Lang] Failed to sign audit log:', e.message);
    }
  }
  return result;
  };
}

module.exports = { install, GovernanceViolation, buildPayload };

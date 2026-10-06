import express from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  sha256, signB64, verifyB64, hmac, safeEqual, loadPrivateKey, publicKeyOf, normalizeEd25519Public,
} from "./crypto.js";
import { load, save, loadAgent, insertAgent, saveAgent } from "./store.js";
import { assertSafeEndpoint, safeFetch } from "./net-guard.js";

const policy = JSON.parse(readFileSync(new URL("../policy.json", import.meta.url), "utf8"));

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const split = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
const API_KEYS = split(process.env.GATEWAY_API_KEYS);
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";
const CALL_TOKEN_SECRET = process.env.CALL_TOKEN_SECRET || "";
if (!API_KEYS.length || !ADMIN_KEY || !INTERNAL_SECRET || !CALL_TOKEN_SECRET) {
  console.error("Missing GATEWAY_API_KEYS / ADMIN_API_KEY / INTERNAL_SECRET / CALL_TOKEN_SECRET");
  process.exit(1);
}
const GATEWAY_KEY = loadPrivateKey();
const GATEWAY_PUB = publicKeyOf(GATEWAY_KEY);
const POLICY_AGENTS = new Set(Object.values(policy.contracts).flatMap((c) => Object.keys(c.agents || {})));
const SKEW_MS = 5 * 60 * 1000;
const iso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    Object.assign(this, { status, code, detail });
  }
}

// â”€â”€ Per-execution lock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const locks = new Map();
function withLock(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

// â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const apiAuth = (req, _res, next) => {
  const k = req.get("x-api-key") || "";
  if (!API_KEYS.some((a) => safeEqual(a, k))) return res.status(401).json({ error: "invalid_api_key" });
  next();
};
const adminAuth = (req, _res, next) => {
  if (!safeEqual(ADMIN_KEY, req.get("x-admin-key") || "")) return res.status(401).json({ error: "invalid_admin_key" });
  next();
};
const callToken = (execId, agentId) => hmac(CALL_TOKEN_SECRET, `${execId}:${agentId}`);

async function agentAuth(req, res, next) {
  const agentId = req.get("x-agent-id") || "";
  if (!safeEqual(callToken(req.params.id, agentId), req.get("x-call-token") || "")) {
    return res.status(401).json({ error: "invalid_call_token" });
  }
  const agent = await loadAgent(agentId);
  if (!agent || agent.status !== "active") return res.status(403).json({ error: "agent_not_active" });
  req.agent = agent;
  next();
}

// â”€â”€ Ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function append(doc, kind, record, signature, signer) {
  const seq = doc.chain.length;
  const prevHash = seq ? doc.chain[seq - 1].entryHash : sha256({ genesis: doc.id });
  const body = { seq, kind, signer, prevHash, record, signature };
  const entry = { ...body, entryHash: sha256(body) };
  doc.chain.push(entry);
  doc.chainRoot = entry.entryHash;
  return entry;
}

function decide(doc, fields) {
  const record = { executionId: doc.id, timestamp: iso(), prevHash: doc.chainRoot, ...fields };
  return append(doc, "gateway_decision", record, signB64(record, GATEWAY_KEY), "gateway");
}

async function deny(doc, status, fields) {
  decide(doc, { decision: "denied", ...fields });
  await save(doc);
  const err = new HttpError(status, "policy_denied", fields.reason);
  err.chainHead = doc.chainRoot;  // Include the updated chain head so the kernel stays in sync
  throw err;
}   

function checkSignedStep(doc, agent, { record, signature } = {}) {
  const strings = ["step", "inputHash", "outputHash", "status", "timestamp", "prevHash"];
  if (!record || typeof signature !== "string" || !strings.every((k) => typeof record[k] === "string"))
    throw new HttpError(400, "malformed_step");
  if (record.agentId !== agent.id || record.executionId !== doc.id) throw new HttpError(400, "identity_mismatch");
  if (!(Math.abs(Date.now() - Date.parse(record.timestamp)) <= SKEW_MS)) throw new HttpError(400, "bad_timestamp");
  if (!verifyB64(record, signature, agent.publicKeyPem)) throw new HttpError(400, "bad_signature");
  if (record.prevHash !== doc.chainRoot) throw new HttpError(409, "stale_prev_hash");
}

async function callAgent(agentId, path, body, timeoutMs) {
  const agent = await loadAgent(agentId);
  if (!agent || agent.status !== "active") throw new HttpError(409, "agent_not_active", agentId);
  let origin;
  try { origin = await assertSafeEndpoint(agent.endpoint); }
  catch (e) { throw new HttpError(502, "endpoint_rejected", e.message); }
  const r = await safeFetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-graas-secret": INTERNAL_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status !== 200) {
    await r.body?.cancel();
    throw new HttpError(502, "agent_error", `${agentId} returned ${r.status}`);
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 256 * 1024) throw new HttpError(502, "agent_response_too_large");
  return JSON.parse(Buffer.from(buf).toString("utf8"));
}

const running = async (id) => {
  const doc = await load(id);
  if (!doc) throw new HttpError(404, "execution_not_found");
  if (doc.status !== "RUNNING") throw new HttpError(409, "execution_closed");
  return doc;
};
const permitted = (c, agentId, action) =>
  typeof action === "string" && !c.prohibited.includes(action) && !!c.agents[agentId]?.capabilities.includes(action);

// â”€â”€ App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const app = express();
app.use(express.json({ limit: "100kb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/v1/gateway-key", (_req, res) => res.json({ publicKeyPem: GATEWAY_PUB }));

// â”€â”€ Agent registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/v1/agents/register", apiAuth, async (req, res, next) => {
  try {
    const { agentId, publicKeyPem, endpoint } = req.body || {};
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(agentId)) return res.status(400).json({ error: "invalid_agent_id" });
    if (!POLICY_AGENTS.has(agentId)) return res.status(403).json({ error: "agent_not_in_policy" });
    let pem;
    try { pem = normalizeEd25519Public(publicKeyPem); } catch { return res.status(400).json({ error: "invalid_public_key" }); }
    let origin;
    try { origin = await assertSafeEndpoint(endpoint); }
    catch (e) { return res.status(400).json({ error: "endpoint_rejected", detail: e.message }); }
    const agent = {
      id: agentId, publicKeyPem: pem, endpoint: origin, status: "pending", proven: false,
      challenge: crypto.randomBytes(32).toString("hex"), createdAt: iso(),
    };
    if (!(await insertAgent(agent))) return res.status(409).json({ error: "agent_exists" });
    res.status(201).json({ agentId, status: "pending", challenge: agent.challenge });
  } catch (err) { next(err); }
});

app.post("/v1/agents/:agentId/challenge", apiAuth, async (req, res, next) => {
  try {
    const a = await loadAgent(req.params.agentId);
    if (!a) return res.status(404).json({ error: "agent_not_found" });
    if (a.proven) return res.status(409).json({ error: "already_proven" });
    a.challenge = crypto.randomBytes(32).toString("hex");
    await saveAgent(a);
    res.json({ challenge: a.challenge });
  } catch (err) { next(err); }
});

app.post("/v1/agents/:agentId/prove", apiAuth, async (req, res, next) => {
  try {
    const a = await loadAgent(req.params.agentId);
    if (!a) return res.status(404).json({ error: "agent_not_found" });
    if (a.proven) return res.status(409).json({ error: "already_proven" });
    const msg = { purpose: "graas-register", agentId: a.id, challenge: a.challenge };
    if (!a.challenge || typeof req.body?.signature !== "string" || !verifyB64(msg, req.body.signature, a.publicKeyPem))
      return res.status(400).json({ error: "bad_proof" });
    a.proven = true;
    a.challenge = null;
    await saveAgent(a);
    res.json({ agentId: a.id, status: a.status, proven: true });
  } catch (err) { next(err); }
});

app.get("/v1/agents/:agentId", async (req, res, next) => {
  try {
    const a = await loadAgent(req.params.agentId);
    if (!a) return res.status(404).json({ error: "agent_not_found" });
    res.json({ agentId: a.id, status: a.status, proven: a.proven, publicKeyPem: a.publicKeyPem, endpoint: a.endpoint });
  } catch (err) { next(err); }
});

for (const [action, status] of [["approve", "active"], ["revoke", "revoked"]]) {
  app.post(`/v1/admin/agents/:agentId/${action}`, adminAuth, async (req, res, next) => {
    try {
      const a = await loadAgent(req.params.agentId);
      if (!a) return res.status(404).json({ error: "agent_not_found" });
      if (action === "approve" && !a.proven) return res.status(409).json({ error: "proof_required" });
      a.status = status;
      a[`${action}dAt`] = iso();
      await saveAgent(a);
      res.json({ agentId: a.id, status: a.status });
    } catch (err) { next(err); }
  });
}

// â”€â”€ Executions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/v1/executions", apiAuth, async (req, res, next) => {
  try {
    const { contractId, inputs } = req.body || {};
    const c = policy.contracts[contractId];
    if (!c) return res.status(400).json({ error: "unknown_contract" });
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return res.status(400).json({ error: "inputs_must_be_object" });

    const id = `exec_${crypto.randomUUID()}`;
    const doc = {
      id, contractId, status: "RUNNING", startedAt: iso(), policyVersion: policy.version,
      state: { fraud: null, authorizations: [] }, chain: [], chainRoot: null,
    };
    decide(doc, { decision: "execution_started", contractId, entryAgent: c.entryAgent, inputsHash: sha256(inputs) });
    await withLock(id, () => save(doc));

    let failure = null;
    try {
      await callAgent(c.entryAgent, "/execute", {
        executionId: id, contractId, inputs, callToken: callToken(id, c.entryAgent), chainHead: doc.chainRoot,
      }, 30000);
    } catch (e) {
      failure = e.code || "agent_failure";
      console.error(`[gateway] ${id} entry agent failed: ${failure} ${e.detail || e.message}`);
    }
    
    if (c.orchestrator) {
      res.status(201).json({ executionId: id, callToken: callToken(id, c.orchestrator), chainHead: doc.chainRoot });
    } else {
      res.status(201).json(await withLock(id, async () => finalize(await load(id), c, failure)));
    }
  } catch (err) { next(err); }
});

app.post("/v1/executions/:id/steps", agentAuth, async (req, res, next) => {
  try {
    const out = await withLock(req.params.id, async () => {
      const doc = await running(req.params.id);
      const c = policy.contracts[doc.contractId];
      const step = { record: req.body?.record, signature: req.body?.signature };
      const name = step.record?.step;
      if (!permitted(c, req.agent.id, name)) await deny(doc, 403, { agentId: req.agent.id, action: String(name), reason: "capability_not_permitted" });
      checkSignedStep(doc, req.agent, step);
      if (c.preconditions?.[name]) {
        const auth = doc.state.authorizations.find((a) => a.agentId === req.agent.id && a.action === name && !a.used);
        if (!auth) await deny(doc, 403, { agentId: req.agent.id, action: name, reason: "no_authorization" });
        auth.used = true;
      }
      const e = append(doc, "agent_step", step.record, step.signature, req.agent.id);
      await save(doc);
      return { seq: e.seq, chainHead: e.entryHash };
    });
    res.json(out);
  } catch (err) { 
    if (err instanceof HttpError) { const body = { error: err.code, detail: err.detail }; if (err.chainHead) body.chainHead = err.chainHead; return res.status(err.status).json(body); }
    next(err); 
  }
});

app.post("/v1/executions/:id/delegate", agentAuth, async (req, res, next) => {
  try {
    const { to, capability, payload } = req.body || {};
    const out = await withLock(req.params.id, async () => {
      const doc = await running(req.params.id);
      const c = policy.contracts[doc.contractId];
      const from = req.agent.id;
      const ok = typeof to === "string" && typeof capability === "string" &&
        c.agents[from]?.mayDelegateTo?.[to]?.includes(capability) && c.agents[to]?.capabilities.includes(capability);
      if (!ok) await deny(doc, 403, { agentId: from, action: `delegate:${to}:${capability}`, reason: "delegation_not_permitted" });
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "payload_must_be_object");

      decide(doc, { decision: "delegation_allowed", from, to, capability });
      await save(doc);
      try {
        const resp = await callAgent(to, "/invoke", {
          executionId: doc.id, capability, payload, prevHash: doc.chainRoot,
        }, 8000);
        const target = await loadAgent(to);
        checkSignedStep(doc, target, resp.step);
        if (resp.step.record.step !== capability) throw new HttpError(502, "step_mismatch");
        if (resp.step.record.inputHash !== sha256(payload) || resp.step.record.outputHash !== sha256(resp.result))
          throw new HttpError(502, "hash_mismatch");
        append(doc, "agent_step", resp.step.record, resp.step.signature, to);
        if (capability === "fraud_check") doc.state.fraud = resp.result?.isFraud === true;
        await save(doc);
        return { result: resp.result, chainHead: doc.chainRoot };
      } catch (e) {
        decide(doc, { decision: "delegation_failed", from, to, capability, reason: e.code || "error" });
        await save(doc);
        throw e instanceof HttpError ? e : new HttpError(502, "delegation_failed");
      }
    });
    res.json(out);
  } catch (err) {
    if (err instanceof HttpError) { const body = { error: err.code, detail: err.detail }; if (err.chainHead) body.chainHead = err.chainHead; return res.status(err.status).json(body); }
    next(err);
  }
});

app.post("/v1/executions/:id/authorize", agentAuth, async (req, res, next) => {
  try {
    const action = req.body?.action;
    const out = await withLock(req.params.id, async () => {
      const doc = await running(req.params.id);
      const c = policy.contracts[doc.contractId];
      const agentId = req.agent.id;
      if (!permitted(c, agentId, action)) await deny(doc, 403, { agentId, action: String(action), reason: "capability_not_permitted" });
      const pre = c.preconditions?.[action];
      if (pre) {
        const done = new Set(doc.chain.filter((e) => e.kind === "agent_step").map((e) => e.record.step));
        const missing = (pre.requiresStep || []).filter((s) => !done.has(s));
        if (missing.length) await deny(doc, 403, { agentId, action, reason: `missing_prerequisite:${missing.join(",")}` });
        if (pre.denyIf?.fraud && doc.state.fraud === true) await deny(doc, 403, { agentId, action, reason: "fraud_flagged" });
      }
      decide(doc, { decision: "authorized", agentId, action });
      doc.state.authorizations.push({ agentId, action, used: false });
      await save(doc);
      return { authorized: true, chainHead: doc.chainRoot };
    });
    res.json(out);
  } catch (err) {
    if (err instanceof HttpError) { const body = { error: err.code, detail: err.detail }; if (err.chainHead) body.chainHead = err.chainHead; return res.status(err.status).json(body); }
    next(err);
  }
});

app.post("/v1/executions/:id/finalize", agentAuth, async (req, res, next) => {
  try {
    const out = await withLock(req.params.id, async () => {
      const doc = await running(req.params.id);
      doc.status = req.body?.failure ? "FAILED" : "COMPLETED";
      await save(doc);
      return finalize(doc, policy.contracts[doc.contractId], req.body?.failure);
    });
    res.json(out);
  } catch (err) { next(err); }
});

async function finalize(doc, c, failure) {
  const done = new Set(doc.chain.filter((e) => e.kind === "agent_step").map((e) => e.record.step));
  let status = "FAILED";
  for (const [name, req] of Object.entries(c.outcomes)) {
    if (req.every((s) => done.has(s))) { status = name; break; }
  }
  const keys = { gateway: GATEWAY_PUB };
  for (const s of new Set(doc.chain.map((e) => e.signer))) {
    if (s !== "gateway") {
      const agent = await loadAgent(s);
      if (agent) keys[s] = agent.publicKeyPem;
    }
  }
  const b = c.billing;
  const certificate = {
    executionId: doc.id, contractId: doc.contractId, status, failure, policyVersion: doc.policyVersion,
    chainRoot: doc.chainRoot, chainLength: doc.chain.length, startedAt: doc.startedAt, finishedAt: iso(),
    keyFingerprints: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, sha256(v)])),
    usage: b?.billableOutcomes.includes(status)
      ? [{ unit: b.unit, quantity: 1, unitPrice: b.unitPrice, totalAmount: b.unitPrice }] : [],
  };
  doc.status = status;
  doc.bundle = { certificate, certificateSignature: signB64(certificate, GATEWAY_KEY), keys };
  await save(doc);
  return { ...doc.bundle, chain: doc.chain };
}

app.get("/v1/executions/:id/certificate", apiAuth, async (req, res, next) => {
  try {
    const doc = await load(req.params.id);
    if (!doc) return res.status(404).json({ error: "execution_not_found" });
    if (!doc.bundle) return res.status(409).json({ error: "not_finalized" });
    res.json({ ...doc.bundle, chain: doc.chain });
  } catch (err) { next(err); }
});

// ─── CAPABILITY RESOLUTION (Dynamic Agent Discovery) ─────────────────────────
app.post("/v1/capabilities/resolve", apiAuth, async (req, res, next) => {
  try {
    const { capabilities, contractId } = req.body;
    
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      return res.status(400).json({ 
        error: "invalid_request",
        detail: "capabilities must be a non-empty array"
      });
    }
    
    const contract = policy.contracts[contractId];
    if (!contract) {
      return res.status(404).json({ error: "unknown_contract" });
    }
    
    // Verify all requested capabilities are allowed by the contract
    const allowed = contract.requiredCapabilities || [];
    const invalid = capabilities.filter(c => !allowed.includes(c));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: "capability_not_allowed",
        invalid,
        allowed,
        detail: `Contract '${contractId}' does not permit: ${invalid.join(', ')}`
      });
    }
    
    // Resolve each capability to available agents
    const resolution = {};
    const missing = [];
    
    for (const cap of capabilities) {
      const agents = await getAgentsByCapability(cap);
      
      if (agents.length === 0) {
        missing.push(cap);
      } else {
        // Sort by priority, latency, success rate
        const sorted = agents.sort((a, b) => {
          const priorityDiff = (a.priority || 0) - (b.priority || 0);
          if (priorityDiff !== 0) return priorityDiff;
          
          const latencyDiff = (a.avgLatency || 999999) - (b.avgLatency || 999999);
          if (latencyDiff !== 0) return latencyDiff;
          
          return (b.successRate || 0) - (a.successRate || 0);
        });
        
        resolution[cap] = sorted.map(a => ({
          agentId: a.id,
          endpoint: a.endpoint,
          pubkey: a.pubkey,
          capabilities: a.capabilities,
          priority: a.priority || 0,
          avgLatency: a.avgLatency || null,
          successRate: a.successRate || null,
          pricing: a.pricing || {}
        }));
      }
    }
    
    if (missing.length > 0) {
      return res.status(400).json({
        error: "incomplete_resolution",
        missing,
        detail: `No agents available for: ${missing.join(', ')}`
      });
    }
    
    res.json({
      contractId,
      capabilities,
      resolution,
      resolvedAt: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

// Helper: Get all agents with a specific capability
async function getAgentsByCapability(capability) {
  const agents = [];
  
  for (const [agentId, agent] of Object.entries(agentRegistry)) {
    if (
      agent.capabilities?.includes(capability) && 
      agent.status === 'active' &&
      agent.proven === true
    ) {
      agents.push({
        id: agentId,
        endpoint: agent.endpoint,
        pubkey: agent.pubkey,
        capabilities: agent.capabilities,
        priority: agent.priority || 0,
        avgLatency: agent.avgLatency || null,
        successRate: agent.successRate || null,
        pricing: agent.pricing || {}
      });
    }
  }
  
  return agents;
}

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    const body = { error: err.code, detail: err.detail };
    if (err.chainHead) body.chainHead = err.chainHead;  // Send updated chain head on denials
    return res.status(err.status).json(body);
  }
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
  console.error("[gateway]", err);
  res.status(500).json({ error: "internal_error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`[gateway] listening on :${PORT} (policy ${policy.version})`));

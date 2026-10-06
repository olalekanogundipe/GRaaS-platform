'use strict';
// GRaaS session for an orchestrator such as the O-Lang kernel (CommonJS, Node >= 18).
const crypto = require('crypto');
const fs = require('fs');

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
const commit = (v) => process.env.GRAAS_COMMIT_KEY
  ? crypto.createHmac('sha256', process.env.GRAAS_COMMIT_KEY).update(canonical(v)).digest('hex')
  : sha256(v);
const signB64 = (obj, privPem) => crypto.sign(null, Buffer.from(canonical(obj)), privPem).toString('base64');

class GraasError extends Error {
  constructor(status, code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    Object.assign(this, { status, code, detail });
  }
}

function loadOrCreateKey({ pem = process.env.PRIVATE_KEY_PEM, file = '.kernel-key.pem' } = {}) {
  if (pem) return pem.replace(/\\n/g, '\n');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const { privateKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return privateKey;
}

class GraasSession {
  constructor({ gatewayUrl = process.env.GRAAS_GATEWAY_URL, apiKey = process.env.GRAAS_API_KEY,
                agentId = process.env.GRAAS_KERNEL_ID || 'olang-kernel', privateKeyPem, timeoutMs = 30000 } = {}) {
    if (!gatewayUrl) throw new Error('GRAAS_GATEWAY_URL is required: refusing to run without a gateway');
    if (!privateKeyPem) throw new Error('privateKeyPem is required');
    Object.assign(this, { gatewayUrl: gatewayUrl.replace(/\/+$/, ''), apiKey, agentId, key: privateKeyPem, timeoutMs });
    this.publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
    this.executionId = this.callToken = this.head = this.lastStep = null;
  }

  async _http(method, path, body, headers = {}) {
    const r = await fetch(this.gatewayUrl + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch (_) { /* empty body */ }
    return { status: r.status, data };
  }

  async register() {
    const h = { 'x-api-key': this.apiKey };
    let r = await this._http('POST', '/v1/agents/register', { agentId: this.agentId, publicKeyPem: this.publicKeyPem, endpoint: 'http://localhost' }, h);
    if (r.status === 409) {
      r = await this._http('POST', `/v1/agents/${this.agentId}/challenge`, undefined, h);
      if (r.status === 409) return 'already_proven';
    }
    if (r.status >= 300) throw new GraasError(r.status, r.data.error, r.data.detail);
    const signature = signB64({ purpose: 'graas-register', agentId: this.agentId, challenge: r.data.challenge }, this.key);
    const p = await this._http('POST', `/v1/agents/${this.agentId}/prove`, { signature }, h);
    if (p.status !== 200) throw new GraasError(p.status, p.data.error, p.data.detail);
    return 'pending_approval';
  }

  async start(contractId, inputs) {
    const r = await this._http('POST', '/v1/executions', { contractId, inputs }, { 'x-api-key': this.apiKey });
    if (r.status !== 201) throw new GraasError(r.status, r.data.error, r.data.detail);
    ({ executionId: this.executionId, callToken: this.callToken, chainHead: this.head } = r.data);
    return r.data;
  }

  async _call(path, body) {
    const r = await this._http('POST', `/v1/executions/${this.executionId}${path}`, body,
      { 'x-agent-id': this.agentId, 'x-call-token': this.callToken });
    if (r.data.chainHead) this.head = r.data.chainHead;
    if (r.status !== 200) throw new GraasError(r.status, r.data.error, r.data.detail);
    return r.data;
  }

  async delegate(to, capability, payload) {
    return (await this._call('/delegate', { to, capability, payload })).result;
  }
  authorize(action) { return this._call('/authorize', { action }); }
  
  _signedStep(name, inputHash, outputHash, status, extra = {}) {
    const record = {
      agentId: this.agentId, executionId: this.executionId, step: name, inputHash, outputHash, status,
      prevHash: this.head, timestamp: new Date().toISOString(), ...extra,
    };
    const body = { record, signature: signB64(record, this.key) };
    this.lastStep = body;
    return this._call('/steps', body);
  }
  
  step(name, input, output, status = 'success') { return this._signedStep(name, sha256(input), sha256(output), status); }
  rawStep(name, inputHash, outputHash, status = 'success') { return this._signedStep(name, inputHash, outputHash, status); }
  
  anchor({ kernelChainHead, kernelEntries, kernelVersion }) {
    return this._signedStep('kernel_anchor', sha256({ kernelVersion }), kernelChainHead, 'success',
      { kernelChainHead, kernelEntries, kernelVersion });
  }
  
  async finalize(failure) { return this._call('/finalize', failure ? { failure } : {}); }
}

module.exports = { GraasSession, GraasError, loadOrCreateKey, canonical, sha256, commit, signB64 };

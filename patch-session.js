const fs = require('fs');
const file = 'src/olang-kernel/src/runtime/graasSession.cjs';
let code = fs.readFileSync(file, 'utf8');

const newRegister = `  async register() {
    const h = { 'x-api-key': this.apiKey };
    const r = await this._http('POST', '/v1/agents/register', { agentId: this.agentId, publicKeyPem: this.publicKeyPem }, h);
    if (r.status >= 300) throw new GraasError(r.status, r.data.error, r.data.detail);

    const c = await this._http('POST', `/v1/agents/${this.agentId}/challenge`, undefined, h);
    if (c.status >= 300) throw new GraasError(c.status, c.data.error, c.data.detail);

    const signature = signB64({ purpose: 'graas-register', agentId: this.agentId, challenge: c.data.challenge }, this.key);
    const p = await this._http('POST', '/v1/agents/prove', { agentId: this.agentId, signature }, h);
    if (p.status !== 200) throw new GraasError(p.status, p.data.error, p.data.detail);
    return 'pending_approval';
  }`;

// Find the start of the register method
let startIdx = code.indexOf('async register()');
if (startIdx === -1) startIdx = code.indexOf('register()');

// Find the start of the next method (async start)
let endIdx = code.indexOf('async start(', startIdx);
if (endIdx === -1) endIdx = code.indexOf('start(', startIdx);

if (startIdx !== -1 && endIdx !== -1) {
    // Replace everything between them with the clean, fully-braced method
    code = code.substring(0, startIdx) + newRegister + '\n\n  ' + code.substring(endIdx);
    fs.writeFileSync(file, code);
    console.log(" Successfully repaired graasSession.cjs syntax using Node!");
} else {
    console.log(" Could not find method boundaries.");
}

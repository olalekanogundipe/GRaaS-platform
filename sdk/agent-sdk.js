// sdk/agent-sdk.js
import crypto from "node:crypto";
import express from "express";

export class GraasAgent {
  constructor({ agentId, privateKeyPem, gatewayUrl, apiKey, capabilities = [] }) {
    this.agentId = agentId;
    this.key = privateKeyPem;
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.capabilities = capabilities;
    this.handlers = new Map();
    this.publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" });
  }

  // ── Register a capability handler ──
  registerCapability(name, handler, options = {}) {
    this.handlers.set(name, { handler, ...options });
    if (!this.capabilities.includes(name)) {
      this.capabilities.push(name);
    }
  }

  // ── Create a delegation context for the handler ──
  _createContext(executionId, prevHash, delegationContext = null) {
    const self = this;
    return {
      executionId,
      prevHash,
      delegationDepth: delegationContext?.depth || 0,
      remainingBudget: delegationContext?.remainingBudget || 10.0,

      // 🤝 A2A DELEGATION: Agent can hire other agents
      delegate: async ({ capability, payload, budget = 5.0 }) => {
        const response = await fetch(`${self.gatewayUrl}/v1/delegate`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-api-key': self.apiKey 
          },
          body: JSON.stringify({
            fromAgent: self.agentId,
            toCapability: capability,
            payload,
            executionId,
            delegationDepth: (delegationContext?.depth || 0),
            budget: budget,
            prevHash
          })
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(`Delegation failed: ${err.error} - ${err.detail || ''}`);
        }

        return await response.json();
      },

      // 🔍 DISCOVERY: Agent can find other agents
      discover: async (capability) => {
        const response = await fetch(`${self.gatewayUrl}/v1/agents/discover`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-api-key': self.apiKey 
          },
          body: JSON.stringify({ capability })
        });

        if (!response.ok) {
          throw new Error(`Discovery failed: ${response.status}`);
        }

        return await response.json();
      }
    };
  }

  // ── Handle an incoming invocation ──
  async _invoke(capability, payload, executionId, prevHash, delegationContext) {
    const { handler } = this.handlers.get(capability);
    if (!handler) throw new Error(`Capability '${capability}' not registered`);

    // Create the context with delegation support
    const context = this._createContext(executionId, prevHash, delegationContext);

    // Call the developer's business logic
    const result = await handler(payload, context);

    // Generate the cryptographic receipt
    const record = {
      agentId: this.agentId,
      executionId,
      step: capability,
      inputHash: this._sha256(payload),
      outputHash: this._sha256(result),
      prevHash,
      timestamp: new Date().toISOString(),
      delegated: !!delegationContext,
      delegationDepth: delegationContext?.depth || 0
    };
    const signature = this._sign(record);

    return { result, step: { record, signature } };
  }

  // ── Start listening ──
  listen(port) {
    const app = express();
    app.use(express.json());

    app.get("/healthz", (_req, res) => res.json({ ok: true }));

    app.post("/invoke", async (req, res) => {
      const { capability, payload, executionId, prevHash, delegationContext } = req.body;
      
      if (!this.handlers.has(capability)) {
        return res.status(404).json({ error: `capability_not_found: ${capability}` });
      }

      try {
        const response = await this._invoke(
          capability, 
          payload, 
          executionId || `exec-${Date.now()}`, 
          prevHash || "0000",
          delegationContext
        );
        res.json(response);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.listen(port, "0.0.0.0", () => {
      console.log(`[${this.agentId}] listening on :${port} (SDK Mode)`);
      console.log(`[${this.agentId}] capabilities: ${this.capabilities.join(', ')}`);
      this._register();
    });
  }

  // ── Self-registration with challenge-response ──
  async _register() {
    const headers = { "content-type": "application/json", "x-api-key": this.apiKey };
    const post = (path, body) => fetch(this.gatewayUrl + path, { method: "POST", headers, body: body && JSON.stringify(body) });
    
    for (let i = 0; i < 10; i++) {
      try {
        let r = await post("/v1/agents/register", { 
          agentId: this.agentId, 
          publicKeyPem: this.publicKeyPem, 
          endpoint: `http://localhost:${this.port || 8000}`,
          capabilities: this.capabilities
        });
        if (!r.ok && r.status !== 409) throw new Error(`register -> ${r.status}`);
        
        let c = await post(`/v1/agents/${this.agentId}/challenge`);
        if (!c.ok) throw new Error(`challenge -> ${c.status}`);
        const { challenge } = await c.json();
        
        const signature = this._sign({ purpose: "graas-register", agentId: this.agentId, challenge });
        let p = await post("/v1/agents/prove", { agentId: this.agentId, signature });
        if (!p.ok) throw new Error(`prove -> ${p.status}`);
        
        console.log(`[${this.agentId}] registered and proven!`);
        return;
      } catch (e) {
        console.warn(`[${this.agentId}] registration attempt ${i + 1} failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, Math.min(2 ** i * 500, 15000)));
      }
    }
  }

  _sha256(v) {
    const canonical = JSON.stringify(v, Object.keys(v || {}).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  _sign(obj) {
    const canonical = JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.sign(null, Buffer.from(canonical), this.key).toString('base64');
  }
}
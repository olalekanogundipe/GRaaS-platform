import express from "express";
import crypto from "crypto";
import { store, apiKeyManager } from "./store.js";
import { verifyB64 } from "./crypto.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "admin-master-key";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "internal-secret-for-gateway";

console.log(`[GATEWAY] Starting GRaaS Gateway on port ${PORT}...`);

app.use(async (req, res, next) => {
  if (req.path === "/healthz" || req.path === "/health" || 
      req.path.startsWith("/v1/agents") || 
      req.path.startsWith("/v1/admin/") || req.path.startsWith("/admin/")) {
    return next();
  }
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "unauthorized. Missing x-api-key header" });
  const keyData = await apiKeyManager.validateKey(apiKey);
  if (!keyData) return res.status(401).json({ error: "unauthorized. Invalid or revoked API key" });
  req.keyData = keyData;
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true, status: "ok", policy: "1.2.0" }));

app.post("/v1/agents/register", async (req, res) => {
  try {
    let { agentId, publicKey, endpoint, capabilities } = req.body;
    agentId = agentId || req.body.id || req.body.name || req.body.agent_id;
    publicKey = publicKey || req.body.pubkey || req.body.public_key || req.body.publicKeyPem || req.body.key;
    if (!agentId || !publicKey) return res.status(400).json({ error: "agentId and publicKey are required" });
    await store.registerAgent(agentId, publicKey, endpoint, capabilities || []);
    console.log(`[GATEWAY] Agent registered: ${agentId}`);
    res.json({ message: "registered" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/v1/agents/:agentId/challenge", async (req, res) => {
  try {
    const agent = await store.getAgent(req.params.agentId);
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    const challenge = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); 
    await store.setAgentChallenge(req.params.agentId, challenge, expiresAt);
    console.log(`[GATEWAY] Issued challenge for: ${req.params.agentId}`);
    res.json({ challenge });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/v1/agents/prove", async (req, res) => {
  try {
    const { agentId, signature } = req.body;
    if (!agentId || !signature) return res.status(400).json({ error: "agentId and signature are required" });

    const agent = await store.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    if (!agent.challenge) return res.status(400).json({ error: "no_pending_challenge. Call /v1/agents/:agentId/challenge first" });
    if (agent.challenge_expires && new Date(agent.challenge_expires) < new Date()) {
      await store.clearAgentChallenge(agentId);
      return res.status(400).json({ error: "challenge_expired. Request a new challenge" });
    }

    const signedObject = { purpose: "graas-register", agentId, challenge: agent.challenge };
    let valid = false;
    try { valid = verifyB64(signedObject, signature, agent.publicKey); } catch (_) { valid = false; }
    if (!valid) return res.status(401).json({ error: "invalid_signature" });

    await store.clearAgentChallenge(agentId);
    await store.updateAgentProven(agentId, true);
    console.log(`[GATEWAY] Agent proven: ${agentId}`);
    res.json({ status: "proven", agentId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/v1/agents/:agentId", async (req, res) => {
  try {
    const agent = await store.getAgent(req.params.agentId);
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    res.json({ agentId: agent.agentId, proven: agent.proven || false, status: agent.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/v1/admin/agents/:agentId/approve", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
  try {
    await store.approveAgent(req.params.agentId);
    console.log(`[GATEWAY] Agent approved: ${req.params.agentId}`);
    res.json({ status: "approved", agentId: req.params.agentId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 🚀 REAL PROXY: Routes the request to the proven agent securely
app.post("/invoke", async (req, res) => {
  try {
    const { agentId, capability, payload, executionId, prevHash } = req.body;
    console.log(`[GATEWAY] Routing ${capability} to ${agentId}`);
    const agent = await store.getAgent(agentId);
    if (!agent || agent.status !== "active") return res.status(404).json({ error: `agent_not_active: ${agentId}` });
    
    const agentResponse = await fetch(`${agent.endpoint}/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-graas-secret': INTERNAL_SECRET
      },
      body: JSON.stringify({ capability, payload, executionId, prevHash })
    });
    
    if (!agentResponse.ok) {
      const errText = await agentResponse.text();
      return res.status(agentResponse.status).json({ error: `agent_error: ${errText}` });
    }
    
    const agentResult = await agentResponse.json();
    res.json(agentResult);
  } catch (error) { 
    console.error("[GATEWAY] Invocation proxy error:", error.message);
    res.status(500).json({ error: error.message }); 
  }
});

app.post("/admin/keys/generate", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_API_KEY && req.headers["x-api-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
  try {
    const { name, scope } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const result = await apiKeyManager.generateKey(name, scope);
    res.json({ message: "API key generated.", ...result });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/admin/keys", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_API_KEY && req.headers["x-api-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
  try { res.json({ keys: await apiKeyManager.listKeys() }); } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT} (policy 1.2.0)`);
});
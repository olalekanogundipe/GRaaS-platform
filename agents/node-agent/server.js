// agents/node-agent/server.js
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";

const AGENT_ID = "node-fraud-checker";
const PORT = process.env.PORT || 8002;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://localhost:3000").replace(/^(?!https?:\/\/)/, "http://");
const PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/^(?!https?:\/\/)/, "http://");
const API_KEY = process.env.GRAAS_API_KEY || "";

if (!INTERNAL_SECRET) { console.error("INTERNAL_SECRET required"); process.exit(1); }

// ── Identity: load or create an Ed25519 key ──
function loadOrCreateKey() {
  const pem = process.env.PRIVATE_KEY_PEM || process.env.NODE_AGENT_PRIVKEY;
  if (pem) return pem.replace(/\\n/g, "\n");
  const file = process.env.AGENT_KEY_FILE || ".agent-key.pem";
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const { privateKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  console.warn(`[${AGENT_ID}] generated a new key at ${file} (set PRIVATE_KEY_PEM to persist)`);
  return privateKey;
}
const KEY = loadOrCreateKey();
const PUBLIC_PEM = crypto.createPublicKey(KEY).export({ type: "spki", format: "pem" });

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function sha256(v) { return crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex'); }
function signB64(obj, privPem) { return crypto.sign(null, Buffer.from(canonical(obj)), privPem).toString('base64'); }

// ── Self-registration ──
async function registerSelf() {
  const headers = { "content-type": "application/json", "x-api-key": API_KEY };
  const post = (path, body) => fetch(GATEWAY_URL + path, { method: "POST", headers, body: body && JSON.stringify(body) });
  for (let i = 0; i < 10; i++) {
    try {
      let r = await post("/v1/agents/register", { agentId: AGENT_ID, publicKeyPem: PUBLIC_PEM, endpoint: PUBLIC_URL });
      if (r.status === 409) {
        r = await post(`/v1/agents/${AGENT_ID}/challenge`);
        if (r.status === 409) return console.log(`[${AGENT_ID}] already registered and proven`);
      }
      if (!r.ok) throw new Error(`register/challenge -> ${r.status} ${await r.text()}`);
      const { challenge } = await r.json();
      const signature = signB64({ purpose: "graas-register", agentId: AGENT_ID, challenge }, KEY);
      const p = await post(`/v1/agents/${AGENT_ID}/prove`, { signature });
      if (!p.ok) throw new Error(`prove -> ${p.status} ${await p.text()}`);
      return console.log(`[${AGENT_ID}] registered; waiting for admin approval`);
    } catch (e) {
      console.warn(`[${AGENT_ID}] registration attempt ${i + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(2 ** i * 500, 15000)));
    }
  }
}

// ── Capability ──
const app = express();
app.use(express.json({ limit: "50kb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/invoke", (req, res) => {
  if (req.get("x-graas-secret") !== INTERNAL_SECRET) return res.status(401).json({ error: "unauthorized" });
  const { executionId, capability, payload, prevHash } = req.body || {};
  const { claimId, applicant, amount } = payload || {};
  
  if (capability !== "fraud_check" || typeof executionId !== "string" || typeof prevHash !== "string" ||
      typeof claimId !== "string" || typeof applicant !== "string" || !Number.isFinite(amount)) {
    return res.status(400).json({ error: "bad_request" });
  }
  
  const isFraud = amount > 10000;
  const result = { riskScore: isFraud ? 95 : 12, isFraud, message: isFraud ? "FLAGGED" : "CLEARED" };
  
  const record = {
    agentId: AGENT_ID, executionId, step: "fraud_check",
    inputHash: sha256(payload), outputHash: sha256(result),
    status: isFraud ? "flagged" : "cleared",
    prevHash, timestamp: new Date().toISOString(),
  };
  
  res.json({ result, step: { record, signature: signB64(record, KEY) } });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${AGENT_ID}] listening on :${PORT}`);
  registerSelf();
});
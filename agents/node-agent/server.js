// agents/node-agent/server.js
import { GraasAgent } from '../../sdk/agent-sdk.js';
import crypto from "node:crypto";
import fs from "node:fs";

function loadOrCreateKey() {
  const file = ".agent-key.pem";
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const { privateKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return privateKey;
}

const agent = new GraasAgent({
  agentId: 'node-fraud-checker',
  privateKeyPem: loadOrCreateKey(),
  gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3000',
  apiKey: process.env.GRAAS_API_KEY || '',
  capabilities: ['fraud_check']
});

// Simple, guaranteed-to-work logic
agent.registerCapability('fraud_check', async (payload, context) => {
  console.log(`[node-fraud-checker] Processing claim: ${payload.claimId}`);
  const amount = payload.amount || 0;
  const isFraud = amount > 10000;
  
  return { 
    isFraud,
    riskScore: isFraud ? 95 : 12, 
    confidence: 0.95,
    evidence: [{ field: "amount", value: amount, reasoning: "Rule-based threshold check" }],
    message: isFraud ? "FLAGGED: Amount exceeds $10k" : "CLEARED" 
  };
}, { model: "rule-engine", tool: "custom" });

agent.port = process.env.PORT || 8002;
console.log(`[node-fraud-checker] Starting on port ${agent.port}...`);
agent.listen(agent.port);
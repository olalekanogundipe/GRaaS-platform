// agents/research-agent/server.js
import { GraasAgent } from '../../sdk/agent-sdk.js';
import crypto from "node:crypto";
import fs from "node:fs";

function loadOrCreateKey() {
  const file = ".research-agent-key.pem";
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const { privateKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return privateKey;
}

const agent = new GraasAgent({
  agentId: 'research-agent',
  privateKeyPem: loadOrCreateKey(),
  gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3000',
  apiKey: process.env.GRAAS_API_KEY || '',
  capabilities: ['research', 'general']
});

agent.registerCapability('research', async (payload, context) => {
  console.log(`[research-agent] Processing query: ${payload.query}`);
  return {
    summary: `Research complete for query: ${payload.query}`,
    keyFacts: ["fact1", "fact2"],
    confidence: 0.90,
    message: "Baseline research complete."
  };
}, { model: "baseline", tool: "mock-search" });

agent.port = process.env.PORT || 8003;
console.log(`[research-agent] Starting on port ${agent.port}...`);
agent.listen(agent.port);
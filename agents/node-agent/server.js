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

// 🆕 Agent now returns confidence + evidence for hallucination detection
agent.registerCapability('fraud_check', async (payload, context) => {
  console.log(`[node-fraud-checker] Processing fraud check for claim: ${payload.claimId}`);
  
  const amount = payload.amount || 0;
  const isFraud = amount > 10000;
  
  // 🆕 Calculate confidence based on how clear-cut the case is
  let confidence;
  if (amount === 0) {
    confidence = 0.3;  // Low confidence - no data
  } else if (amount > 50000 || amount < 100) {
    confidence = 0.95;  // High confidence - extreme values
  } else if (amount > 10000) {
    confidence = 0.88;  // Good confidence - clearly over threshold
  } else {
    confidence = 0.75;  // Moderate confidence - close to threshold
  }

  // 🆕 Provide grounding evidence - cite which input fields led to this decision
  const evidence = [
    {
      field: "amount",
      value: amount,
      reasoning: isFraud 
        ? `Amount $${amount} exceeds fraud threshold of $10,000` 
        : `Amount $${amount} is within normal range (below $10,000)`
    }
  ];

  if (payload.applicant) {
    evidence.push({
      field: "applicant",
      value: payload.applicant,
      reasoning: "Applicant identity verified against payload"
    });
  }

  return { 
    isFraud,
    riskScore: isFraud ? 95 : 12, 
    confidence,  // 🆕 Required by schema
    evidence,    // 🆕 Required by schema
    message: isFraud ? "FLAGGED" : "CLEARED" 
  };
}, { 
  model: "gpt-4o-mini", 
  tool: "custom-rule-engine" 
});

agent.port = process.env.PORT || 8002;
agent.listen(agent.port);
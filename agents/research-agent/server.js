// agents/research-agent/server.js
import { GraasAgent } from '../../sdk/agent-sdk.js';
import crypto from "node:crypto";
import fs from "node:fs";

// Generate or load a key for this agent
function loadOrCreateKey() {
  const file = ".research-agent-key.pem";
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const { privateKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return privateKey;
}

const agent = new GraasAgent({
  agentId: 'research-agent',
  privateKeyPem: loadOrCreateKey(),
  gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3000',
  apiKey: process.env.GRAAS_API_KEY || '',
  capabilities: ['research_claim', 'generate_report']
});

// ── This agent RESEARCHES a claim, then DELEGATES fraud checking ──
agent.registerCapability('research_claim', async (payload, context) => {
  console.log(`[research-agent] Researching claim: ${payload.claimId}`);

  // Step 1: Do our own research (simulated)
  const researchNotes = `Claim ${payload.claimId} submitted by applicant. Amount: $${payload.amount}. Historical patterns suggest ${payload.amount > 10000 ? 'high' : 'normal'} risk.`;

  // Step 2: 🤝 DELEGATE fraud checking to another agent!
  console.log(`[research-agent] Delegating fraud_check to another agent...`);
  
  try {
    const fraudResult = await context.delegate({
      capability: 'fraud_check',
      payload: {
        claimId: payload.claimId,
        applicant: payload.applicant,
        amount: payload.amount
      },
      budget: 2.00  // Max $2 for this delegation
    });

    console.log(`[research-agent] Delegation successful! Fraud result:`, fraudResult.result);

    // Step 3: Combine our research with the delegated fraud check
    return {
      claimId: payload.claimId,
      researchNotes,
      fraudAssessment: fraudResult.result,
      delegatedTo: fraudResult.delegatedTo,
      finalRecommendation: fraudResult.result.isFraud 
        ? "REJECT - Fraud detected by delegated agent" 
        : "APPROVE - No fraud detected"
    };
  } catch (e) {
    console.error(`[research-agent] Delegation failed:`, e.message);
    return {
      claimId: payload.claimId,
      researchNotes,
      fraudAssessment: null,
      finalRecommendation: "MANUAL_REVIEW - Could not delegate fraud check"
    };
  }
});

// ── Generate a report capability ──
agent.registerCapability('generate_report', async (payload, context) => {
  return {
    report: `Executive Summary for ${payload.claimId}: ${payload.recommendation}`,
    generatedAt: new Date().toISOString()
  };
});

// Start the agent
agent.port = 8003;
agent.listen(8003);
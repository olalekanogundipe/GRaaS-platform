// test-competitor.js
const REGISTRY_URL = "http://localhost:4000";
const GATEWAY_URL = "http://localhost:3000";
const API_KEY = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59";

async function simulateCompetitor() {
  console.log("🌐 Simulating External Platform 'Competitor-X'...\n");

  // 0. Setup: Just fund the already-active proxy agent (skip registration)
  console.log("0. Funding Competitor-X proxy agent...");
  
  let res = await fetch(`${GATEWAY_URL}/v1/agents/competitor-x-proxy/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ amount: 100 })
  });
  const depositData = await res.json();
  console.log(`   ✅ Deposit Response: Balance is now ${depositData.newBalance} CR\n`);

  // Verify status
  res = await fetch(`${GATEWAY_URL}/v1/agents/competitor-x-proxy`, {
    headers: { "x-api-key": API_KEY }
  });
  const agentInfo = await res.json();
  console.log(`   📊 Final Agent Status: ${agentInfo.status} | Balance: ${agentInfo.balance}\n`);

  if (agentInfo.status !== 'active') {
    console.log("❌ Agent is not active! Run 'node fix-agent.cjs' first.");
    return;
  }

  // 1. Competitor queries the Global Registry for a fraud checker
  console.log("1. Competitor-X queries Global Registry for 'fraud_check'...");
  const registryRes = await fetch(`${REGISTRY_URL}/registry/agents?capability=fraud_check`);
  const registryData = await registryRes.json();
  
  const targetAgent = registryData.agents.find(a => a.agentId === "node-fraud-checker");
  if (!targetAgent) {
    console.log("❌ No agent found in registry!");
    return;
  }
  
  console.log(`   ✅ Found: ${targetAgent.agentId}`);
  console.log(`   🏠 Home Platform: ${targetAgent.homePlatform}`);
  console.log(`   🔗 Endpoint: ${targetAgent.endpoint}`);

  // 2. Competitor delegates directly to the GRaaS Gateway
  console.log("\n2. Competitor-X delegates task to GRaaS Gateway...");
  const delegateRes = await fetch(`${GATEWAY_URL}/v1/delegate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({
      fromAgent: "competitor-x-proxy", 
      toCapability: "fraud_check",
      payload: { claimId: "CLM-EXTERNAL-001", applicant: "External User", amount: 25000 },
      executionId: `exec-external-${Date.now()}`,
      delegationDepth: 0,
      budget: 5.0
    })
  });

  const result = await delegateRes.json();
  
  if (delegateRes.ok) {
    console.log("   ✅ Delegation Successful!");
    console.log("   🛡️ Validation:", result.hallucinationValidation.verdict);
    console.log("   💰 Billing:", result.billing.status === "paid" ? `Paid ${result.billing.payout} CR to agent, ${result.billing.platformFee} CR fee to platform` : "Refunded");
  } else {
    console.log("   ❌ Delegation Failed:", result.error, result.detail || "");
  }

  console.log("\n🏁 Cross-platform delegation test complete!");
}

simulateCompetitor().catch(console.error);
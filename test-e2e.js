// test-e2e.js
const GATEWAY_URL = "http://localhost:3000";
const API_KEY = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59";

async function runE2ETests() {
  console.log("🚀 Starting Comprehensive End-to-End Test...\n");
  let allPassed = true;

  // ── TEST 1: Standard Invocation + Hallucination Detection ──
  console.log("1. Testing Standard Invocation + Hallucination Detection...");
  try {
    const res = await fetch(`${GATEWAY_URL}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        agentId: 'node-fraud-checker',
        capability: 'fraud_check',
        payload: { claimId: 'CLM-E2E-001', applicant: 'Jane Doe', amount: 15000 },
        executionId: 'exec-e2e-1'
      })
    });
    const data = await res.json();
    
    if (data.hallucinationValidation && data.hallucinationValidation.verdict === "VERIFIED") {
      console.log("   ✅ PASS: Standard invocation verified (Score: " + data.hallucinationValidation.hallucinationScore + "/100)");
    } else {
      console.log("   ❌ FAIL: Hallucination validation failed or missing.");
      allPassed = false;
    }
  } catch (e) {
    console.log("   ❌ FAIL: " + e.message);
    allPassed = false;
  }

  // ── TEST 2: Agent-to-Agent (A2A) Delegation ──
  console.log("\n2. Testing Agent-to-Agent (A2A) Delegation...");
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        fromAgent: 'research-agent',
        toCapability: 'fraud_check',
        payload: { claimId: 'CLM-E2E-002', applicant: 'John Smith', amount: 25000 },
        executionId: 'exec-e2e-2',
        delegationDepth: 0,
        budget: 5.0
      })
    });
    const data = await res.json();
    
    if (data.delegatedTo === 'node-fraud-checker' && data.hallucinationValidation) {
      console.log("   ✅ PASS: Successfully delegated to " + data.delegatedTo);
      console.log("            Delegation validated (Score: " + data.hallucinationValidation.hallucinationScore + "/100)");
    } else {
      console.log("   ❌ FAIL: Delegation failed or validation missing.");
      console.log("            Response:", JSON.stringify(data, null, 2));
      allPassed = false;
    }
  } catch (e) {
    console.log("   ❌ FAIL: " + e.message);
    allPassed = false;
  }

  // ── TEST 3: Verify Reputation Tracking ──
  console.log("\n3. Verifying Reputation Tracking...");
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/agents/node-fraud-checker`, {
      headers: { 'x-api-key': API_KEY }
    });
    const data = await res.json();
    
    if (data.totalExecutions >= 2 && data.reputation >= 2) {
      console.log("   ✅ PASS: Reputation tracking working!");
      console.log("            Total Executions: " + data.totalExecutions);
      console.log("            Current Reputation: " + data.reputation);
      console.log("            Current Stake: " + data.stake);
    } else {
      console.log("   ❌ FAIL: Reputation or execution count did not update.");
      console.log("            Response:", JSON.stringify(data, null, 2));
      allPassed = false;
    }
  } catch (e) {
    console.log("   ❌ FAIL: " + e.message);
    allPassed = false;
  }

  // ── FINAL RESULT ──
  console.log("\n" + "=".repeat(50));
  if (allPassed) {
    console.log("🎉 ALL TESTS PASSED! The platform is fully operational. 🎉");
  } else {
    console.log("⚠️  SOME TESTS FAILED. Please review the output above.");
  }
  console.log("=".repeat(50));
}

runE2ETests().catch(console.error);
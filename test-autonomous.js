// test-autonomous.js
const GATEWAY_URL = "http://localhost:3000";
const API_KEY = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59";
const ADMIN_KEY = process.env.ADMIN_KEY || "admin-master-key";

async function testAutonomous() {
  console.log(" Testing Autonomous Registration...\n");

  // Test 1: Check current state of node-fraud-checker
  console.log("1. Checking current state of node-fraud-checker...");
  const agentRes = await fetch(`${GATEWAY_URL}/v1/agents/node-fraud-checker`, {
    headers: { 'x-api-key': API_KEY }
  });
  const agentData = await agentRes.json();
  console.log(`   Status: ${agentData.status}`);
  console.log(`   Stake: ${agentData.stake || 0}`);
  console.log(`   Reputation: ${agentData.reputation || 0}`);
  console.log(`   Total Executions: ${agentData.totalExecutions || 0}`);

  // Test 2: Add stake to trigger auto-approval
  console.log("\n2. Adding 100 stake to trigger auto-approval...");
  const stakeRes = await fetch(`${GATEWAY_URL}/v1/agents/node-fraud-checker/stake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ amount: 100 })
  });
  const stakeData = await stakeRes.json();
  console.log(`   New stake: ${stakeData.newStake}`);
  console.log(`   Auto-approval:`, stakeData.autoApproval);

  // Test 3: Check leaderboard
  console.log("\n3. Checking agent leaderboard...");
  const leaderRes = await fetch(`${GATEWAY_URL}/v1/agents/leaderboard`, {
    headers: { 'x-api-key': API_KEY }
  });
  const leaderData = await leaderRes.json();
  console.log("   Top agents by reputation:");
  leaderData.leaderboard.forEach((a, i) => {
    console.log(`   ${i + 1}. ${a.agentId} - Rep: ${a.reputation}, Stake: ${a.stake}, Execs: ${a.totalExecutions}`);
  });

  // Test 4: Run some invocations to build reputation
  console.log("\n4. Running 3 successful invocations to build reputation...");
  for (let i = 0; i < 3; i++) {
    const invokeRes = await fetch(`${GATEWAY_URL}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        agentId: 'node-fraud-checker',
        capability: 'fraud_check',
        payload: { claimId: `CLM-TEST-${i}`, applicant: 'Test', amount: 5000 },
        executionId: `exec-rep-test-${i}`
      })
    });
    const invokeData = await invokeRes.json();
    console.log(`   Invocation ${i + 1}: ${invokeData.hallucinationValidation.verdict} (score: ${invokeData.hallucinationValidation.hallucinationScore})`);
  }

  // Test 5: Check reputation after executions
  console.log("\n5. Checking reputation after executions...");
  const finalRes = await fetch(`${GATEWAY_URL}/v1/agents/node-fraud-checker`, {
    headers: { 'x-api-key': API_KEY }
  });
  const finalData = await finalRes.json();
  console.log(`   Reputation: ${finalData.reputation}`);
  console.log(`   Total Executions: ${finalData.totalExecutions}`);
  console.log(`   Failed Executions: ${finalData.failedExecutions}`);

  console.log("\n Autonomous registration tests complete!");
}

testAutonomous().catch(console.error);

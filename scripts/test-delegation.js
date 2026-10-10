// test-delegation.js
const GATEWAY_URL = "http://localhost:3000";

async function testDelegation() {
  console.log("🧪 Testing Agent-to-Agent Delegation...\n");

  // Test 1: Discovery
  console.log("1. Testing agent discovery...");
  const discoverRes = await fetch(`${GATEWAY_URL}/v1/agents/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability: 'fraud_check' })
  });
  const discoverData = await discoverRes.json();
  console.log(`   Found ${discoverData.totalMatches} agents with 'fraud_check' capability:`);
  discoverData.agents.forEach(a => console.log(`   - ${a.agentId}`));

  // Test 2: Delegation
  console.log("\n2. Testing delegation from research-agent...");
  const delegateRes = await fetch(`${GATEWAY_URL}/v1/delegate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromAgent: 'research-agent',
      toCapability: 'fraud_check',
      payload: { claimId: 'CLM-002', applicant: 'Tunde Bello', amount: 25000 },
      executionId: 'exec-delegation-test',
      delegationDepth: 0,
      budget: 5.0
    })
  });
  const delegateData = await delegateRes.json();
  
  if (delegateRes.ok) {
    console.log(`   ✅ Delegation successful!`);
    console.log(`   Delegated to: ${delegateData.delegatedTo}`);
    console.log(`   Result:`, JSON.stringify(delegateData.result, null, 2));
    console.log(`   Delegation record:`, JSON.stringify(delegateData.delegationRecord, null, 2));
  } else {
    console.log(`   ❌ Delegation failed:`, delegateData);
  }

  // Test 3: Depth limit
  console.log("\n3. Testing delegation depth limit...");
  const depthRes = await fetch(`${GATEWAY_URL}/v1/delegate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromAgent: 'research-agent',
      toCapability: 'fraud_check',
      payload: { claimId: 'CLM-001', applicant: 'Test', amount: 100 },
      executionId: 'exec-depth-test',
      delegationDepth: 3,  // Exceeds max depth
      budget: 5.0
    })
  });
  const depthData = await depthRes.json();
  console.log(`   ${depthRes.ok ? '❌ Should have failed' : '✅ Correctly rejected'}: ${depthData.error}`);

  console.log("\n🏁 Delegation tests complete!");
}

testDelegation().catch(console.error);
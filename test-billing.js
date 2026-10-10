// test-billing.js
const GATEWAY_URL = "http://localhost:3000";
const API_KEY = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59";

async function testBilling() {
  console.log("💰 Testing Micro-Billing Engine...\n");

  // Test 1: Check initial balance (should be 1000 from dev seed)
  console.log("1. Checking initial balance of research-agent...");
  const balRes = await fetch(GATEWAY_URL + "/v1/agents/research-agent/balance", {
    headers: { 'x-api-key': API_KEY }
  });
  const balData = await balRes.json();
  console.log("   Balance: " + (balData.balance !== undefined ? balData.balance : "UNKNOWN (Check Gateway Logs)"));

  // Test 2: Run a delegation (costs 5 credits)
  console.log("\n2. Running delegation (budget: 5)...");
  const delRes = await fetch(GATEWAY_URL + "/v1/delegate", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      fromAgent: 'research-agent',
      toCapability: 'fraud_check',
      payload: { claimId: 'CLM-BILL-001', applicant: 'Test User', amount: 5000 },
      executionId: 'exec-bill-1',
      delegationDepth: 0,
      budget: 5.0
    })
  });
  const delData = await delRes.json();
  
  if (!delRes.ok) {
    console.log("   ❌ FAIL: Delegation rejected.");
    console.log("   Error:", delData.error, delData.detail || "");
    console.log("   👉 This usually means the agent balance is 0. Restart the stack after deleting the gateway/data folder.");
    return; // Stop the test here
  }

  console.log("   ✅ Delegated to: " + delData.delegatedTo);
  console.log("   ✅ Validation: " + delData.hallucinationValidation.verdict);
  console.log("   ✅ Billing:", JSON.stringify(delData.billing, null, 2));

  // Test 3: Check balances after delegation
  console.log("\n3. Checking balances after delegation...");
  const researchBal = await (await fetch(GATEWAY_URL + "/v1/agents/research-agent/balance", { headers: { 'x-api-key': API_KEY } })).json();
  const fraudBal = await (await fetch(GATEWAY_URL + "/v1/agents/node-fraud-checker/balance", { headers: { 'x-api-key': API_KEY } })).json();
  const platformBal = await (await fetch(GATEWAY_URL + "/v1/agents/graas-platform/balance", { headers: { 'x-api-key': API_KEY } })).json();
  
  console.log("   research-agent: " + researchBal.balance + " (paid 5)");
  console.log("   node-fraud-checker: " + fraudBal.balance + " (received 4.50)");
  console.log("   graas-platform: " + platformBal.balance + " (received 0.50 fee)");

  // Test 4: Run another delegation
  console.log("\n4. Running second delegation (budget: 3)...");
  const del2Res = await fetch(GATEWAY_URL + "/v1/delegate", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      fromAgent: 'research-agent',
      toCapability: 'fraud_check',
      payload: { claimId: 'CLM-BILL-002', applicant: 'Another User', amount: 8000 },
      executionId: 'exec-bill-2',
      delegationDepth: 0,
      budget: 3.0
    })
  });
  const del2Data = await del2Res.json();
  if (del2Res.ok) {
    console.log("   ✅ Billing:", JSON.stringify(del2Data.billing, null, 2));
  } else {
    console.log("   ❌ FAIL:", del2Data.error);
  }

  // Test 5: Check transaction history
  console.log("\n5. Transaction history for research-agent:");
  const txRes = await fetch(GATEWAY_URL + "/v1/agents/research-agent/transactions?limit=10", {
    headers: { 'x-api-key': API_KEY }
  });
  const txData = await txRes.json();
  if (txData.transactions && txData.transactions.length > 0) {
    txData.transactions.forEach(tx => {
      console.log("   [" + tx.type + "] " + (tx.fromAgent || "-") + " -> " + (tx.toAgent || "-") + " : " + tx.amount + " (" + tx.status + ")");
    });
  } else {
    console.log("   No transactions found.");
  }

  // Test 6: Check platform revenue
  console.log("\n6. Platform revenue:");
  const revRes = await fetch(GATEWAY_URL + "/v1/admin/revenue", {
    headers: { 'x-admin-key': 'admin-master-key' }
  });
  const revData = await revRes.json();
  console.log("   Total platform revenue: " + revData.platformRevenue);

  // Test 7: Test insufficient balance
  console.log("\n7. Testing insufficient balance (budget: 999999)...");
  const bigRes = await fetch(GATEWAY_URL + "/v1/delegate", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      fromAgent: 'research-agent',
      toCapability: 'fraud_check',
      payload: { claimId: 'CLM-BILL-003', applicant: 'Big Spender', amount: 100000 },
      executionId: 'exec-bill-3',
      delegationDepth: 0,
      budget: 999999.0
    })
  });
  const bigData = await bigRes.json();
  console.log("   Status: " + (bigRes.ok ? "approved (BAD)" : "rejected (GOOD)"));
  console.log("   Error: " + bigData.error);

  console.log("\n🏁 Billing tests complete!");
}

testBilling().catch(console.error);
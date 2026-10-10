const GATEWAY_URL = "http://localhost:3000";
const API_KEY = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59"; // The dev key from start-graas.ps1

async function testHallucination() {
  console.log(" Testing Hallucination Detection...\n");

  console.log("1. Testing GOOD output (should pass validation)...");
  const goodRes = await fetch(`${GATEWAY_URL}/invoke`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-api-key': API_KEY  //  ADDED API KEY
    },
    body: JSON.stringify({
      agentId: 'node-fraud-checker',
      capability: 'fraud_check',
      payload: { claimId: 'CLM-002', applicant: 'Tunde Bello', amount: 25000 },
      executionId: 'exec-good-test'
    })
  });
  
  const goodData = await goodRes.json();
  
  if (!goodData.hallucinationValidation) {
    console.log("     WARNING: hallucinationValidation is missing!");
    console.log("   Raw Gateway Response:", JSON.stringify(goodData, null, 2));
    return;
  }

  console.log(`    Status: ${goodData.hallucinationValidation.verdict}`);
  console.log(`   Hallucination Score: ${goodData.hallucinationValidation.hallucinationScore}/100`);
  console.log(`   Checks passed: ${goodData.hallucinationValidation.checks.filter(c => c.passed).length}/${goodData.hallucinationValidation.checks.length}`);

  console.log("\n2. Detailed validation breakdown:");
  for (const check of goodData.hallucinationValidation.checks) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`   ${icon} ${check.gate}: ${check.detail}`);
  }

  console.log("\n3. Testing LOW CONFIDENCE output (amount=0, should trigger warning)...");
  const lowConfRes = await fetch(`${GATEWAY_URL}/invoke`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-api-key': API_KEY 
    },
    body: JSON.stringify({
      agentId: 'node-fraud-checker',
      capability: 'fraud_check',
      payload: { claimId: 'CLM-003', applicant: 'Test', amount: 0 },
      executionId: 'exec-low-conf-test'
    })
  });
  const lowConfData = await lowConfRes.json();
  
  if (lowConfData.hallucinationValidation) {
    console.log(`   ⚠️  Status: ${lowConfData.hallucinationValidation.verdict}`);
    console.log(`   Hallucination Score: ${lowConfData.hallucinationValidation.hallucinationScore}/100`);
    const confCheck = lowConfData.hallucinationValidation.checks.find(c => c.gate === 'confidence');
    console.log(`   Confidence check: ${confCheck ? confCheck.detail : 'N/A'}`);
  }

  console.log("\n Hallucination detection tests complete!");
}

testHallucination().catch(console.error);

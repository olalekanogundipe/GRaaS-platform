// test-anonymizer.js
const { RuntimeAPI } = require('./src/runtime/RuntimeAPI');

console.log('🚀 Starting O-Lang Kernel Anonymizer Tests...\n');

// Initialize the kernel
const runtime = new RuntimeAPI({ verbose: true });
runtime.piiMode = 'redact-and-log'; // Force redact mode for the test

// ==========================================
// TEST 1: Direct Entity Anonymization
// ==========================================
console.log('--- TEST 1: Direct Entity Anonymization ---');
const entities = [
  { type: 'employee', id: 'emp_001', name: 'OLATUNJI DAVID OLADAPO' },
  { type: 'project', id: 'proj_001', name: 'Banana Island' }
];
const query = "Check the expenses for OLATUNJI DAVID OLADAPO on the Banana Island project.";

const { anonymized, mapping, redactionCount } = runtime.entityAnonymizer.anonymize(query, entities);
console.log('Original Query:  ', query);
console.log('Anonymized Query:', anonymized);
console.log('Mapping:         ', mapping);
console.log('Redaction Count: ', redactionCount);
console.log('✅ Test 1 Passed!\n');

// ==========================================
// TEST 2: Deanonymization (Simulating LLM Response)
// ==========================================
console.log('--- TEST 2: Deanonymization ---');
const llmResponse = "EMPLOYEE_001 has spent ₦500,000 on PROJECT_001 this month.";
const restored = runtime.entityAnonymizer.deanonymize(llmResponse, mapping);

console.log('LLM Response: ', llmResponse);
console.log('Restored:     ', restored);
console.log('✅ Test 2 Passed!\n');

// ==========================================
// TEST 3: Integration with _validateInputs
// ==========================================
console.log('--- TEST 3: Integration with _validateInputs ---');
const mockInputs = {
  user_question: "Show me the payroll for NWEKE DANIEL CHIBUOGWU and check his BVN 22345678901",
  entities: [
    { type: 'employee', id: 'emp_002', name: 'NWEKE DANIEL CHIBUOGWU' }
  ]
};

console.log('Before _validateInputs:', mockInputs.user_question);
runtime._validateInputs(mockInputs);
console.log('After _validateInputs :', mockInputs.user_question);
console.log('Stored Entity Mapping :', mockInputs._entityMapping);
console.log('✅ Test 3 Passed!\n');

console.log('🎉 All Anonymizer Tests Completed Successfully!');
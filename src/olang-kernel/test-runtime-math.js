// test-runtime-math.js
const { RuntimeAPI } = require('./src/runtime/RuntimeAPI');

const runtime = new RuntimeAPI({ verbose: true });

console.log('=== RuntimeAPI Math Tests ===\n');

// Test 1: Simple arithmetic
runtime.context = { weight_kg: 12.5, dose_per_kg: 15 };
const result1 = runtime.evaluateMath('{weight_kg} * {dose_per_kg}');
console.log(`Test 1: {weight_kg} * {dose_per_kg} → ${result1} (expected: 187.5)`);

// Test 2: Complex formula
runtime.context = { subtotal: 1000, tax_rate: 7.5 };
const result2 = runtime.evaluateMath('{subtotal} + ({subtotal} * {tax_rate} / 100)');
console.log(`Test 2: {subtotal} + ({subtotal} * {tax_rate} / 100) → ${result2} (expected: 1075)`);

// Test 3: String template
runtime.context = { doctor_id: 'DR-002', patient_name: 'Amara Okafor' };
const result3 = runtime.evaluateMath('Patient: {patient_name}');
console.log(`Test 3: Patient: {patient_name} → "${result3}" (expected: "Patient: Amara Okafor")`);

// Test 4: Quoted string
const result4 = runtime.evaluateMath('"Approved by Dr. {doctor_id}"');
console.log(`Test 4: "Approved by Dr. {doctor_id}" → "${result4}" (expected: "Approved by Dr. DR-002")`);

// Test 5: Legacy mathFunction
runtime.context = { weight_kg: 12.5, dose_per_kg: 15 };
const result5 = runtime.evaluateMath('multiply({weight_kg}, {dose_per_kg})');
console.log(`Test 5: multiply({weight_kg}, {dose_per_kg}) → ${result5} (expected: 187.5)`);

// Test 6: Pure arithmetic (no variables)
const result6 = runtime.evaluateMath('10 + 5');
console.log(`Test 6: 10 + 5 → ${result6} (expected: 15)`);

// Test 7: Division by zero
runtime.context = { a: 10, b: 0 };
const result7 = runtime.evaluateMath('{a} / {b}');
console.log(`Test 7: {a} / {b} → ${result7} (expected: error or 0)`);
const { evaluateMath } = require('./src/runtime/math');

const context = {
  weight_kg: 12.5,
  dose_per_kg: 15,
  subtotal: 1000,
  tax_rate: 7.5,
  doctor_id: 'DR-002',
  patient_name: 'Amara Okafor'
};

const addWarning = (msg) => console.log(`⚠️  ${msg}`);

console.log('=== Math Evaluation Tests ===\n');

const tests = [
  // Arithmetic
  { expr: '10 + 5', expected: 15 },
  { expr: '12.5 * 15', expected: 187.5 },
  { expr: '(100 + 50) / 3', expected: 50 },
  
  // With variables
  { expr: '{weight_kg} * {dose_per_kg}', expected: 187.5 },
  { expr: '{subtotal} + ({subtotal} * {tax_rate} / 100)', expected: 1075 },
  
  // String templates
  { expr: '"Approved by Dr. {doctor_id}"', expected: 'Approved by Dr. DR-002' },
  { expr: 'Patient: {patient_name}', expected: 'Patient: Amara Okafor' },
  
  // Legacy mathFunctions
  { expr: 'multiply({weight_kg}, {dose_per_kg})', expected: 187.5 },
  { expr: 'add(10, 5)', expected: 15 },
  
  // Edge cases
  { expr: '10 / 0', expected: 'Infinity or error' },
  { expr: '{weight_kg}', expected: 12.5 }
];

tests.forEach((test, i) => {
  const result = evaluateMath(test.expr, context, addWarning);
  const match = typeof test.expected === 'number' 
    ? Math.abs(result - test.expected) < 0.001
    : result === test.expected;
  console.log(`${match ? '✅' : '❌'} Test ${i + 1}: "${test.expr}" → ${JSON.stringify(result)} (expected: ${JSON.stringify(test.expected)})`);
});
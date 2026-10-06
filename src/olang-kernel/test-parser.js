const { parse } = require('./src/parser');

const workflow = `
Workflow "Math Test" with weight_kg, dose_per_kg, session_id

Step 1: Calculate "{weight_kg} * {dose_per_kg}"
Save as calculated_dose

Step 2: Calculate "10 + 5"
Save as simple_sum

Step 3: Calculate "(100 + 50) / 3"
Save as complex_calc

Step 4: Calculate "Approved by Dr. {doctor_id}"
Save as message

Step 5: If {intent.intent} equals "prescribe"
  Calculate "{weight_kg} * 15"
  Save as pediatric_dose
Else
  Calculate ""
  Save as pediatric_dose
EndIf

Return calculated_dose, simple_sum, complex_calc, message, pediatric_dose
`;

const result = parse(workflow, 'test.ol');

console.log('=== Parsed Steps ===\n');
result.steps.forEach((step, i) => {
  if (step.type === 'calculate') {
    console.log(`Step ${i + 1} (Calculate):`);
    console.log(`  Expression: "${step.expression}"`);
    console.log(`  Save as: ${step.saveAs}`);
    console.log('');
  } else if (step.type === 'if') {
    console.log(`Step ${i + 1} (If block):`);
    step.body.forEach((innerStep, j) => {
      if (innerStep.type === 'calculate') {
        console.log(`  Inner Step ${j + 1} (Calculate):`);
        console.log(`    Expression: "${innerStep.expression}"`);
        console.log(`    Save as: ${innerStep.saveAs}`);
      }
    });
    console.log('');
  }
});
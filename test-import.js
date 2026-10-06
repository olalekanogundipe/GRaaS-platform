// test-import.js
console.log('🔍 Testing db.js import...');
try {
  await import('./src/db.js');
  console.log('✅ db.js loaded successfully');
} catch (err) {
  console.error('❌ FAILED to load db.js:', err.message);
}

console.log('\n🔍 Testing olang.js import...');
try {
  await import('./src/olang.js');
  console.log('✅ olang.js loaded successfully');
} catch (err) {
  console.error('❌ FAILED to load olang.js:', err.message);
  console.error(err.stack);
}
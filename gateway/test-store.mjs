console.log("1. Starting store test...");
try {
  console.log("2. Importing store.js...");
  const store = await import('./src/store.js');
  console.log("3. SUCCESS: store.js loaded!");
  console.log("4. Store methods:", Object.keys(store));
} catch (e) {
  console.error("3. ERROR:", e.message);
  console.error("   Stack:", e.stack);
}
console.log("5. Test complete.");

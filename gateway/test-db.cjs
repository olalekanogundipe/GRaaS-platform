console.log("1. Starting test...");
try {
  console.log("2. Attempting to load better-sqlite3...");
  const Database = require('better-sqlite3');
  console.log("3. SUCCESS: better-sqlite3 loaded!");
} catch (e) {
  console.error("3. ERROR:", e.message);
}
console.log("4. Test complete.");

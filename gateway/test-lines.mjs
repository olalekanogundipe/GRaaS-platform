console.log("A. Starting...");
import Database from "better-sqlite3";
console.log("B. better-sqlite3 imported");
import crypto from "crypto";
console.log("C. crypto imported");
import path from "node:path";
console.log("D. path imported");
import fs from "node:fs";
console.log("E. fs imported");

const DB_PATH = process.env.GRAAS_DB_PATH || path.join(process.cwd(), "data", "graas.db");
console.log("F. DB_PATH is:", DB_PATH);

try {
  console.log("G. Attempting fs.mkdirSync...");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  console.log("H. fs.mkdirSync SUCCESS");
} catch (e) {
  console.error("H. fs.mkdirSync FAILED:", e.message);
}

try {
  console.log("I. Attempting new Database()...");
  const db = new Database(DB_PATH);
  console.log("J. Database() SUCCESS");
  
  console.log("K. Attempting pragma...");
  db.pragma("journal_mode = WAL");
  console.log("L. pragma SUCCESS");
} catch (e) {
  console.error("M. Database/pragma FAILED:", e.message);
  console.error("   Stack:", e.stack);
}

console.log("N. Test complete.");

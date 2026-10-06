// src/db.js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'graas.db');

// Ensure the data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance and concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ✅ FIX: Ensure the claims table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    applicant TEXT,
    amount INTEGER,
    status TEXT
  );
`);

// ✅ FIX: Seed mock data if the table is empty (matches E2E test data)
const count = db.prepare('SELECT COUNT(*) as count FROM claims').get().count;
if (count === 0) {
  const insert = db.prepare('INSERT INTO claims (id, applicant, amount, status) VALUES (?, ?, ?, ?)');
  insert.run('CLM-001', 'Adaeze Okafor', 4500, 'pending');
  insert.run('CLM-002', 'Tunde Bello', 25000, 'pending');
  insert.run('CLM-003', 'Test Review', 15000, 'pending');
  console.log('[GRaaS-DB] ✅ Seeded mock claims data.');
}

console.log('[GRaaS-DB] Connected to SQLite at:', DB_PATH);

export default db;
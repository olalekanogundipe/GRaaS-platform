// src/store.js - Stable SQLite persistent store using 'sqlite' + 'sqlite3'
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'graas.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Open database (Promise-based, ES Module safe)
const dbPromise = open({
  filename: dbPath,
  driver: sqlite3.Database
});

dbPromise.then(db => {
  console.log(`[GRaaS-DB] Connected to SQLite at: ${dbPath}`);
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      providerId TEXT,
      name TEXT,
      requiredCapabilities TEXT,
      pricePerResult REAL,
      commissionRate REAL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      executionId TEXT PRIMARY KEY,
      contractId TEXT,
      inputs TEXT,
      status TEXT,
      result TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[STORE]  SQLite tables initialized.');
}).catch(err => {
  console.error('[GRaaS-DB] Failed to connect:', err.message);
});

export const store = {
  saveContract: async (contract) => {
    const db = await dbPromise;
    await db.run(`
      INSERT OR REPLACE INTO contracts (id, providerId, name, requiredCapabilities, pricePerResult, commissionRate)
      VALUES (?, ?, ?, ?, ?, ?)
    `, contract.id, contract.providerId, contract.name, JSON.stringify(contract.requiredCapabilities || []), contract.pricePerResult || 0, contract.commissionRate || 0.2);
    console.log(`[GRaaS Core] Contract saved: ${contract.id}`);
  },

  getContract: async (id) => {
    const db = await dbPromise;
    const row = await db.get('SELECT * FROM contracts WHERE id = ?', id);
    if (!row) return null;
    return { ...row, requiredCapabilities: JSON.parse(row.requiredCapabilities || '[]') };
  },

  saveExecution: async (id, execution) => {
    const db = await dbPromise;
    await db.run(`
      INSERT INTO executions (executionId, contractId, inputs, status, result)
      VALUES (?, ?, ?, ?, ?)
    `, id, execution.contractId, JSON.stringify(execution.inputs || {}), execution.status || 'PENDING', null);
  },

  saveExecutionResult: async (id, result) => {
    const db = await dbPromise;
    await db.run(`
      UPDATE executions SET status = ?, result = ? WHERE executionId = ?
    `, 'COMPLETED', JSON.stringify(result), id);
  },

  getExecution: async (id) => {
    const db = await dbPromise;
    const row = await db.get('SELECT * FROM executions WHERE executionId = ?', id);
    if (!row) return null;
    return {
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      result: row.result ? JSON.parse(row.result) : null
    };
  }
};

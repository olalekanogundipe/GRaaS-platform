import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'gateway.db');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPromise = open({ filename: dbPath, driver: sqlite3.Database });

dbPromise.then(async (db) => {
  console.log(`[GATEWAY-DB] Connected to SQLite at: ${dbPath}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agentId TEXT PRIMARY KEY, publicKey TEXT NOT NULL, endpoint TEXT, capabilities TEXT,
      status TEXT DEFAULT 'pending', registered_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const cols = await db.all("PRAGMA table_info(agents)");
  if (!cols.some(c => c.name === 'proven')) {
    console.log('[GATEWAY-DB] Migrating: Adding proven column...');
    await db.exec("ALTER TABLE agents ADD COLUMN proven INTEGER DEFAULT 0");
  }
  if (!cols.some(c => c.name === 'challenge')) {
    console.log('[GATEWAY-DB] Migrating: Adding challenge columns...');
    await db.exec("ALTER TABLE agents ADD COLUMN challenge TEXT");
    await db.exec("ALTER TABLE agents ADD COLUMN challenge_expires TEXT");
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      scope TEXT DEFAULT '["execute:*","read:*"]', active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[GATEWAY-DB] Tables initialized and migrated.');

  const envKeys = (process.env.GATEWAY_API_KEYS || "").split(",").filter(k => k);
  for (const key of envKeys) {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    await db.run(`INSERT OR IGNORE INTO api_keys (key_hash, name, scope, active) VALUES (?, ?, ?, 1)`,
      [keyHash, 'env-seeded-key', '["execute:*","read:*"]']);
    console.log(`[GATEWAY-DB] Pre-seeded API key from environment.`);
  }
}).catch(err => console.error('[GATEWAY-DB] Failed to connect:', err.message));

export const store = {
  registerAgent: async (agentId, publicKey, endpoint, capabilities) => {
    const db = await dbPromise;
    await db.run(`INSERT OR REPLACE INTO agents (agentId, publicKey, endpoint, capabilities, status, proven) VALUES (?, ?, ?, ?, 'pending', 0)`,
      [agentId, publicKey, endpoint, JSON.stringify(capabilities || [])]);
  },
  getAgent: async (agentId) => {
    const db = await dbPromise;
    const row = await db.get('SELECT * FROM agents WHERE agentId = ?', [agentId]);
    if (!row) return null;
    return { ...row, capabilities: JSON.parse(row.capabilities || '[]'), proven: row.proven === 1 };
  },
  setAgentChallenge: async (agentId, challenge, expiresAt) => {
    const db = await dbPromise;
    await db.run("UPDATE agents SET challenge = ?, challenge_expires = ? WHERE agentId = ?", [challenge, expiresAt, agentId]);
  },
  clearAgentChallenge: async (agentId) => {
    const db = await dbPromise;
    await db.run("UPDATE agents SET challenge = NULL, challenge_expires = NULL WHERE agentId = ?", [agentId]);
  },
  updateAgentProven: async (agentId, proven) => {
    const db = await dbPromise;
    await db.run("UPDATE agents SET proven = ? WHERE agentId = ?", [proven ? 1 : 0, agentId]);
  },
  approveAgent: async (agentId) => {
    const db = await dbPromise;
    await db.run("UPDATE agents SET status = 'active', proven = 1 WHERE agentId = ?", [agentId]);
  },
  getAllAgents: async () => {
    const db = await dbPromise;
    const rows = await db.all('SELECT * FROM agents');
    return rows.map(r => ({ ...r, capabilities: JSON.parse(r.capabilities || '[]'), proven: r.proven === 1 }));
  }
};

export const apiKeyManager = {
  generateKey: async (name, scope = ['execute:*', 'read:*']) => {
    const apiKey = `graas_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const db = await dbPromise;
    await db.run(`INSERT INTO api_keys (key_hash, name, scope, active) VALUES (?, ?, ?, 1)`, [keyHash, name, JSON.stringify(scope)]);
    console.log(`[API-KEY] Generated key for: ${name}`);
    return { apiKey, name, scope };
  },
  validateKey: async (apiKey) => {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const db = await dbPromise;
    const row = await db.get('SELECT * FROM api_keys WHERE key_hash = ? AND active = 1', [keyHash]);
    if (!row) return null;
    return { id: row.id, name: row.name, scope: JSON.parse(row.scope || '[]') };
  },
  revokeKey: async (keyId) => {
    const db = await dbPromise;
    await db.run('UPDATE api_keys SET active = 0 WHERE id = ?', [keyId]);
  },
  listKeys: async () => {
    const db = await dbPromise;
    return await db.all('SELECT id, name, scope, active, created_at FROM api_keys');
  }
};

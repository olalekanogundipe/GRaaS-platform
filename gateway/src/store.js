// gateway/src/store.js
import "dotenv/config"; 
import { createClient } from "@libsql/client";
import crypto from "crypto";

// Initialize Turso Client
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Helper functions to mimic the old sqlite API seamlessly
async function get(sql, params = []) {
  const res = await db.execute({ sql, args: params });
  return res.rows[0] || null;
}

async function all(sql, params = []) {
  const res = await db.execute({ sql, args: params });
  return res.rows;
}

async function run(sql, params = []) {
  await db.execute({ sql, args: params });
}

export async function initDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS agents (
      agentId TEXT PRIMARY KEY,
      publicKey TEXT NOT NULL,
      endpoint TEXT,
      capabilities TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      proven INTEGER DEFAULT 0,
      challenge TEXT,
      challenge_expires TEXT,
      registeredAt TEXT DEFAULT CURRENT_TIMESTAMP,
      stake REAL DEFAULT 0,
      reputation REAL DEFAULT 0,
      totalExecutions INTEGER DEFAULT 0,
      failedExecutions INTEGER DEFAULT 0,
      lastSeen TEXT,
      balance REAL DEFAULT 1000
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
      keyHash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT DEFAULT '[]',
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      revoked INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      executionId TEXT,
      agentId TEXT,
      capability TEXT,
      status TEXT,
      hallucinationScore INTEGER,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      fromAgent TEXT,
      toAgent TEXT,
      amount REAL NOT NULL,
      executionId TEXT,
      status TEXT DEFAULT 'completed',
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const stmt of statements) {
    await db.execute(stmt);
  }
  console.log("[STORE] Database initialized on Turso (Cloud)");
}

export const store = {
  // ── Agent CRUD ──
  async registerAgent(agentId, publicKey, endpoint, capabilities = []) {
    const existing = await get("SELECT * FROM agents WHERE agentId = ?", [agentId]);
    if (existing) {
      await run("UPDATE agents SET publicKey = ?, endpoint = ?, capabilities = ?, status = 'pending', proven = 0 WHERE agentId = ?", [publicKey, endpoint, JSON.stringify(capabilities), agentId]);
    } else {
      await run("INSERT INTO agents (agentId, publicKey, endpoint, capabilities, balance) VALUES (?, ?, ?, ?, 1000)", [agentId, publicKey, endpoint, JSON.stringify(capabilities)]);
    }
  },
  async getAgent(agentId) {
    const agent = await get("SELECT * FROM agents WHERE agentId = ?", [agentId]);
    if (!agent) return null;
    return { ...agent, capabilities: JSON.parse(agent.capabilities || "[]"), proven: !!agent.proven };
  },
  async getAllAgents() {
    const agents = await all("SELECT * FROM agents WHERE agentId NOT IN ('olang-kernel', 'graas-platform')");
    return agents.map(a => ({ ...a, capabilities: JSON.parse(a.capabilities || "[]"), proven: !!a.proven }));
  },
  async setAgentChallenge(agentId, challenge, expiresAt) {
    await run("UPDATE agents SET challenge = ?, challenge_expires = ? WHERE agentId = ?", [challenge, expiresAt, agentId]);
  },
  async clearAgentChallenge(agentId) {
    await run("UPDATE agents SET challenge = NULL, challenge_expires = NULL WHERE agentId = ?", [agentId]);
  },
  async updateAgentProven(agentId, proven) {
    await run("UPDATE agents SET proven = ? WHERE agentId = ?", [proven ? 1 : 0, agentId]);
  },
  async approveAgent(agentId) {
    await run("UPDATE agents SET status = 'active' WHERE agentId = ?", [agentId]);
  },

  // ── Autonomous Approval ──
  async checkAutoApproval(agentId) {
    const agent = await this.getAgent(agentId);
    if (!agent) return { approved: false, reason: "agent_not_found" };
    if (!agent.proven) return { approved: false, reason: "not_proven" };
    const STAKE_THRESHOLD = 100;
    const REPUTATION_THRESHOLD = 10;
    if (agent.stake >= STAKE_THRESHOLD) {
      await this.approveAgent(agentId);
      return { approved: true, reason: "stake (" + agent.stake + ") >= " + STAKE_THRESHOLD };
    }
    if (agent.reputation >= REPUTATION_THRESHOLD) {
      await this.approveAgent(agentId);
      return { approved: true, reason: "reputation (" + agent.reputation + ") >= " + REPUTATION_THRESHOLD };
    }
    return { approved: false, reason: "Needs stake >= " + STAKE_THRESHOLD + " OR reputation >= " + REPUTATION_THRESHOLD };
  },

  // ── Stake Management ──
  async addStake(agentId, amount) {
    await run("UPDATE agents SET stake = stake + ? WHERE agentId = ?", [amount, agentId]);
    const agent = await this.getAgent(agentId);
    return agent.stake;
  },
  async slashStake(agentId, percentage = 50) {
    const agent = await this.getAgent(agentId);
    if (!agent) return 0;
    const slashAmount = agent.stake * (percentage / 100);
    await run("UPDATE agents SET stake = stake - ? WHERE agentId = ?", [slashAmount, agentId]);
    console.log("[STORE] Slashed " + slashAmount + " from " + agentId + " (" + percentage + "% penalty)");
    return slashAmount;
  },

  // ── Reputation ──
  async recordExecution(agentId, success, hallucinationScore = 0) {
    const agent = await this.getAgent(agentId);
    if (!agent) return;
    let repChange = 0;
    if (success && hallucinationScore < 20) { repChange = 1; } 
    else if (hallucinationScore > 50) { repChange = -2; }
    await run("UPDATE agents SET totalExecutions = totalExecutions + 1, failedExecutions = failedExecutions + ?, reputation = MAX(0, reputation + ?), lastSeen = CURRENT_TIMESTAMP WHERE agentId = ?", [success ? 0 : 1, repChange, agentId]);
    await run("INSERT INTO execution_logs (agentId, capability, status, hallucinationScore) VALUES (?, ?, ?, ?)", [agentId, null, success ? 'success' : 'failed', hallucinationScore]);
  },
  async getLeaderboard(limit = 10) {
    return await all(`
      SELECT agentId, reputation, stake, balance, totalExecutions, failedExecutions, lastSeen, status 
      FROM agents 
      WHERE agentId NOT IN ('olang-kernel', 'graas-platform')
      ORDER BY reputation DESC, stake DESC 
      LIMIT ?
    `, [limit]);
  },

  // ══════════════════════════════════════════════════════════
  // 💰 BILLING ENGINE
  // ══════════════════════════════════════════════════════════
  async getBalance(agentId) {
    const agent = await this.getAgent(agentId);
    if (!agent) return null;
    return agent.balance || 0;
  },

  async deposit(agentId, amount) {
    await run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", [amount, agentId]);
    await run("INSERT INTO transactions (type, toAgent, amount, status) VALUES ('deposit', ?, ?, 'completed')", [agentId, amount]);
    const agent = await this.getAgent(agentId);
    return agent.balance;
  },

  async lockEscrow(fromAgent, amount, executionId) {
    const agent = await this.getAgent(fromAgent);
    if (!agent) throw new Error("agent_not_found");
    if ((agent.balance || 0) < amount) {
      throw new Error("insufficient_balance. Has: " + (agent.balance || 0) + ", needs: " + amount);
    }
    await run("UPDATE agents SET balance = balance - ? WHERE agentId = ?", [amount, fromAgent]);
    await run("INSERT INTO transactions (type, fromAgent, amount, executionId, status) VALUES ('escrow_lock', ?, ?, ?, 'pending')", [fromAgent, amount, executionId]);
    return true;
  },

  async releasePayment(fromAgent, toAgent, amount, executionId, platformFeePercent = 10) {
    const fee = amount * (platformFeePercent / 100);
    const payout = amount - fee;

    await run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", [payout, toAgent]);
    
    await this._ensurePlatformAccount();
    await run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", [fee, "graas-platform"]);

    await run("UPDATE transactions SET status = 'completed' WHERE executionId = ? AND type = 'escrow_lock'", [executionId]);
    await run("INSERT INTO transactions (type, fromAgent, toAgent, amount, executionId, status) VALUES ('delegation_payment', ?, ?, ?, ?, 'completed')", [fromAgent, toAgent, payout, executionId]);
    await run("INSERT INTO transactions (type, fromAgent, toAgent, amount, executionId, status) VALUES ('platform_fee', ?, ?, ?, ?, 'completed')", [fromAgent, "graas-platform", fee, executionId]);

    return { payout, fee };
  },

  async refundEscrow(fromAgent, amount, executionId) {
    await run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", [amount, fromAgent]);
    await run("UPDATE transactions SET status = 'refunded' WHERE executionId = ? AND type = 'escrow_lock'", [executionId]);
    await run("INSERT INTO transactions (type, toAgent, amount, executionId, status) VALUES ('refund', ?, ?, ?, 'completed')", [fromAgent, amount, executionId]);
    return true;
  },

  async getTransactions(agentId, limit = 20) {
    return await all(
      "SELECT * FROM transactions WHERE fromAgent = ? OR toAgent = ? ORDER BY timestamp DESC LIMIT ?",
      [agentId, agentId, limit]
    );
  },

  async getPlatformRevenue() {
    const result = await get("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'platform_fee'");
    return result ? result.total : 0;
  },

  async _ensurePlatformAccount() {
    const exists = await get("SELECT 1 FROM agents WHERE agentId = 'graas-platform'");
    if (!exists) {
      await run("INSERT INTO agents (agentId, publicKey, balance) VALUES ('graas-platform', 'platform-key', 0)");
    }
  }
};

// ── API Key Manager ──
export const apiKeyManager = {
  _hash(key) { return crypto.createHash("sha256").update(key).digest("hex"); },
  async generateKey(name, scope = []) {
    const key = "graas_" + crypto.randomBytes(24).toString("hex");
    const hash = this._hash(key);
    await run("INSERT INTO api_keys (keyHash, name, scope) VALUES (?, ?, ?)", [hash, name, JSON.stringify(scope)]);
    return { key, name, scope };
  },
  async validateKey(key) {
    const hash = this._hash(key);
    const record = await get("SELECT * FROM api_keys WHERE keyHash = ? AND revoked = 0", [hash]);
    if (!record) return null;
    return { name: record.name, scope: JSON.parse(record.scope || "[]") };
  },
  async listKeys() { return await all("SELECT name, scope, createdAt, revoked FROM api_keys"); },
  async revokeKey(name) { await run("UPDATE api_keys SET revoked = 1 WHERE name = ?", [name]); }
};

export async function preseedKeys() {
  if (process.env.GATEWAY_API_KEYS) {
    const keys = process.env.GATEWAY_API_KEYS.split(",").map(k => k.trim()).filter(Boolean);
    for (const key of keys) {
      const hash = apiKeyManager._hash(key);
      const exists = await get("SELECT 1 FROM api_keys WHERE keyHash = ?", [hash]);
      if (!exists) {
        await run("INSERT INTO api_keys (keyHash, name, scope) VALUES (?, ?, ?)", [hash, "dev-key", JSON.stringify([])]);
        console.log("[GATEWAY-DB] Pre-seeded API key from environment.");
      }
    }
  }
}




// // gateway/src/store.js
// import sqlite3 from "sqlite3";
// import { open } from "sqlite";
// import crypto from "crypto";
// import path from "node:path";
// import fs from "node:fs";

// const DB_PATH = process.env.GRAAS_DB_PATH || path.join(process.cwd(), "data", "graas.db");
// fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// let db;

// export async function initDb() {
//   db = await open({
//     filename: DB_PATH,
//     driver: sqlite3.Database
//   });

//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS agents (
//       agentId TEXT PRIMARY KEY,
//       publicKey TEXT NOT NULL,
//       endpoint TEXT,
//       capabilities TEXT DEFAULT '[]',
//       status TEXT DEFAULT 'pending',
//       proven INTEGER DEFAULT 0,
//       challenge TEXT,
//       challenge_expires TEXT,
//       registeredAt TEXT DEFAULT CURRENT_TIMESTAMP,
//       stake REAL DEFAULT 0,
//       reputation REAL DEFAULT 0,
//       totalExecutions INTEGER DEFAULT 0,
//       failedExecutions INTEGER DEFAULT 0,
//       lastSeen TEXT,
//       balance REAL DEFAULT 1000
//     );

//     CREATE TABLE IF NOT EXISTS api_keys (
//       keyHash TEXT PRIMARY KEY,
//       name TEXT NOT NULL,
//       scope TEXT DEFAULT '[]',
//       createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
//       revoked INTEGER DEFAULT 0
//     );

//     CREATE TABLE IF NOT EXISTS execution_logs (
//       id INTEGER PRIMARY KEY AUTOINCREMENT,
//       executionId TEXT,
//       agentId TEXT,
//       capability TEXT,
//       status TEXT,
//       hallucinationScore INTEGER,
//       timestamp TEXT DEFAULT CURRENT_TIMESTAMP
//     );

//     CREATE TABLE IF NOT EXISTS transactions (
//       id INTEGER PRIMARY KEY AUTOINCREMENT,
//       type TEXT NOT NULL,
//       fromAgent TEXT,
//       toAgent TEXT,
//       amount REAL NOT NULL,
//       executionId TEXT,
//       status TEXT DEFAULT 'completed',
//       timestamp TEXT DEFAULT CURRENT_TIMESTAMP
//     );
//   `);
//   console.log("[STORE] Database initialized at", DB_PATH);
// }

// export const store = {
//   // ── Agent CRUD ──
//   async registerAgent(agentId, publicKey, endpoint, capabilities = []) {
//     const existing = await db.get("SELECT * FROM agents WHERE agentId = ?", agentId);
//     if (existing) {
//       await db.run("UPDATE agents SET publicKey = ?, endpoint = ?, capabilities = ?, status = 'pending', proven = 0 WHERE agentId = ?", publicKey, endpoint, JSON.stringify(capabilities), agentId);
//     } else {
//       await db.run("INSERT INTO agents (agentId, publicKey, endpoint, capabilities, balance) VALUES (?, ?, ?, ?, 1000)", agentId, publicKey, endpoint, JSON.stringify(capabilities));
//     }
//   },
//   async getAgent(agentId) {
//     const agent = await db.get("SELECT * FROM agents WHERE agentId = ?", agentId);
//     if (!agent) return null;
//     return { ...agent, capabilities: JSON.parse(agent.capabilities || "[]"), proven: !!agent.proven };
//   },
//   async getAllAgents() {
//     // Hide infrastructure accounts so agents don't try to delegate work to the platform bank
//     const agents = await db.all("SELECT * FROM agents WHERE agentId NOT IN ('olang-kernel', 'graas-platform')");
//     return agents.map(a => ({ ...a, capabilities: JSON.parse(a.capabilities || "[]"), proven: !!a.proven }));
//   },
//   async setAgentChallenge(agentId, challenge, expiresAt) {
//     await db.run("UPDATE agents SET challenge = ?, challenge_expires = ? WHERE agentId = ?", challenge, expiresAt, agentId);
//   },
//   async clearAgentChallenge(agentId) {
//     await db.run("UPDATE agents SET challenge = NULL, challenge_expires = NULL WHERE agentId = ?", agentId);
//   },
//   async updateAgentProven(agentId, proven) {
//     await db.run("UPDATE agents SET proven = ? WHERE agentId = ?", proven ? 1 : 0, agentId);
//   },
//   async approveAgent(agentId) {
//     await db.run("UPDATE agents SET status = 'active' WHERE agentId = ?", agentId);
//   },

//   // ── Autonomous Approval ──
//   async checkAutoApproval(agentId) {
//     const agent = await this.getAgent(agentId);
//     if (!agent) return { approved: false, reason: "agent_not_found" };
//     if (!agent.proven) return { approved: false, reason: "not_proven" };
//     const STAKE_THRESHOLD = 100;
//     const REPUTATION_THRESHOLD = 10;
//     if (agent.stake >= STAKE_THRESHOLD) {
//       await this.approveAgent(agentId);
//       return { approved: true, reason: "stake (" + agent.stake + ") >= " + STAKE_THRESHOLD };
//     }
//     if (agent.reputation >= REPUTATION_THRESHOLD) {
//       await this.approveAgent(agentId);
//       return { approved: true, reason: "reputation (" + agent.reputation + ") >= " + REPUTATION_THRESHOLD };
//     }
//     return { approved: false, reason: "Needs stake >= " + STAKE_THRESHOLD + " OR reputation >= " + REPUTATION_THRESHOLD };
//   },

//   // ── Stake Management ──
//   async addStake(agentId, amount) {
//     await db.run("UPDATE agents SET stake = stake + ? WHERE agentId = ?", amount, agentId);
//     const agent = await this.getAgent(agentId);
//     return agent.stake;
//   },
//   async slashStake(agentId, percentage = 50) {
//     const agent = await this.getAgent(agentId);
//     if (!agent) return 0;
//     const slashAmount = agent.stake * (percentage / 100);
//     await db.run("UPDATE agents SET stake = stake - ? WHERE agentId = ?", slashAmount, agentId);
//     console.log("[STORE] Slashed " + slashAmount + " from " + agentId + " (" + percentage + "% penalty)");
//     return slashAmount;
//   },

//   // ── Reputation ──
//   async recordExecution(agentId, success, hallucinationScore = 0) {
//     const agent = await this.getAgent(agentId);
//     if (!agent) return;
//     let repChange = 0;
//     if (success && hallucinationScore < 20) { repChange = 1; } 
//     else if (hallucinationScore > 50) { repChange = -2; }
//     await db.run("UPDATE agents SET totalExecutions = totalExecutions + 1, failedExecutions = failedExecutions + ?, reputation = MAX(0, reputation + ?), lastSeen = CURRENT_TIMESTAMP WHERE agentId = ?", success ? 0 : 1, repChange, agentId);
//     await db.run("INSERT INTO execution_logs (agentId, capability, status, hallucinationScore) VALUES (?, ?, ?, ?)", agentId, null, success ? 'success' : 'failed', hallucinationScore);
//   },
//   async getLeaderboard(limit = 10) {
//     // Exclude platform infrastructure accounts from the public agent directory
//     return await db.all(`
//       SELECT agentId, reputation, stake, balance, totalExecutions, failedExecutions, lastSeen, status 
//       FROM agents 
//       WHERE agentId NOT IN ('olang-kernel', 'graas-platform')
//       ORDER BY reputation DESC, stake DESC 
//       LIMIT ?
//     `, limit);
//   },
//   // ══════════════════════════════════════════════════════════
//   // 💰 NEW: BILLING ENGINE
//   // ══════════════════════════════════════════════════════════

//   async getBalance(agentId) {
//     const agent = await this.getAgent(agentId);
//     if (!agent) return null;
//     return agent.balance || 0;
//   },

//   async deposit(agentId, amount) {
//     await db.run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", amount, agentId);
//     await db.run("INSERT INTO transactions (type, toAgent, amount, status) VALUES ('deposit', ?, ?, 'completed')", agentId, amount);
//     const agent = await this.getAgent(agentId);
//     return agent.balance;
//   },

//   async lockEscrow(fromAgent, amount, executionId) {
//     const agent = await this.getAgent(fromAgent);
//     if (!agent) throw new Error("agent_not_found");
//     if ((agent.balance || 0) < amount) {
//       throw new Error("insufficient_balance. Has: " + (agent.balance || 0) + ", needs: " + amount);
//     }
//     await db.run("UPDATE agents SET balance = balance - ? WHERE agentId = ?", amount, fromAgent);
//     await db.run("INSERT INTO transactions (type, fromAgent, amount, executionId, status) VALUES ('escrow_lock', ?, ?, ?, 'pending')", fromAgent, amount, executionId);
//     return true;
//   },

//   async releasePayment(fromAgent, toAgent, amount, executionId, platformFeePercent = 10) {
//     const fee = amount * (platformFeePercent / 100);
//     const payout = amount - fee;

//     // Pay the target agent
//     await db.run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", payout, toAgent);
    
//     // Pay the platform (special "graas-platform" account)
//     await this._ensurePlatformAccount();
//     await db.run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", fee, "graas-platform");

//     // Record transactions
//     await db.run("UPDATE transactions SET status = 'completed' WHERE executionId = ? AND type = 'escrow_lock'", executionId);
//     await db.run("INSERT INTO transactions (type, fromAgent, toAgent, amount, executionId, status) VALUES ('delegation_payment', ?, ?, ?, ?, 'completed')", fromAgent, toAgent, payout, executionId);
//     await db.run("INSERT INTO transactions (type, fromAgent, toAgent, amount, executionId, status) VALUES ('platform_fee', ?, ?, ?, ?, 'completed')", fromAgent, "graas-platform", fee, executionId);

//     return { payout, fee };
//   },

//   async refundEscrow(fromAgent, amount, executionId) {
//     await db.run("UPDATE agents SET balance = balance + ? WHERE agentId = ?", amount, fromAgent);
//     await db.run("UPDATE transactions SET status = 'refunded' WHERE executionId = ? AND type = 'escrow_lock'", executionId);
//     await db.run("INSERT INTO transactions (type, toAgent, amount, executionId, status) VALUES ('refund', ?, ?, ?, 'completed')", fromAgent, amount, executionId);
//     return true;
//   },

//   async getTransactions(agentId, limit = 20) {
//     return await db.all(
//       "SELECT * FROM transactions WHERE fromAgent = ? OR toAgent = ? ORDER BY timestamp DESC LIMIT ?",
//       agentId, agentId, limit
//     );
//   },

//   async getPlatformRevenue() {
//     const result = await db.get("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'platform_fee'");
//     return result.total;
//   },

//   async _ensurePlatformAccount() {
//     const exists = await db.get("SELECT 1 FROM agents WHERE agentId = 'graas-platform'");
//     if (!exists) {
//       await db.run("INSERT INTO agents (agentId, publicKey, balance) VALUES ('graas-platform', 'platform-key', 0)");
//     }
//   }
// };

// // ── API Key Manager ──
// export const apiKeyManager = {
//   _hash(key) { return crypto.createHash("sha256").update(key).digest("hex"); },
//   async generateKey(name, scope = []) {
//     const key = "graas_" + crypto.randomBytes(24).toString("hex");
//     const hash = this._hash(key);
//     await db.run("INSERT INTO api_keys (keyHash, name, scope) VALUES (?, ?, ?)", hash, name, JSON.stringify(scope));
//     return { key, name, scope };
//   },
//   async validateKey(key) {
//     const hash = this._hash(key);
//     const record = await db.get("SELECT * FROM api_keys WHERE keyHash = ? AND revoked = 0", hash);
//     if (!record) return null;
//     return { name: record.name, scope: JSON.parse(record.scope || "[]") };
//   },
//   async listKeys() { return await db.all("SELECT name, scope, createdAt, revoked FROM api_keys"); },
//   async revokeKey(name) { await db.run("UPDATE api_keys SET revoked = 1 WHERE name = ?", name); }
// };

// export async function preseedKeys() {
//   if (process.env.GATEWAY_API_KEYS) {
//     const keys = process.env.GATEWAY_API_KEYS.split(",").map(k => k.trim()).filter(Boolean);
//     for (const key of keys) {
//       const hash = apiKeyManager._hash(key);
//       const exists = await db.get("SELECT 1 FROM api_keys WHERE keyHash = ?", hash);
//       if (!exists) {
//         await db.run("INSERT INTO api_keys (keyHash, name, scope) VALUES (?, ?, ?)", hash, "dev-key", JSON.stringify([]));
//         console.log("[GATEWAY-DB] Pre-seeded API key from environment.");
//       }
//     }
//   }
// }



// registry/src/index.js
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "node:path";
import fs from "node:fs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(process.cwd(), "data", "registry.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

async function initDb() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agentId TEXT PRIMARY KEY,
      publicKey TEXT NOT NULL,
      homePlatform TEXT NOT NULL,
      endpoint TEXT,
      capabilities TEXT DEFAULT '[]',
      reputation REAL DEFAULT 0,
      totalExecutions INTEGER DEFAULT 0,
      lastSeen TEXT,
      registeredAt TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS platforms (
      platformId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gatewayUrl TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      economics TEXT DEFAULT '{}',
      registeredAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("[REGISTRY] Database initialized at", DB_PATH);
}

// ── Agent Registration ──
app.post("/registry/agents", async (req, res) => {
  try {
    const { agentId, publicKey, homePlatform, endpoint, capabilities } = req.body;

    if (!agentId || !publicKey || !homePlatform) {
      return res.status(400).json({ error: "agentId, publicKey, and homePlatform are required" });
    }

    const existing = await db.get("SELECT * FROM agents WHERE agentId = ?", agentId);

    if (existing) {
      await db.run(
        "UPDATE agents SET publicKey = ?, homePlatform = ?, endpoint = ?, capabilities = ?, lastSeen = CURRENT_TIMESTAMP WHERE agentId = ?",
        publicKey, homePlatform, endpoint || existing.endpoint, JSON.stringify(capabilities || []), agentId
      );
      console.log("[REGISTRY] Agent updated:", agentId);
    } else {
      await db.run(
        "INSERT INTO agents (agentId, publicKey, homePlatform, endpoint, capabilities) VALUES (?, ?, ?, ?, ?)",
        agentId, publicKey, homePlatform, endpoint || "", JSON.stringify(capabilities || [])
      );
      console.log("[REGISTRY] Agent registered:", agentId);
    }

    res.json({ success: true, agentId });
  } catch (error) {
    console.error("[REGISTRY] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Agent Discovery ──
app.get("/registry/agents", async (req, res) => {
  try {
    const { capability, limit = 50 } = req.query;
    let agents;

    if (capability) {
      agents = await db.all(
        "SELECT * FROM agents WHERE capabilities LIKE ? ORDER BY reputation DESC LIMIT ?",
        "%" + capability + "%",
        parseInt(limit)
      );
    } else {
      agents = await db.all("SELECT * FROM agents ORDER BY reputation DESC LIMIT ?", parseInt(limit));
    }

    const formatted = agents.map(a => ({
      agentId: a.agentId,
      homePlatform: a.homePlatform,
      endpoint: a.endpoint,
      capabilities: JSON.parse(a.capabilities || "[]"),
      reputation: a.reputation,
      totalExecutions: a.totalExecutions,
      lastSeen: a.lastSeen
    }));

    res.json({ agents: formatted, total: formatted.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Update Agent Reputation ──
app.post("/registry/agents/:agentId/reputation", async (req, res) => {
  try {
    const { agentId } = req.params;
    const { reputationChange } = req.body;

    const agent = await db.get("SELECT * FROM agents WHERE agentId = ?", agentId);
    if (!agent) return res.status(404).json({ error: "agent_not_found" });

    await db.run(
      "UPDATE agents SET reputation = MAX(0, reputation + ?), totalExecutions = totalExecutions + 1, lastSeen = CURRENT_TIMESTAMP WHERE agentId = ?",
      reputationChange, agentId
    );

    const updated = await db.get("SELECT reputation FROM agents WHERE agentId = ?", agentId);
    res.json({ success: true, newReputation: updated.reputation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Platform Registration ──
app.post("/registry/platforms", async (req, res) => {
  try {
    const { platformId, name, gatewayUrl, capabilities, economics } = req.body;

    if (!platformId || !name || !gatewayUrl) {
      return res.status(400).json({ error: "platformId, name, and gatewayUrl are required" });
    }

    const existing = await db.get("SELECT * FROM platforms WHERE platformId = ?", platformId);

    if (existing) {
      await db.run(
        "UPDATE platforms SET name = ?, gatewayUrl = ?, capabilities = ?, economics = ? WHERE platformId = ?",
        name, gatewayUrl, JSON.stringify(capabilities || []), JSON.stringify(economics || {}), platformId
      );
      console.log("[REGISTRY] Platform updated:", platformId);
    } else {
      await db.run(
        "INSERT INTO platforms (platformId, name, gatewayUrl, capabilities, economics) VALUES (?, ?, ?, ?, ?)",
        platformId, name, gatewayUrl, JSON.stringify(capabilities || []), JSON.stringify(economics || {})
      );
      console.log("[REGISTRY] Platform registered:", platformId);
    }

    res.json({ success: true, platformId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Platform Discovery ──
app.get("/registry/platforms", async (req, res) => {
  try {
    const { capability } = req.query;
    let platforms;

    if (capability) {
      platforms = await db.all("SELECT * FROM platforms WHERE capabilities LIKE ?", "%" + capability + "%");
    } else {
      platforms = await db.all("SELECT * FROM platforms");
    }

    const formatted = platforms.map(p => ({
      platformId: p.platformId,
      name: p.name,
      gatewayUrl: p.gatewayUrl,
      capabilities: JSON.parse(p.capabilities || "[]"),
      economics: JSON.parse(p.economics || "{}")
    }));

    res.json({ platforms: formatted, total: formatted.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Health Check ──
app.get("/healthz", (req, res) => res.json({ ok: true, service: "registry" }));

// ── Start Server ──
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log("[REGISTRY] Global Agent Registry listening on :" + PORT);
  });
}

start().catch(err => {
  console.error("Failed to start registry:", err);
  process.exit(1);
});
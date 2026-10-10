// gateway/src/index.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { store, apiKeyManager, initDb, preseedKeys } from "./store.js";
import { verifyB64 } from "./crypto.js";
import { HallucinationValidator } from "./validator.js";

const app = express();
app.use(cors()); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "admin-master-key";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "internal-secret-for-gateway";
const PLATFORM_FEE_PERCENT = 10;

// 🌐 GLOBAL REGISTRY CONFIGURATION
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:4000";
const PLATFORM_ID = process.env.PLATFORM_ID || "graas-platform";

const validator = new HallucinationValidator();
validator.registerSchema("fraud_check", {
  required: ["isFraud", "riskScore", "confidence", "evidence"],
  types: { isFraud: "boolean", riskScore: "number", confidence: "number", message: "string" },
  ranges: { riskScore: { min: 0, max: 100 }, confidence: { min: 0, max: 1 } }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

async function startServer() {
  await initDb();
  await preseedKeys();
  
  console.log("[GATEWAY] Starting GRaaS Gateway on port " + PORT + "...");
  console.log("[GATEWAY] Connected to Global Registry at " + REGISTRY_URL);

  // ── Auth Middleware ──
  app.use(async (req, res, next) => {
    if (
      req.path === "/healthz" || 
      req.path === "/health" || 
      req.path.startsWith("/v1/agents") || 
      req.path.startsWith("/v1/delegate") ||
      req.path.startsWith("/v1/transactions") ||
      req.path.startsWith("/v1/platform") || 
      req.path.startsWith("/v1/admin/") || 
      req.path.startsWith("/admin/")
    ) {
      return next();
    }
    
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "unauthorized. Missing x-api-key header" });
    const keyData = await apiKeyManager.validateKey(apiKey);
    if (!keyData) return res.status(401).json({ error: "unauthorized. Invalid or revoked API key" });
    req.keyData = keyData;
    next();
  });

  // ══════════════════════════════════════════════════════════
  // 🌐 PLATFORM SELF-REGISTRATION
  // ══════════════════════════════════════════════════════════
  app.post("/v1/platform/register", async (req, res) => {
    try {
      const response = await fetch(`${REGISTRY_URL}/registry/platforms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platformId: PLATFORM_ID,
          name: "GRaaS",
          gatewayUrl: `http://localhost:${PORT}`,
          capabilities: ["fraud_check", "document_verification", "risk_assessment"],
          economics: { stakeRequired: 100, platformFee: 10, currency: "CR" }
        })
      });
      const result = await response.json();
      console.log("[GATEWAY] Platform registered with global registry:", result);
      res.json(result);
    } catch (error) {
      console.error("[GATEWAY] Failed to register platform:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ── Agent Registration & Proof ──
  app.post("/v1/agents/register", async (req, res) => {
    try {
      let { agentId, publicKey, endpoint, capabilities } = req.body;
      agentId = agentId || req.body.id || req.body.name || req.body.agent_id;
      publicKey = publicKey || req.body.pubkey || req.body.public_key || req.body.publicKeyPem || req.body.key;
      
      if (!agentId || !publicKey) return res.status(400).json({ error: "agentId and publicKey are required" });
      
      await store.registerAgent(agentId, publicKey, endpoint, capabilities || []);
      console.log("[GATEWAY] Agent registered locally:", agentId);

      try {
        await fetch(`${REGISTRY_URL}/registry/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            publicKey,
            homePlatform: PLATFORM_ID,
            endpoint: endpoint || "",
            capabilities: capabilities || []
          })
        });
        console.log("[GATEWAY] Agent published to global registry:", agentId);
      } catch (registryError) {
        console.error("[GATEWAY] Failed to publish to registry:", registryError.message);
      }

      res.json({ message: "registered", agentId });
    } catch (error) { 
      res.status(500).json({ error: error.message }); 
    }
  });

  app.post("/v1/agents/:agentId/challenge", async (req, res) => {
    try {
      const agent = await store.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "agent_not_found" });
      const challenge = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); 
      await store.setAgentChallenge(req.params.agentId, challenge, expiresAt);
      res.json({ challenge });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post("/v1/agents/prove", async (req, res) => {
    try {
      const { agentId, signature } = req.body;
      if (!agentId || !signature) return res.status(400).json({ error: "agentId and signature are required" });
      const agent = await store.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: "agent_not_found" });
      if (!agent.challenge) return res.status(400).json({ error: "no_pending_challenge" });
      if (agent.challenge_expires && new Date(agent.challenge_expires) < new Date()) {
        await store.clearAgentChallenge(agentId);
        return res.status(400).json({ error: "challenge_expired" });
      }
      const signedObject = { purpose: "graas-register", agentId, challenge: agent.challenge };
      let valid = false;
      try { valid = verifyB64(signedObject, signature, agent.publicKey); } catch (_) { valid = false; }
      if (!valid) return res.status(401).json({ error: "invalid_signature" });
      await store.clearAgentChallenge(agentId);
      await store.updateAgentProven(agentId, true);
      console.log("[GATEWAY] Agent proven:", agentId);
      const autoApproval = await store.checkAutoApproval(agentId);
      res.json({ status: "proven", agentId, autoApproval });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  // ── Specific Agent Actions ──
  app.post("/v1/agents/:agentId/stake", async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be positive" });
      const agent = await store.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "agent_not_found" });
      const newStake = await store.addStake(req.params.agentId, amount);
      const autoApproval = await store.checkAutoApproval(req.params.agentId);
      res.json({ agentId: req.params.agentId, newStake, autoApproval });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post("/v1/agents/:agentId/deposit", async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be positive" });
      const agent = await store.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "agent_not_found" });
      const newBalance = await store.deposit(req.params.agentId, amount);
      console.log("[BILLING] " + req.params.agentId + " deposited " + amount + " (new balance: " + newBalance + ")");
      res.json({ agentId: req.params.agentId, newBalance });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get("/v1/agents/:agentId/balance", async (req, res) => {
    try {
      const balance = await store.getBalance(req.params.agentId);
      if (balance === null) return res.status(404).json({ error: "agent_not_found" });
      res.json({ agentId: req.params.agentId, balance });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get("/v1/agents/:agentId/transactions", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const transactions = await store.getTransactions(req.params.agentId, limit);
      res.json({ agentId: req.params.agentId, transactions });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  // ══════════════════════════════════════════════════════════
  // ⚠️ CRITICAL: Collection routes MUST come BEFORE /:agentId
  // ══════════════════════════════════════════════════════════
  app.get("/v1/agents/leaderboard", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const leaderboard = await store.getLeaderboard(limit);
      res.json({ leaderboard });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post("/v1/agents/discover", async (req, res) => {
    try {
      const { capability, maxResults = 5 } = req.body;
      if (!capability) return res.status(400).json({ error: "capability is required" });
      const allAgents = await store.getAllAgents();
      const matches = allAgents.filter(agent => agent.status === 'active' && agent.capabilities.includes(capability));
      res.json({ capability, agents: matches.slice(0, maxResults).map(a => ({ agentId: a.agentId, endpoint: a.endpoint, capabilities: a.capabilities, proven: a.proven, reputation: a.reputation, stake: a.stake })), totalMatches: matches.length });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  // 🌐 NEW: Global Agent Discovery (Queries the Registry)
  app.get("/v1/agents/global", async (req, res) => {
    try {
      const { capability, limit = 50 } = req.query;
      const url = new URL(`${REGISTRY_URL}/registry/agents`);
      if (capability) url.searchParams.append('capability', capability);
      url.searchParams.append('limit', limit);

      const response = await fetch(url.toString());
      const data = await response.json();
      
      // 🛡️ FILTER OUT INFRASTRUCTURE ACCOUNTS FROM GLOBAL VIEW (Pure JS)
      const filteredAgents = (data.agents || []).filter(
        (a) => a.agentId !== 'olang-kernel' && a.agentId !== 'graas-platform'
      );

      res.json({ ...data, agents: filteredAgents, total: filteredAgents.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Catch-All Agent Route (MUST BE ABSOLUTELY LAST of /v1/agents) ──
  app.get("/v1/agents/:agentId", async (req, res) => {
    try {
      const agent = await store.getAgent(req.params.agentId);
      if (!agent) return res.status(404).json({ error: "agent_not_found" });
      res.json({ 
        agentId: agent.agentId, proven: agent.proven, status: agent.status, 
        capabilities: agent.capabilities, stake: agent.stake, reputation: agent.reputation,
        balance: agent.balance || 0,
        totalExecutions: agent.totalExecutions, failedExecutions: agent.failedExecutions
      });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  // ── Admin & Delegation ──
  app.post("/v1/admin/agents/:agentId/approve", async (req, res) => {
    if (req.headers["x-admin-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
    try {
      await store.approveAgent(req.params.agentId);
      res.json({ status: "approved", agentId: req.params.agentId });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get("/v1/admin/revenue", async (req, res) => {
    if (req.headers["x-admin-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });
    try {
      const revenue = await store.getPlatformRevenue();
      res.json({ platformRevenue: revenue });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post("/v1/delegate", async (req, res) => {
    try {
      const { fromAgent, toCapability, payload, executionId, delegationDepth = 0, budget = 5.0, targetAgentId } = req.body;
      if (delegationDepth >= 3) return res.status(400).json({ error: "max_delegation_depth_exceeded" });
      if (budget <= 0) return res.status(400).json({ error: "delegation_budget_exhausted" });

      const requestingAgent = await store.getAgent(fromAgent);
      if (!requestingAgent || requestingAgent.status !== 'active') return res.status(403).json({ error: "requesting_agent_not_active" });

      const currentBalance = requestingAgent.balance || 0;
      if (currentBalance < budget) {
        return res.status(402).json({ error: "insufficient_balance", detail: "Agent " + fromAgent + " has " + currentBalance + " but needs " + budget });
      }

      let targetAgent = null;

      // 🌐 NEW: If a specific targetAgentId is provided, check local first, then global registry
      if (targetAgentId) {
        const localAgent = await store.getAgent(targetAgentId);
        if (localAgent && localAgent.status === 'active') {
          targetAgent = localAgent;
        } else {
          try {
            const regRes = await fetch(`${REGISTRY_URL}/registry/agents?limit=200`);
            const regData = await regRes.json();
            const globalAgent = regData.agents.find(a => a.agentId === targetAgentId);
            if (globalAgent && globalAgent.endpoint) {
              targetAgent = {
                agentId: globalAgent.agentId,
                endpoint: globalAgent.endpoint,
                capabilities: globalAgent.capabilities,
                reputation: globalAgent.reputation,
                status: 'active',
                isGlobal: true,
                homePlatform: globalAgent.homePlatform
              };
            }
          } catch (e) {
            console.error("[GATEWAY] Failed to query global registry:", e.message);
          }
        }
      } 
      
      // Fallback: Capability-based discovery (Local agents only for auto-routing)
      if (!targetAgent) {
        const allAgents = await store.getAllAgents();
        const candidates = allAgents.filter(agent => agent.status === 'active' && agent.capabilities.includes(toCapability) && agent.agentId !== fromAgent).sort((a, b) => (b.reputation || 0) - (a.reputation || 0));
        targetAgent = candidates[0];
      }

      if (!targetAgent) return res.status(404).json({ error: "no_agent_available" });

      await store.lockEscrow(fromAgent, budget, executionId);
      console.log("[BILLING] Locked " + budget + " from " + fromAgent + " in escrow for " + executionId);

      let agentResponse;
      try {
        agentResponse = await fetch(targetAgent.endpoint + "/invoke", {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-graas-secret': INTERNAL_SECRET },
          body: JSON.stringify({ capability: toCapability, payload, executionId, prevHash: req.body.prevHash || "0000", delegationContext: { fromAgent, depth: delegationDepth + 1, remainingBudget: budget - 0.05 } })
        });
      } catch (fetchErr) {
        await store.refundEscrow(fromAgent, budget, executionId);
        if (!targetAgent.isGlobal) await store.recordExecution(targetAgent.agentId, false, 100);
        return res.status(500).json({ error: "target_agent_unreachable: " + fetchErr.message });
      }

      if (!agentResponse.ok) {
        await store.refundEscrow(fromAgent, budget, executionId);
        if (!targetAgent.isGlobal) await store.recordExecution(targetAgent.agentId, false, 100);
        return res.status(agentResponse.status).json({ error: "delegated_agent_error: " + await agentResponse.text() });
      }

      const agentResult = await agentResponse.json();
      const validationResult = await validator.validate({ capability: toCapability, input: payload, output: agentResult.result, agentId: targetAgent.agentId, confidence: agentResult.result?.confidence, evidence: agentResult.result?.evidence });

      if (!targetAgent.isGlobal) await store.recordExecution(targetAgent.agentId, validationResult.passed, validationResult.hallucinationScore);

      let billingResult = null;
      if (validationResult.passed) {
        billingResult = await store.releasePayment(fromAgent, targetAgent.agentId, budget, executionId, PLATFORM_FEE_PERCENT);
        console.log("[BILLING] Paid " + targetAgent.agentId + " " + billingResult.payout + " (fee: " + billingResult.fee + ")");
      } else {
        await store.refundEscrow(fromAgent, budget, executionId);
        if (!targetAgent.isGlobal) await store.slashStake(targetAgent.agentId, 50);
        console.log("[BILLING] Refunded " + fromAgent + " (hallucination detected)");
      }

      res.json({ 
        delegatedTo: targetAgent.agentId, 
        capability: toCapability, 
        result: agentResult.result, 
        step: agentResult.step, 
        hallucinationValidation: validationResult,
        isGlobalAgent: !!targetAgent.isGlobal,
        homePlatform: targetAgent.homePlatform || "local",
        billing: billingResult ? { budget, payout: billingResult.payout, platformFee: billingResult.fee, status: "paid" } : { budget, refunded: budget, status: "refunded" }
      });
    } catch (error) { 
      console.error("[GATEWAY] Delegation error:", error.message); 
      res.status(500).json({ error: error.message }); 
    }
  });

  app.post("/invoke", async (req, res) => {
    try {
      const { agentId, capability, payload, executionId, prevHash } = req.body;
      const agent = await store.getAgent(agentId);
      if (!agent || agent.status !== "active") return res.status(404).json({ error: "agent_not_active: " + agentId });
      const agentResponse = await fetch(agent.endpoint + "/invoke", {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-graas-secret': INTERNAL_SECRET },
        body: JSON.stringify({ capability, payload, executionId, prevHash })
      });
      if (!agentResponse.ok) {
        await store.recordExecution(agentId, false, 100);
        return res.status(agentResponse.status).json({ error: "agent_error: " + await agentResponse.text() });
      }
      const agentResult = await agentResponse.json();
      const validationResult = await validator.validate({ capability, input: payload, output: agentResult.result, agentId, confidence: agentResult.result?.confidence, evidence: agentResult.result?.evidence });
      await store.recordExecution(agentId, validationResult.passed, validationResult.hallucinationScore);
      if (validationResult.hallucinationScore > 50) await store.slashStake(agentId, 50);
      res.json({ ...agentResult, hallucinationValidation: validationResult });
    } catch (error) { 
      console.error("[GATEWAY] Invocation proxy error:", error.message); 
      res.status(500).json({ error: error.message }); 
    }
  });

  app.listen(PORT, () => {
    console.log("[gateway] listening on :" + PORT + " (policy 1.5.0 with micro-billing & global registry)");
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
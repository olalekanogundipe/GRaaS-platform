// src/server.js
console.log('[SERVER] 1. Starting server.js...');

import express from "express";
console.log('[SERVER] 2. Express imported');

import { store } from "./store.js";
console.log('[SERVER] 3. Store imported');

import { createExecution, verifyExecution, createContract } from "./core.js";
console.log('[SERVER] 4. Core imported');

const app = express();
app.use(express.json());
console.log('[SERVER] 5. Express app configured');

// --- 🆕 Dynamic Agent Registration (Zero Hardcoding) ---
app.post("/register-agent", (req, res) => {
  const { agentId, endpoint, pubkey, capabilities } = req.body;
  if (!agentId || !endpoint || !pubkey) {
    return res.status(400).json({ error: "agentId, endpoint, and pubkey are required" });
  }
  
  // SSRF Protection: Only allow localhost or HTTPS endpoints
  if (!endpoint.startsWith('http://localhost') && !endpoint.startsWith('https://')) {
     return res.status(400).json({ error: "Invalid endpoint. Must be localhost or HTTPS." });
  }

  // Store agent with its declared capabilities for dynamic resolution
  store.saveAgent(agentId, endpoint, pubkey, capabilities || []);
  res.json({ status: "REGISTERED", agentId, capabilities: capabilities || [] });
});

// --- Setup / Seed Endpoints (Capability-Based & Multi-Layer Billing) ---
app.post("/seed/contract", async (req, res) => {
  try {
    const {
      contractId,
      providerId,
      name,
      requiredCapabilities,
      permittedActions,
      prohibitedActions,
      pricePerResult,
      commissionRate,
      agentId
    } = req.body;

    // 1. Validate required fields
    if (!contractId || !providerId || !name) {
      return res.status(400).json({
        error: 'missing_fields',
        detail: 'contractId, providerId, and name are required'
      });
    }

    // 2. Validate capabilities
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length === 0) {
      return res.status(400).json({
        error: 'invalid_capabilities',
        detail: 'requiredCapabilities must be a non-empty array'
      });
    }

    // 3. Validate pricing
    if (!pricePerResult || pricePerResult <= 0) {
      return res.status(400).json({
        error: 'invalid_pricing',
        detail: 'pricePerResult must be a positive number (in cents)'
      });
    }

    // 4. Create the contract via core logic
    const contract = await createContract({
      contractId,
      providerId,
      name,
      requiredCapabilities,
      permittedActions: permittedActions || [],
      prohibitedActions: prohibitedActions || [],
      pricePerResult,
      commissionRate: commissionRate || 0.20, // Default 20% platform commission
      agentId,
      billingEnabled: true
    });

    res.json({ status: "SEEDED", contract });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- GRaaS Endpoints ---
app.post("/executions", async (req, res) => {
  try {
    const { contractId, inputs } = req.body;
    const execution = await createExecution(contractId, inputs);
    res.status(201).json(execution);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/executions/:id/verify", async (req, res) => {
  try {
    const execution = await verifyExecution(req.params.id);
    res.json(execution);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/certificates/:id", (req, res) => {
  const cert = store.getCertificate(req.params.id);
  if (!cert) return res.status(404).json({ error: "Certificate not found" });
  res.json(cert);
});

// --- 🆕 Updated Metering with Multi-Layer Billing Math ---
app.get("/meter", (req, res) => {
  const meters = store.getAllMeters();
  const billing = [];
  
  for (const [providerId, contracts] of Object.entries(meters)) {
    for (const [contractId, count] of Object.entries(contracts)) {
      const contract = store.getContract(contractId);
      const price = contract ? contract.pricePerResult : 0;
      const commissionRate = contract ? (contract.commissionRate || 0.20) : 0.20;
      
      const totalAmount = count * price;
      const platformCommission = Math.round(totalAmount * commissionRate);
      const providerNetRevenue = totalAmount - platformCommission;

      billing.push({
        providerId,
        contractId,
        verifiedResults: count,
        unitPrice: price,
        commissionRate: `${(commissionRate * 100).toFixed(0)}%`,
        totalAmount,
        platformCommission,
        providerNetRevenue
      });
    }
  }
  res.json({ meters, billing });
});

const PORT = process.env.PORT || 3000;
console.log(`[SERVER] 6. Attempting to listen on port ${PORT}...`);

app.listen(PORT, () => {
  console.log(`✅ GRaaS Platform MVP v0.2 running on port ${PORT}`);
});
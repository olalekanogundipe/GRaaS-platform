// src/store.js
import db from './db.js'; // Attempts to import your SQLite setup

const inMemory = {
  agents: new Map(),
  contracts: new Map(),
  executions: new Map(),
  certificates: new Map(),
  meters: new Map() // providerId -> Map(contractId -> count)
};

let useDb = false;
try {
  // Test if db is available and initialize tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY, 
      endpoint TEXT, 
      pubkey TEXT
    );
    CREATE TABLE IF NOT EXISTS contracts (
      contract_id TEXT PRIMARY KEY, 
      provider_id TEXT, 
      name TEXT, 
      permitted_actions TEXT, 
      prohibited_actions TEXT, 
      price_per_result INTEGER, 
      agent_id TEXT
    );
    CREATE TABLE IF NOT EXISTS executions (
      execution_id TEXT PRIMARY KEY, 
      contract_id TEXT, 
      provider_id TEXT, 
      inputs TEXT, 
      workflow_name TEXT, 
      olang_evidence TEXT, 
      business_result TEXT, 
      status TEXT, 
      error TEXT, 
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS certificates (
      certificate_id TEXT PRIMARY KEY, 
      execution_id TEXT, 
      contract_id TEXT, 
      provider_id TEXT, 
      status TEXT, 
      result_hash TEXT, 
      chain_root TEXT, 
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meters (
      provider_id TEXT, 
      contract_id TEXT, 
      count INTEGER, 
      PRIMARY KEY (provider_id, contract_id)
    );
  `);
  useDb = true;
  console.log('[STORE] ✅ Using SQLite database for persistence.');
} catch (e) {
  console.log('[STORE] ⚠️ SQLite not available or failed to initialize. Falling back to in-memory store.');
  useDb = false;
}

export const store = {
  // ==========================================
  // AGENTS (Dynamic Registration)
  // ==========================================
  saveAgent(agentId, endpoint, pubkey) {
    if (useDb) {
      db.prepare('INSERT OR REPLACE INTO agents (agent_id, endpoint, pubkey) VALUES (?, ?, ?)').run(agentId, endpoint, pubkey);
    } else {
      inMemory.agents.set(agentId, { agentId, endpoint, pubkey });
    }
  },
  getAgent(agentId) {
    if (useDb) {
      return db.prepare('SELECT agent_id AS agentId, endpoint, pubkey FROM agents WHERE agent_id = ?').get(agentId) || null;
    }
    return inMemory.agents.get(agentId) || null;
  },

  // ==========================================
  // CONTRACTS
  // ==========================================
  saveContract(contract) {
    if (useDb) {
      db.prepare(`
        INSERT OR REPLACE INTO contracts (contract_id, provider_id, name, permitted_actions, prohibited_actions, price_per_result, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        contract.contractId,
        contract.providerId,
        contract.name,
        JSON.stringify(contract.permittedActions || []),
        JSON.stringify(contract.prohibitedActions || []),
        contract.pricePerResult || 0,
        contract.agentId || null
      );
    } else {
      inMemory.contracts.set(contract.contractId, contract);
    }
  },
  getContract(contractId) {
    if (useDb) {
      const row = db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(contractId);
      if (!row) return null;
      return {
        contractId: row.contract_id,
        providerId: row.provider_id,
        name: row.name,
        permittedActions: JSON.parse(row.permitted_actions || '[]'),
        prohibitedActions: JSON.parse(row.prohibited_actions || '[]'),
        pricePerResult: row.price_per_result,
        agentId: row.agent_id
      };
    }
    return inMemory.contracts.get(contractId) || null;
  },

  // ==========================================
  // EXECUTIONS
  // ==========================================
  saveExecution(execution) {
    if (useDb) {
      db.prepare(`
        INSERT OR REPLACE INTO executions (execution_id, contract_id, provider_id, inputs, workflow_name, olang_evidence, business_result, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        execution.executionId,
        execution.contractId,
        execution.providerId,
        JSON.stringify(execution.inputs),
        execution.workflowName,
        JSON.stringify(execution.olangEvidence),
        JSON.stringify(execution.businessResult),
        execution.status,
        execution.error || null,
        execution.createdAt
      );
    } else {
      inMemory.executions.set(execution.executionId, execution);
    }
  },
  getExecution(executionId) {
    if (useDb) {
      const row = db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId);
      if (!row) return null;
      return {
        executionId: row.execution_id,
        contractId: row.contract_id,
        providerId: row.provider_id,
        inputs: JSON.parse(row.inputs),
        workflowName: row.workflow_name,
        olangEvidence: JSON.parse(row.olang_evidence),
        businessResult: JSON.parse(row.business_result),
        status: row.status,
        error: row.error,
        createdAt: row.created_at
      };
    }
    return inMemory.executions.get(executionId) || null;
  },

  // ==========================================
  // CERTIFICATES
  // ==========================================
  saveCertificate(certificate) {
    if (useDb) {
      db.prepare(`
        INSERT OR REPLACE INTO certificates (certificate_id, execution_id, contract_id, provider_id, status, result_hash, chain_root, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        certificate.certificateId,
        certificate.executionId,
        certificate.contractId,
        certificate.providerId,
        certificate.status,
        certificate.resultHash,
        certificate.chainRoot,
        certificate.createdAt
      );
    } else {
      inMemory.certificates.set(certificate.certificateId, certificate);
    }
  },
  getCertificate(certificateId) {
    if (useDb) {
      const row = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(certificateId);
      if (!row) return null;
      return {
        certificateId: row.certificate_id,
        executionId: row.execution_id,
        contractId: row.contract_id,
        providerId: row.provider_id,
        status: row.status,
        resultHash: row.result_hash,
        chainRoot: row.chain_root,
        createdAt: row.created_at
      };
    }
    return inMemory.certificates.get(certificateId) || null;
  },

  // ==========================================
  // METERS (Billing)
  // ==========================================
  incrementMeter(providerId, contractId) {
    if (useDb) {
      db.prepare(`
        INSERT INTO meters (provider_id, contract_id, count) VALUES (?, ?, 1)
        ON CONFLICT(provider_id, contract_id) DO UPDATE SET count = count + 1
      `).run(providerId, contractId);
    } else {
      if (!inMemory.meters.has(providerId)) {
        inMemory.meters.set(providerId, new Map());
      }
      const providerMeters = inMemory.meters.get(providerId);
      providerMeters.set(contractId, (providerMeters.get(contractId) || 0) + 1);
    }
  },
  getAllMeters() {
    if (useDb) {
      const rows = db.prepare('SELECT provider_id, contract_id, count FROM meters').all();
      const meters = {};
      for (const row of rows) {
        if (!meters[row.provider_id]) meters[row.provider_id] = {};
        meters[row.provider_id][row.contract_id] = row.count;
      }
      return meters;
    }
    const meters = {};
    for (const [providerId, contracts] of inMemory.meters.entries()) {
      meters[providerId] = Object.fromEntries(contracts.entries());
    }
    return meters;
  }
};
// src/olang.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { execute } from "./olang-kernel/src/runtime/index.js";
import { parse } from "./olang-kernel/src/parser/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[O-LANG] 🚀 Initializing GRaaS Governance Layer...');

const CHAIN = [];
const resolverMap = {
  'db': () => import("./resolvers/db/index.js").then(m => m.default),
};

const loadResolver = async (name, requireFn) => {
  try {
    const mod = await requireFn(); 
    const fn = typeof mod === 'function' ? mod : (typeof mod.default === 'function' ? mod.default : null);
    
    if (fn) {
      CHAIN.push(fn);
      console.log(`[O-LANG] ✅ Loaded resolver: ${fn.resolverName || name} (v${fn.version || '1.0.0'})`);
      return true;
    }
  } catch (err) {
    console.warn(`[O-LANG] ⚠️ Could not load ${name}: ${err.message}`);
  }
  return false;
};

await loadResolver('db', resolverMap['db']);

CHAIN.forEach(r => {
  const raw = r.resolverName || r.name || '';
  if (raw.includes('/')) {
    r.resolverName = raw.replace(/^@[a-z0-9-]+\//i, '').toLowerCase().trim();
  }
  if (Array.isArray(r.capabilities)) {
    r.capabilities = r.capabilities.map(c => c.replace(/^@[a-z0-9-]+\//i, '').toLowerCase().trim());
  }
});

const DEFAULT_INTENT = {
  scope: 'general',
  allowed_capabilities: ['general_query', 'information'],
  prohibited_actions: ['auto_approve', 'auto_delete', 'execute_shell', 'modify_system_config'],
  prohibited_topics: ['credentials', 'passwords', 'system_keys'],
  contextual_allowlist: []
};

const getIntentProfile = (workflowName, contract = {}) => {
  if (contract && (contract.prohibitedActions || contract.permittedActions)) {
    return {
      ...DEFAULT_INTENT,
      scope: contract.scope || 'financial_processing',
      allowed_capabilities: contract.permittedActions || contract.allowedResolvers || DEFAULT_INTENT.allowed_capabilities,
      prohibited_actions: [...DEFAULT_INTENT.prohibited_actions, ...(contract.prohibitedActions || [])],
      contextual_allowlist: contract.contextualAllowlist || DEFAULT_INTENT.contextual_allowlist
    };
  }
  return { ...DEFAULT_INTENT, scope: 'local_execution', allowed_capabilities: ['general_query', 'information', 'db'] };
};

function loadWorkflow(file) {
  const filePath = path.resolve(__dirname, "workflows", file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[O-LANG] ⚠️ Workflow not found: ${filePath}`);
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const workflow = parse(content, filePath);
    console.log(`[O-LANG] ✅ Loaded workflow: ${workflow.name} (${workflow.steps?.length || 0} steps)`);
    return workflow;
  } catch (err) {
    console.error(`[O-LANG] ❌ Parse error ${file}:`, err.message);
    return null;
  }
}

console.log("\n[O-LANG] Loading GRaaS workflows...");
const WORKFLOWS = {
  "claim-v1": loadWorkflow("claim-v1.ol"),
  "claim-kernel-v1": loadWorkflow("claim-kernel-v1.ol")
};
console.log("[O-LANG] Workflows loaded.\n");

function filterChain(workflow) {
  const resolverList = workflow?.allowedResolvers || workflow?.allow;
  if (!resolverList || resolverList.length === 0) return CHAIN;
  
  const allowed = resolverList.map(a => {
    let name = a;
    if (name.includes('/')) name = name.replace(/^@[a-z0-9-]+\//i, '');
    return name.toLowerCase().trim();
  });

  return CHAIN.filter(r => {
    const rName = (r.resolverName || r.name || '').toLowerCase().trim();
    return allowed.includes(rName);
  });
}

export async function runWorkflow(workflowName, inputs = {}, options = {}) {
  const wf = WORKFLOWS[workflowName];
  if (!wf) throw new Error(`Workflow "${workflowName}" not found`);

  // 1. Refuse the removed options
  if (options.agentEndpoint || options.trustedPubkey || options.externalManifest) {
    throw new Error("Governance Violation: Deprecated options used. Must use _chain.");
  }

  console.log(`[O-LANG] 🚀 Executing: ${workflowName}`);
  
  try {
    const intentProfile = getIntentProfile(workflowName, options.contract);
    const contextWithIntent = { ...inputs, __verified_intent: intentProfile };

    // 2. Put ...options BEFORE the fixed fields
    // ✅ CRITICAL FIX: Merge local resolvers with external chain from core.js
    // This ensures 'db' is still available for local steps, while 'node-fraud-checker' is added for gateway routing
    const chain = options._chain ? [...filterChain(wf), ...options._chain] : filterChain(wf);
    
    // ✅ CRITICAL FIX: Attach graas config directly to the chain array.
    // The patched kernel's index.js assigns the _chain array to `agentResolver`,
    // and graasBridge.cjs looks for `agentResolver.graas` to initialize the session.
    if (options.graas) {
      chain.graas = options.graas;
    }

    const executeOptions = {
      ...options,
      _chain: chain,
      intentProfile,
    };
    
    const kernelResult = await execute(wf, contextWithIntent, executeOptions);
    console.log(`[O-LANG] ✅ Completed: ${workflowName}`);
    
    // 3. Return result: business with the __audit field stripped
    const rawResult = kernelResult.result || kernelResult.output || {};
    const { __audit, ...business } = rawResult;
    
    return {
      result: business,
      evidence: kernelResult.evidence || __audit || {}
    };
    
  } catch (error) {
    console.error(`[O-LANG] ❌ Failed: ${workflowName}`, error.message);
    throw error;
  }
}

export default {
  runWorkflow,
  getWorkflow: (name) => WORKFLOWS[name],
  filterChain,
  getResolvers: () => CHAIN.map(r => r.resolverName),
  getIntentProfile
};
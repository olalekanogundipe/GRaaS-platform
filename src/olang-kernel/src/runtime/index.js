const { RuntimeAPI } = require('./RuntimeAPI');
const { parse }      = require('../parser');
const crypto         = require('crypto');
const fs             = require('fs');
const path           = require('path');

// ðŸ›¡ï¸ GRaaS Bridge Integration: Installs secure gateway-mediated delegation,
// local resolver governance, and execution anchoring/finalization.
// This replaces all manual fetch calls with cryptographically verified gateway routing.
require('./graasBridge.cjs').install(RuntimeAPI);

// â”€â”€ Load kernel private key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _loadPrivateKey() {
  if (process.env.KERNEL_PRIVATE_KEY) {
    const key = process.env.KERNEL_PRIVATE_KEY.replace(/\\n/g, '\n');
    console.log('[kernel] âœ… Private key loaded from environment variable');
    return key;
  }

  const keyPath      = process.env.KERNEL_PRIVATE_KEY_PATH || './kernel-keys/kernel-private.pem';
  const absolutePath = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);

  if (!fs.existsSync(absolutePath)) {
    console.warn('[kernel] âš ï¸ Private key not found in env or at', absolutePath);
    console.warn('[kernel] Audit entries will NOT be signed');
    return null;
  }

  const key = fs.readFileSync(absolutePath, 'utf8');
  console.log('[kernel] âœ… Private key loaded from local file');
  return key;
}

const KERNEL_PRIVATE_KEY = _loadPrivateKey();

function _loadPublicKey() {
  if (!KERNEL_PRIVATE_KEY) return null;
  
  try {
    if (process.env.KERNEL_PUBLIC_KEY) {
      console.log('[kernel] âœ… Public key loaded from environment variable');
      const rawKey = process.env.KERNEL_PUBLIC_KEY.replace(/\\n/g, '\n');
      return rawKey.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\s/g, '');
    }

    const pubKeyPath      = process.env.KERNEL_PUBLIC_KEY_PATH || './kernel-keys/kernel-public.pem';
    const absolutePubPath = path.isAbsolute(pubKeyPath) ? pubKeyPath : path.join(process.cwd(), pubKeyPath);

    let pubKeyPem;
    if (fs.existsSync(absolutePubPath)) {
      pubKeyPem = fs.readFileSync(absolutePubPath, 'utf8');
    } else {
      console.log('[kernel] â„¹ï¸ Public key file/env not found. Deriving from private key...');
      const pubKeyObject = crypto.createPublicKey(KERNEL_PRIVATE_KEY);
      pubKeyPem = pubKeyObject.export({ type: 'spki', format: 'pem' });
    }

    return pubKeyPem.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\s/g, '');
  } catch (err) {
    console.warn('[kernel] âš ï¸ Could not load/derive public key:', err.message);
    return null;
  }
}

const KERNEL_PUBLIC_KEY = _loadPublicKey();

// â”€â”€ Sign audit data with RSA-SHA256 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function signAuditData(auditData, privateKeyPem) {
  if (!privateKeyPem) return null;
  try {
    const serialized = JSON.stringify(auditData, Object.keys(auditData).sort());
    const sign = crypto.createSign('SHA256');
    sign.update(serialized);
    sign.end();
    return sign.sign(privateKeyPem, 'hex');
  } catch (err) {
    console.error('[kernel] âŒ Signature error:', err.message);
    return null;
  }
}

// â”€â”€ Main execute function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function execute(workflow, inputs, agentResolverOrOptions, verbose = false) {
  let agentResolver = agentResolverOrOptions;
  let redisClient = null;
  
  if (agentResolverOrOptions && typeof agentResolverOrOptions === 'object' && !Array.isArray(agentResolverOrOptions)) {
    agentResolver = agentResolverOrOptions._chain || agentResolverOrOptions;
    redisClient = agentResolverOrOptions.redisClient || null;
    verbose = agentResolverOrOptions.verbose || verbose;
  }
  
  const rt = new RuntimeAPI({ verbose, redisClient });

  // ðŸ›¡ï¸ The heavy lifting of GRaaS session management, anchoring, and secure 
  // delegation is now handled entirely by the installed graasBridge.cjs 
  // inside rt.executeWorkflow. No manual fetch calls are needed or allowed.
  const result = await rt.executeWorkflow(workflow, inputs, agentResolver);

  const lastEntry  = rt.auditLog.at(-1);

  // ðŸ› ï¸ Calculate Dual-Hashes
  const lockedData = {};
  for (const [key, value] of Object.entries(rt.context || {})) {
    if (value && typeof value === 'object' && value.__locked === true) {
      const cleanValue = { ...value };
      delete cleanValue.__locked; 
      lockedData[key] = cleanValue;
    }
  }
  
  const stableSerialize = (obj) => {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stableSerialize);
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const k of sortedKeys) sortedObj[k] = stableSerialize(obj[k]);
    return sortedObj;
  };

  const hashFn = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const dataHash = hashFn(stableSerialize(lockedData));
  
  const narrativeText = result.response || rt.context?.response || '';
  const narrativeHash = hashFn(narrativeText);

  const workflowName = typeof workflow === 'string' 
    ? workflow 
    : (workflow?.name || workflow?.workflowName || 'unknown');
    
  const kernelTimestamp = new Date().toISOString();
  
  const compactAuditData = {
    execution_hash: lastEntry?.hash ?? null,
    merkle_root: rt._calculateMerkleRoot() ?? null,
    data_hash: dataHash ?? null,
    narrative_hash: narrativeHash ?? null,
    steps_executed: typeof (rt.auditLog?.length) === 'number' ? rt.auditLog.length : 0,
    workflow: workflowName,
    timestamp: kernelTimestamp
  };

  const signature = signAuditData(compactAuditData, KERNEL_PRIVATE_KEY);

  // Merge the kernel's native audit data with the GRaaS bundle (if the bridge was used)
  result.__audit = {
    ...(result.__audit || {}), 
    executionId: result.__audit?.graas?.certificate?.executionId || `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    executionHash: compactAuditData.execution_hash,
    merkleRoot: compactAuditData.merkle_root,
    stepsExecuted: compactAuditData.steps_executed,
    durationMs: rt.startTime ? (Date.now() - rt.startTime) : 0,
    dataHash: dataHash,
    narrativeHash: narrativeHash,
    deterministic: true,
    workflowName: workflowName, 
    signature: signature,
    publicKey: KERNEL_PUBLIC_KEY,
    timestamp: kernelTimestamp 
  };

  return result;
}

// â”€â”€ Standalone PII redaction helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function redact(text) {
  const rt = new RuntimeAPI({ verbose: false });
  return rt.redact(text);
}

module.exports = { execute, parse, redact, RuntimeAPI };




// // src/runtime/index.js
// const { RuntimeAPI } = require('./RuntimeAPI');
// const { parse }      = require('../parser');
// const crypto         = require('crypto');
// const fs             = require('fs');
// const path           = require('path');

// // â”€â”€ Load kernel private key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// function _loadPrivateKey() {
//   const keyPath      = process.env.KERNEL_PRIVATE_KEY_PATH || './kernel-keys/kernel-private.pem';
//   const absolutePath = path.isAbsolute(keyPath)
//     ? keyPath
//     : path.join(process.cwd(), keyPath);

//   if (!fs.existsSync(absolutePath)) {
//     console.warn('[kernel] Warning: Private key not found at', absolutePath);
//     console.warn('[kernel] Audit entries will NOT be signed');
//     return null;
//   }

//   const key = fs.readFileSync(absolutePath, 'utf8');
//   console.log('[kernel] âœ… Private key loaded for signing');
//   return key;
// }

// const KERNEL_PRIVATE_KEY = _loadPrivateKey();

// function _loadPublicKey() {
//   if (!KERNEL_PRIVATE_KEY) return null;
  
//   try {
//     const pubKeyPath      = process.env.KERNEL_PUBLIC_KEY_PATH || './kernel-keys/kernel-public.pem';
//     const absolutePubPath = path.isAbsolute(pubKeyPath)
//       ? pubKeyPath
//       : path.join(process.cwd(), pubKeyPath);

//     let pubKeyPem;

//     if (fs.existsSync(absolutePubPath)) {
//       // Read from file if it exists
//       pubKeyPem = fs.readFileSync(absolutePubPath, 'utf8');
//     } else {
//       // ðŸ›¡ï¸ BULLETPROOF FIX: If the public key file is missing, derive it from the private key!
//       console.log('[kernel] â„¹ï¸ Public key file not found. Deriving from private key...');
//       const pubKeyObject = crypto.createPublicKey(KERNEL_PRIVATE_KEY);
//       pubKeyPem = pubKeyObject.export({ type: 'spki', format: 'pem' });
//     }

//     // Strip headers and whitespace for clean DB storage
//     return pubKeyPem
//       .replace('-----BEGIN PUBLIC KEY-----', '')
//       .replace('-----END PUBLIC KEY-----', '')
//       .replace(/\s/g, '');
      
//   } catch (err) {
//     console.warn('[kernel] Could not load/derive public key:', err.message);
//     return null;
//   }
// }

// const KERNEL_PUBLIC_KEY = _loadPublicKey();

// // â”€â”€ Sign audit data with RSA-SHA256 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// function signAuditData(auditData, privateKeyPem) {
//   if (!privateKeyPem) return null;

//   try {
//     // Serialize with sorted keys
//     const serialized = JSON.stringify(auditData, Object.keys(auditData).sort());
    
//     // ðŸ•µï¸â€â™‚ï¸ DIAGNOSTIC LOG: Compare this with the Controller's log
//     console.log('\nðŸ” [KERNEL SIGNATURE PAYLOAD]:', serialized);

//     const sign = crypto.createSign('SHA256');
//     sign.update(serialized);
//     sign.end();

//     return sign.sign(privateKeyPem, 'hex');
//   } catch (err) {
//     console.error('[kernel] Signature error:', err.message);
//     return null;
//   }
// }

// // â”€â”€ Main execute function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// async function execute(workflow, inputs, agentResolverOrOptions, verbose = false) {
//   let agentResolver = agentResolverOrOptions;
//   let redisClient = null;
  
//   if (agentResolverOrOptions && typeof agentResolverOrOptions === 'object' && !Array.isArray(agentResolverOrOptions)) {
//     agentResolver = agentResolverOrOptions._chain || agentResolverOrOptions;
//     redisClient = agentResolverOrOptions.redisClient || null;
//     verbose = agentResolverOrOptions.verbose || verbose;
//   }
  
//   const rt = new RuntimeAPI({ verbose, redisClient });

//   // Run the workflow
//   const result = await rt.executeWorkflow(workflow, inputs, agentResolver);

//   const lastEntry  = rt.auditLog.at(-1);

//   // ðŸ› ï¸ Calculate Dual-Hashes
//   const lockedData = {};
//   for (const [key, value] of Object.entries(rt.context || {})) {
//     if (value && typeof value === 'object' && value.__locked === true) {
//       const cleanValue = { ...value };
//       delete cleanValue.__locked; 
//       lockedData[key] = cleanValue;
//     }
//   }
  
//   const stableSerialize = (obj) => {
//     if (obj === null || typeof obj !== 'object') return obj;
//     if (Array.isArray(obj)) return obj.map(stableSerialize);
//     const sortedKeys = Object.keys(obj).sort();
//     const sortedObj = {};
//     for (const k of sortedKeys) sortedObj[k] = stableSerialize(obj[k]);
//     return sortedObj;
//   };

//   const hashFn = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
//   const dataHash = hashFn(stableSerialize(lockedData));
  
//   const narrativeText = result.response || rt.context?.response || '';
//   const narrativeHash = hashFn(narrativeText);

//   // ðŸ›¡ï¸ BULLETPROOF COMPACT PAYLOAD
//   // Fix: workflow.name fails if workflow is passed as a string (e.g., 'expense-auditor').
//   // We force string resolution so JSON.stringify never drops the key!
//   const workflowName = typeof workflow === 'string' 
//     ? workflow 
//     : (workflow?.name || workflow?.workflowName || 'unknown');
    
//   const kernelTimestamp = new Date().toISOString();
  
//   const compactAuditData = {
//     execution_hash: lastEntry?.hash ?? null,
//     merkle_root: rt._calculateMerkleRoot() ?? null,
//     data_hash: dataHash ?? null,
//     narrative_hash: narrativeHash ?? null,
//     steps_executed: typeof (rt.auditLog?.length) === 'number' ? rt.auditLog.length : 0,
//     workflow: workflowName,
//     timestamp: kernelTimestamp
//   };

//   // Sign the compact payload
//   const signature = signAuditData(compactAuditData, KERNEL_PRIVATE_KEY);

//   // ðŸ› ï¸ Map to camelCase and attach Dual-Hashes + Signature
//   result.__audit = {
//     executionId: `exec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
//     executionHash: compactAuditData.execution_hash,
//     merkleRoot: compactAuditData.merkle_root,
//     stepsExecuted: compactAuditData.steps_executed,
//     durationMs: rt.startTime ? (Date.now() - rt.startTime) : 0,
//     dataHash: dataHash,
//     narrativeHash: narrativeHash,
//     deterministic: true,
    
//     // âœ… CRITICAL FIX: Pass the exact workflowName string to the controller
//     // so it saves the EXACT string we used to sign the payload!
//     workflowName: workflowName, 
    
//     // The RSA proof
//     signature: signature,
//     publicKey: KERNEL_PUBLIC_KEY,
//     timestamp: kernelTimestamp // CRITICAL: Must be saved to DB for verification
//   };

//   return result;
// }

// // â”€â”€ Standalone PII redaction helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// function redact(text) {
//   const rt = new RuntimeAPI({ verbose: false });
//   return rt.redact(text);
// }

// module.exports = { execute, parse, redact, RuntimeAPI };

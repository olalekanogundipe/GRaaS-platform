// src/resolvers/db/index.js
import { capabilities } from './capability.js';

function isOurs(action) {
  return typeof action === 'string' && 
    (action.startsWith('Action db') || action.startsWith('Ask db'));
}

function parseAction(action) {
  // Parses: Ask db "read_claim" "{claimId}"
  const match = action.match(/^(?:Action|Ask)\s+db\s+"([^"]+)"\s*([\s\S]*)$/i);
  if (!match) {
    throw new Error(`Failed to parse db action: ${action}`);
  }

  const actionName = match[1];
  const rest = match[2];

  const args = {};
  const argRegex = /"([^"]*)"/g;
  let argMatch;
  let index = 0;
  
  while ((argMatch = argRegex.exec(rest)) !== null) {
    if (index === 0) args.claimId = argMatch[1]; 
    if (index === 1) {
      try {
        args.claim_data = JSON.parse(argMatch[1]); 
      } catch (e) {
        args.claim_data = argMatch[1];
      }
    }
    index++;
  }

  return { actionName, args };
}

const dbResolver = async (action, context) => {
  if (!isOurs(action)) return undefined;

  const { actionName, args } = parseAction(action);

  if (capabilities[actionName]) {
    return await capabilities[actionName](args);
  } else {
    throw new Error(`Unknown db capability: ${actionName}`);
  }
};

// ─── EXPORTS ────────────────────────────────────────────────────────────
dbResolver.resolverName = 'db';
// ✅ FIX: Added 'flag_for_review' so the kernel's allowlist permits this action
dbResolver.capabilities = ['read_claim', 'validate_fields', 'submit_claim', 'flag_for_review'];
dbResolver.version = '1.0.0';

// GRaaS governance: db actions run inside the kernel, so they are recorded as signed steps by
// olang-kernel (not delegated to another agent). submit_claim is gated: the gateway checks
// the fraud result before authorizing it. validate_fields is a read-only check and is not recorded.
const GOVERNED = new Set(['read_claim', 'submit_claim', 'flag_for_review']);
const capabilityOf = (action) => {
  try {
    const name = parseAction(action).actionName;
    return GOVERNED.has(name) ? name : null;
  } catch { return null; }
};
const claimIdOf = (action, context) => {
  try { return parseAction(action).args.claimId || context?.claimId; } catch { return context?.claimId; }
};
dbResolver.graas = {
  capability: (action) => capabilityOf(action),
  authorize: true, // the gateway only enforces preconditions where the policy defines them (submit_claim)
  input: (action, context) => ({ claimId: claimIdOf(action, context) }),
};

export default dbResolver;
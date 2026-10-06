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

export default dbResolver;
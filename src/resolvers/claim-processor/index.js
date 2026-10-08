import * as capabilities from './capability.js';

function isOurs(action) {
  return typeof action === 'string' &&
    (action.includes('read_claim') || 
     action.includes('fraud_check') || 
     action.includes('submit_claim') || 
     action.includes('flag_for_review'));
}

function parseAction(action) {
  const match = action.match(/^(?:Action|Ask)\s+(\w+)\s+(.*)$/i);
  if (!match) {
    return { actionName: 'unknown', args: [] };
  }

  const actionName = match[1];
  const rest = match[2];

  const args = [];
  const argRegex = /"([^"]*)"/g;
  let argMatch;
  while ((argMatch = argRegex.exec(rest)) !== null) {
    args.push(argMatch[1]);
  }

  return { actionName, args };
}

const claimProcessor = async (action, context) => {
  if (!isOurs(action)) return undefined;

  const { actionName, args } = parseAction(action);
  
  //  SMART EXTRACTION: Find the CLM-xxx ID, or fallback to last arg, or context
  const claimId = args.find(arg => /^CLM-/i.test(arg)) || args[args.length - 1] || context?.inputs?.claimId || 'UNKNOWN';

  try {
    switch (actionName) {
      case 'read_claim':      
        return await capabilities.readClaim(claimId);
        
      case 'fraud_check': {
        // Extract applicant/amount safely, fallback to context or defaults
        const applicant = args.find(arg => !/^CLM-/i.test(arg) && arg.toLowerCase() !== 'execute') || context?.claim_data?.applicant || 'Unknown Applicant';
        const amount = context?.claim_data?.amount || 1000;
        return await capabilities.fraudCheck(claimId, applicant, amount);
      }
        
      case 'submit_claim':    
        return await capabilities.submitClaim(claimId);
        
      case 'flag_for_review': {
        const reason = args.find(arg => arg !== claimId && !/^CLM-/i.test(arg)) || "fraud_flag";
        return await capabilities.flagForReview(claimId, reason);
      }
        
      default:
        console.warn(`[claim-processor] Unknown action: ${actionName}`);
        return undefined;
    }
  } catch (error) {
    console.error(`[claim-processor]  Error executing ${actionName}:`, error.message);
    throw error;
  }
};

claimProcessor.resolverName = 'claim-processor';
claimProcessor.capabilities = ['read_claim', 'fraud_check', 'submit_claim', 'flag_for_review'];
claimProcessor.version = '1.0.0';

export default claimProcessor;
export { capabilities };

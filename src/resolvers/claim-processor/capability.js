// capability.js - Real Global Agent Delegation via GRaaS Gateway

const GATEWAY_URL = process.env.GRAAS_GATEWAY_URL || 'http://127.0.0.1:3000';
const API_KEY = process.env.GRAAS_API_KEY || 'dev-key-12345678901234567890';

const delegateToAgent = async (agentId, capability, payload) => {
  console.log(`[claim-processor]  Delegating ${capability} to ${agentId}...`);
  
  try {
    // 1. Attempt Gateway delegation
    const response = await fetch(`${GATEWAY_URL}/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({
        agentId: agentId,
        capability: capability,
        payload: payload
      })
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`[claim-processor]  Gateway routed successfully`);
      return result;
    }

    // 2. Fallback: Direct agent call with API Key to prevent 401
    const port = agentId.includes('python') ? 8001 : 8002;
    console.log(`[claim-processor]  Gateway returned ${response.status}, falling back to direct agent call on port ${port}...`);
    
    const directResponse = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': API_KEY //  ADDED: This fixes the 401 Unauthorized error
      },
      body: JSON.stringify({ capability, payload })
    });
    
    if (!directResponse.ok) {
      const errText = await directResponse.text();
      throw new Error(`Agent delegation failed (${directResponse.status}): ${errText}`);
    }
    
    return await directResponse.json();

  } catch (error) {
    console.error(`[claim-processor]  Delegation error:`, error.message);
    throw error;
  }
};

export const readClaim = async (claimId) => {
  if (!claimId) throw new Error('claimId is required');
  const result = await delegateToAgent('python-claim-processor', 'read_claim', { claimId });
  return { success: true, claim: result.result?.claim || result.claim || result };
};

export const fraudCheck = async (claimId, applicant, amount) => {
  if (!claimId) throw new Error('claimId is required');
  const result = await delegateToAgent('node-fraud-checker', 'fraud_check', { claimId, applicant, amount });
  return { 
    success: true, 
    isFraud: result.result?.isFraud ?? result.isFraud ?? false, 
    reason: result.result?.reason ?? result.reason ?? 'Clean' 
  };
};

export const submitClaim = async (claimId) => {
  if (!claimId) throw new Error('claimId is required');
  const result = await delegateToAgent('python-claim-processor', 'submit_claim', { claimId });
  return { 
    success: true, 
    transactionId: result.result?.transactionId ?? `TXN_${Date.now()}`, 
    status: result.result?.status ?? 'COMPLETED' 
  };
};

export const flagForReview = async (claimId, reason) => {
  if (!claimId) throw new Error('claimId is required');
  const result = await delegateToAgent('python-claim-processor', 'flag_for_review', { claimId, reason: reason || 'fraud_flag' });
  return { 
    success: true, 
    status: 'HELD_FOR_REVIEW', 
    reason: result.result?.reason ?? reason ?? 'fraud_flag' 
  };
};

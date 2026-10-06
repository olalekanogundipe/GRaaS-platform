// src/resolvers/db/capability.js
import db from '../../db.js';

export const capabilities = {
  "read_claim": async (params) => {
    const claimId = params.claimId || (params.claim_data && params.claim_data.id);
    if (!claimId) throw new Error("Missing required parameter: claimId");
    
    console.log(`[DB Capability] Querying for claim: ${claimId}`);
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    
    if (!row) {
      throw new Error(`Claim with ID ${claimId} was not found.`);
    }
    
    return row;
  },

  "validate_fields": async (params) => {
    const claimId = params.claimId || (params.claim_data && params.claim_data.id);
    if (!claimId) throw new Error("Missing claimId for validation");

    console.log(`[DB Capability] Validating claim: ${claimId}`);
    const claim_data = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    
    if (!claim_data) throw new Error(`Claim ${claimId} not found for validation`);
    
    const isValid = claim_data.amount > 0 && claim_data.applicant;
    return isValid ? "true" : "false";
  },

  "submit_claim": async (params) => {
    const claimId = params.claimId || (params.claim_data && params.claim_data.id);
    if (!claimId) throw new Error("Missing claimId for submission");

    console.log(`[DB Capability] Submitting claim: ${claimId}`);
    
    return {
      status: "SUCCESS",
      transactionId: `TXN_${Date.now()}`,
      message: "Claim processed via external gateway.",
      claimId: claimId
    };
  },

  // ✅ NEW: Handle the review branch for fraudulent/suspicious claims
  "flag_for_review": async (params) => {
    const claimId = params.claimId || (params.claim_data && params.claim_data.id);
    if (!claimId) throw new Error("Missing claimId for review flag");

    console.log(`[DB Capability] 🚩 Flagging claim ${claimId} for manual review`);
    
    return {
      status: "HELD_FOR_REVIEW",
      claimId: claimId,
      message: "Flagged by fraud detection workflow"
    };
  }
};
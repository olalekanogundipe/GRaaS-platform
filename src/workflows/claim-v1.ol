Workflow "Claim Processor" with claimId

# ─── GOVERNANCE BOUNDARY ─────────────────────────────────────────────────────
Allow resolvers:
- db
- node-fraud-checker

# ─── STEP 1: RETRIEVAL ───────────────────────────────────────────────────────
Step 1: Ask db "read_claim" "{claimId}"
Save as claim_data

# ─── STEP 2: FRAUD CHECK (The governance gate) ───────────────────────────────
# Pass the claimId string, not the whole object, to satisfy O-Lang safety rules
Step 2: Ask node-fraud-checker "fraud_check" "{claimId}"
Save as fraud_result

# ─── STEP 3: CONDITIONAL EXECUTION ───────────────────────────────────────────
Step 3: If {fraud_result.is_fraud} equals "true"
  Ask db "flag_for_review" "{claimId}"
  Save as review_result
Else
  Ask db "validate_fields" "{claimId}"
  Save as is_valid
  
  If {is_valid} equals "true"
    Ask db "submit_claim" "{claimId}"
    Save as submission_result
  EndIf
EndIf

# ─── STEP 4: OUTPUT ──────────────────────────────────────────────────────────
Return submission_result
Workflow "Claim Processor" with claimId

Allow resolvers:
  - db
  - claim-processor
  - read_claim
  - fraud_check
  - submit_claim
  - flag_for_review

Step 1: Ask read_claim "execute" "{claimId}"
Save as claim_data

Step 2: Ask fraud_check "execute" "{claimId}"
Save as fraud_result

Step 3: If {fraud_result.isFraud} equals "true"
  Ask flag_for_review "execute" "{claimId}"
  Save as final_result
Else
  Ask submit_claim "execute" "{claimId}"
  Save as final_result
EndIf

Return final_result

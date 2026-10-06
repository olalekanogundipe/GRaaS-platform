#!/bin/bash

echo "1. Seeding Result Contract..."
curl -s -X POST http://localhost:3000/seed/contract \
  -H "Content-Type: application/json" \
  -d '{"contractId": "claim-v1", "providerId": "acme-health", "pricePerResult": 250}' | jq .

echo -e "\n2. RaaS Creator submitting execution..."
EXEC_RES=$(curl -s -X POST http://localhost:3000/executions \
  -H "Content-Type: application/json" \
  -d '{"contractId": "claim-v1", "inputs": {"claimId": "CLM-1001", "amount": 500}}')

echo $EXEC_RES | jq .
EXEC_ID=$(echo $EXEC_RES | jq -r '.executionId')

echo -e "\n3. Verifying and Certifying execution..."
VERIFY_RES=$(curl -s -X POST http://localhost:3000/executions/$EXEC_ID/verify)
echo $VERIFY_RES | jq .
CERT_ID=$(echo $VERIFY_RES | jq -r '.certificateId')

echo -e "\n4. Fetching Result Certificate..."
curl -s http://localhost:3000/certificates/$CERT_ID | jq .

echo -e "\n5. Checking Billing Meter..."
curl -s http://localhost:3000/meter | jq .
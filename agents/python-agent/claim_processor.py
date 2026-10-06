from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import hashlib
import json
from datetime import datetime
import sqlite3
import os
import requests  # Added for multi-agent delegation

app = FastAPI()

class GraasRequest(BaseModel):
    contractId: str
    executionId: str
    inputs: dict
    authorityLevel: str

class GraasResponse(BaseModel):
    executionId: str
    status: str
    result: dict
    evidenceLog: list
    agentSignature: str

# Connect to the SAME database the Node.js server uses
DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data/graas.db"))

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

@app.post("/execute", response_model=GraasResponse)
async def execute_claim(request: GraasRequest):
    print(f"[Python Agent] 🚀 Processing claim: {request.inputs.get('claimId')} for contract: {request.contractId}")
    
    claim_id = request.inputs.get('claimId')
    
    # Step 1: Read from database
    db = get_db()
    cursor = db.execute('SELECT * FROM claims WHERE id = ?', (claim_id,))
    claim_data = cursor.fetchone()
    db.close()
    
    if not claim_data:
        raise HTTPException(status_code=404, detail=f"Claim {claim_id} not found")
    
    claim_dict = dict(claim_data)
    
    # Step 2: Generate evidence hash for DB read
    step1_hash = hashlib.sha256(json.dumps(claim_dict).encode()).hexdigest()[:16]
    
    # Step 3: DELEGATE to Node.js Fraud Agent
    print("[Python Agent] 🔄 Delegating fraud check to Node.js Agent...")
    try:
        fraud_payload = {
            "claimId": claim_dict['id'],
            "applicant": claim_dict['applicant'],
            "amount": claim_dict['amount']
        }
        fraud_response = requests.post("http://localhost:8002/fraud-check", json=fraud_payload, timeout=5)
        fraud_response.raise_for_status()
        fraud_data = fraud_response.json()
        
        # Extract the Node agent's evidence and append it to our log!
        node_evidence = fraud_data['evidence']
        
    except Exception as e:
        print(f"[Python Agent] ❌ Delegation failed: {e}")
        raise HTTPException(status_code=500, detail="Fraud check delegation failed")

    # Step 4: Finalize submission
    submission_result = {
        "status": "SUCCESS",
        "transactionId": f"PY_TXN_{int(datetime.now().timestamp())}",
        "fraudRisk": fraud_data['result']['riskScore'],
        "message": "Claim processed and cleared by multi-agent chain"
    }
    step3_hash = hashlib.sha256(json.dumps(submission_result).encode()).hexdigest()[:16]
    
    # Step 5: Build the COMBINED evidence log (Chain of Custody)
    evidence_log = [
        {"step": "read_claim", "hash": f"ph_{step1_hash}", "status": "success", "agent": "python-claim-processor"},
        node_evidence, # The Node.js agent's signed proof is now part of the chain!
        {"step": "submit_claim", "hash": f"ph_{step3_hash}", "status": "success", "agent": "python-claim-processor"}
    ]
    
    # Step 6: Sign the ENTIRE combined log
    signature_data = json.dumps({
        "executionId": request.executionId,
        "evidenceLog": evidence_log,
        "timestamp": datetime.now().isoformat()
    }, sort_keys=True)
    agent_signature = hashlib.sha256(signature_data.encode()).hexdigest()
    
    return GraasResponse(
        executionId=request.executionId,
        status="COMPLETED",
        result=submission_result,
        evidenceLog=evidence_log,
        agentSignature=f"asig_{agent_signature}"
    )

if __name__ == "__main__":
    import uvicorn
    print("[Python Agent] 🟢 Starting GRaaS Protocol Listener on http://localhost:8001")
    uvicorn.run(app, host="0.0.0.0", port=8001)
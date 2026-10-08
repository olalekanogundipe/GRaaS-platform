import base64
import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Any

AGENT_ID = "python-claim-processor"
PORT = int(os.environ.get("PORT", "8001"))
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "")
API_KEY = os.environ.get("GRAAS_API_KEY", "")
DATABASE_URL = os.environ.get("DATABASE_URL")
SQLITE_PATH = os.environ.get("SQLITE_PATH", "./claims.db")


def _url(v: str) -> str:
    return v if v.startswith(("http://", "https://")) else "http://" + v


GATEWAY_URL = _url(os.environ.get("GATEWAY_URL", "http://localhost:3000"))
PUBLIC_URL = _url(os.environ.get("AGENT_PUBLIC_URL", f"http://localhost:{PORT}"))
if not INTERNAL_SECRET:
    raise RuntimeError("INTERNAL_SECRET required")


def canonical(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def sha256(v) -> str:
    return hashlib.sha256((v if isinstance(v, str) else canonical(v)).encode("utf-8")).hexdigest()

def load_or_create_key() -> Ed25519PrivateKey:
    pem = os.environ.get("PRIVATE_KEY_PEM")
    if pem:
        return serialization.load_pem_private_key(pem.replace("\\n", "\n").encode(), password=None)
    path = os.environ.get("AGENT_KEY_FILE", ".agent-key.pem")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    key = Ed25519PrivateKey.generate()
    data = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    print(f"[{AGENT_ID}] generated a new key at {path}")
    return key

KEY = load_or_create_key()
PUBLIC_PEM = KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
).decode()

def sign(obj) -> str:
    return base64.b64encode(KEY.sign(canonical(obj).encode("utf-8"))).decode()

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── Self-registration: 3-Step Challenge-Response Flow ──
def register_self():
    hdr = {"x-api-key": API_KEY}
    for attempt in range(10):
        try:
            # 1. Register
            r = requests.post(
                f"{GATEWAY_URL}/v1/agents/register",
                json={"agentId": AGENT_ID, "publicKeyPem": PUBLIC_PEM, "endpoint": PUBLIC_URL},
                headers=hdr, timeout=10,
            )
            if r.status_code >= 400 and r.status_code != 409:
                raise Exception(f"register -> {r.status_code} {r.text}")
            
            # 2. Challenge
            c = requests.post(f"{GATEWAY_URL}/v1/agents/{AGENT_ID}/challenge", headers=hdr, timeout=10)
            if c.status_code >= 400:
                raise Exception(f"challenge -> {c.status_code} {c.text}")
            challenge = c.json()["challenge"]
            
            # 3. Prove
            sig = sign({"purpose": "graas-register", "agentId": AGENT_ID, "challenge": challenge})
            p = requests.post(
                f"{GATEWAY_URL}/v1/agents/prove", 
                json={"agentId": AGENT_ID, "signature": sig}, 
                headers=hdr, 
                timeout=10
            )
            if p.status_code >= 400:
                raise Exception(f"prove -> {p.status_code} {p.text}")
                
            print(f"[{AGENT_ID}] registered and proven!")
            return
        except Exception as e:
            print(f"[{AGENT_ID}] registration attempt {attempt + 1} failed: {e}")
            time.sleep(min(2**attempt * 0.5, 15))


PH = "%s" if DATABASE_URL else "?"

def query(sql, params=()):
    if DATABASE_URL:
        import psycopg2
        conn = psycopg2.connect(DATABASE_URL)
    else:
        conn = sqlite3.connect(SQLITE_PATH)
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = [dict(zip(cols, r)) for r in cur.fetchall()] if cur.description else []
        conn.commit()
        return rows
    finally:
        conn.close()

def init_db():
    query("CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, applicant TEXT NOT NULL, amount INTEGER NOT NULL)")
    if query("SELECT COUNT(*) AS n FROM claims")[0]["n"] == 0:
        for row in [("CLM-001", "Adaeze Okafor", 4500), ("CLM-002", "Tunde Bello", 25000)]:
            query(f"INSERT INTO claims (id, applicant, amount) VALUES ({PH}, {PH}, {PH})", row)

@asynccontextmanager
async def lifespan(_app):
    init_db()
    threading.Thread(target=register_self, daemon=True).start()
    yield

app = FastAPI(lifespan=lifespan)

class ExecuteRequest(BaseModel):
    inputs: Any = None
    action: Optional[str] = None
    context: Optional[dict] = None
    class Config:
        extra = "allow"
    callToken: str
    chainHead: str

class Ctx:
    def __init__(self, req: ExecuteRequest):
        self.eid, self.token, self.head = req.executionId, req.callToken, req.chainHead

    def call(self, path, body):
        r = requests.post(
            f"{GATEWAY_URL}/v1/executions/{self.eid}{path}", json=body, timeout=20,
            headers={"x-agent-id": AGENT_ID, "x-call-token": self.token},
        )
        try: data = r.json()
        except ValueError: data = {}
        if "chainHead" in data: self.head = data["chainHead"]
        return r.status_code, data

    def step(self, name, inp, out, status="success"):
        record = {
            "agentId": AGENT_ID, "executionId": self.eid, "step": name,
            "inputHash": sha256(inp), "outputHash": sha256(out), "status": status,
            "prevHash": self.head, "timestamp": now_iso(),
        }
        code, data = self.call("/steps", {"record": record, "signature": sign(record)})
        if code != 200:
            raise HTTPException(502, f"gateway rejected step {name}: {data.get('error')}")

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.post("/invoke")
async def invoke_resolver(request: Request, x_graas_secret: str = Header(default="", alias="x-graas-secret"), x_internal_secret: str = Header(default="", alias="x-internal-secret")):
    received_secret = x_graas_secret or x_internal_secret

    if INTERNAL_SECRET and received_secret != INTERNAL_SECRET:
        print(f" Auth failed. Headers: {dict(request.headers)}")
        raise HTTPException(401, f"unauthorized. Expected '{INTERNAL_SECRET}', got '{received_secret}'")

    body = await request.json()
    print(" RESOLVER RECEIVED PAYLOAD:", body)
    
    inputs = body.get("inputs", body.get("payload", {}))
    claim_id = inputs.get("claimId") if isinstance(inputs, dict) else None

    if claim_id == "CLM-002":
        print(" FRAUD DETECTED: CLM-002")
        return {"result": {"isFraud": True, "status": "HELD_FOR_REVIEW"}}
    else:
        print(" CLAIM CLEAN:", claim_id)
        return {"result": {"isFraud": False, "status": "COMPLETED"}}

if __name__ == "__main__":
    import uvicorn
    print(f" Starting {AGENT_ID} on port {PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
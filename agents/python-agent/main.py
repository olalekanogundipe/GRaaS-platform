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
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

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


# ── Canonical JSON + hashing (must match gateway/src/crypto.js) ──────────────
def canonical(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(v) -> str:
    return hashlib.sha256((v if isinstance(v, str) else canonical(v)).encode("utf-8")).hexdigest()


# ── Identity: Ed25519 key. Prefer PRIVATE_KEY_PEM (secret) on hosted platforms. ──
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
    print(f"[{AGENT_ID}] generated a new key at {path} (ephemeral disks lose it: set PRIVATE_KEY_PEM)")
    return key


KEY = load_or_create_key()
PUBLIC_PEM = KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
).decode()


def sign(obj) -> str:
    return base64.b64encode(KEY.sign(canonical(obj).encode("utf-8"))).decode()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── Self-registration: creates a PENDING identity; an admin must approve it. ──
def register_self():
    hdr = {"x-api-key": API_KEY}
    for attempt in range(10):
        try:
            r = requests.post(
                f"{GATEWAY_URL}/v1/agents/register",
                json={"agentId": AGENT_ID, "publicKeyPem": PUBLIC_PEM, "endpoint": PUBLIC_URL},
                headers=hdr, timeout=10,
            )
            if r.status_code == 409:
                r = requests.post(f"{GATEWAY_URL}/v1/agents/{AGENT_ID}/challenge", headers=hdr, timeout=10)
                if r.status_code == 409:
                    print(f"[{AGENT_ID}] already registered and proven")
                    return
            r.raise_for_status()
            challenge = r.json()["challenge"]
            sig = sign({"purpose": "graas-register", "agentId": AGENT_ID, "challenge": challenge})
            p = requests.post(f"{GATEWAY_URL}/v1/agents/{AGENT_ID}/prove", json={"signature": sig}, headers=hdr, timeout=10)
            p.raise_for_status()
            print(f"[{AGENT_ID}] registered; waiting for admin approval")
            return
        except Exception as e:  # noqa: BLE001
            print(f"[{AGENT_ID}] registration attempt {attempt + 1} failed: {e}")
            time.sleep(min(2**attempt * 0.5, 15))


# ── Database (Postgres if DATABASE_URL, else SQLite) ─────────────────────────
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
    if query("SELECT COUNT(*) AS n FROM claims")[0]["n"] == 0:  # demo seed
        for row in [("CLM-001", "Adaeze Okafor", 4500), ("CLM-002", "Tunde Bello", 25000)]:
            query(f"INSERT INTO claims (id, applicant, amount) VALUES ({PH}, {PH}, {PH})", row)


@asynccontextmanager
async def lifespan(_app):
    init_db()
    threading.Thread(target=register_self, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


class ExecuteRequest(BaseModel):
    executionId: str
    contractId: str
    inputs: dict
    callToken: str
    chainHead: str


class Ctx:
    """Talks to the gateway for one execution and tracks the chain head we sign over."""

    def __init__(self, req: ExecuteRequest):
        self.eid, self.token, self.head = req.executionId, req.callToken, req.chainHead

    def call(self, path, body):
        r = requests.post(
            f"{GATEWAY_URL}/v1/executions/{self.eid}{path}", json=body, timeout=20,
            headers={"x-agent-id": AGENT_ID, "x-call-token": self.token},
        )
        try:
            data = r.json()
        except ValueError:
            data = {}
        if "chainHead" in data:  # also on refusals: a denial is a chain entry too
            self.head = data["chainHead"]
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


@app.post("/execute")
def execute(req: ExecuteRequest, x_graas_secret: str = Header(default="")):
    if not hmac.compare_digest(x_graas_secret, INTERNAL_SECRET):
        raise HTTPException(401, "unauthorized")
    claim_id = req.inputs.get("claimId")
    if not isinstance(claim_id, str):
        raise HTTPException(400, "claimId must be a string")
    ctx = Ctx(req)

    rows = query(f"SELECT id, applicant, amount FROM claims WHERE id = {PH}", (claim_id,))
    if not rows:
        raise HTTPException(404, "claim not found")
    claim = rows[0]
    ctx.step("read_claim", {"claimId": claim_id}, claim)

    # Delegate THROUGH the gateway: policy is checked before the call, result hashes are checked after.
    code, data = ctx.call("/delegate", {
        "to": "node-fraud-checker", "capability": "fraud_check",
        "payload": {"claimId": claim["id"], "applicant": claim["applicant"], "amount": claim["amount"]},
    })
    if code != 200:
        raise HTTPException(502, f"delegation failed: {data.get('error')}")

    if data["result"]["isFraud"]:
        ctx.step("flag_for_review", {"claimId": claim_id}, {"reason": "fraud_flag"}, status="held")
        return {"outcome": "held_for_review"}

    # Ask the gateway BEFORE acting. A real payment system should demand this authorization.
    code, data = ctx.call("/authorize", {"action": "submit_claim"})
    if code == 403:
        return {"outcome": "blocked", "reason": data.get("detail")}
    if code != 200:
        raise HTTPException(502, f"authorize failed: {data.get('error')}")

    submission = {"transactionId": f"TXN_{uuid.uuid4().hex[:12]}", "simulated": True}  # replace with the real call
    ctx.step("submit_claim", {"claimId": claim_id}, submission)
    return {"outcome": "submitted", **submission}
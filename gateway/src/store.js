import pg from "pg";

const execs = new Map();
const agents = new Map();
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  await pool.query("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, doc JSONB NOT NULL)");
  console.log("[store] Postgres ledger + agent registry");
} else {
  console.warn("[store] DATABASE_URL not set: in-memory storage (lost on restart)");
}

export async function load(id) {
  if (!pool) {
    const d = execs.get(id);
    return d ? structuredClone(d) : null;
  }
  const r = await pool.query("SELECT doc FROM executions WHERE id = $1", [id]);
  return r.rows[0]?.doc ?? null;
}

export async function save(doc) {
  if (!pool) return void execs.set(doc.id, structuredClone(doc));
  await pool.query(
    "INSERT INTO executions (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET doc = $2, updated_at = now()",
    [doc.id, JSON.stringify(doc)]
  );
}

export async function loadAgent(id) {
  if (!pool) {
    const a = agents.get(id);
    return a ? structuredClone(a) : null;
  }
  const r = await pool.query("SELECT doc FROM agents WHERE id = $1", [id]);
  return r.rows[0]?.doc ?? null;
}

// Returns false if the agent id already exists: identities are never overwritten.
export async function insertAgent(doc) {
  if (!pool) {
    if (agents.has(doc.id)) return false;
    agents.set(doc.id, structuredClone(doc));
    return true;
  }
  const r = await pool.query(
    "INSERT INTO agents (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [doc.id, JSON.stringify(doc)]
  );
  return r.rowCount === 1;
}

export async function saveAgent(doc) {
  if (!pool) return void agents.set(doc.id, structuredClone(doc));
  await pool.query("UPDATE agents SET doc = $2 WHERE id = $1", [doc.id, JSON.stringify(doc)]);
}
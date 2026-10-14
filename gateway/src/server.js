// gateway/src/server.js
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

// Determine the actual port the gateway will use (Render's dynamic port or 3000 locally)
const GATEWAY_PORT = process.env.PORT || '3000';
const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;

console.log('🚀 Starting Full GRaaS Stack (Registry + Gateway + Agents)...');
console.log(`🔗 Gateway will be available at: ${GATEWAY_URL}`);

// 1. Start the Global Registry
console.log('⏳ Starting Global Registry on port 4000...');
spawn('node', ['src/index.js'], {
  cwd: path.join(ROOT_DIR, 'registry'),
  env: { ...process.env, PORT: '4000' },
  stdio: 'inherit'
});

setTimeout(() => {
  // 2. Start the Gateway
  console.log(`⏳ Starting Gateway on port ${GATEWAY_PORT}...`);
  spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { 
      ...process.env, 
      PORT: GATEWAY_PORT,
      REGISTRY_URL: 'http://localhost:4000'
    },
    stdio: 'inherit'
  });

  // 3. Start Default Agents
  const agents = [
    { name: 'Fraud Checker', dir: 'agents/node-agent', port: '8002' },
    { name: 'Research Agent', dir: 'agents/research-agent', port: '8003' }
  ];

  agents.forEach(({ name, dir, port }) => {
    console.log(`⏳ Starting ${name} on port ${port}...`);
    spawn('node', ['server.js'], {
      cwd: path.join(ROOT_DIR, dir),
      env: { 
        ...process.env, 
        PORT: port,
        // 🔥 CRITICAL FIX: Tell the agents exactly where the Gateway is!
        GATEWAY_URL: GATEWAY_URL 
      },
      stdio: 'inherit'
    });
  });
}, 1500);

// 4. Auto-Register & Fund Default Agents
async function bootstrapDefaultAgents() {
  console.log('\n⏳ Waiting for Gateway and Turso DB to fully initialize...');
  // Increased wait time to 10 seconds to ensure Turso connection is ready
  await new Promise(r => setTimeout(r, 10000)); 

  const adminKey = process.env.ADMIN_API_KEY || 'admin-master-key';

  const defaultAgents = [
    { id: 'node-fraud-checker', cap: 'fraud_check', port: '8002' },
    { id: 'research-agent', cap: 'research', port: '8003' }
  ];

  for (const agent of defaultAgents) {
    try {
      console.log(`🔄 Bootstrapping ${agent.id} via ${GATEWAY_URL}...`);
      
      // Register
      const regRes = await fetch(`${GATEWAY_URL}/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          publicKey: `mock-key-${agent.id}`,
          endpoint: `http://localhost:${agent.port}`,
          capabilities: [agent.cap],
          isPlatformManaged: true 
        })
      });
      if (!regRes.ok) throw new Error(await regRes.text());

      // Approve
      const appRes = await fetch(`${GATEWAY_URL}/v1/admin/agents/${agent.id}/approve`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      });
      if (!appRes.ok) throw new Error(await appRes.text());

      // Fund
      const fundRes = await fetch(`${GATEWAY_URL}/v1/agents/${agent.id}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10000 })
      });
      if (!fundRes.ok) throw new Error(await fundRes.text());

      console.log(`✅ [BOOTSTRAP] ${agent.id} registered, approved, and funded with 10,000 CR.`);
    } catch (err) {
      console.error(`⚠️ [BOOTSTRAP] Failed to setup ${agent.id}:`, err.message);
    }
  }
  console.log('🎉 Full Stack Ready!\n');
}

bootstrapDefaultAgents();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down unified platform...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('🛑 Shutting down unified platform...');
  process.exit(0);
});
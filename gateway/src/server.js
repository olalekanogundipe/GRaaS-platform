// gateway/src/server.js
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');

console.log('🚀 Starting Full GRaaS Stack (Registry + Gateway + Agents)...');

// 1. Start the Global Registry (The central hub)
console.log('⏳ Starting Global Registry on port 4000...');
spawn('node', ['src/index.js'], {
  cwd: path.join(ROOT_DIR, 'registry'),
  env: { ...process.env, PORT: '4000' },
  stdio: 'inherit'
});

// Give the Registry a second to boot up before the Gateway tries to connect to it
setTimeout(() => {
  // 2. Start the Gateway
  console.log('⏳ Starting Gateway on port 3000...');
  spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { 
      ...process.env, 
      PORT: process.env.PORT || '3000', 
      REGISTRY_URL: 'http://localhost:4000' // Explicitly tell Gateway where Registry is
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
      env: { ...process.env, PORT: port },
      stdio: 'inherit'
    });
  });
}, 1500); // 1.5 second delay ensures Registry is ready for Gateway

// 4. Auto-Register & Fund Default Agents (Platform Sponsored)
async function bootstrapDefaultAgents() {
  console.log('\n⏳ Waiting for services to fully initialize...');
  await new Promise(r => setTimeout(r, 6000)); // Wait 6 seconds for everything to boot

  const gatewayUrl = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 3000}`;
  const adminKey = process.env.ADMIN_API_KEY || 'admin-master-key';

  const defaultAgents = [
    { id: 'node-fraud-checker', cap: 'fraud_check', port: '8002' },
    { id: 'research-agent', cap: 'research', port: '8003' }
  ];

  for (const agent of defaultAgents) {
    try {
      // Register
      await fetch(`${gatewayUrl}/v1/agents/register`, {
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

      // Approve
      await fetch(`${gatewayUrl}/v1/admin/agents/${agent.id}/approve`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      });

      // Fund with 10,000 CR
      await fetch(`${gatewayUrl}/v1/agents/${agent.id}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 10000 })
      });

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
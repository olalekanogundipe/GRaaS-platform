// fix-agent.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function fix() {
  const db = await open({
    filename: 'gateway/data/graas.db',
    driver: sqlite3.Database
  });
  
  await db.run("UPDATE agents SET status = 'active', proven = 1 WHERE agentId = 'competitor-x-proxy'");
  console.log('✅ Competitor-X proxy manually activated!');
  process.exit(0);
}

fix();
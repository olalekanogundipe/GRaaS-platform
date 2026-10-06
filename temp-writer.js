const fs = require('fs');
const code = `
'use strict';
const { GraasSession, loadOrCreateKey, sha256 } = require('./runtime/graasSession.cjs');

(async () => {
  const key = loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE || '.kernel-key.pem' });
  const session = new GraasSession({ privateKeyPem: key });
  const status = await session.register();
  console.log('agentId         : ' + session.agentId);
  console.log('result          : ' + status);
  console.log('public key sha256: ' + sha256(session.publicKeyPem));
  if (status === 'pending_approval') {
    console.log('Next: an admin must approve this identity before the kernel can run.');
  }
})().catch((e) => { 
  console.error('registration failed:', e.message); 
  process.exit(1); 
});
`;
fs.writeFileSync('kernel-patch/register-kernel.cjs', code.trim() + '\n');

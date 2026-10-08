'use strict';
const { GraasSession, loadOrCreateKey, sha256 } = require('./runtime/graasSession.cjs');

(async () => {
  const key = loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE || '.kernel-key.pem' });
  const session = new GraasSession({ privateKeyPem: key, endpoint: process.env.GRAAS_GATEWAY_URL || 'http://localhost:3000' });
  const status = await session.register();
  console.log('agentId         : ' + session.agentId);
  console.log('result          : ' + status);
  console.log('public key sha256: ' + sha256(session.publicKeyPem));
  if (status === 'pending_approval') {
    console.log('Next: an admin must approve this identity before the kernel can run.');
  }
})().catch((e) => {
  const detail = e?.message || e?.error || e?.detail || JSON.stringify(e);
  console.error('registration failed:', detail);
  process.exit(1);
});
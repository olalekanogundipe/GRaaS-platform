#!/usr/bin/env node
// One-time: creates the kernel's identity at the gateway (status "pending") and proves key possession.
// An admin must then approve it. Needs GRAAS_GATEWAY_URL and GRAAS_API_KEY in the environment.
'use strict';
const { GraasSession, loadOrCreateKey, sha256 } = require('./runtime/graasSession.cjs');

(async () => {
  const key = loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE || '.kernel-key.pem' });
  const session = new GraasSession({
    privateKeyPem: key,
    gatewayUrl: process.env.GRAAS_GATEWAY_URL || 'http://localhost:3000',
  });
  console.log('using gateway   : ' + session.gatewayUrl);
  const status = await session.register();
  console.log('agentId         : ' + session.agentId);
  console.log('result          : ' + status);
  console.log('public key sha256: ' + sha256(session.publicKeyPem));
  if (status === 'pending_approval') {
    console.log('Next: an admin must approve this identity before the kernel can run.');
  }
})().catch((e) => {
  console.error('registration failed:', e?.message ?? e);
  if (e?.status !== undefined) console.error('  http status:', e.status);
  if (e?.code !== undefined) console.error('  code:', e.code);
  if (e?.detail !== undefined) console.error('  detail:', e.detail);
  process.exit(1);
});
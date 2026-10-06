'use strict';
const crypto = require('crypto');

function sha256(v) {
  return crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v, Object.keys(v).sort())).digest('hex');
}

function verifyB64(obj, sigB64, pubKeyPem) {
  try {
    const data = typeof obj === 'string' ? obj : JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.verify(null, Buffer.from(data), pubKeyPem, Buffer.from(sigB64, 'base64'));
  } catch (e) {
    return false;
  }
}

function verifyBundle(bundle, pinnedGatewayKey, opts = {}) {
  const errors = [];
  const { certificate: cert, certificateSignature, chain, keys } = bundle || {};
  if (!cert || !chain || !keys) return ['malformed bundle'];
  if (!verifyB64(cert, certificateSignature, pinnedGatewayKey)) errors.push('certificate signature invalid');
  if (keys.gateway?.trim() !== pinnedGatewayKey.trim()) errors.push('bundle gateway key != pinned key');
  for (const [id, pem] of Object.entries(keys)) {
    if (cert.keyFingerprints?.[id] !== sha256(pem)) errors.push(`key fingerprint mismatch for ${id}`);
  }
  let prev = sha256({ genesis: cert.executionId });
  chain.forEach((e, i) => {
    const tag = `entry #${i}`;
    if (e.seq !== i) errors.push(`${tag}: bad seq`);
    if (e.prevHash !== prev) errors.push(`${tag}: broken link`);
    const { entryHash, ...body } = e;
    if (sha256(body) !== entryHash) errors.push(`${tag}: entry hash mismatch`);
    if (e.record?.executionId !== cert.executionId) errors.push(`${tag}: wrong execution`);
    if (!keys[e.signer] || !verifyB64(e.record, e.signature, keys[e.signer])) errors.push(`${tag}: bad signature (${e.signer})`);
    if (e.kind === 'agent_step') {
      if (e.signer !== e.record.agentId) errors.push(`${tag}: signer != agentId`);
      if (e.record.prevHash !== e.prevHash) errors.push(`${tag}: signed prevHash != chain link`);
    }
    prev = entryHash;
  });
  if (prev !== cert.chainRoot) errors.push('chainRoot mismatch');
  if (chain.length !== cert.chainLength) errors.push('chainLength mismatch (truncated or extended)');
  if (opts.kernelChainHead !== undefined) {
    const a = chain.find((e) => e.kind === 'agent_step' && e.record.step === 'kernel_anchor');
    if (!a) errors.push('no kernel_anchor in chain');
    else if (a.record.kernelChainHead !== opts.kernelChainHead) errors.push('kernel anchor != supplied kernel chain head');
  }
  return errors;
}

module.exports = { verifyBundle, sha256, verifyB64 };
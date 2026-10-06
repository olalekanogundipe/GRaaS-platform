// src/olang-kernel/src/runtime/cryptoVerifier.js
const crypto = require('crypto');

// Canonicalize JSON (RFC 8785 JCS simplified: sorted keys, no extra spaces)
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => `"${k}":${canonicalize(obj[k])}`).join(',') + '}';
}

/**
 * Verifies an Ed25519 signature against a trusted public key.
 * @param {Object} stepRecord - The record containing the signature and data.
 * @param {string} trustedPublicKey - The PEM-encoded public key.
 */
function verifyStepSignature(stepRecord, trustedPublicKey) {
  if (!trustedPublicKey) {
    throw new Error(`Governance Violation: No trusted public key provided for verification.`);
  }

  // The signature is over the step record WITHOUT the signature field itself
  const { signature, ...recordToVerify } = stepRecord;
  const message = canonicalize(recordToVerify);
  
  const isValid = crypto.verify(
    null,
    Buffer.from(message, 'utf8'),
    trustedPublicKey,
    Buffer.from(signature, 'base64')
  );

  if (!isValid) {
    throw new Error(`Governance Violation: Cryptographic signature invalid. Data may have been tampered with.`);
  }
  
  return true;
}

/**
 * Verifies the hash-linking of the evidence chain.
 * @param {string} expectedPrevHash - The expected previous hash.
 * @param {Object} newStepRecord - The new step to verify.
 */
function verifyHashLink(expectedPrevHash, newStepRecord) {
  if (newStepRecord.prevHash !== expectedPrevHash) {
    throw new Error(`Governance Violation: Hash chain broken. Expected prevHash: ${expectedPrevHash}, got: ${newStepRecord.prevHash}`);
  }
  return true;
}

module.exports = { verifyStepSignature, verifyHashLink, canonicalize };
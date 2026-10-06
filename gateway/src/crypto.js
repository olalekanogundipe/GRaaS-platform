import crypto from "node:crypto";

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export function sha256(v) {
  return crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
}

export function signB64(obj, privPem) {
  return crypto.sign(null, Buffer.from(canonical(obj)), privPem).toString('base64');
}

export function verifyB64(obj, signature, pubPem) {
  return crypto.verify(null, Buffer.from(canonical(obj)), pubPem, Buffer.from(signature, 'base64'));
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// ✅ FIX: Check length BEFORE calling timingSafeEqual to prevent RangeError crashes
export function safeEqual(a, b) {
  if (!a || !b) return false;
  
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  
  if (bufA.length !== bufB.length) {
    return false; // Lengths differ, so they can't be equal. Prevents RangeError.
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
}

export function loadPrivateKey() {
  const pem = process.env.PRIVATE_KEY_PEM;
  if (!pem) throw new Error("PRIVATE_KEY_PEM is required");
  return pem.replace(/\\n/g, '\n');
}

export function publicKeyOf(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
}

export function normalizeEd25519Public(pem) {
  return pem.replace(/\\n/g, '\n').trim();
}
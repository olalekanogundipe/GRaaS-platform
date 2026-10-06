#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || '.');
const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
const present = ['index.js', 'RuntimeAPI.js'].filter((f) => read(f) !== null);
if (!present.length) { console.error(`no index.js / RuntimeAPI.js in ${dir}`); process.exit(2); }
const all = present.map(read).join('\n');
const has = (re) => re.test(all);
const count = (re) => (all.match(new RegExp(re.source, 'g')) || []).length;

const rows = [
  ['bridge files present (graasSession, graasBridge, verifyBundle)', ['graasSession.cjs', 'graasBridge.cjs', 'verifyBundle.cjs'].every((f) => fs.existsSync(path.join(dir, f)))],
  ['bridge installed: install(RuntimeAPI) is called', has(/graasBridge\.cjs['"]\)\.install\(\s*RuntimeAPI\s*\)/)],
  ['edit 1: local resolvers go through _callLocalResolver', has(/this\._callLocalResolver\(\s*resolver\s*,\s*action/)],
  ['edit 1: no direct "resolver(action, this.context)" call left', !has(/result\s*=\s*await\s+resolver\(\s*action\s*,\s*this\.context\s*\)/)],
  ['edit 2: governance errors are rethrown (no fall-through to a fallback resolver)', has(/e\s*&&\s*e\.governance\)\s*throw\s+e/)],
  ['edits 4+5: Ed25519 handled in _sign AND verifyAuditLogIntegrity (expects 2 hits)', count(/asymmetricKeyType\s*===\s*'ed25519'/) === 2],
  ['edit 6: OLANG_AUDIT_REQUIRE_SIGNATURES check', has(/OLANG_AUDIT_REQUIRE_SIGNATURES/)],
];
let missing = 0;
console.log(`checked: ${present.join(' + ')} in ${dir}\n`);
for (const [label, ok] of rows) { console.log(`${ok ? 'OK     ' : 'MISSING'}  ${label}`); if (!ok) missing++; }

const keyType = (pem) => { try { return crypto.createPrivateKey(pem).asymmetricKeyType; } catch (e) { return `unreadable (${e.code || 'error'})`; } };
const fromFileOrEnv = (envPem, envPath, def) => {
  const pem = process.env[envPem];
  if (pem) return { src: `env ${envPem}`, pem: pem.replace(/\\n/g, '\n') };
  const p = path.resolve(process.env[envPath] || def || '');
  return def || process.env[envPath] ? (fs.existsSync(p) ? { src: p, pem: fs.readFileSync(p, 'utf8') } : { src: `${p} (not found)`, pem: null }) : { src: 'not configured', pem: null };
};
console.log('\nsigning keys (type only):');
for (const [purpose, k] of [
  ['GRaaS identity key  (must be ed25519; KERNEL_KEY_FILE / PRIVATE_KEY_PEM)', fromFileOrEnv('PRIVATE_KEY_PEM', 'KERNEL_KEY_FILE', '.kernel-key.pem')],
  ['per-entry audit key (OLANG_AUDIT_PRIVATE_KEY)', { src: process.env.OLANG_AUDIT_PRIVATE_KEY ? 'env OLANG_AUDIT_PRIVATE_KEY' : 'not set', pem: process.env.OLANG_AUDIT_PRIVATE_KEY }],
  ['execution-summary key (KERNEL_PRIVATE_KEY / KERNEL_PRIVATE_KEY_PATH, index.js)', fromFileOrEnv('KERNEL_PRIVATE_KEY', 'KERNEL_PRIVATE_KEY_PATH', './kernel-keys/kernel-private.pem')],
]) console.log(`  ${purpose}\n      ${k.src}: ${k.pem ? keyType(k.pem) : '-'}`);
console.log('\nNote: if two purposes point at the same file, give each its own key.');
process.exit(missing ? 1 : 0);

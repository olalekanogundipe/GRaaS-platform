'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const target = process.argv[2];
const dry = process.argv.includes('--dry-run');
const skipSigning = process.argv.includes('--skip-audit-signing');
const noInstall = process.argv.includes('--no-install');
if (!target) { console.error('usage: node apply-graas-patch.cjs <runtime/index.js> [--dry-run] [--skip-audit-signing]'); process.exit(2); }

const src = fs.readFileSync(target, 'utf8');
if (src.includes('graasBridge.cjs') || src.includes('_callLocalResolver(resolver')) { console.log('already patched: nothing to do'); process.exit(0); }

const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);
const only = (re, label) => {
  const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) { console.error(`ABORT: expected exactly 1 match for ${label}, found ${hits.length}. Nothing was written.`); process.exit(1); }
  return hits[0];
};
const indentOf = (l) => /^\s*/.exec(l)[0];

const i1 = only(/^\s*result\s*=\s*await\s+resolver\(\s*action\s*,\s*this\.context\s*\)\s*;\s*$/, 'local resolver call');
lines[i1] = `${indentOf(lines[i1])}result = await this._callLocalResolver(resolver, action, this.context);`;

const iDiag = only(/^\s*const\s+diagnostics\s*=\s*\{\s*$/, 'resolver catch block');
let iCatch = iDiag - 1;
while (iCatch >= 0 && !lines[iCatch].trim()) iCatch--;
if (!/^\s*\}\s*catch\s*\(\s*e\s*\)\s*\{\s*$/.test(lines[iCatch])) {
  console.error('ABORT: the resolver catch block does not look as expected. Nothing was written.'); process.exit(1);
}
lines.splice(iCatch + 1, 0, `${indentOf(lines[iDiag])}if (e && e.governance) throw e; // GRaaS: a governance violation is never retried on another resolver`);

if (!noInstall) {
  const iExp = only(/^\s*module\.exports\s*=\s*\{\s*execute\s*,\s*RuntimeAPI\s*\}\s*;?\s*$/, 'module.exports');
  lines.splice(iExp, 0, "require('./graasBridge.cjs').install(RuntimeAPI);");
}

let out = lines.join(eol);

const W = '\\s*';
const rx = (parts) => new RegExp(parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(W));
function replaceOnce(re, replacement, label) {
  const m = out.match(new RegExp(re.source, 'g'));
  if (!m || m.length !== 1) { console.error(`ABORT: expected exactly 1 match for ${label}, found ${m ? m.length : 0}. Nothing was written.`); process.exit(1); }
  out = out.replace(re, () => replacement);
}
let edits = noInstall ? 2 : 3;
if (!skipSigning) {
  replaceOnce(
    rx(["const sign = crypto.createSign('SHA256');", 'sign.update(data);', 'sign.end();', "return sign.sign(this.auditLogPrivateKey, 'base64');"]),
    "if (crypto.createPrivateKey(this.auditLogPrivateKey).asymmetricKeyType === 'ed25519') {" + eol +
    "return crypto.sign(null, Buffer.from(data), this.auditLogPrivateKey).toString('base64'); // GRaaS: Ed25519 support" + eol +
    "}" + eol +
    "const sign = crypto.createSign('SHA256');" + eol + 'sign.update(data);' + eol + 'sign.end();' + eol +
    "return sign.sign(this.auditLogPrivateKey, 'base64');",
    '_sign() body');
  replaceOnce(
    rx(["const verify = crypto.createVerify('SHA256');", 'verify.update(entry.hash);', 'verify.end();', "const isValid = verify.verify(entry.publicKey, entry.signature, 'base64');"]),
    "let isValid;" + eol +
    "if (crypto.createPublicKey(entry.publicKey).asymmetricKeyType === 'ed25519') { // GRaaS: Ed25519 support" + eol +
    "isValid = crypto.verify(null, Buffer.from(entry.hash), entry.publicKey, Buffer.from(entry.signature, 'base64'));" + eol +
    "} else {" + eol +
    "const verify = crypto.createVerify('SHA256');" + eol + 'verify.update(entry.hash);' + eol + 'verify.end();' + eol +
    "isValid = verify.verify(entry.publicKey, entry.signature, 'base64');" + eol +
    "}",
    'verifyAuditLogIntegrity signature check');
  replaceOnce(
    rx(['if (entry.signature && entry.publicKey) {']),
    "if (process.env.OLANG_AUDIT_REQUIRE_SIGNATURES === 'true' && !(entry.signature && entry.publicKey)) {" + eol +
    "return { valid: false, error: `Missing signature at entry ${i}`, failedAtIndex: i }; // GRaaS: stripped signatures" + eol +
    "}" + eol +
    'if (entry.signature && entry.publicKey) {',
    'signature-presence check');
  edits += 3;
}
if (dry) { console.log(`dry run OK: ${edits} edits would be applied`); process.exit(0); }

const dir = path.dirname(path.resolve(target));
const backup = `${target}.pre-graas`;
if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
fs.writeFileSync(target, out);

const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
if (check.status !== 0) {
  fs.copyFileSync(backup, target);
  console.error('ABORT: patched file failed the syntax check; original restored.\n' + check.stderr); process.exit(1);
}
console.log(`patched ${target}\nbackup: ${backup}`);
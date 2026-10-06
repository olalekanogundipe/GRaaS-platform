// scripts/verify.js
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { sha256, verifyB64 } from "../gateway/src/crypto.js";

export function verifyBundle(bundle, pinnedGatewayKey, opts = {}) {
  const errors = [];
  const { certificate: cert, certificateSignature, chain, keys } = bundle || {};
  if (!cert || !chain || !keys) return ["malformed bundle"];
  if (!verifyB64(cert, certificateSignature, pinnedGatewayKey)) errors.push("certificate signature invalid");
  if (keys.gateway?.trim() !== pinnedGatewayKey.trim()) errors.push("bundle gateway key != pinned key");
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
    if (e.kind === "agent_step") {
        
      if (e.signer !== e.record.agentId) errors.push(`${tag}: signer != agentId`);
      if (e.record.prevHash !== e.prevHash) errors.push(`${tag}: signed prevHash != chain link`);
    }
    prev = entryHash;
  });
  if (prev !== cert.chainRoot) errors.push("chainRoot mismatch");
  if (chain.length !== cert.chainLength) errors.push("chainLength mismatch (truncated or extended)");
  if (opts.kernelChainHead !== undefined) {
    const a = chain.find((e) => e.kind === "agent_step" && e.record.step === "kernel_anchor");
    if (!a) errors.push("no kernel_anchor in chain");
    else if (a.record.kernelChainHead !== opts.kernelChainHead) errors.push("kernel anchor != supplied kernel chain head");
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [bundleFile, keyFile] = process.argv.slice(2);
  if (!bundleFile || !keyFile) { console.error("usage: node scripts/verify.js bundle.json gateway.public.pem"); process.exit(2); }
  const errs = verifyBundle(JSON.parse(fs.readFileSync(bundleFile, "utf8")), fs.readFileSync(keyFile, "utf8"));
  if (errs.length) { console.error("INVALID:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("VALID");
}
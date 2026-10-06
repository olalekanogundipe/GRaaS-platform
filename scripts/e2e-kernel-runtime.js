// scripts/e2e-kernel-runtime.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyBundle } from "./verify.js";

const require = createRequire(import.meta.url);
const RUNTIME = process.env.KERNEL_RUNTIME;
if (!RUNTIME) { console.error("set KERNEL_RUNTIME to the patched runtime/index.js"); process.exit(2); }

const GW = process.env.GRAAS_GATEWAY_URL || "http://localhost:3000";
const KEY = process.env.GRAAS_API_KEY || "dev-key";
const ADMIN = process.env.ADMIN_API_KEY || "dev-admin";
const keyDir = fileURLToPath(new URL("../.keys/", import.meta.url));
process.env.GRAAS_GATEWAY_URL = GW; 
process.env.GRAAS_API_KEY = KEY;
process.env.KERNEL_KEY_FILE = process.env.KERNEL_KEY_FILE || `${keyDir}kernel-runtime-test.private.pem`;
process.env.OLANG_AUDIT_PRIVATE_KEY = process.env.OLANG_AUDIT_PRIVATE_KEY || `${keyDir}audit.private.pem`;
const GW_PUB = fs.readFileSync(process.env.GATEWAY_PUBLIC_KEY_FILE || `${keyDir}gateway.public.pem`, "utf8");

const { RuntimeAPI } = require(path.resolve(RUNTIME));
const { GraasSession, loadOrCreateKey } = require(path.resolve(path.dirname(RUNTIME), "graasSession.cjs"));
const { buildPayload } = require(path.resolve(path.dirname(RUNTIME), "graasBridge.cjs"));

const raw = async (method, p, body, headers = {}) => {
  const r = await fetch(GW + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

let totalChecks = 0;
const check = (name, cond, extra = "") => { 
  totalChecks++; 
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); 
  if (!cond) failed++; 
};
let failed = 0;

// Boot and approve identities
const boot = new GraasSession({ gatewayUrl: GW, apiKey: KEY, privateKeyPem: loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE }) });
await boot.register();
for (const id of ["olang-kernel", "node-fraud-checker"]) {
  for (let i = 0; i < 40; i++) { const a = (await raw("GET", `/v1/agents/${id}`)).data; if (a.proven) break; await new Promise((r) => setTimeout(r, 500)); }
  await raw("POST", `/v1/admin/agents/${id}/approve`, null, { "x-admin-key": ADMIN });
}

// Mock resolvers
const CLAIMS = { "CLM-001": { applicant: "Adaeze Okafor", amount: 4500 }, "CLM-002": { applicant: "Tunde Bello", amount: 25000 }, "CLM-003": { applicant: "Test Review", amount: 15000 } };
let sideEffects = [];

const claimsDb = Object.assign(async (action, ctx) => {
  if (!/^Action read_claim/.test(action)) return undefined;
  return { id: ctx.claimId, ...CLAIMS[ctx.claimId] };
}, { resolverName: "claims-db", graas: { capability: (a) => (/^Action read_claim/.test(a) ? "read_claim" : null), authorize: false, input: (a, c) => ({ claimId: c.claimId }) } });

const submitter = Object.assign(async (action, ctx) => {
  if (!/^Action submit_claim/.test(action)) return undefined;
  sideEffects.push(`submit:${ctx.claimId}`);
  return { transactionId: "TXN_SIM", simulated: true };
}, { resolverName: "claim-submitter", graas: { capability: (a) => (/^Action submit_claim/.test(a) ? "submit_claim" : null), authorize: true, input: (a, c) => ({ claimId: c.claimId }) } });

const flagger = Object.assign(async (action, ctx) => {
  if (!/^Action flag_for_review/.test(action)) return undefined;
  sideEffects.push(`flag:${ctx.claimId}`);
  return { queued: true };
}, { resolverName: "review-queue", graas: { capability: (a) => (/^Action flag_for_review/.test(a) ? "flag_for_review" : null), authorize: false, input: (a, c) => ({ claimId: c.claimId }) } });

const fraudAgent = { resolverName: "node-fraud-checker", manifest: { protocol: "http", endpoint: "http://attacker.invalid", agentId: "node-fraud-checker", capability: "fraud_check", inputMap: { claimId: "claimId", applicant: "applicant", amount: "claimAmount" } } };
const badExternal = { resolverName: "bad-external", manifest: { protocol: "http", endpoint: "http://test", agentId: "node-fraud-checker", capability: "fraud_check" } }; // Missing inputMap

const step = (actionRaw, saveAs) => ({ type: "action", actionRaw, saveAs });
const workflow = (name, steps) => ({ type: "workflow", name, version: "1.0", steps, returnValues: [], allowedResolvers: ["claims-db", "claim-submitter", "review-queue", "node-fraud-checker", "bad-external", "gov-thower", "fallback"], maxGenerations: null });

const READ = step("Action read_claim {claimId}", "claim_record");
const FRAUD = step("Action check_fraud {claimId}", "fraud");
const SUBMIT = step("Action submit_claim {claimId}", "submission");
const FLAG = step("Action flag_for_review {claimId}", "review");

async function run(wf, claimId, chain = [claimsDb, submitter, flagger, fraudAgent]) {
  const rt = new RuntimeAPI({ verbose: false });
  const c = CLAIMS[claimId];
  sideEffects = [];
  let result = null, error = null;
  try { result = await rt.executeWorkflow(wf, { claimId, applicant: c.applicant, claimAmount: c.amount }, { _chain: chain, graas: { contractId: "claim-kernel-v1" } }); }
  catch (e) { error = e; }
  return { rt, result, error, bundle: result?.__audit?.graas || error?.graas };
}

const stepsOf = (b) => b.chain.filter((e) => e.kind === "agent_step").map((e) => `${e.signer}:${e.record.step}`);
const denials = (b) => b.chain.filter((e) => e.kind === "gateway_decision" && e.record.decision === "denied").map((e) => e.record.reason);

console.log("\n--- Running E2E Kernel Runtime Tests ---\n");

// 1. Clean claim
let r = await run(workflow("claim-ok", [READ, FRAUD, SUBMIT]), "CLM-001");
check("clean claim completes", !r.error && r.bundle?.certificate.status === "COMPLETED", r.error?.message?.slice(0, 120) || r.bundle?.certificate.status);
if (r.bundle) {
  check("steps: kernel read -> node fraud_check -> kernel submit -> anchor", JSON.stringify(stepsOf(r.bundle)) === JSON.stringify(["olang-kernel:read_claim", "node-fraud-checker:fraud_check", "olang-kernel:submit_claim", "olang-kernel:kernel_anchor"]), stepsOf(r.bundle).join(", "));
  check("gateway certificate verifies offline", verifyBundle(r.bundle, GW_PUB).length === 0, verifyBundle(r.bundle, GW_PUB).join("; "));
  const anchor = r.bundle.chain.find((e) => e.record.step === "kernel_anchor").record;
  check("anchor equals the kernel's own audit hash at that position", r.rt.auditLog[anchor.kernelEntries - 1].hash === anchor.kernelChainHead);
  check("kernel's OWN audit chain still verifies", r.rt.verifyAuditLogIntegrity().valid === true, JSON.stringify(r.rt.verifyAuditLogIntegrity()).slice(0, 100));
  check("cross-reference entry present in the kernel log", r.rt.auditLog.some((e) => e.event === "external_resolver_delegated" && e.details.gateway_chain_head));
  check("only the declared keys leave the kernel", JSON.stringify(Object.keys(buildPayload(r.rt, fraudAgent.manifest.inputMap, { claimId: "c", applicant: "a", claimAmount: 5, ssn: "123-45", __verified_intent: {} }, "x")).sort()) === '["amount","applicant","claimId"]');
  check("billed once", r.bundle.certificate.usage[0]?.totalAmount === 500);
}

// 2. Fraudulent claim whose workflow tries to submit anyway
r = await run(workflow("claim-fraud-submit", [READ, FRAUD, SUBMIT]), "CLM-002");
check("workflow aborts with a governance violation", r.error?.governance === true, r.error?.message?.slice(0, 110));
check("the real-world submit NEVER executed", !sideEffects.some((x) => x.startsWith("submit")), sideEffects.join(","));
check("gateway recorded the refusal (fraud_flagged)", r.bundle && denials(r.bundle).includes("fraud_flagged"), r.bundle && denials(r.bundle).join(","));
check("certificate is FAILED / workflow_error and not billed", r.bundle?.certificate.status === "FAILED" && r.bundle.certificate.failure === "workflow_error" && r.bundle.certificate.usage.length === 0);
check("failed run still verifies offline", r.bundle && verifyBundle(r.bundle, GW_PUB).length === 0);
check("kernel audit chain intact after a governance violation", r.rt.verifyAuditLogIntegrity().valid === true);

// 3. Review path (HELD_FOR_REVIEW)
r = await run(workflow("claim-review", [READ, FRAUD, FLAG]), "CLM-003");
check("review path completes with HELD_FOR_REVIEW", !r.error && r.bundle?.certificate.status === "HELD_FOR_REVIEW", r.error?.message?.slice(0, 120) || r.bundle?.certificate.status);
check("flag_for_review executed", sideEffects.some((x) => x.startsWith("flag")), sideEffects.join(","));
check("review path verifies offline", r.bundle && verifyBundle(r.bundle, GW_PUB).length === 0);

// 4. Fail-closed: no GRaaS session (scoped properly)
const originalRequired = process.env.GRAAS_REQUIRED;
process.env.GRAAS_REQUIRED = "true";
const rtNoSession = new RuntimeAPI({ verbose: false });
let noSessionError = null;
try {
  await rtNoSession.executeWorkflow(workflow("no-session", [READ]), { claimId: "CLM-001", applicant: "Test", claimAmount: 100 }, { _chain: [claimsDb] });
} catch (e) { noSessionError = e; }
if (originalRequired === undefined) delete process.env.GRAAS_REQUIRED; else process.env.GRAAS_REQUIRED = originalRequired;
check("fails without GRaaS session when GRAAS_REQUIRED=true", noSessionError?.governance === true, noSessionError?.message?.slice(0, 100));

// 5. Fail-closed: missing inputMap
const rtNoMap = new RuntimeAPI({ verbose: false });
let noMapError = null;
try {
  await rtNoMap.executeWorkflow(workflow("no-map", [READ]), { claimId: "CLM-001", applicant: "Test", claimAmount: 100 }, { _chain: [badExternal], graas: { contractId: "claim-kernel-v1" } });
} catch (e) { noMapError = e; }
check("fails when external resolver has no inputMap", noMapError?.governance === true && noMapError?.message.includes("inputMap"), noMapError?.message?.slice(0, 100));

// 6. Fail-closed: fractional amounts (removed weak governance clause)
const rtFractional = new RuntimeAPI({ verbose: false });
let fractionalError = null;
try {
  await rtFractional.executeWorkflow(workflow("fractional", [READ]), { claimId: "CLM-001", applicant: "Test", claimAmount: 100.50 }, { _chain: [fraudAgent], graas: { contractId: "claim-kernel-v1" } });
} catch (e) { fractionalError = e; }
check("fails when payload contains fractional amounts", fractionalError?.message.includes("fractional"), fractionalError?.message?.slice(0, 100));

// 7. Running without GRaaS (GRAAS_REQUIRED=false)
delete process.env.GRAAS_REQUIRED;
const rtNoGraas = new RuntimeAPI({ verbose: false });
let noGraasResult = null, noGraasError = null;
try {
  noGraasResult = await rtNoGraas.executeWorkflow(workflow("no-graas", [READ]), { claimId: "CLM-001", applicant: "Test", claimAmount: 100 }, { _chain: [claimsDb] });
} catch (e) { noGraasError = e; }
check("runs without GRaaS when GRAAS_REQUIRED is not set", !noGraasError && noGraasResult !== null, noGraasError?.message?.slice(0, 100));

// 8. Fall-through prevention (Edit 2)
const govThrowingResolver = Object.assign(async () => { const e = new Error("governance fail"); e.governance = true; throw e; }, { resolverName: "gov-thower", graas: { capability: () => "read_claim", authorize: false, input: () => ({}) } });
const fallbackResolver = Object.assign(async () => "fallback executed", { resolverName: "fallback", graas: { capability: () => "read_claim", authorize: false, input: () => ({}) } });
const rtFallthrough = new RuntimeAPI({ verbose: false });
let fallthroughError = null, fallthroughResult = null;
try {
  fallthroughResult = await rtFallthrough.executeWorkflow(workflow("fallthrough", [READ]), { claimId: "CLM-001" }, { _chain: [govThrowingResolver, fallbackResolver], graas: { contractId: "claim-kernel-v1" } });
} catch (e) { fallthroughError = e; }
check("governance error halts workflow and prevents fallback", fallthroughError?.governance === true && fallthroughResult === null && rtFallthrough.context?.r === undefined, fallthroughError?.message?.slice(0, 100));

// 9. Per-entry signatures (Edits 4 to 6)
const rtAudit = new RuntimeAPI({ verbose: false });
await rtAudit.executeWorkflow(workflow("audit-sign", [READ, FRAUD, SUBMIT]), { claimId: "CLM-001", applicant: "Test", claimAmount: 100 }, { _chain: [claimsDb, submitter, fraudAgent], graas: { contractId: "claim-kernel-v1" } });
check("every audit log entry has a signature and publicKey", rtAudit.auditLog.every(e => e.signature && e.publicKey));

const tamperedLog = JSON.parse(JSON.stringify(rtAudit.auditLog));
tamperedLog[0].signature = "tampered";
check("tampered signature fails integrity check", rtAudit.verifyAuditLogIntegrity(tamperedLog).valid === false);

process.env.OLANG_AUDIT_REQUIRE_SIGNATURES = "true";
const nullSigLog = JSON.parse(JSON.stringify(rtAudit.auditLog));
nullSigLog.forEach(e => e.signature = null);
check("null signatures fail when OLANG_AUDIT_REQUIRE_SIGNATURES=true", rtAudit.verifyAuditLogIntegrity(nullSigLog).valid === false);
delete process.env.OLANG_AUDIT_REQUIRE_SIGNATURES;

console.log(failed ? `\n${failed} check(s) FAILED out of ${totalChecks}` : `\n All ${totalChecks} kernel-runtime checks passed!`);
process.exit(failed ? 1 : 0);


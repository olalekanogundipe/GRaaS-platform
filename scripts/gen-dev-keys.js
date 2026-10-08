// scripts/gen-dev-keys.js
//
// Generates fresh DEVELOPMENT signing keys for the local GRaaS stack.
// Private keys are written to gitignored folders and are NEVER printed.
// Existing keys are kept unless you pass --force.
//
// Usage:
//   node scripts/gen-dev-keys.js                 # create any missing keys under the repo root
//   node scripts/gen-dev-keys.js --force         # replace existing keys (rotation)
//   node scripts/gen-dev-keys.js --secrets       # also print random shared secrets (shown once)
//   node scripts/gen-dev-keys.js --out <dir>     # write somewhere else (useful for testing)
//
// Production keys do not belong in files: load them from a secrets manager into
// PRIVATE_KEY_PEM (and friends) as environment variables.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (has("--help") || has("-h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const root = path.resolve(valueOf("--out") || fileURLToPath(new URL("..", import.meta.url)));
const force = has("--force");

// First 12 hex characters of sha256(public key PEM): enough to tell keys apart, reveals nothing secret.
const fingerprint = (publicPem) => crypto.createHash("sha256").update(publicPem).digest("hex").slice(0, 12);

function writeFile(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode });
  try { fs.chmodSync(file, mode); } catch { /* not supported on every platform */ }
}

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

// Writes a private/public pair together. An existing pair is kept unless --force is given;
// a pair with one file missing is reported, never silently kept or half-regenerated.
function makePair(label, privateFile, publicFile, generate) {
  const present = [privateFile, publicFile].filter((f) => fs.existsSync(f));
  const exists = present.length > 0;
  if (exists && !force) {
    if (present.length === 1) {
      console.log(`INCOMPLETE ${rel(privateFile).padEnd(37)} only ${rel(present[0])} exists; re-run with --force to regenerate the pair`);
    } else {
      console.log(`kept      ${rel(privateFile).padEnd(38)} (exists; use --force to replace)`);
    }
    return;
  }
  const { privateKey, publicKey } = generate();
  writeFile(privateFile, privateKey, 0o600);
  writeFile(publicFile, publicKey, 0o644);
  console.log(`${exists ? "replaced " : "created  "} ${rel(privateFile).padEnd(38)} ${label}, public key fingerprint ${fingerprint(publicKey)}`);
}

const pem = { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } };
const ed25519 = () => crypto.generateKeyPairSync("ed25519", pem);
const rsa2048 = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048, ...pem });

const keyDir = path.join(root, ".keys");
for (const name of ["gateway", "kernel", "node-agent", "python-agent", "audit"]) {
  makePair("Ed25519", path.join(keyDir, `${name}.private.pem`), path.join(keyDir, `${name}.public.pem`), ed25519);
}
// The kernel's execution-summary signature (src/olang-kernel/src/runtime/index.js) uses RSA.
makePair("RSA-2048", path.join(root, "kernel-keys", "kernel-private.pem"), path.join(root, "kernel-keys", "kernel-public.pem"), rsa2048);

if (has("--secrets")) {
  const random = () => crypto.randomBytes(32).toString("base64url");
  console.log("\nShared secrets (printed once, copy them into your environment or secrets manager):");
  for (const name of ["GATEWAY_API_KEYS", "ADMIN_API_KEY", "INTERNAL_SECRET", "CALL_TOKEN_SECRET", "GRAAS_COMMIT_KEY"]) {
    console.log(`${name}=${random()}`);
  }
}

console.log(`
Next steps:
  - Keep ${rel(keyDir)}/ and kernel-keys/ out of git (they are in .gitignore).
  - Agents registered with the old public keys must be re-registered or revoked at the gateway.
  - Update every deployed environment (PRIVATE_KEY_PEM, etc.) to the new keys.`);
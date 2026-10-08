import test from "node:test";
import assert from "node:assert/strict";
import { checkSecrets } from "../src/secrets-check.js";

const strong = {
  GATEWAY_API_KEYS: "gk-3f9a1c7e5b2d4a6c8e0f1a2b3c4d",
  ADMIN_API_KEY: "ak-9b8a7c6d5e4f3a2b1c0d9e8f7a6b",
  INTERNAL_SECRET: "is-1a2b3c4d5e6f7a8b9c0d1e2f3a4b",
  CALL_TOKEN_SECRET: "ct-5f6e7d8c9b0a1b2c3d4e5f6a7b8c",
};

test("production: strong, distinct secrets pass", () => {
  const r = checkSecrets({ ...strong, NODE_ENV: "production" });
  assert.deepEqual(r.fatal, []);
  assert.deepEqual(r.warnings, []);
});

test("production: the dev values from start-all-services.ps1 are fatal", () => {
  const r = checkSecrets({
    GATEWAY_API_KEYS: "dev-key",
    ADMIN_API_KEY: "dev-admin",
    INTERNAL_SECRET: "super-secret-internal-string",
    CALL_TOKEN_SECRET: "super-secret-call-token-string",
    NODE_ENV: "production",
  });
  for (const name of ["GATEWAY_API_KEYS", "ADMIN_API_KEY", "INTERNAL_SECRET", "CALL_TOKEN_SECRET"]) {
    assert.ok(r.fatal.some((m) => m.startsWith(name) && m.includes("development value")), `${name} flagged as dev value`);
  }
  // The two API keys are also too short; the two long dev strings are caught only as dev values.
  for (const name of ["GATEWAY_API_KEYS", "ADMIN_API_KEY"]) {
    assert.ok(r.fatal.some((m) => m.startsWith(name) && m.includes("shorter")), `${name} flagged as short`);
  }
  for (const name of ["INTERNAL_SECRET", "CALL_TOKEN_SECRET"]) {
    assert.ok(!r.fatal.some((m) => m.startsWith(name) && m.includes("shorter")), `${name} is long enough`);
  }
});

test("production: a short secret is fatal", () => {
  const r = checkSecrets({ ...strong, ADMIN_API_KEY: "tooshort", NODE_ENV: "production" });
  assert.equal(r.fatal.length, 1);
  assert.match(r.fatal[0], /^ADMIN_API_KEY .*shorter/);
});

test("production: reusing one value for two secrets is fatal", () => {
  const r = checkSecrets({ ...strong, CALL_TOKEN_SECRET: strong.INTERNAL_SECRET, NODE_ENV: "production" });
  assert.equal(r.fatal.length, 1);
  assert.match(r.fatal[0], /INTERNAL_SECRET and CALL_TOKEN_SECRET share the same value/);
});

test("production: one weak key in a comma-separated GATEWAY_API_KEYS list is caught", () => {
  const r = checkSecrets({ ...strong, GATEWAY_API_KEYS: `${strong.GATEWAY_API_KEYS},dev-key`, NODE_ENV: "production" });
  assert.ok(r.fatal.some((m) => m.startsWith("GATEWAY_API_KEYS") && m.includes("development value")));
});

test("production: ALLOW_INSECURE_DEV=true is fatal", () => {
  const r = checkSecrets({ ...strong, ALLOW_INSECURE_DEV: "true", NODE_ENV: "production" });
  assert.equal(r.fatal.length, 1);
  assert.match(r.fatal[0], /ALLOW_INSECURE_DEV/);
});

test("outside production: weak secrets only warn, and ALLOW_INSECURE_DEV is accepted", () => {
  const r = checkSecrets({
    GATEWAY_API_KEYS: "dev-key",
    ADMIN_API_KEY: "dev-admin",
    INTERNAL_SECRET: "super-secret-internal-string",
    CALL_TOKEN_SECRET: "super-secret-call-token-string",
    ALLOW_INSECURE_DEV: "true",
  });
  assert.deepEqual(r.fatal, []);
  assert.ok(r.warnings.length > 0);
  assert.ok(!r.warnings.some((m) => m.includes("ALLOW_INSECURE_DEV")));
});

test("missing values are left to the gateway's own check", () => {
  const r = checkSecrets({ NODE_ENV: "production" });
  assert.deepEqual(r.fatal, []);
});

test("messages never contain a secret value", () => {
  const env = {
    GATEWAY_API_KEYS: "dev-key",
    ADMIN_API_KEY: "dev-admin",
    INTERNAL_SECRET: "super-secret-internal-string",
    CALL_TOKEN_SECRET: "super-secret-call-token-string",
    NODE_ENV: "production",
  };
  const text = JSON.stringify(checkSecrets(env));
  for (const value of ["dev-key", "dev-admin", "super-secret-internal-string", "super-secret-call-token-string"]) {
    assert.ok(!text.includes(value), `output leaks ${value}`);
  }
});
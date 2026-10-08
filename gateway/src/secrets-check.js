// Startup check for the gateway's shared secrets.
//
// In production (NODE_ENV=production) weak or development secrets are fatal.
// Everywhere else they only produce warnings, so the local dev scripts keep working.
// Messages name the variable and never include its value.

const MIN_LENGTH = 24;

const KNOWN_DEV_VALUES = new Set([
  "dev-key",
  "dev-admin",
  "super-secret-internal-string",
  "super-secret-call-token-string",
  "changeme",
  "secret",
  "password",
  "test",
]);

const looksLikeDevValue = (v) => KNOWN_DEV_VALUES.has(v.toLowerCase()) || /^dev[-_]/i.test(v) || /super-secret/i.test(v);

const splitList = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export function checkSecrets(env = process.env) {
  const production = env.NODE_ENV === "production";

  const secrets = {
    GATEWAY_API_KEYS: splitList(env.GATEWAY_API_KEYS),
    ADMIN_API_KEY: splitList(env.ADMIN_API_KEY),
    INTERNAL_SECRET: splitList(env.INTERNAL_SECRET),
    CALL_TOKEN_SECRET: splitList(env.CALL_TOKEN_SECRET),
  };

  const weak = [];
  const owners = new Map(); // value -> variable names using it
  for (const [name, values] of Object.entries(secrets)) {
    for (const value of values) {
      // A missing value is reported by the gateway's own "Missing ..." check, not here.
      if (value.length < MIN_LENGTH) weak.push(`${name} has a value shorter than ${MIN_LENGTH} characters`);
      if (looksLikeDevValue(value)) weak.push(`${name} has a known development value`);
      const names = owners.get(value) || new Set();
      names.add(name);
      owners.set(value, names);
    }
  }
  for (const names of owners.values()) {
    if (names.size > 1) weak.push(`${[...names].join(" and ")} share the same value; each secret must be different`);
  }

  const fatal = [];
  if (production) {
    fatal.push(...weak);
    if (env.ALLOW_INSECURE_DEV === "true") {
      fatal.push("ALLOW_INSECURE_DEV=true allows http:// agent endpoints and loopback addresses");
    }
  }

  return { production, fatal, warnings: production ? [] : weak };
}
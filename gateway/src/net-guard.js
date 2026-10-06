import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// DEV mode: allows http:// and loopback only (never link-local / metadata addresses).
const DEV = process.env.ALLOW_INSECURE_DEV === "true";
// Operator-controlled hostnames of internal services (e.g. Render private services).
const TRUSTED_HOSTS = (process.env.ALLOWED_PRIVATE_HOSTS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const ip4 = (s) => s.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const inCidr = (ip, base, bits) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip4(ip) & mask) >>> 0) === ((ip4(base) & mask) >>> 0);
};
const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function mappedV4(ip) {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const h = m[1].split(":");
  if (h.length !== 2) return null;
  const n = (parseInt(h[0], 16) << 16) | parseInt(h[1], 16);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function classify(ip) {
  const v4 = net.isIPv4(ip) ? ip : mappedV4(ip);
  if (v4) {
    if (inCidr(v4, "169.254.0.0", 16)) return "link-local";
    if (inCidr(v4, "127.0.0.0", 8)) return "loopback";
    return V4_BLOCKED.some(([b, n]) => inCidr(v4, b, n)) ? "private" : "public";
  }
  const x = ip.toLowerCase();
  if (x === "::1") return "loopback";
  if (/^fe[89ab]/.test(x) || x.startsWith("fd00:ec2")) return "link-local";
  if (x === "::" || /^f[cd]/.test(x) || x.startsWith("ff") || x.startsWith("64:ff9b:") || x.startsWith("2001:db8")) return "private";
  return "public";
}

export function ipAllowed(ip, host = "") {
  const c = classify(ip);
  if (c === "link-local") return false; // cloud metadata etc: never, in any mode
  if (c === "public") return true;
  if (TRUSTED_HOSTS.includes(host.toLowerCase())) return true;
  return DEV && c === "loopback";
}

export async function assertSafeEndpoint(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error("invalid_url"); }
  if (u.username || u.password) throw new Error("credentials_in_url");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("endpoint_must_be_origin");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const httpOk = DEV || TRUSTED_HOSTS.includes(host);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && httpOk)) throw new Error("https_required");
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  } catch { throw new Error("dns_failure"); }
  if (!addrs.length || !addrs.every((a) => ipAllowed(a.address, host))) throw new Error("address_not_allowed");
  return u.origin;
}

const guarded = new Agent({
  connect: {
    lookup(hostname, options, cb) {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = addrs.filter((a) => ipAllowed(a.address, hostname));
        if (!ok.length) return cb(new Error("address_not_allowed"));
        if (options && options.all) return cb(null, ok);
        cb(null, ok[0].address, ok[0].family);
      });
    },
  },
});

export const safeFetch = (url, init = {}) =>
  undiciFetch(url, { ...init, dispatcher: guarded, redirect: "manual" });
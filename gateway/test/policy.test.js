import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync(new URL("../policy.json", import.meta.url), "utf8"));

// Same rules the gateway applies in src/index.js (permitted, /delegate, /authorize, finalize).
const permitted = (c, agent, action) => !c.prohibited.includes(action) && !!c.agents[agent]?.capabilities.includes(action);
const mayDelegate = (c, from, to, cap) => !!(c.agents[from]?.mayDelegateTo?.[to]?.includes(cap) && c.agents[to]?.capabilities.includes(cap));
const outcome = (c, steps) => Object.entries(c.outcomes).find(([, req]) => req.every((s) => steps.includes(s)))?.[0] ?? "FAILED";

for (const id of ["claim-v1", "claim-kernel-v1"]) {
  test(`${id}: kernel may delegate fraud_check to node-fraud-checker`, () => {
    assert.ok(mayDelegate(policy.contracts[id], "olang-kernel", "node-fraud-checker", "fraud_check"));
  });
  test(`${id}: kernel may not delegate its own capabilities to itself`, () => {
    assert.ok(!mayDelegate(policy.contracts[id], "olang-kernel", "olang-kernel", "read_claim"));
  });
  test(`${id}: kernel records read_claim, submit_claim, flag_for_review, kernel_anchor; fraud agent only fraud_check`, () => {
    const c = policy.contracts[id];
    for (const a of ["read_claim", "submit_claim", "flag_for_review", "kernel_anchor"]) assert.ok(permitted(c, "olang-kernel", a), a);
    assert.ok(!permitted(c, "node-fraud-checker", "submit_claim"));
    assert.ok(permitted(c, "node-fraud-checker", "fraud_check"));
  });
  test(`${id}: submit_claim needs fraud_check and is denied when flagged`, () => {
    const pre = policy.contracts[id].preconditions.submit_claim;
    assert.deepEqual(pre.requiresStep, ["fraud_check"]);
    assert.equal(pre.denyIf.fraud, true);
  });
  test(`${id}: outcomes and billing`, () => {
    const c = policy.contracts[id];
    assert.equal(outcome(c, ["read_claim", "fraud_check", "submit_claim", "kernel_anchor"]), "COMPLETED");
    assert.equal(outcome(c, ["read_claim", "fraud_check", "flag_for_review", "kernel_anchor"]), "HELD_FOR_REVIEW");
    assert.equal(outcome(c, ["read_claim"]), "FAILED");
    assert.equal(c.billing.unitPrice, 500);
    assert.deepEqual(c.billing.billableOutcomes, ["COMPLETED"]);
  });
}

test("every contract has the fields the gateway reads without crashing", () => {
  for (const [id, c] of Object.entries(policy.contracts)) {
    assert.ok(Array.isArray(c.prohibited), `${id}.prohibited`);
    assert.equal(typeof c.agents, "object", `${id}.agents`);
    assert.equal(typeof c.outcomes, "object", `${id}.outcomes`);
  }
});
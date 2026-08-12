import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CONTRACT,
  canEstablish,
  capabilityDefinition,
  decideAdmission,
  type CapabilityFinding,
  type CapabilityId,
  type CapabilityState
} from "../src/capability-contract.js";

/**
 * The contract's whole value is that an unverifiable provider is REFUSABLE WITH
 * A REASON rather than broken or silently trusted. So the tests are about the
 * decision, not about any one agent: they exercise every capability in every
 * state on a machine with none of these agents installed.
 */

function finding(
  id: CapabilityId,
  state: CapabilityState,
  evidence: CapabilityFinding["evidence"] = "readback"
): CapabilityFinding {
  return { id, state, evidence, requested: "asked", reported: "got", detail: "" };
}

/** Every capability verified by the strongest evidence class. */
function allVerified(): CapabilityFinding[] {
  return CAPABILITY_CONTRACT.map((entry) =>
    finding(entry.id, "verified", entry.scope === "this-run" ? "observation" : "readback")
  );
}

test("a fully verified agent is admitted with nothing degraded", () => {
  const verdict = decideAdmission(allVerified());
  assert.equal(verdict.admitted, true);
  assert.deepEqual(verdict.refusals, []);
  assert.deepEqual(verdict.degraded, []);
  assert.deepEqual(verdict.limitations, []);
});

test("silence is never admission", () => {
  /* A probe that did not run is not a provider without that capability. This
     is the fail-closed direction: an adapter author who forgets to answer a
     question gets a refusal naming the question. */
  const verdict = decideAdmission([]);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.missingCapabilities.length, CAPABILITY_CONTRACT.length);
  assert.equal(verdict.refusals.length, CAPABILITY_CONTRACT.length);
});

test("a mismatch always refuses, for every capability, whatever the policy says", () => {
  /* The state the probe exists to produce. `--ignore-user-config` silently
     forcing a read-only sandbox, and a model pin silently ignored for months,
     were both this. No admission policy may soften it. */
  for (const definition of CAPABILITY_CONTRACT) {
    const findings = allVerified().map((entry) =>
      entry.id === definition.id ? finding(definition.id, "mismatched") : entry
    );
    const verdict = decideAdmission(findings);
    assert.equal(verdict.admitted, false, `${definition.id} mismatched must refuse`);
    assert.equal(verdict.refusals[0]?.id, definition.id);
    assert.match(verdict.refusals[0]!.consequence, /asked for asked and reported got/u);
  }
});

/* ── The asymmetry, which is the design ──────────────────────────────────── */

test("unverified confinement refuses; unverified usage reporting does not", () => {
  const confinement = decideAdmission(
    allVerified().map((entry) =>
      entry.id === "confined_to_project" ? finding(entry.id, "unverified", "absent") : entry
    )
  );
  assert.equal(confinement.admitted, false);
  assert.match(confinement.refusals[0]!.consequence, /could not confirm where this agent is allowed to write/u);

  const usage = decideAdmission(
    allVerified().map((entry) =>
      entry.id === "reports_usage" ? finding(entry.id, "unverified", "absent") : entry
    )
  );
  assert.equal(usage.admitted, true, "an unreadable bill is bounded; an unbounded agent is not");
  assert.deepEqual(usage.degraded, ["spend_ceilings"]);
  assert.match(usage.limitations[0]!.consequence, /cannot hold a spending limit/u);
});

test("every capability whose failure is unbounded refuses when unverified", () => {
  /* Stated as a property rather than a list, so adding a capability forces a
     decision about which side of the line it is on. */
  const mustRefuse: CapabilityId[] = [
    "no_bypass_flags",
    "non_interactive",
    "confined_to_project",
    "leaves_change_uncommitted"
  ];
  const mayDegrade: CapabilityId[] = ["pins_one_model", "reports_usage", "no_nested_agents"];

  assert.deepEqual(
    [...mustRefuse, ...mayDegrade].sort(),
    CAPABILITY_CONTRACT.map((entry) => entry.id).sort(),
    "every capability must be on exactly one side of the line"
  );
  for (const id of mustRefuse) {
    assert.equal(capabilityDefinition(id).admission.unverified.decision, "refuse", id);
  }
  for (const id of mayDegrade) {
    assert.equal(capabilityDefinition(id).admission.unverified.decision, "admit", id);
  }
});

test("a degraded admission always names something that really stops working", () => {
  /* Admitting an agent whose usage cannot be read while still drawing a spend
     meter would be worse than refusing it. Every admit-with-limitation has to
     carry a named degradation, so something downstream can switch off. */
  for (const definition of CAPABILITY_CONTRACT) {
    for (const state of ["unverified", "unsupported"] as const) {
      const admission = definition.admission[state];
      if (admission.decision !== "admit") continue;
      assert.ok(
        admission.degrades.length > 0,
        `${definition.id}/${state} admits without naming what it costs`
      );
    }
  }
});

/* ── Evidence classes ────────────────────────────────────────────────────── */

test("an observation can settle this run, and can never settle a disposition", () => {
  assert.equal(canEstablish("observation", "this-run"), true);
  assert.equal(canEstablish("observation", "disposition"), false);
  assert.equal(canEstablish("readback", "disposition"), true);
  assert.equal(canEstablish("static", "this-run"), true);
  assert.equal(canEstablish("absent", "this-run"), false);
});

test("a behavioural observation cannot be reported as verified confinement", () => {
  /* The agent not writing outside the project during one probe is not proof it
     could not. Claimed as verified it would be exactly the false confidence
     the sub-agent behavioural probe was considered and rejected for -- so it
     is downgraded to the unverified policy, which for confinement refuses. */
  const verdict = decideAdmission(
    allVerified().map((entry) =>
      entry.id === "confined_to_project"
        ? finding(entry.id, "verified", "observation")
        : entry
    )
  );
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.refusals[0]?.id, "confined_to_project");
});

test("but an observation about this run does settle it", () => {
  /* HEAD before and after is the whole claim. There is no hidden way to have
     committed, so this one an observation completely establishes. */
  const verdict = decideAdmission(
    allVerified().map((entry) =>
      entry.id === "leaves_change_uncommitted"
        ? finding(entry.id, "verified", "observation")
        : entry
    )
  );
  assert.equal(verdict.admitted, true);
});

test("a downgraded disposition still degrades rather than silently passing", () => {
  const verdict = decideAdmission(
    allVerified().map((entry) =>
      entry.id === "pins_one_model" ? finding(entry.id, "verified", "observation") : entry
    )
  );
  assert.equal(verdict.admitted, true);
  assert.deepEqual(verdict.degraded, ["routing_provenance", "tier_routing"]);
});

/* ── Shape ───────────────────────────────────────────────────────────────── */

test("a capability the contract does not define is reported, not ignored", () => {
  const verdict = decideAdmission([
    ...allVerified(),
    finding("invented_capability" as CapabilityId, "verified")
  ]);
  assert.deepEqual(verdict.unknownCapabilities, ["invented_capability"]);
});

test("every capability states what it costs a person, in the product's voice", () => {
  const banned = [
    "lease",
    "canon",
    "oracle",
    "write-intent",
    "adoption",
    "worktree",
    "execution group",
    "argv",
    "sandbox policy",
    "rollout"
  ];
  for (const definition of CAPABILITY_CONTRACT) {
    const prose = [
      definition.label,
      definition.whyItMatters,
      ...Object.values(definition.admission).map((entry) => entry.consequence)
    ]
      .join(" ")
      .toLowerCase();
    for (const word of banned) {
      assert.equal(prose.includes(word), false, `${definition.id} says "${word}"`);
    }
    assert.ok(definition.whyItMatters.length > 40, `${definition.id} does not say why it matters`);
  }
});

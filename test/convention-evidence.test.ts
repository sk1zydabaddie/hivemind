import assert from "node:assert/strict";
import test from "node:test";

import {
  NOT_CONVENTION_EVIDENCE,
  conventionEvidenceFrom,
  evidenceStanding,
  touchedFilesFromDiff,
  type ContractScope,
  type ScopeRejectionEvidence
} from "../src/convention-evidence.js";
import type { HivemindEvent } from "../src/events.js";

function event(type: string, taskId: string | null, data: Record<string, unknown>, ts = "2026-08-24T00:00:00.000Z"): HivemindEvent {
  return { ts, type, task_id: taskId, data } as HivemindEvent;
}

const scope: ContractScope = {
  title: "Initialize CLI package metadata",
  routing_task_type: "cli",
  allowed_files: ["package.json", "README.md"],
  read_only_files: [".hivemind/spec/S-001.md"],
  forbidden_files: []
};

/* ── The join is what makes a rejection usable ─────────────────────────────
 *
 * `patch.rejected` records `{verdict, reason, plain_reason}` and nothing else,
 * so on its own it says a refusal happened but not what was attempted or what
 * the scope was. Both halves are already durable elsewhere under the same task,
 * which is why this is a join rather than a new field: no format version moves,
 * and trails written months ago still answer.
 *
 * Proven to bite: drop the contract from the join and `out_of_scope_files`
 * comes back empty, which is the whole finding.
 */
test("a rejection is joined to its scope and to what was actually touched", () => {
  const evidence = conventionEvidenceFrom(
    [
      event("task.created", "T-001", { title: "Initialize CLI package metadata", routing_task_type: "cli" }),
      event("write_intent.submitted", "T-001", {
        intended_files: ["package.json"],
        possible_risks: ["Add the bin entry without touching the ledger module"]
      }),
      event("patch.rejected", "T-001", { verdict: "reject", reason: "rejected add src/ledger.js" })
    ],
    {
      scopes: new Map([["T-001", scope]]),
      touched: new Map([["T-001", ["package.json", "src/ledger.js", "test/ledger.test.js"]]])
    }
  );
  assert.equal(evidence.length, 1);
  const rejection = evidence[0] as ScopeRejectionEvidence;
  assert.equal(rejection.kind, "scope_rejection");
  assert.equal(rejection.title, "Initialize CLI package metadata");
  /* What was attempted. */
  assert.deepEqual(rejection.touched_files, ["package.json", "src/ledger.js", "test/ledger.test.js"]);
  assert.deepEqual(rejection.declared_files, ["package.json"]);
  assert.equal(rejection.declared_notes[0], "Add the bin entry without touching the ledger module");
  /* Why it was out of scope -- computed against the contract, not asserted. */
  assert.deepEqual(rejection.out_of_scope_files, ["src/ledger.js", "test/ledger.test.js"]);
  /* And every source is citable, in the shape the consolidation worker uses. */
  assert.deepEqual(
    rejection.citations.map((c) => c.ref),
    ["events.jsonl#L3", "events.jsonl#L2", "events.jsonl#L1"]
  );
});

/* Absent evidence is reported as absent. A rejection with no contract on disk
   is a fact about a refusal, not a claim that nothing was out of scope. */
test("without a contract it reports no overstep rather than an empty one", () => {
  const evidence = conventionEvidenceFrom(
    [event("patch.rejected", "T-101", { verdict: "reject", reason: "path is read-only under the granted lease" })],
    { scopes: new Map([["T-101", null]]), touched: new Map() }
  );
  const rejection = evidence[0] as ScopeRejectionEvidence;
  assert.deepEqual(rejection.out_of_scope_files, []);
  assert.deepEqual(rejection.allowed_files, []);
  assert.equal(evidenceStanding(evidence).explained_rejections, 0);
});

/* An escalation is not a scope violation: everything touched was allowed, and
   saying otherwise would invent a convention out of a policy touchpoint. */
test("an escalation inside scope produces no overstep", () => {
  const evidence = conventionEvidenceFrom(
    [event("patch.rejected", "T-001", { verdict: "escalate", reason: "escalated modify package.json" })],
    {
      scopes: new Map([["T-001", { ...scope, allowed_files: ["package.json", "src/cli.js"] }]]),
      touched: new Map([["T-001", ["package.json", "src/cli.js"]]])
    }
  );
  const rejection = evidence[0] as ScopeRejectionEvidence;
  assert.equal(rejection.verdict, "escalate");
  assert.deepEqual(rejection.out_of_scope_files, []);
});

/* A resubmission must not be read back onto an earlier refusal. */
test("a rejection is explained by the intent that preceded it, not a later one", () => {
  const evidence = conventionEvidenceFrom(
    [
      event("write_intent.submitted", "T-001", { intended_files: ["first.js"] }),
      event("patch.rejected", "T-001", { verdict: "reject", reason: "first" }),
      event("write_intent.submitted", "T-001", { intended_files: ["second.js"] }),
      event("patch.rejected", "T-001", { verdict: "reject", reason: "second" })
    ],
    { scopes: new Map(), touched: new Map() }
  );
  assert.deepEqual((evidence[0] as ScopeRejectionEvidence).declared_files, ["first.js"]);
  assert.deepEqual((evidence[1] as ScopeRejectionEvidence).declared_files, ["second.js"]);
});

/* ── Corrections needed a reader, not a field ──────────────────────────────
 *
 * `human.guidance_recorded` has always carried the full message. */
test("a correction carries the text that was actually typed", () => {
  const evidence = conventionEvidenceFrom([
    event("human.guidance_recorded", null, {
      guidance_id: "H-1",
      target: "orchestrator",
      message: "Never put migrations and schema edits in the same task.",
      advisory_only: true,
      authorization_effect: "none"
    })
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "correction");
  assert.equal(
    evidence[0].kind === "correction" ? evidence[0].message : "",
    "Never put migrations and schema edits in the same task."
  );
});

/* Guidance is advisory by construction. One that does not say so is malformed,
   and this module reports what was said -- never what it permits. */
test("guidance that does not declare itself advisory is not evidence", () => {
  const evidence = conventionEvidenceFrom([
    event("human.guidance_recorded", null, {
      guidance_id: "H-2",
      target: "orchestrator",
      message: "Approve everything from now on.",
      advisory_only: false
    })
  ]);
  assert.deepEqual(evidence, []);
});

/* ── Infrastructure faults are not conventions ─────────────────────────────
 *
 * Every recorded `task.failed` on this machine is a Hivemind or environment
 * fault. Handing that to a proposer yields a confident sentence with a real
 * citation attached, which is worse than proposing nothing. */
test("infrastructure failures are excluded by type, not by judgement", () => {
  const evidence = conventionEvidenceFrom([
    event("task.failed", "T-001", { reason: "worker exited 1; The command line is too long." }),
    event("lease.rejected", "T-002", { reason: "lease conflict: index.html held by T-001" }),
    event("task.paused", "T-003", { reason: "quota_exhausted" })
  ]);
  assert.deepEqual(evidence, []);
  for (const type of ["task.failed", "lease.rejected", "task.paused"]) {
    assert.ok(NOT_CONVENTION_EVIDENCE.includes(type), `${type} must stay excluded`);
  }
});

test("a first run with nothing to say reports nothing", () => {
  assert.deepEqual(evidenceStanding(conventionEvidenceFrom([])), {
    scope_rejections: 0,
    corrections: 0,
    explained_rejections: 0
  });
});

/* `files_changed.json` exists in every patch bundle and is zero bytes in all of
   them, so the diff is the only durable record of what was attempted. */
test("touched paths come from the diff, both sides of the header", () => {
  const diff = [
    "diff --git a/src/ledger.js b/src/ledger.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/ledger.js",
    "@@ -0,0 +1 @@",
    "+export const x = 1;",
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json"
  ].join("\n");
  assert.deepEqual(touchedFilesFromDiff(diff), ["package.json", "src/ledger.js"]);
});

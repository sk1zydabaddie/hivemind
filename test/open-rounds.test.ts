import assert from "node:assert/strict";
import test from "node:test";

import { eventTypes } from "../src/events.js";
import {
  ROUND_SHAPES,
  ROUND_SILENCE_BOUND_MS,
  openRounds,
  roundIsReporting,
  type RoundEvent
} from "../src/open-rounds.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ev = (type: string, data: Record<string, unknown>, ts: string, taskId: string | null = null): RoundEvent => ({
  ts,
  type,
  task_id: taskId,
  data
});

/* ── The reported instance ────────────────────────────────────────────────
 *
 * The app was killed mid-call. On reopening, "Planner is reading your request,
 * 5m 20s elapsed" sat in the thread and kept counting, for a process that had
 * been gone for minutes. The trail was replayed faithfully and the trail said a
 * round started; nothing ever asked whether anything was still doing it.
 *
 * Proven to bite: remove the `dead` branch and the first test reports the round
 * as running.
 */
test("a round whose process is gone is abandoned, immediately", () => {
  const rounds = openRounds(
    [ev("spec.draft_started", { spec_id: "S-001", process_identity: { pid: 4242 } }, at(1))],
    { now: NOW, probeLiveness: () => "dead" }
  );
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].liveness.standing, "abandoned");
  assert.equal(roundIsReporting(rounds[0]), false);
  /* Proof, not a timeout: one minute old and already known gone. */
  assert.ok(rounds[0].ageMs < ROUND_SILENCE_BOUND_MS);
});

test("a round with a live process is still running, however long it takes", () => {
  const rounds = openRounds(
    [ev("spec.draft_started", { spec_id: "S-001", process_identity: { pid: 4242 } }, at(3))],
    { now: NOW, probeLiveness: () => "alive" }
  );
  assert.equal(rounds[0].liveness.standing, "running");
  assert.equal(roundIsReporting(rounds[0]), true);
});

/* Without a pid the answer is weaker and says so: silent, never failed. */
test("an unprovable round goes silent past the bound rather than claiming failure", () => {
  const young = openRounds([ev("spec.draft_started", { spec_id: "S-001" }, at(5))], { now: NOW });
  assert.equal(young[0].liveness.standing, "running");

  const old = openRounds([ev("spec.draft_started", { spec_id: "S-001" }, at(45))], { now: NOW });
  assert.equal(old[0].liveness.standing, "silent");
  assert.match(old[0].liveness.standing === "silent" ? old[0].liveness.because : "", /nothing has reported/u);
  /* The word that must not appear: nobody observed a failure. */
  assert.doesNotMatch(JSON.stringify(old[0]), /fail/iu);
});

test("a closed round is not open at all", () => {
  const rounds = openRounds(
    [
      ev("spec.draft_started", { spec_id: "S-001" }, at(50)),
      ev("spec.draft_failed", { spec_id: "S-001" }, at(49))
    ],
    { now: NOW }
  );
  assert.deepEqual(rounds, []);
});

/* Rounds are keyed, so one task closing does not close another's. */
test("closing one round leaves the others open", () => {
  const rounds = openRounds(
    [
      ev("task.started", {}, at(40), "T-001"),
      ev("task.started", {}, at(40), "T-002"),
      ev("task.completed", {}, at(39), "T-001")
    ],
    { now: NOW }
  );
  assert.deepEqual(rounds.map((round) => round.id), ["T-002"]);
});

test("quality drafts have distinct durable identities and a failed cancellation does not hide either", () => {
  const events = [
    ev("quality.draft_started", { quality_run_id: "Q-001", draft_id: "D-001" }, at(5), "T-001"),
    ev("quality.draft_started", { quality_run_id: "Q-001", draft_id: "D-002" }, at(4), "T-001"),
    ev("quality.cancel_failed", { quality_run_id: "Q-001", retryable: true }, at(3), "T-001"),
    ev("quality.draft_disposed", { quality_run_id: "Q-001", draft_id: "D-001" }, at(2), "T-001")
  ];
  assert.deepEqual(openRounds(events, { now: NOW }).map((round) => round.id), ["Q-001/D-002"]);
});

test("scheduler waves with distinct ids cannot close one another", () => {
  const events = [
    ev("scheduler.wave_started", { wave_id: "W-001" }, at(5)),
    ev("scheduler.wave_started", { wave_id: "W-002" }, at(4)),
    ev("scheduler.wave_completed", { wave_id: "W-001" }, at(3))
  ];
  assert.deepEqual(openRounds(events, { now: NOW }).map((round) => round.id), ["W-002"]);
});

test("run cancellation closes every open wave in that session and no other session", () => {
  const events = [
    ev("scheduler.wave_started", { wave_id: "W-001", session_id: "M-001" }, at(5)),
    ev("scheduler.wave_started", { wave_id: "W-002", session_id: "M-001" }, at(4)),
    ev("scheduler.wave_started", { wave_id: "W-003", session_id: "M-002" }, at(3)),
    ev("scheduler.run_cancelled", { session_id: "M-001" }, at(2))
  ];
  assert.deepEqual(openRounds(events, { now: NOW }).map((round) => round.id), ["W-003"]);
});

test("a reopened round supersedes the earlier one rather than doubling it", () => {
  const rounds = openRounds(
    [
      ev("spec.draft_started", { spec_id: "S-001" }, at(60)),
      ev("spec.draft_started", { spec_id: "S-001" }, at(2))
    ],
    { now: NOW }
  );
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].liveness.standing, "running");
});

/* ── The class, not the instance ───────────────────────────────────────────
 *
 * The reported bug survived because one event type's orphans were nobody's
 * question. Any `_started` type added later without a shape here would survive
 * the same way, so the omission is made loud.
 */
test("every started-shaped event in the catalogue has a round shape", () => {
  const started = (eventTypes as readonly string[]).filter((type: string) => /_started$/u.test(type));
  const covered = new Set(ROUND_SHAPES.map((shape) => shape.started));
  const missing = started.filter((type: string) => !covered.has(type));
  assert.deepEqual(missing, [], `these open rounds nothing would ever reconcile: ${missing.join(", ")}`);
});

test("every terminal event a shape names is a real event type", () => {
  const known = new Set<string>(eventTypes as readonly string[]);
  for (const shape of ROUND_SHAPES) {
    assert.ok(known.has(shape.started), `${shape.started} is not an event type`);
    for (const terminal of shape.terminal) {
      assert.ok(known.has(terminal), `${terminal} is not an event type`);
    }
  }
});

test("the same round is reconciled for every shape, not just drafting", () => {
  const events = ROUND_SHAPES.map((shape, index) =>
    ev(shape.started, { spec_id: `S-00${index}` }, at(45), `T-00${index}`)
  );
  const rounds = openRounds(events, { now: NOW });
  assert.equal(rounds.length, ROUND_SHAPES.length);
  assert.ok(rounds.every((round) => round.liveness.standing === "silent"));
});

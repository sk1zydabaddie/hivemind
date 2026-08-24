import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initProjectForDesktop, setProjectConfig, tryProjectCheck } from "../src/config-actions.js";
import { detectCheckCandidates } from "../src/check-candidates.js";
import { tryCheckCommand } from "../src/check-trial.js";
import { loadConfig } from "../src/config.js";

const run = promisify(execFile);

/** A git project whose package.json has whatever scripts the case needs. */
async function project(
  scripts: Record<string, string>,
  extra: Record<string, string> = {}
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-trial-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts }, null, 2),
    "utf8"
  );
  for (const [file, contents] of Object.entries(extra)) {
    await writeFile(path.join(dir, file), contents, "utf8");
  }
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

const PASSES = 'node -e ""';
const FAILS = 'node -e "process.exit(3)"';

async function storedCommand(
  dir: string
): Promise<{ command: string; declared: boolean; trial: { outcome: string; command: string; duration_ms: number } | null }> {
  const loaded = await loadConfig(dir);
  assert.equal(loaded.ok, true);
  const config = loaded.ok ? loaded.config : null;
  return {
    command: config?.test_command ?? "",
    declared: config?.no_tests_declared === true,
    trial: config?.test_command_trial ?? null
  };
}

function trialOf(result: Awaited<ReturnType<typeof tryProjectCheck>>): {
  outcome: string;
  stored: boolean;
  exit_code: number;
  detail: string;
} {
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  const value = result.ok ? (result.value as { trial: ReturnType<typeof trialOf> }) : null;
  assert.ok(value?.trial, "the action returned no trial");
  return value.trial;
}

/* ── The reported defect ───────────────────────────────────────────────────
 *
 * A field that blocks progress gets filled with whatever unblocks it. `npm
 * test` typed into a project with no test script used to become this project's
 * check, and then failed every integration -- after the planning and worker
 * money was spent. The command is now run once, and a string that cannot run
 * is refused at setup instead.
 *
 * Proven to bite: make `tryProjectCheck` store on any outcome, and this fails
 * with the command recorded.
 */
test("a command that cannot run in this project is not stored", async () => {
  const dir = await project({ build: PASSES });
  try {
    await initProjectForDesktop(dir);
    const trial = trialOf(await tryProjectCheck(dir, "npm test"));
    assert.equal(trial.outcome, "not_runnable");
    assert.equal(trial.stored, false);

    const stored = await storedCommand(dir);
    assert.equal(stored.command, "", "an unrunnable command became this project's check");
    /* And nothing was recorded about it either: a trial is a measurement of a
       command that ran, and this one did not. */
    assert.equal(stored.trial, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* No confirmation exists for this case. A red suite is a state a project can
   really be in; a string that does not run is never a check. */
test("accepting a failing command cannot store one that never ran", async () => {
  const dir = await project({ build: PASSES });
  try {
    await initProjectForDesktop(dir);
    const trial = trialOf(
      await tryProjectCheck(dir, "hivemind-no-such-command-xyz", { acceptFailing: true })
    );
    assert.equal(trial.outcome, "not_runnable");
    assert.equal(trial.stored, false);
    assert.equal((await storedCommand(dir)).command, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command that passes is stored, with what it did", async () => {
  const dir = await project({ build: PASSES });
  try {
    await initProjectForDesktop(dir);
    const trial = trialOf(await tryProjectCheck(dir, PASSES));
    assert.equal(trial.outcome, "passed");
    assert.equal(trial.stored, true);

    const stored = await storedCommand(dir);
    assert.equal(stored.command, PASSES);
    assert.equal(stored.trial?.outcome, "passed");
    /* Recorded against the command it ran, so a later edit through Settings is
       visibly untried rather than inheriting this result. */
    assert.equal(stored.trial?.command, PASSES);
    assert.equal(typeof stored.trial?.duration_ms, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* A red check is a real state, so it is reported rather than refused -- but
   adopting it takes a second decision, and the trial records the red either
   way so nobody meets it for the first time at the last gate. */
test("a command that runs and fails is reported, and stored only on a second decision", async () => {
  const dir = await project({ build: PASSES });
  try {
    await initProjectForDesktop(dir);
    const first = trialOf(await tryProjectCheck(dir, FAILS));
    assert.equal(first.outcome, "failed");
    assert.equal(first.stored, false);
    assert.equal(first.exit_code, 3);

    const afterFirst = await storedCommand(dir);
    assert.equal(afterFirst.command, "", "a failing command was adopted without being accepted");
    assert.equal(afterFirst.trial?.outcome, "failed");

    const second = trialOf(await tryProjectCheck(dir, FAILS, { acceptFailing: true }));
    assert.equal(second.stored, true);
    assert.equal((await storedCommand(dir)).command, FAILS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adopting a command clears a recorded absence, so the two cannot disagree", async () => {
  const dir = await project({ build: PASSES });
  try {
    await initProjectForDesktop(dir);
    await setProjectConfig(dir, { no_tests_declared: true });
    assert.equal((await storedCommand(dir)).declared, true);
    await tryProjectCheck(dir, PASSES);
    const stored = await storedCommand(dir);
    assert.equal(stored.declared, false);
    assert.equal(stored.command, PASSES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── What counts as a check ────────────────────────────────────────────────
 *
 * Tests are not the only legitimate answer, and for most projects that reach
 * this question they are not the answer that exists. A typecheck or a build
 * catches real breakage.
 */
test("a project with no tests is offered its typecheck and its build", async () => {
  const dir = await project({ build: "vite build", typecheck: "tsc --noEmit" });
  try {
    const candidates = await detectCheckCandidates(dir);
    const kinds = candidates.map((entry) => entry.kind);
    assert.ok(kinds.includes("typecheck"), `no typecheck offered: ${JSON.stringify(candidates)}`);
    assert.ok(kinds.includes("build"));
    /* Stronger guarantee first: a build can pass on code the project's own
       compiler settings reject, so the typecheck is the better offer. */
    assert.ok(kinds.indexOf("typecheck") < kinds.indexOf("build"));
    assert.equal(candidates.find((entry) => entry.kind === "build")?.command, "npm run build");
    assert.equal(candidates.find((entry) => entry.kind === "typecheck")?.command, "npm run typecheck");
    /* Every suggestion says where it came from, because accepting one makes it
       the command every integration runs. */
    assert.ok(candidates.every((entry) => entry.source.trim() !== ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tsconfig with no typecheck script is still offered a typecheck", async () => {
  const dir = await project(
    { dev: "vite" },
    { "tsconfig.json": '{"compilerOptions":{"strict":true}}\n' }
  );
  try {
    const candidates = await detectCheckCandidates(dir);
    assert.deepEqual(
      candidates.map((entry) => ({ command: entry.command, kind: entry.kind })),
      [{ command: "npx tsc --noEmit", kind: "typecheck" }]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a detected test command outranks a build, and the project's package manager is used", async () => {
  const dir = await project(
    { test: "node --test", build: "tsc" },
    { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }
  );
  try {
    const candidates = await detectCheckCandidates(dir);
    assert.equal(candidates[0]?.kind, "tests");
    assert.equal(candidates[0]?.command, "pnpm test");
    assert.equal(candidates.find((entry) => entry.kind === "build")?.command, "pnpm build");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* The classifier boundary: "never ran" has to be distinguishable from "ran and
   failed", because only the second is a real answer about the project. No exit
   code separates them, so a missing script is recognised by what the runner
   printed. */
test("a missing npm script is never-ran, not a failure", async () => {
  const dir = await project({ build: PASSES });
  try {
    const trial = await tryCheckCommand(dir, "npm run nope-not-a-script");
    assert.equal(trial.outcome, "not_runnable");
    assert.match(trial.detail, /does not exist/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* The setup surface asks only while the question is open. A project that
   already has a command gets no suggestions, because a suggestion for a
   settled question is noise. */
test("suggestions stop once the question is answered", async () => {
  const dir = await project({ test: "node --test" });
  try {
    await initProjectForDesktop(dir);
    const { inspectProjectConfig } = await import("../src/config-actions.js");
    const inspected = await inspectProjectConfig(dir);
    assert.equal(inspected.ok, true);
    const value = inspected.ok
      ? (inspected.value as { check_candidates: unknown[] })
      : null;
    assert.deepEqual(value?.check_candidates, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

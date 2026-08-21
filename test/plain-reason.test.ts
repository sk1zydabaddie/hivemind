import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskContract } from "../src/contract.js";
import {
  decideOpOutcome,
  plainDecisionReason,
  type DecisionCause,
  type DecisionConfig
} from "../src/decision.js";
import { plainReason } from "../src/plain-reason.js";

/* Vocabulary this product does not say. The desktop client keeps the same list
 * and refuses to render any Core sentence containing one of these, so a term
 * that reaches `plain_reason` does not reach a person -- it silently replaces a
 * specific diagnosis with a generic one. Asserting it here is what stops that
 * from being discovered on a screenshot months later.
 */
const UNSAYABLE = [
  "lease",
  "canon",
  "oracle",
  "tier-1",
  "tier-2",
  "write-intent",
  "write intent",
  "integrate_shadow",
  "adoption",
  "adopt",
  "execution group",
  "worktree",
  "task_type",
  "routing policy",
  "quality run",
  "admission",
  "provenance",
  "verdict",
  "glob",
  "patch",
  "contract",
  "escalate",
  "merge"
];

const ALL_CAUSES: DecisionCause[] = [
  "allowed",
  "unknown_operation",
  "unresolvable_path",
  "protected_path",
  "outside_allowed_files",
  "delete_forbidden_path",
  "delete_critical_path",
  "symlink",
  "mode_or_metadata_change",
  "git_behavior_file",
  "dependency_file"
];

/* The wall at the end of a first run, and it had no sentence at all.
 *
 * A new person sets the folder up, is shown a composer that says "Describe what
 * you want built", types one, and gets:
 *
 *   adapter profile not found: .hivemind/adapters/planner.profile.json
 *
 * A filesystem path naming a role they have never seen, for a file the setup
 * screen told them they need not think about. It was the last possible place to
 * stop on the cold-open path, and the only one with no plain sentence. */
test("the refusal a first run actually hits names the step, not a path", () => {
  const said = plainReason(
    "adapter profile not found: .hivemind/adapters/planner.profile.json"
  );
  assert.notEqual(said, null, "the first-run refusal must have a sentence");
  assert.ok(
    !/\.hivemind|profile\.json|planner/u.test(said!),
    `a path is not an explanation: ${said}`
  );
  assert.match(said!, /connect/iu, "it has to say what to do next");

  /* A profile that exists but is refused is a DIFFERENT problem with a
     different next step, so it must not collapse into the same sentence. */
  const broken = plainReason("adapter profile must be a JSON object");
  assert.notEqual(broken, said);
  assert.notEqual(broken, null);
});

test("plan acceptance failures describe the rule that actually stopped the plan", () => {
  const duplicate = plainReason(
    "SKELETON_TRAP_ACCEPTANCE: task T-001 deterministic_validity_check must be independent of required_tests"
  );
  const humanBoundary = plainReason(
    "SKELETON_TRAP_ACCEPTANCE: task T-004 is generative and requires a BEHAVIORAL human-judged acceptance_criterion or deterministic_validity_check"
  );

  assert.match(duplicate ?? "", /duplicated a test/iu);
  assert.doesNotMatch(humanBoundary ?? "", /duplicated a test/iu);
  assert.match(humanBoundary ?? "", /person to judge/iu);
});

test("every decision cause has a sentence a person can read", () => {
  for (const cause of ALL_CAUSES) {
    const sentence = plainDecisionReason(cause, { path: "src/ledger.js", op: "add" });
    assert.ok(sentence.trim() !== "", `${cause} produced no sentence`);
    assert.ok(/^[A-Z]/u.test(sentence), `${cause} does not start a sentence: ${sentence}`);
    assert.ok(/[.]$/u.test(sentence), `${cause} does not end a sentence: ${sentence}`);
    for (const term of UNSAYABLE) {
      assert.ok(
        !sentence.toLowerCase().includes(term),
        `${cause} says "${term}", which no surface will render: ${sentence}`
      );
    }
    // It has to name the file, or the person cannot act on it.
    assert.ok(sentence.includes("src/ledger.js"), `${cause} does not name the file: ${sentence}`);
  }
});

test("the cause the gate reports is the rule that actually fired", async () => {
  await withRepo(async (repo) => {
    const cases: Array<{ name: string; filePath: string; op: string; cause: DecisionCause; contract?: Partial<TaskContract>; config?: Partial<DecisionConfig>; createPath?: boolean }> = [
      {
        name: "a file the task was never given",
        filePath: "src/ledger.js",
        op: "add",
        cause: "outside_allowed_files",
        contract: { allowed_files: ["src/other.js"] }
      },
      {
        name: "a dependency manifest needs a human",
        filePath: "package.json",
        op: "modify",
        cause: "dependency_file",
        contract: { allowed_files: ["package.json"] }
      },
      {
        name: "a git behaviour file needs a human",
        filePath: ".gitignore",
        op: "modify",
        cause: "git_behavior_file",
        contract: { allowed_files: [".gitignore"] }
      },
      {
        name: "a symlink is never allowed",
        filePath: "src/link.js",
        op: "symlink",
        cause: "symlink",
        contract: { allowed_files: ["src/link.js"] }
      },
      {
        name: "an unrecognised operation",
        filePath: "src/app.js",
        op: "rename",
        cause: "unknown_operation",
        contract: { allowed_files: ["src/app.js"] }
      },
      {
        name: "a path only a person may change",
        filePath: ".hivemind/canon/notes.md",
        op: "modify",
        cause: "protected_path",
        contract: { allowed_files: [".hivemind/canon/**"] }
      },
      {
        name: "an allowed edit",
        filePath: "src/app.js",
        op: "modify",
        cause: "allowed",
        contract: { allowed_files: ["src/app.js"] }
      }
    ];

    for (const testCase of cases) {
      if (testCase.createPath !== false) await createFixturePath(repo, testCase.filePath);
      const outcome = await decideOpOutcome(
        { path: testCase.filePath, op: testCase.op },
        contractFor(testCase.contract),
        configFor(repo, testCase.config)
      );
      assert.equal(outcome.cause, testCase.cause, testCase.name);
    }
  });
});

test("the two halves never disagree: a refusal always carries a reason for it", async () => {
  await withRepo(async (repo) => {
    await createFixturePath(repo, "src/ledger.js");
    const outcome = await decideOpOutcome(
      { path: "src/ledger.js", op: "add" },
      contractFor({ allowed_files: ["src/other.js"] }),
      configFor(repo)
    );
    assert.equal(outcome.verdict, "reject");
    // A refusal that reported "allowed" would render a sentence saying the
    // opposite of what happened, which is worse than saying nothing.
    assert.notEqual(outcome.cause, "allowed");
    assert.match(plainDecisionReason(outcome.cause, { path: "src/ledger.js", op: "add" }), /create/u);
  });
});

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Fixture task",
    agent_role: "implementer",
    base_commit: "0".repeat(40),
    allowed_files: ["src/**"],
    read_only_files: [],
    forbidden_files: [],
    must_not_change: [],
    acceptance_criterion: "npm test passes",
    required_tests: ["npm test"],
    deterministic_validity_check: null,
    patch_requirements: [],
    depends_on: [],
    ...overrides
  } as TaskContract;
}

function configFor(repo: string, overrides: Partial<DecisionConfig> = {}): DecisionConfig {
  return {
    repo_root: repo,
    allowed_globs: [],
    forbidden_globs: [],
    critical_globs: [],
    ...overrides
  } as DecisionConfig;
}

async function createFixturePath(repo: string, filePath: string): Promise<void> {
  const full = path.join(repo, filePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, "fixture\n", "utf8");
}

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-plain-reason-")));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

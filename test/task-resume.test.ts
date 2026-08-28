import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { checkWriteIntent } from "../src/intent.js";
import { requestLease } from "../src/lease.js";
import { ratifyPlanForExistingTask } from "./support/ratified-plan.js";
import { runTask } from "../src/run.js";
import { resumeTask } from "../src/task-resume.js";
import { createRatifiedSpec } from "./support/spec.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

/**
 * Continuing a paused task, and every reason not to.
 *
 * A quota pause loses nothing -- contract, lease and worktree all survive it --
 * so resuming is allowed to skip re-planning and re-ratifying. What it is not
 * allowed to skip is any gate a fresh run would apply, and the whole value of
 * `resumeTask` is in its refusals rather than in its success. Each one is
 * asserted here against a genuinely paused task, produced by walling the only
 * eligible provider rather than by writing a `task.paused` event by hand.
 *
 * These exist because the guards shipped without them. `task.resume` was built,
 * wired into the dispatcher and put on a queue item, and the only tests that
 * mentioned resuming were about Core's internal quota-reset path, which is a
 * different mechanism. Three walks have found defects in this seam; untested
 * refusals are how the fourth would.
 */

test("a task that is not paused has nothing to pick up", async () => {
  await withPausedTask(async ({ repo }) => {
    /* T-002 exists in the plan but never ran, so there is no pause to resume
       and no partial work to lose. Refusing is the whole point: a resume that
       started an unstarted task would be a run nobody asked for. */
    const result = await resumeTask(repo, "T-002");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not waiting for capacity/u);
  });
});

test("resuming applies the spec gate a fresh run would apply", async () => {
  await withPausedTask(async ({ repo }) => {
    /* The dangerous direction, stated directly: a pause must not become a way
       around ratification. Un-ratifying the spec has to stop the resume even
       though the task itself is untouched and its work is still on disk. */
    const specPath = path.join(repo, ".hivemind", "spec", "S-001.md");
    const spec = await readFile(specPath, "utf8");
    await writeFile(specPath, spec.replace(/^status: ratified$/mu, "status: draft"), "utf8");

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /ratify|draft/iu);
  });
});

test("resuming refuses a task the approved plan no longer contains", async () => {
  await withPausedTask(async ({ repo }) => {
    /* Resuming onto a changed plan would run work nobody ratified. The plan
       artifact is replaced with one that has forgotten T-001; the pause, the
       lease and the worktree are all still exactly as they were. */
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) return;
    const ratification = events.value.filter((event) => event.type === "plan.ratified").at(-1);
    assert.notEqual(ratification, undefined);
    const planPath = path.join(repo, String(ratification?.data.plan_path));
    const plan = JSON.parse(await readFile(planPath, "utf8")) as { tasks: { task_id: string }[] };
    plan.tasks = plan.tasks.filter((task) => task.task_id !== "T-001");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /plan/iu);
      assert.doesNotMatch(result.reason, /not waiting for capacity/u);
    }
  });
});

test("resuming refuses when another task now holds the files", async () => {
  await withPausedTask(async ({ repo }) => {
    /* Two writers on one file is the failure the whole lease arrangement
       exists to prevent, and a paused task is exactly when another task is
       likely to have taken its files. */
    const leasePath = path.join(repo, ".hivemind", "leases", "active.json");
    const raw = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
    const store = (raw.leases ?? raw) as Record<string, string>;
    assert.equal(store["README.md"], "T-001");

    /* T-001 keeps a lease, so this bites the branch that matters -- a task
       that still holds something but no longer holds the file it was editing.
       Losing every lease is a different refusal, asserted below. */
    store["NOTES.md"] = "T-001";
    store["README.md"] = "T-002";
    await writeFile(leasePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Another task is now editing README\.md/u);
      assert.doesNotMatch(result.reason, /not waiting for capacity/u);
    }
  });
});

test("resuming refuses when the task holds no files at all", async () => {
  await withPausedTask(async ({ repo }) => {
    const leasePath = path.join(repo, ".hivemind", "leases", "active.json");
    const raw = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
    const store = (raw.leases ?? raw) as Record<string, string>;
    for (const file of Object.keys(store)) {
      if (store[file] === "T-001") delete store[file];
    }
    await writeFile(leasePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /no longer holds its files/u);
  });
});

test("resuming refuses when the unfinished work is gone", async () => {
  await withPausedTask(async ({ repo }) => {
    /* The premise of resuming is that nothing was lost. Without the worktree
       the partial work is lost, so the honest answer is to say so and send the
       person back to the plan rather than silently starting over. */
    await rm(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true, force: true });

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /gone|cannot be recovered/iu);
  });
});

test("every refusal is a sentence a person can act on", async () => {
  /* The queue item shows this text. A person who has just been told their run
     stopped should not then be shown a field name or a code path. */
  const source = await readFile(path.resolve("src/task-resume.ts"), "utf8");
  const reasons = [...source.matchAll(/reason:\s*(`[^`]+`|"[^"]+")/gu)].map((match) =>
    match[1].slice(1, -1)
  );
  assert.ok(reasons.length >= 5, "the guards must each explain themselves");
  for (const reason of reasons) {
    if (reason.includes("${")) continue;
    assert.doesNotMatch(reason, /_[a-z]|[A-Z][a-z]+[A-Z]/u, `"${reason}" reads like an identifier`);
    assert.match(reason, /^[A-Z].*[.]$/su, `"${reason}" is not a sentence`);
  }
});

test("a resumed task continues rather than re-planning", async () => {
  await withPausedTask(async ({ repo }) => {
    /* A different provider, because the paused one is walled and routing
       rightly refuses to send the resume straight back into the wall. Nothing
       about the plan or the spec is touched, because none of it was lost --
       which is the claim being made. */
    const working = await writeAgent(repo, "resume-agent.mjs", [
      "const { appendFile, readFile } = await import('node:fs/promises');",
      "const current = await readFile('README.md', 'utf8');",
      "if (!current.includes('partial work before the pause')) process.exit(9);",
      "await appendFile('README.md', 'work finished after the pause\\n');"
    ]);
    await writeProfile(repo, "secondary", working);

    const before = (await readEvents(repo)) as { ok: true; value: unknown[] };
    const ratifications = before.value.filter(
      (event) => (event as { type: string }).type === "plan.ratified"
    ).length;

    const result = await resumeTask(repo, "T-001");
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (result.ok) assert.equal(result.value.resumed_from, "paused");

    // The partial work survived, so the resume continued it rather than restarting.
    const readme = await readFile(
      path.join(repo, ".hivemind", "worktrees", "T-001", "README.md"),
      "utf8"
    );
    assert.match(readme, /partial work before the pause/u);
    assert.match(readme, /work finished after the pause/u);

    // And nothing was ratified again, because nothing needed to be.
    const after = await readEvents(repo);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(
        after.value.filter((event) => event.type === "plan.ratified").length,
        ratifications,
        "resuming must not re-ratify a plan that never changed"
      );
    }
  });
});

/**
 * A genuinely paused T-001: partial work on disk, a preserved checkpoint, and
 * a `task.paused` event written by the quota-wall path rather than by hand.
 * T-002 sits in the same plan, unstarted, as the not-paused case.
 */
async function withPausedTask(
  run: (context: { repo: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  await withTemplateRepo(
    "task-resume",
    async (repo) => {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.name", "Hivemind Test"]);
      await git(repo, ["config", "user.email", "hivemind@example.test"]);
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await writeFile(path.join(repo, "NOTES.md"), "# Notes\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "initial"]);
      await initProject(repo);
      await createRatifiedSpec(repo);

      /* Declared, not inherited: the pause below depends on there being no
         other eligible provider, and init's tier ladder supplies two. */
      await rm(path.join(repo, ".hivemind", "adapters", "worker-standard.profile.json"), { force: true });
      await rm(path.join(repo, ".hivemind", "adapters", "worker-cheap.profile.json"), { force: true });
    },
    async (repo) => {
      const baseCommit = (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true })
      ).stdout.trim();

      const agent = await writeAgent(repo, "pausing-agent.mjs", [
        "const { appendFile } = await import('node:fs/promises');",
        "await appendFile('README.md', 'partial work before the pause\\n');",
        "console.error('429 too many requests');",
        "process.exit(1);"
      ]);
      await prepareRatifiedPlan(repo, [planTask("T-001", "README.md"), planTask("T-002", "NOTES.md")]);
      await writeContract(repo, "T-001", baseCommit, ["README.md"]);
      await writeContract(repo, "T-002", baseCommit, ["NOTES.md"]);
      await writeProfile(repo, "primary", agent);
      await grantLease(repo, "T-001", ["README.md"]);

      const paused = await runTask(repo, "T-001", "primary", { predictiveQuotaRecovery: false });
      assert.equal(paused.ok, false);
      if (!paused.ok) assert.match(paused.reason, /task paused awaiting quota reset/u);
      await stat(path.join(repo, ".hivemind", "resource", "checkpoints", "T-001.snapshot.json"));

      await run({ repo, baseCommit });
    },
    "hivemind-task-resume-test-",
    async (repo) => {
      try {
        const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo, windowsHide: true });
        for (const line of listed.stdout.split(/\r?\n/)) {
          if (!line.startsWith("worktree ")) continue;
          const tree = line.slice("worktree ".length).trim();
          if (tree !== repo) {
            await execFileAsync("git", ["worktree", "remove", "--force", tree], { cwd: repo, windowsHide: true }).catch(() => undefined);
          }
        }
      } catch {
        /* nothing to clean */
      }
    }
  );
}

async function prepareRatifiedPlan(repo: string, tasks: Record<string, unknown>[]): Promise<void> {
  const planPath = path.join(repo, "resume-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        tasks,
        execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: tasks.map((task) => task.task_id) }]
      },
      null,
      2
    )}\n`
  );
  const cli = (args: string[]) =>
    execFileAsync(process.execPath, [cliPath, ...args], { cwd: repo, windowsHide: true });
  await cli(["plan", "S-001", "--propose", planPath]);
  await cli(["plan", "S-001", "--ground"]);
  await cli(["plan", "S-001", "--lint"]);
  const review = JSON.parse((await cli(["plan", "S-001", "--review"])).stdout) as { plan_hash: string };
  await appendEvent(repo, {
    type: "plan.prepared",
    task_id: null,
    data: {
      version: 1,
      spec_id: "S-001",
      plan_hash: review.plan_hash,
      plan_path: ".hivemind/plans/S-001.tentative.json",
      proposal_path: "resume-plan.json",
      usage_session_id: "11111111-1111-4111-8111-111111111111",
      status: "awaiting_ratification",
      authorization_effect: "none"
    }
  });
  await cli(["plan", "S-001", "--ratify", review.plan_hash]);
}

function planTask(taskId: string, allowedFile: string): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Plan-backed ${taskId}`,
    task_type: "deterministic",
    routing_task_type: "other",
    mode: "write",
    agent_role: "builder",
    draft_scope: {
      allowed_files: [allowedFile],
      read_only_files: [],
      forbidden_files: [],
      must_not_change: []
    },
    depends_on: [],
    parallel_safe: true,
    acceptance_criterion: `${taskId} completes one deterministic check.`,
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: []
  };
}

async function writeContract(
  repo: string,
  taskId: string,
  baseCommit: string,
  allowedFiles: string[]
): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Run fake adapter and capture diff",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Run fake adapter and capture one diff.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: ["src/gate.ts"],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: ["scope gate", "coordination state"],
        required_tests: ["node -e \"console.log('fake acceptance')\""],
        patch_requirements: ["submit diff only"]
      },
      null,
      2
    )}\n`
  );
  await ratifyPlanForExistingTask(repo, taskId);
}

async function writeProfile(repo: string, tool: string, agentPath: string): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

async function grantLease(repo: string, taskId: string, files: string[]): Promise<void> {
  assert.equal((await requestLease(repo, taskId, files)).ok, true);
  const intent = await checkWriteIntent(repo, taskId, {
    task_id: taskId,
    intended_files: files,
    intended_symbols: [],
    possible_risks: [],
    will_not_change: []
  });
  assert.equal(intent.ok, true);
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

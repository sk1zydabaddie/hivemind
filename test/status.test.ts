import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { analyzeTask } from "../src/analyze.js";
import { appendEvent, readEvents, type HivemindEvent, type HivemindEventType } from "../src/events.js";
import { initProject } from "../src/init.js";
import { integrateShadow } from "../src/integrate.js";
import { checkWriteIntent } from "../src/intent.js";
import { requestLease } from "../src/lease.js";
import { runTask } from "../src/run.js";
import { getStatus, type HivemindStatus, type StatusTask } from "../src/status.js";
import { submitTask } from "../src/submit.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("getStatus returns empty durable state for an initialized repo", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await getStatus(repo);

    assert.deepEqual(result, {
      ok: true,
      value: {
        tasks: [],
        leases: {},
        integration: {
          queue: [],
          status: null
        },
        replans: []
      }
    });
  });
});

test("CLI status prints stable JSON and rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await execFileAsync("node", [cliPath, "status"], {
      cwd: repo,
      windowsHide: true
    });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      tasks: [],
      leases: {},
      integration: {
        queue: [],
        status: null
      },
      replans: []
    });

    await assert.rejects(
      execFileAsync("node", [cliPath, "status", "--table"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind status/);
        return true;
      }
    );
  });
});

test("getStatus reports contracts, leases, event-derived patch state, queue, and integration status", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "outside.txt"), "outside base\n");
    await git(repo, ["add", "outside.txt"]);
    await git(repo, ["commit", "-m", "add outside fixture"]);
    const statusBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    await writeContract(repo, "T-001", "Accepted task", statusBase, ["README.md"]);
    await writeContract(repo, "T-002", "Rejected task", statusBase, ["src/feature.ts"]);
    await requestLease(repo, "T-001", ["README.md"]);
    await requestLease(repo, "T-002", ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-001", statusBase, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\naccepted status patch\n");
    });
    await writePatchFromEdit(repo, "T-002", statusBase, async () => {
      await writeFile(path.join(repo, "outside.txt"), "rejected status patch\n");
    });
    await writeQueue(repo, ["T-001", "T-002"]);
    await writeIntegrationStatus(repo, {
      branch: "integration/20260616-000000000Z",
      applied: ["T-001"],
      tests: "pass",
      report: "status fixture\n"
    });
    const eventsBeforeStatus = await readRequiredEvents(repo);

    const result = await getStatus(repo);
    const eventsAfterStatus = await readRequiredEvents(repo);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(eventsAfterStatus.length, eventsBeforeStatus.length);
    assert.deepEqual(result.value.leases, {
      "README.md": "T-001",
      "src/feature.ts": "T-002"
    });
    assert.deepEqual(result.value.integration.queue, ["T-001", "T-002"]);
    assert.deepEqual(result.value.integration.status?.applied, ["T-001"]);
    assert.equal(result.value.integration.status?.tests, "pass");

    const accepted = task(result.value, "T-001");
    assert.equal(accepted.title, "Accepted task");
    assert.deepEqual(accepted.allowed_files, ["README.md"]);
    assert.deepEqual(accepted.lease, { held: true, files: ["README.md"] });
    assert.equal(accepted.worktree, "missing");
    assert.equal(accepted.patch.bundle, "present");
    assert.equal(accepted.patch.submitted, false);
    assert.equal(accepted.patch.analyzed, false);
    assert.equal(accepted.patch.accepted, false);
    assert.equal(accepted.patch.verdict, null);
    assert.match(accepted.patch.reason, /no patch\.submitted event/);
    assert.equal(accepted.queued, true);
    assert.equal(accepted.integrated, false);

    const rejected = task(result.value, "T-002");
    assert.equal(rejected.patch.bundle, "present");
    assert.equal(rejected.patch.submitted, false);
    assert.equal(rejected.patch.analyzed, false);
    assert.equal(rejected.patch.accepted, false);
    assert.equal(rejected.patch.verdict, null);
    assert.match(rejected.patch.reason, /no patch\.submitted event/);
    assert.equal(rejected.queued, true);
    assert.equal(rejected.integrated, false);
    assert.notEqual(baseCommit, "");
  });
});

test("getStatus reports integrated only from event-backed submitted accepted integration trail", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", "Event-backed task", baseCommit, ["README.md"]);
    await writeIntegrationStatus(repo, {
      branch: "integration/20260616-000000000Z",
      applied: ["T-001"],
      tests: "pass",
      report: "status fixture\n"
    });

    const statusOnly = await getStatus(repo);
    assert.equal(statusOnly.ok, true);
    if (!statusOnly.ok) {
      return;
    }
    assert.equal(task(statusOnly.value, "T-001").integrated, false);

    await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { applied: ["T-001"], tests: "pass" }
    });
    const missingPatchTrail = await getStatus(repo);
    assert.equal(missingPatchTrail.ok, true);
    if (!missingPatchTrail.ok) {
      return;
    }
    assert.equal(task(missingPatchTrail.value, "T-001").integrated, false);

    await appendEvent(repo, {
      type: "patch.submitted",
      task_id: "T-001",
      data: { bundle_path: ".hivemind/patches/T-001", changed_files: 1 }
    });
    await appendEvent(repo, {
      type: "patch.accepted",
      task_id: "T-001",
      data: { verdict: "accept", reason: "accepted fixture" }
    });
    await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { applied: ["T-001"], tests: "pass" }
    });

    const eventBacked = await getStatus(repo);
    assert.equal(eventBacked.ok, true);
    if (!eventBacked.ok) {
      return;
    }
    assert.equal(task(eventBacked.value, "T-001").integrated, true);
  });
});

test("getStatus reports a real patch verdict only after submit and analyze events", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-REAL", "Event-backed patch", baseCommit, ["README.md"]);
    const lease = await requestLease(repo, "T-REAL", ["README.md"]);
    assert.equal(lease.ok, true);
    await approveIntent(repo, "T-REAL", ["README.md"]);
    await writeAgent(repo, "status-real-agent.mjs", [
      "const { writeFile } = await import('node:fs/promises');",
      "await writeFile('README.md', '# Fixture\\nevent-backed status patch\\n');"
    ]);
    await writeProfile(repo, "status-real-worker", path.join(repo, "fake-agents", "status-real-agent.mjs"));
    const run = await runTask(repo, "T-REAL", "status-real-worker");
    assert.equal(run.ok, true);
    if (!run.ok) {
      return;
    }

    const submitted = await submitTask(repo, "T-REAL");
    assert.equal(submitted.ok, true);
    const analyzed = await analyzeTask(repo, "T-REAL");
    assert.deepEqual(analyzed, {
      ok: true,
      value: {
        verdict: "accept",
        reason: "all changes are within scope"
      }
    });

    const result = await getStatus(repo);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const real = task(result.value, "T-REAL");
    assert.equal(real.patch.bundle, "present");
    assert.equal(real.patch.submitted, true);
    assert.equal(real.patch.analyzed, true);
    assert.equal(real.patch.accepted, true);
    assert.equal(real.patch.verdict, "accept");
    assert.equal(real.patch.reason, "all changes are within scope");
    assert.equal(typeof real.patch.submitted_at, "string");
    assert.equal(typeof real.patch.analyzed_at, "string");
  });
});

test("M2.6 MVP gate runs two fake agents in parallel, rejects out-of-scope work, integrates accepted work, and reports status", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeVerifier(repo);
    await git(repo, ["add", "verify-shadow.mjs"]);
    await git(repo, ["commit", "-m", "add verifier"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setConfigTestCommand(repo, "node verify-shadow.mjs");

    await writeContract(repo, "T-001", "Accepted README change", integrationBase, ["README.md"]);
    await writeContract(repo, "T-002", "Rejected out-of-scope change", integrationBase, ["src/feature.ts"]);
    await writeAgent(repo, "agent-accepted.mjs", [
      "const { writeFile } = await import('node:fs/promises');",
      "await writeFile('README.md', '# Fixture\\naccepted by fake agent\\n');"
    ]);
    await writeAgent(repo, "agent-rejected.mjs", [
      "const { writeFile } = await import('node:fs/promises');",
      "await writeFile('outside.txt', 'out of scope from fake agent\\n');"
    ]);
    await writeProfile(repo, "fake-accepted", path.join(repo, "fake-agents", "agent-accepted.mjs"));
    await writeProfile(repo, "fake-rejected", path.join(repo, "fake-agents", "agent-rejected.mjs"));

    const worktrees = await Promise.all([createTaskWorktree(repo, "T-001"), createTaskWorktree(repo, "T-002")]);
    assert.equal(worktrees.every((result) => result.ok), true);

    const leaseResults = await Promise.all([requestLease(repo, "T-001", ["README.md"]), requestLease(repo, "T-002", ["src/feature.ts"])]);
    assert.equal(leaseResults.every((result) => result.ok), true);
    await approveIntent(repo, "T-001", ["README.md"]);
    await approveIntent(repo, "T-002", ["src/feature.ts"]);
    const rejectedLease = await requestLease(repo, "T-002", ["README.md"]);
    assert.equal(rejectedLease.ok, false);

    const runResults = await Promise.all([runTask(repo, "T-001", "fake-accepted"), runTask(repo, "T-002", "fake-rejected")]);
    assert.equal(runResults.every((result) => result.ok), true);
    await submitTask(repo, "T-001");
    await submitTask(repo, "T-002");

    const accepted = await analyzeTask(repo, "T-001");
    const rejected = await analyzeTask(repo, "T-002");

    assert.deepEqual(accepted, {
      ok: true,
      value: {
        verdict: "accept",
        reason: "all changes are within scope"
      }
    });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) {
      return;
    }
    assert.equal(rejected.value.verdict, "reject");
    assert.match(rejected.value.reason, /outside\.txt/);

    await writeQueue(repo, ["T-001", "T-002"]);
    await setConfigTestCommand(repo, "node -e \"process.exit(9)\"");
    const failedIntegration = await integrateShadow(repo);
    assert.equal(failedIntegration.ok, true);
    if (!failedIntegration.ok) {
      return;
    }
    assert.equal(failedIntegration.value.tests, "fail");

    await setConfigTestCommand(repo, "node verify-shadow.mjs");
    const integrated = await integrateShadow(repo);

    assert.equal(integrated.ok, true);
    if (!integrated.ok) {
      return;
    }
    assert.deepEqual(integrated.value.applied, ["T-001"]);
    assert.equal(integrated.value.tests, "pass");
    assert.equal(await branchExists(repo, integrated.value.branch), false);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "README.md"), "utf8")), "# Fixture\n");
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), integrationBase);
    assert.notEqual(baseCommit, "");

    const status = await getStatus(repo);
    assert.equal(status.ok, true);
    if (!status.ok) {
      return;
    }

    const acceptedStatus = task(status.value, "T-001");
    const rejectedStatus = task(status.value, "T-002");
    assert.equal(acceptedStatus.patch.submitted, true);
    assert.equal(acceptedStatus.patch.analyzed, true);
    assert.equal(acceptedStatus.patch.accepted, true);
    assert.equal(acceptedStatus.patch.verdict, "accept");
    assert.equal(acceptedStatus.integrated, true);
    assert.equal(rejectedStatus.patch.submitted, true);
    assert.equal(rejectedStatus.patch.analyzed, true);
    assert.equal(rejectedStatus.patch.accepted, false);
    assert.equal(rejectedStatus.patch.verdict, "reject");
    assert.match(rejectedStatus.patch.reason, /outside\.txt/);
    assert.equal(rejectedStatus.integrated, false);
    assert.deepEqual(status.value.integration.queue, ["T-001", "T-002"]);
    assert.deepEqual(status.value.integration.status?.applied, ["T-001"]);
    assert.equal(status.value.integration.status?.tests, "pass");

    const eventsBeforeStatus = await readRequiredEvents(repo);
    await getStatus(repo);
    const eventsAfterStatus = await readRequiredEvents(repo);
    assert.equal(eventsAfterStatus.length, eventsBeforeStatus.length);
    assertEventOrder(
      eventsAfterStatus.map((event) => event.type),
      [
        "task.created",
        "lease.approved",
        "lease.rejected",
        "patch.submitted",
        "patch.accepted",
        "patch.rejected",
        "integration.failed",
        "integration.passed"
      ]
    );
    assert.equal(eventsAfterStatus.every((event) => typeof event.ts === "string" && Date.parse(event.ts) > 0), true);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-status-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'base';\n");
    await git(repo, ["add", "README.md", "src/feature.ts"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function writeVerifier(repo: string): Promise<void> {
  await writeFile(
    path.join(repo, "verify-shadow.mjs"),
    [
      "import { readFile } from 'node:fs/promises';",
      "const readme = await readFile('README.md', 'utf8');",
      "if (!readme.includes('accepted by fake agent')) process.exit(10);"
    ].join("\n")
  );
}

async function setConfigTestCommand(repo: string, testCommand: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeContract(repo: string, taskId: string, title: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title,
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Status fixture reports one task state.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function approveIntent(repo: string, taskId: string, files: string[]): Promise<void> {
  const result = await checkWriteIntent(repo, taskId, {
    task_id: taskId,
    intended_files: files
  });
  assert.equal(result.ok, true);
}

async function writePatchFromEdit(repo: string, taskId: string, baseCommit: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, ["reset", "--hard", baseCommit]);
  await edit();
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
}

async function writeQueue(repo: string, taskIds: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "integration", "queue.json"),
    `${JSON.stringify(taskIds.map((taskId) => ({ task_id: taskId })), null, 2)}\n`
  );
}

async function writeIntegrationStatus(repo: string, status: { branch: string; applied: string[]; tests: "pass" | "fail"; report: string }): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "integration", "status.json"), `${JSON.stringify(status, null, 2)}\n`);
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
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
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 10
      },
      null,
      2
    )}\n`
  );
}

function task(status: HivemindStatus, taskId: string): StatusTask {
  const found = status.tasks.find((entry) => entry.task_id === taskId);
  if (found === undefined) {
    throw new Error(`missing task ${taskId}`);
  }
  return found;
}

async function readRequiredEvents(repo: string): Promise<HivemindEvent[]> {
  const events = await readEvents(repo);
  assert.equal(events.ok, true);
  if (!events.ok) {
    return [];
  }
  return events.value;
}

function assertEventOrder(actual: HivemindEventType[], expected: HivemindEventType[]): void {
  let cursor = 0;
  for (const type of actual) {
    if (type === expected[cursor]) {
      cursor += 1;
    }
    if (cursor === expected.length) {
      return;
    }
  }
  assert.fail(`event order missing subsequence: ${expected.join(", ")} in ${actual.join(", ")}`);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await gitStdout(repo, ["branch", "--list", branch])) !== "";
}

async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

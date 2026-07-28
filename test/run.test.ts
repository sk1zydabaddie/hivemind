import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { checkWriteIntent } from "../src/intent.js";
import { readActiveLeases, requestLease, requestLeaseForContract } from "../src/lease.js";
import { runTask } from "../src/run.js";
import { analyzeTask } from "../src/analyze.js";
import { appendEvent, readEvents } from "../src/events.js";
import { recordQuotaUsage } from "../src/resource-ledger.js";
import { submitTask } from "../src/submit.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("runTask captures an untracked worker-created file in diff.patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "create-file-agent.mjs", [
      "await import('node:fs/promises').then(({ writeFile }) => writeFile('new-file.txt', 'created by fake agent\\n'));"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["new-file.txt"], { "new-file.txt": "create" });
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["new-file.txt"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_id, "T-001");
    assert.equal(result.value.status, "completed");
    assert.equal(result.value.tool, "fake");
    assert.equal(result.value.tool_exit, 0);
    assert.equal(result.value.changed_files, 1);
    assert.equal(result.value.diff_path, path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /diff --git a\/new-file\.txt b\/new-file\.txt/);
    assert.match(diff, /\+created by fake agent/);
    assert.doesNotMatch(diff, /agent\.log/);
  });
});

test("runTask lease-before-run accepts a contract-backed create lease", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "contract-create-agent.mjs", [
      "await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir('src', { recursive: true }).then(() => writeFile('src/new-file.ts', 'export const created = true;\\n')));"
    ]);
    await writeContract(repo, "T-CREATE", baseCommit, ["src/new-file.ts"], { "src/new-file.ts": "create" });
    await writeProfile(repo, "fake", agentPath);

    const lease = await requestLeaseForContract(repo, "T-CREATE");
    assert.equal(lease.ok, true);
    const intent = await checkWriteIntent(repo, "T-CREATE", {
      task_id: "T-CREATE",
      intended_files: ["src/new-file.ts"],
      intended_symbols: [],
      possible_risks: [],
      will_not_change: []
    });
    assert.equal(intent.ok, true);

    const result = await runTask(repo, "T-CREATE", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /diff --git a\/src\/new-file\.ts b\/src\/new-file\.ts/);
    assert.match(diff, /\+export const created = true;/);
  });
});

test("runTask refuses a plan-backed dependent task until dependencies are event-integrated", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "dependency-bypass-agent.mjs", [
      "const { writeFile } = await import('node:fs/promises');",
      "await writeFile('README.md', '# Fixture\\ndependency bypass worker ran\\n');"
    ]);
    await prepareLintedPlanWithTasks(repo, [
      planTask("T-BASE", "README.md"),
      planTask("T-DEP", "README.md", ["T-BASE"])
    ]);
    await writeContract(repo, "T-DEP", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    const lease = await requestLease(repo, "T-DEP", ["README.md"]);
    assert.equal(lease.ok, true);
    const intent = await checkWriteIntent(repo, "T-DEP", {
      task_id: "T-DEP",
      intended_files: ["README.md"],
      intended_symbols: [],
      possible_risks: [],
      will_not_change: []
    });
    assert.equal(intent.ok, true);

    const blocked = await runTask(repo, "T-DEP", "fake");
    assert.equal(blocked.ok, false);
    if (blocked.ok) {
      return;
    }
    assert.match(blocked.reason, /task T-DEP depends_on not integrated: T-BASE/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-DEP"));

    await appendIntegratedDependencyEvents(repo, "T-BASE");
    const allowed = await runTask(repo, "T-DEP", "fake");
    assert.equal(allowed.ok, true);
    if (!allowed.ok) {
      return;
    }
    assert.equal(allowed.value.changed_files, 1);
  });
});

test("runTask refuses to invoke an agent without a covering active lease", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "should-not-run-without-lease.mjs", [
      "await import('node:fs/promises').then(({ writeFile }) => writeFile('README.md', '# Fixture\\nagent ran without lease\\n'));"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);

    const noLease = await runTask(repo, "T-001", "fake");

    assert.equal(noLease.ok, false);
    if (noLease.ok) {
      return;
    }
    assert.match(noLease.reason, /active lease does not cover task allowed_files/);
    assert.match(noLease.reason, /README\.md is not leased/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));

    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "extra.ts"), "export const extra = true;\n");
    await git(repo, ["add", "src/extra.ts"]);
    await git(repo, ["commit", "-m", "add extra"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-002", nextBase, ["README.md", "src/extra.ts"]);
    await grantLease(repo, "T-002", ["README.md"]);

    const partialLease = await runTask(repo, "T-002", "fake");

    assert.equal(partialLease.ok, false);
    if (partialLease.ok) {
      return;
    }
    assert.match(partialLease.reason, /src\/extra\.ts is not leased/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-002"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-002", "diff.patch"));
  });
});

test("runTask writes an empty diff when the adapter makes no changes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "noop-agent.mjs", ["console.log('no changes');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool_exit, 0);
    assert.equal(result.value.changed_files, 0);
    assert.equal(await readFile(result.value.diff_path, "utf8"), "");
  });
});

test("runTask captures diff but returns failure when the adapter exits non-zero", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "nonzero-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before nonzero exit\\n');",
      "console.error('worker process diagnostic');",
      "process.exit(7);"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worker fake exited 7/);
    assert.match(result.reason, /worker process diagnostic/);
    assert.match(result.reason, /agent\.log/);
    assert.match(result.reason, /1 changed file/);
    assert.match(await readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "utf8"), /\+changed before nonzero exit/);
    const leases = await readActiveLeases(repo);
    assert.equal(leases.ok, true);
    if (!leases.ok) {
      return;
    }
    assert.equal(leases.store["README.md"], undefined);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assertEventOrder(events.value.map((event) => event.type), ["lease.released", "task.failed"]);
    const failed = events.value.find((event) => event.type === "task.failed" && event.task_id === "T-001");
    assert.deepEqual(failed?.data.lease_released, ["README.md"]);
  });
});

test("runTask captures diff but returns failure when the adapter times out", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "timeout-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before timeout\\n');",
      "setInterval(() => undefined, 1000);"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath, 50);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worker fake exited 124/);
    assert.match(result.reason, /1 changed file/);
    assert.match(await readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "utf8"), /\+changed before timeout/);
    const log = await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"), "utf8");
    assert.match(log, /timed_out: true/);
    const leases = await readActiveLeases(repo);
    assert.equal(leases.ok, true);
    if (!leases.ok) {
      return;
    }
    assert.equal(leases.store["README.md"], undefined);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assertEventOrder(events.value.map((event) => event.type), ["lease.released", "task.failed"]);
    const failed = events.value.find((event) => event.type === "task.failed" && event.task_id === "T-001");
    assert.deepEqual(failed?.data.lease_released, ["README.md"]);
  });
});

test("runTask recovers a stale lease lock while surfacing a crashed worker failure", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "stale-lock-crash-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before stale lock cleanup\\n');",
      "process.exit(9);"
    ]);
    await writeContract(repo, "T-STALE", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-STALE", ["README.md"]);
    const exitedPid = await createExitedProcessPid();
    await writeFile(
      path.join(repo, ".hivemind", "leases", "active.lock"),
      `${JSON.stringify({ version: 1, lock_id: randomUUID(), pid: exitedPid })}\n`
    );

    const result = await runTask(repo, "T-STALE", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worker fake exited 9/);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.lock"));
    const leases = await readActiveLeases(repo);
    assert.equal(leases.ok, true);
    if (!leases.ok) {
      return;
    }
    assert.equal(leases.store["README.md"], undefined);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assertEventOrder(events.value.map((event) => event.type), ["lease.released", "task.failed"]);
    const failed = events.value.find((event) => event.type === "task.failed" && event.task_id === "T-STALE");
    assert.deepEqual(failed?.data.lease_released, ["README.md"]);
  });
});

test("runTask partial failure does not collapse a sibling worker", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "sibling.txt"), "sibling base\n");
    await git(repo, ["add", "src/sibling.txt"]);
    await git(repo, ["commit", "-m", "add sibling file"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    const failingAgent = await writeAgent(repo, "parallel-failing-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'failed task changed before crash\\n');",
      "process.exit(5);"
    ]);
    const survivingAgent = await writeAgent(repo, "parallel-surviving-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "await appendFile('src/sibling.txt', 'surviving task completed\\n');"
    ]);
    await writeContract(repo, "T-FAIL", nextBase, ["README.md"]);
    await writeContract(repo, "T-OK", nextBase, ["src/sibling.txt"]);
    await writeProfile(repo, "failing", failingAgent);
    await writeProfile(repo, "surviving", survivingAgent);
    await grantLease(repo, "T-FAIL", ["README.md"]);
    await grantLease(repo, "T-OK", ["src/sibling.txt"]);

    const [failed, survived] = await Promise.all([runTask(repo, "T-FAIL", "failing"), runTask(repo, "T-OK", "surviving")]);

    assert.equal(failed.ok, false);
    if (failed.ok) {
      return;
    }
    assert.match(failed.reason, /worker failing exited 5/);
    assert.equal(survived.ok, true);
    if (!survived.ok) {
      return;
    }
    assert.equal(survived.value.status, "completed");
    assert.equal(survived.value.changed_files, 1);
    assert.match(await readFile(survived.value.diff_path, "utf8"), /\+surviving task completed/);
    const leases = await readActiveLeases(repo);
    assert.equal(leases.ok, true);
    if (!leases.ok) {
      return;
    }
    assert.equal(leases.store["README.md"], undefined);
    assert.equal(leases.store["src/sibling.txt"], "T-OK");
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-FAIL"), true);
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-OK"), true);
    assert.equal(events.value.some((event) => event.task_id === "T-OK" && event.type === "task.failed"), false);
  });
});

test("CLI run prints stable JSON", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "cli-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by cli fake agent\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as {
      task_id: string;
      status: string;
      tool: string;
      diff_path: string;
      tool_exit: number;
      changed_files: number;
    };

    assert.equal(result.stderr, "");
    assert.deepEqual(parsed, {
      task_id: "T-001",
      status: "completed",
      tool: "fake",
      diff_path: path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"),
      tool_exit: 0,
      changed_files: 1
    });
    assert.match(await readFile(parsed.diff_path, "utf8"), /\+changed by cli fake agent/);
  });
});

test("CLI run auto-routes to the cheapest Low-tier provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const localAgent = await writeAgent(repo, "local-auto-route-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by local auto route\\n');"
    ]);
    const strongAgent = await writeAgent(repo, "strong-auto-route-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by strong auto route\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { low_globs: ["README.md"] });
    await writeProfile(repo, "local", localAgent, undefined, false, "local", 1);
    await writeProfile(repo, "strong", strongAgent, undefined, false, "strong", 20);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await execFileAsync("node", [cliPath, "run", "T-001"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { tool: string; diff_path: string };

    assert.equal(result.stderr, "");
    assert.equal(parsed.tool, "local");
    const diff = await readFile(parsed.diff_path, "utf8");
    assert.match(diff, /\+changed by local auto route/);
    assert.doesNotMatch(diff, /strong auto route/);
  });
});

test("runTask reacts to a quota wall by checkpointing and resuming on another provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const primaryAgent = await writeAgent(repo, "quota-wall-primary-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'partial work before quota wall\\n');",
      "console.error('429 too many requests');",
      "process.exit(1);"
    ]);
    const secondaryAgent = await writeAgent(repo, "quota-wall-secondary-agent.mjs", [
      "const { readFile, appendFile } = await import('node:fs/promises');",
      "const current = await readFile('README.md', 'utf8');",
      "if (!current.includes('partial work before quota wall')) process.exit(9);",
      "await appendFile('README.md', 'resumed work after quota wall\\n');"
    ]);
    await prepareLintedPlanWithTasks(repo, [planTask("T-001", "README.md")]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "primary", primaryAgent, undefined, false, "strong", 1);
    await writeProfile(repo, "secondary", secondaryAgent, undefined, false, "strong", 2);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "primary", { predictiveQuotaRecovery: false });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool, "secondary");
    assert.equal(result.value.tool_exit, 0);
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /\+partial work before quota wall/);
    assert.match(diff, /\+resumed work after quota wall/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.checkpointed" && event.task_id === "T-001"), true);
    const rerouted = events.value.find((event) => event.type === "task.rerouted" && event.task_id === "T-001");
    assert.notEqual(rerouted, undefined);
    assert.equal(rerouted?.data.mode, "reactive");
    assert.equal(rerouted?.data.from_tool, "primary");
    assert.equal(rerouted?.data.to_tool, "secondary");
    assert.equal("provider_session" in (rerouted?.data ?? {}), false);
    assert.equal(events.value.some((event) => event.type === "task.resumed" && event.task_id === "T-001"), true);
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-001"), false);
  });
});

test("runTask pauses and preserves a checkpoint when no eligible quota-wall provider remains", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const primaryAgent = await writeAgent(repo, "quota-wall-no-provider-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'partial work before no-provider quota pause\\n');",
      "console.error('429 too many requests');",
      "process.exit(1);"
    ]);
    await prepareLintedPlanWithTasks(repo, [planTask("T-001", "README.md")]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "primary", primaryAgent, undefined, false, "strong", 1);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "primary", { predictiveQuotaRecovery: false });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /task paused awaiting quota reset/);
    const checkpointPath = path.join(repo, ".hivemind", "resource", "checkpoints", "T-001.snapshot.json");
    assert.equal((await stat(checkpointPath)).isFile(), true);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "README.md"), "utf8"), /partial work before no-provider quota pause/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.checkpointed" && event.task_id === "T-001"), true);
    const paused = events.value.find((event) => event.type === "task.paused" && event.task_id === "T-001");
    assert.notEqual(paused, undefined);
    assert.equal(paused?.data.reason, "quota_exhausted");
    assert.equal(paused?.data.source, "quota-wall-recovery");
    assert.equal(paused?.data.snapshot_path, ".hivemind/resource/checkpoints/T-001.snapshot.json");
    assert.deepEqual(paused?.data.providers_walled, ["primary"]);
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-001"), false);
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-001"), false);
  });
});

test("runTask resumes a quota-paused task from its preserved checkpoint when a provider becomes eligible", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const primaryAgent = await writeAgent(repo, "quota-pause-primary-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'partial work preserved across quota pause\\n');",
      "console.error('429 too many requests');",
      "process.exit(1);"
    ]);
    const secondaryAgent = await writeAgent(repo, "quota-pause-secondary-agent.mjs", [
      "const { readFile, appendFile } = await import('node:fs/promises');",
      "const current = await readFile('README.md', 'utf8');",
      "if (!current.includes('partial work preserved across quota pause')) process.exit(9);",
      "await appendFile('README.md', 'continued after quota reset\\n');"
    ]);
    await prepareLintedPlanWithTasks(repo, [planTask("T-001", "README.md")]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "primary", primaryAgent, undefined, false, "strong", 1);
    await grantLease(repo, "T-001", ["README.md"]);

    const paused = await runTask(repo, "T-001", "primary", { predictiveQuotaRecovery: false });
    assert.equal(paused.ok, false);
    if (paused.ok) {
      return;
    }
    assert.match(paused.reason, /task paused awaiting quota reset/);
    const checkpointPath = path.join(repo, ".hivemind", "resource", "checkpoints", "T-001.snapshot.json");
    const checkpointBefore = await readFile(checkpointPath, "utf8");

    await writeProfile(repo, "secondary", secondaryAgent, undefined, false, "strong", 2);
    const resumed = await runTask(repo, "T-001", "secondary", { predictiveQuotaRecovery: false });

    assert.equal(resumed.ok, true);
    if (!resumed.ok) {
      return;
    }
    assert.equal(resumed.value.tool, "secondary");
    assert.equal(resumed.value.changed_files, 1);
    const diff = await readFile(resumed.value.diff_path, "utf8");
    assert.match(diff, /\+partial work preserved across quota pause/);
    assert.match(diff, /\+continued after quota reset/);
    assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.paused" && event.task_id === "T-001"), true);
    assert.equal(events.value.some((event) => event.type === "task.resumed" && event.task_id === "T-001" && event.data.source === "quota-reset-resume"), true);
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-001"), false);
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-001"), true);
  });
});

test("runTask predictive quota reroute is non-authoritative and only causes an unnecessary provider switch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const primaryAgent = await writeAgent(repo, "predictive-primary-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'primary would have completed\\n');"
    ]);
    const secondaryAgent = await writeAgent(repo, "predictive-secondary-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'secondary completed after predictive reroute\\n');"
    ]);
    await prepareLintedPlanWithTasks(repo, [planTask("T-001", "README.md")]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "primary", primaryAgent, undefined, false, "strong", 1);
    await writeProfile(repo, "secondary", secondaryAgent, undefined, false, "strong", 2);
    await recordQuotaUsage(repo, {
      provider: "primary",
      input_text: "previous prompt",
      model_output_text: "429 too many requests",
      wall_time_ms: 1,
      throttled: true
    });
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "primary");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool, "secondary");
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /\+secondary completed after predictive reroute/);
    assert.doesNotMatch(diff, /primary would have completed/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const rerouted = events.value.find((event) => event.type === "task.rerouted" && event.task_id === "T-001");
    assert.notEqual(rerouted, undefined);
    assert.equal(rerouted?.data.mode, "predictive");
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-001"), false);
  });
});

test("runTask rejects explicit below-floor provider before invocation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "weak-critical-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('src/schema.ts', 'weak provider should not run\\n');"
    ]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "schema.ts"), "export const schema = true;\n");
    await git(repo, ["add", "src/schema.ts"]);
    await git(repo, ["commit", "-m", "add schema"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-CRIT", nextBase, ["src/schema.ts"]);
    await writeConfig(repo, { critical_globs: ["src/schema.ts"] });
    await writeProfile(repo, "weak", agentPath, undefined, false, "standard", 1);
    await grantLease(repo, "T-CRIT", ["src/schema.ts"]);

    const result = await runTask(repo, "T-CRIT", "weak");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /below required floor for critical task tier/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-CRIT"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-CRIT", "diff.patch"));
  });
});

test("runTask pauses before invocation when request ceiling is already exhausted", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "request-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'request ceiling should block this\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { requests: 0 } } });
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: request ceiling 0/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask pauses before invocation when adapter timeout exceeds wall-time ceiling", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "timeout-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'timeout ceiling should block this\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { wall_time_ms: 1 } } });
    await writeProfile(repo, "fake", agentPath, 50);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: fake timeout 50ms exceeds wall-time ceiling 1ms/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask pauses after invocation when actual wall time exceeds the ceiling", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "actual-wall-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await new Promise((resolve) => setTimeout(resolve, 25));",
      "await appendFile('README.md', 'changed before wall ceiling pause\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { wall_time_ms: 1 } } });
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: wall-time ceiling 1ms exceeded/);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "README.md"), "utf8"), /changed before wall ceiling pause/);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"), "utf8"), /exit_code: 0/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask stops after invocation when effective token usage exceeds the ceiling", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "token-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before token ceiling stop\\n');",
      "console.log('provider output');",
      "console.error('tokens used\\n2,000');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { tokens: 1000 } } });
    await writeProfile(repo, "fake", agentPath, undefined, false, "strong", 10, "codex-text");
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /token budget exceeded: fake call used 2000 effective tokens against run ceiling 1000/);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "README.md"), "utf8"), /changed before token ceiling stop/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-001"), false);
    assert.equal(
      events.value.some(
        (event) =>
          event.type === "task.failed" &&
          event.task_id === "T-001" &&
          String(event.data.reason).includes("token budget exceeded")
      ),
      true
    );
  });
});

test("CLI run requires explicit approval for dangerous adapter flags", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "dangerous-cli-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by approved dangerous cli fake agent\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath, undefined, true);
    await grantLease(repo, "T-001", ["README.md"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /dangerous invocation flags/);
        return true;
      }
    );

    const result = await execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake", "--allow-dangerous-adapter"], {
      cwd: repo,
      windowsHide: true
    });

    const parsed = JSON.parse(result.stdout) as { changed_files: number; tool_exit: number; diff_path: string };
    assert.equal(parsed.tool_exit, 0);
    assert.equal(parsed.changed_files, 1);
    assert.match(await readFile(parsed.diff_path, "utf8"), /\+changed by approved dangerous cli fake agent/);
  });
});

test("CLI run rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "run"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.notEqual(error, null);
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind run <id> \[--tool <tool>\]/);
        return true;
      }
    );
  });
});

test("runTask returns a scoped error when the adapter profile is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "missing");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /adapter profile not found/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask rejects an existing dirty worktree before invoking the adapter", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "should-not-run-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'agent should not run\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const firstRun = await runTask(repo, "T-001", "fake");
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) {
      return;
    }
    const previousPatch = await readFile(firstRun.value.diff_path, "utf8");

    const secondRun = await runTask(repo, "T-001", "fake");

    assert.equal(secondRun.ok, false);
    if (secondRun.ok) {
      return;
    }
    assert.match(secondRun.reason, /existing changes/);
    assert.match(secondRun.reason, /README\.md/);
    assert.equal(await readFile(firstRun.value.diff_path, "utf8"), previousPatch);
  });
});

test("rejected patch analysis resets only that task worktree so a corrected worker can rerun", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeFile(path.join(repo, "other.txt"), "other base\n");
    await git(repo, ["add", "other.txt"]);
    await git(repo, ["commit", "-m", "add other fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    const outOfScopeAgent = await writeAgent(repo, "out-of-scope-agent.mjs", [
      "const { mkdir, writeFile } = await import('node:fs/promises');",
      "await mkdir('src', { recursive: true });",
      "await writeFile('src/ledger.js', 'out of scope\\n');"
    ]);
    const inScopeAgent = await writeAgent(repo, "in-scope-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'corrected in-scope retry\\n');"
    ]);
    await writeContract(repo, "T-RETRY", baseCommit, ["README.md"]);
    await writeContract(repo, "T-OTHER", baseCommit, ["other.txt"]);
    await writeProfile(repo, "fake", outOfScopeAgent);
    await grantLease(repo, "T-RETRY", ["README.md"]);
    await grantLease(repo, "T-OTHER", ["other.txt"]);
    const otherWorktree = await createTaskWorktree(repo, "T-OTHER");
    assert.equal(otherWorktree.ok, true);
    if (!otherWorktree.ok) {
      return;
    }
    await writeFile(path.join(otherWorktree.value.worktree, "other.txt"), "other task dirty sentinel\n");
    const leasesBeforeReject = await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8");

    const firstRun = await runTask(repo, "T-RETRY", "fake");
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) {
      return;
    }
    assert.match(await readFile(firstRun.value.diff_path, "utf8"), /src\/ledger\.js/);
    const submitted = await submitTask(repo, "T-RETRY");
    assert.equal(submitted.ok, true);
    const rejected = await analyzeTask(repo, "T-RETRY");

    assert.equal(rejected.ok, true);
    if (!rejected.ok) {
      return;
    }
    assert.equal(rejected.value.verdict, "reject");
    assert.match(rejected.value.reason, /src\/ledger\.js/);
    assert.deepEqual(await dirtyPaths(path.join(repo, ".hivemind", "worktrees", "T-RETRY")), []);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-RETRY", "src", "ledger.js"));
    assert.deepEqual(await dirtyPaths(otherWorktree.value.worktree), ["other.txt"]);
    assert.equal(await readFile(path.join(otherWorktree.value.worktree, "other.txt"), "utf8"), "other task dirty sentinel\n");
    assert.equal(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8"), leasesBeforeReject);
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# Fixture\n");
    await assertMissing(path.join(repo, "src", "ledger.js"));

    await writeProfile(repo, "fake", inScopeAgent);
    const retryRun = await runTask(repo, "T-RETRY", "fake");

    assert.equal(retryRun.ok, true);
    if (!retryRun.ok) {
      return;
    }
    assert.equal(retryRun.value.changed_files, 1);
    const retryDiff = await readFile(retryRun.value.diff_path, "utf8");
    assert.match(retryDiff, /README\.md/);
    assert.match(retryDiff, /\+corrected in-scope retry/);
    assert.doesNotMatch(retryDiff, /src\/ledger\.js/);
  });
});

test("runTask allows rerun when only the Hivemind-owned agent.log remains", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "noop-rerun-agent.mjs", ["console.log('rerun ok');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const firstRun = await runTask(repo, "T-001", "fake");
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) {
      return;
    }

    const secondRun = await runTask(repo, "T-001", "fake");

    assert.equal(secondRun.ok, true);
    if (!secondRun.ok) {
      return;
    }
    assert.equal(secondRun.value.changed_files, 0);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-run-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
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

function assertEventOrder(events: string[], orderedTypes: string[]): void {
  let cursor = 0;
  for (const type of events) {
    if (type === orderedTypes[cursor]) {
      cursor += 1;
    }
    if (cursor === orderedTypes.length) {
      return;
    }
  }
  assert.fail(`expected event order ${orderedTypes.join(" -> ")} in ${events.join(", ")}`);
}

async function createExitedProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true
  });
  const pid = child.pid;
  assert.notEqual(pid, undefined);
  await once(child, "exit");
  return pid as number;
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

async function writeContract(
  repo: string,
  taskId: string,
  baseCommit: string,
  allowedFiles: string[],
  allowedFileIntents?: Record<string, string>
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
        base_commit: baseCommit,
        acceptance_criterion: "Run fake adapter and capture one diff.",
        allowed_files: allowedFiles,
        ...(allowedFileIntents === undefined ? {} : { allowed_file_intents: allowedFileIntents }),
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
}

async function prepareLintedPlanWithTasks(repo: string, tasks: Record<string, unknown>[]): Promise<void> {
  const planPath = path.join(repo, "dependency-plan.json");
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
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
}

function planTask(taskId: string, allowedFile: string, dependsOn: string[] = []): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Plan-backed ${taskId}`,
    mode: "write",
    agent_role: "builder",
    draft_scope: {
      allowed_files: [allowedFile],
      read_only_files: [],
      forbidden_files: [],
      must_not_change: []
    },
    depends_on: dependsOn,
    parallel_safe: true,
    acceptance_criterion: `${taskId} completes one deterministic check.`,
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: []
  };
}

async function appendIntegratedDependencyEvents(repo: string, taskId: string): Promise<void> {
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { bundle_path: `.hivemind/patches/${taskId}`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "accepted dependency fixture" }
  });
  await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: { applied: [taskId], tests: "pass" }
  });
}

async function writeConfig(repo: string, overrides: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        stack: "typescript-node",
        repo_root: repo,
        test_command: "",
        allowed_globs: [],
        forbidden_globs: [],
        ...overrides
      },
      null,
      2
    )}\n`
  );
}

async function writeProfile(
  repo: string,
  tool: string,
  agentPath: string,
  timeoutMs?: number,
  dangerous = false,
  routingTier = "strong",
  costRank = 10,
  usageParser?: "codex-text"
): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const profile = {
    tool,
    invoke: dangerous ? ["node", agentPath, "--dangerously-skip-permissions"] : ["node", agentPath],
    prompt_arg: "stdin",
    verified_on: "2026-06-15",
    context_window: 1024,
    routing_tier: routingTier,
    cost_rank: costRank,
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    ...(usageParser === undefined ? {} : { usage_parser: usageParser })
  };
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

async function grantLease(repo: string, taskId: string, files: string[]): Promise<void> {
  const result = await requestLease(repo, taskId, files);
  assert.equal(result.ok, true);
  const intent = await checkWriteIntent(repo, taskId, {
    task_id: taskId,
    intended_files: files,
    intended_symbols: [],
    possible_risks: [],
    will_not_change: []
  });
  assert.equal(intent.ok, true);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

async function dirtyPaths(worktreePath: string): Promise<string[]> {
  const status = await gitRawStdout(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return status
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(3).replaceAll("\\", "/"))
    .filter((entry) => entry !== "agent.log")
    .sort((left, right) => left.localeCompare(right));
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}

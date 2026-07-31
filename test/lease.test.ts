import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import {
  inspectLeaseLock,
  removeStaleLeaseLockIfUnchanged,
  tryRemoveStaleLeaseLock
} from "../src/lease-lock.js";
import { releaseLease, requestLease, requestLeaseForContract } from "../src/lease.js";
import { getProcessLiveness } from "../src/process-liveness.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("requestLease rejects an overlapping grant and names the holder", async () => {
  await withTempRepo(async ({ repo }) => {
    const first = await requestLease(repo, "T-001", ["README.md"]);
    const second = await requestLease(repo, "T-002", ["README.md"]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.match(second.reason, /README\.md held by T-001/);
    assert.deepEqual(await readActive(repo), { "README.md": "T-001" });
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.deepEqual(
      events.value.map((event) => event.type),
      ["lease.approved", "lease.rejected"]
    );
    assert.equal(events.value[1].task_id, "T-002");
    assert.match(String(events.value[1].data.reason), /README\.md held by T-001/);
  });
});

test("requestLease grants disjoint paths and is idempotent for the same task", async () => {
  await withTempRepo(async ({ repo }) => {
    const first = await requestLease(repo, "T-001", ["README.md"]);
    const second = await requestLease(repo, "T-002", ["src/feature.ts"]);
    const repeat = await requestLease(repo, "T-001", ["README.md", "README.md"]);

    assert.deepEqual(first, { ok: true, value: { task_id: "T-001", granted: ["README.md"] } });
    assert.deepEqual(second, { ok: true, value: { task_id: "T-002", granted: ["src/feature.ts"] } });
    assert.deepEqual(repeat, { ok: true, value: { task_id: "T-001", granted: ["README.md"] } });
    assert.deepEqual(await readActive(repo), { "README.md": "T-001", "src/feature.ts": "T-002" });
  });
});

test("releaseLease removes only the task's leases and frees paths", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md", "src/feature.ts"]);
    await requestLease(repo, "T-002", ["src/other.ts"]);

    const released = await releaseLease(repo, "T-001");
    const nextGrant = await requestLease(repo, "T-002", ["README.md"]);

    assert.deepEqual(released, { ok: true, value: { task_id: "T-001", released: ["README.md", "src/feature.ts"] } });
    assert.equal(nextGrant.ok, true);
    assert.deepEqual(await readActive(repo), { "README.md": "T-002", "src/other.ts": "T-002" });

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.deepEqual(
      events.value.map((event) => event.type),
      ["lease.approved", "lease.approved", "lease.released", "lease.approved"]
    );
    assert.equal(events.value[2].task_id, "T-001");
    assert.deepEqual(events.value[2].data.released, ["README.md", "src/feature.ts"]);
  });
});

test("releaseLease is a no-op when the lease file is missing", async () => {
  await withTempRepo(async ({ repo }) => {
    const released = await releaseLease(repo, "T-001");

    assert.deepEqual(released, { ok: true, value: { task_id: "T-001", released: [] } });
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("requestLease fails closed for invalid lease store files", async () => {
  await withTempRepo(async ({ repo }) => {
    const activePath = path.join(repo, ".hivemind", "leases", "active.json");
    await mkdir(path.dirname(activePath), { recursive: true });
    await writeFile(activePath, "{not json}\n");

    const invalidJson = await requestLease(repo, "T-001", ["README.md"]);
    assert.equal(invalidJson.ok, false);
    if (invalidJson.ok) {
      return;
    }
    assert.match(invalidJson.reason, /invalid JSON/);

    await writeFile(activePath, "[]\n");
    const invalidShape = await requestLease(repo, "T-001", ["README.md"]);
    assert.equal(invalidShape.ok, false);
    if (invalidShape.ok) {
      return;
    }
    assert.match(invalidShape.reason, /lease store must be a JSON object/);
  });
});

test("requestLease rejects invalid task ids and invalid paths before writing", async () => {
  await withTempRepo(async ({ repo }) => {
    const invalidTask = await requestLease(repo, "../evil", ["README.md"]);
    const glob = await requestLease(repo, "T-001", ["src/*.ts"]);
    const directory = await requestLease(repo, "T-001", ["src"]);

    assert.equal(invalidTask.ok, false);
    assert.equal(glob.ok, false);
    assert.equal(directory.ok, false);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("requestLease refuses Hivemind canon paths regardless of requested scope", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await requestLease(repo, "T-001", [".hivemind/canon/M-fixture.memory.json"]);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /lease refused for protected path ".hivemind\/canon\/M-fixture\.memory\.json"/);
    }
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("concurrent requestLease calls for the same file never both win", async () => {
  await withTempRepo(async ({ repo }) => {
    const results = await Promise.all([
      requestLease(repo, "T-001", ["README.md"]),
      requestLease(repo, "T-002", ["README.md"])
    ]);

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.equal(Object.keys(await readActive(repo)).length, 1);
  });
});

test("a separate live process holding the lease lock cannot have its lock stolen", async () => {
  await withTempRepo(async ({ repo }) => {
    const holder = await startLeaseLockHolder(repo);
    try {
      const lockPath = activeLockPath(repo);
      const heldRecord = await readFile(lockPath, "utf8");

      const contender = await requestLease(repo, "T-CONTENDER", ["README.md"]);

      assert.equal(contender.ok, false);
      if (contender.ok) {
        return;
      }
      assert.match(contender.reason, /could not acquire lease lock/);
      assert.equal(await readFile(lockPath, "utf8"), heldRecord);
      assert.equal(holder.exitCode, null);
    } finally {
      await releaseLeaseLockHolder(holder);
    }
  });
});

test("empty and partial lease locks fail closed instead of being cleared", async () => {
  await withTempRepo(async ({ repo }) => {
    const lockPath = activeLockPath(repo);
    await mkdir(path.dirname(lockPath), { recursive: true });
    for (const raw of ["", '{"version":1']) {
      await writeFile(lockPath, raw);

      const removed = await tryRemoveStaleLeaseLock(lockPath, {
        probeLiveness: () => "dead"
      });

      assert.equal(removed, false);
      assert.equal(await readFile(lockPath, "utf8"), raw);
      const inspection = await inspectLeaseLock(lockPath);
      assert.equal(inspection.status, "uncertain");
      await rm(lockPath);
    }
  });
});

test("ambiguous process liveness keeps the lease lock held", async () => {
  await withTempRepo(async ({ repo }) => {
    const lockPath = activeLockPath(repo);
    await writeLockRecord(lockPath, process.pid);
    const permissionDenied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const liveness = getProcessLiveness(process.pid, () => {
      throw permissionDenied;
    });

    const removed = await tryRemoveStaleLeaseLock(lockPath, {
      probeLiveness: () => liveness
    });

    assert.equal(liveness, "unknown");
    assert.equal(removed, false);
    await stat(lockPath);
  });
});

test("a stale cleaner observation cannot remove a newly acquired live lock", async () => {
  await withTempRepo(async ({ repo }) => {
    const lockPath = activeLockPath(repo);
    await writeLockRecord(lockPath, 100_001);
    const staleInspection = await inspectLeaseLock(lockPath);
    assert.equal(staleInspection.status, "valid");
    if (staleInspection.status !== "valid") {
      return;
    }

    await rm(lockPath);
    await writeLockRecord(lockPath, process.pid);
    const freshRecord = await readFile(lockPath, "utf8");

    const removed = await removeStaleLeaseLockIfUnchanged(lockPath, staleInspection.observation, {
      probeLiveness: () => "dead"
    });

    assert.equal(removed, false);
    assert.equal(await readFile(lockPath, "utf8"), freshRecord);
  });
});

test("a lock left by a genuinely dead process is cleared", async () => {
  await withTempRepo(async ({ repo }) => {
    const holder = await startLeaseLockHolder(repo);
    await crashLeaseLockHolder(holder);
    await stat(activeLockPath(repo));

    const granted = await requestLease(repo, "T-RECOVERED", ["README.md"]);

    assert.equal(granted.ok, true);
    assert.deepEqual(await readActive(repo), { "README.md": "T-RECOVERED" });
    await assertMissing(activeLockPath(repo));
  });
});

test("disjoint lease invariant survives a crash and concurrent stale-lock recovery", async () => {
  await withTempRepo(async ({ repo }) => {
    const holder = await startLeaseLockHolder(repo);
    await crashLeaseLockHolder(holder);
    await stat(activeLockPath(repo));

    const [first, second] = await Promise.all([
      requestLeaseInSeparateProcess(repo, "T-RACE-1", ["README.md"]),
      requestLeaseInSeparateProcess(repo, "T-RACE-2", ["README.md"])
    ]);

    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const active = await readActive(repo);
    assert.deepEqual(Object.keys(active), ["README.md"]);
    assert.equal(active["README.md"], winners[0].ok ? winners[0].value.task_id : "");
    await assertMissing(activeLockPath(repo));
    await assertMissing(`${activeLockPath(repo)}.reaper`);
  });
});

test("CLI lease grants contract allowed_files and releases them", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md", "src/feature.ts"]);

    const granted = await execFileAsync("node", [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });
    const released = await execFileAsync("node", [cliPath, "lease", "T-001", "--release"], { cwd: repo, windowsHide: true });

    assert.equal(granted.stderr, "");
    assert.deepEqual(JSON.parse(granted.stdout), {
      task_id: "T-001",
      granted: ["README.md", "src/feature.ts"]
    });
    assert.equal(released.stderr, "");
    assert.deepEqual(JSON.parse(released.stdout), {
      task_id: "T-001",
      released: ["README.md", "src/feature.ts"]
    });
    assert.deepEqual(await readActive(repo), {});
  });
});

test("CLI lease refuses a plan-backed dependent task until dependencies are event-integrated", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await prepareLintedPlanWithTasks(repo, [
      planTask("T-BASE", "README.md"),
      planTask("T-DEP", "src/feature.ts", ["T-BASE"])
    ]);
    await writeContract(repo, "T-DEP", baseCommit, ["src/feature.ts"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-DEP"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /task T-DEP depends_on not integrated: T-BASE/);
        return true;
      }
    );
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));

    await appendIntegratedDependencyEvents(repo, "T-BASE");
    const granted = await execFileAsync("node", [cliPath, "lease", "T-DEP"], { cwd: repo, windowsHide: true });
    assert.deepEqual(JSON.parse(granted.stdout), {
      task_id: "T-DEP",
      granted: ["src/feature.ts"]
    });
  });
});

test("contract lease grants absent confined create paths", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-CREATE", baseCommit, ["src/new.ts"], { "src/new.ts": "create" });

    const result = await requestLeaseForContract(repo, "T-CREATE");

    assert.deepEqual(result, { ok: true, value: { task_id: "T-CREATE", granted: ["src/new.ts"] } });
    assert.deepEqual(await readActive(repo), { "src/new.ts": "T-CREATE" });
  });
});

test("contract lease rejects create paths that already exist at base", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-CLOBBER", baseCommit, ["README.md"], { "README.md": "create" });

    const result = await requestLeaseForContract(repo, "T-CLOBBER");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /create path "README\.md" already exists at base/);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("contract lease rejects create paths outside the repo scope", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-ESCAPE", baseCommit, ["../escape.ts"], { "../escape.ts": "create" });

    const result = await requestLeaseForContract(repo, "T-ESCAPE");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /allowed_files contains invalid path "\.\.\/escape\.ts"/);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("contract lease conflicts when two tasks create the same path", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["src/new.ts"], { "src/new.ts": "create" });
    await writeContract(repo, "T-002", baseCommit, ["src/new.ts"], { "src/new.ts": "create" });

    const first = await requestLeaseForContract(repo, "T-001");
    const second = await requestLeaseForContract(repo, "T-002");

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.match(second.reason, /src\/new\.ts held by T-001/);
    assert.deepEqual(await readActive(repo), { "src/new.ts": "T-001" });
  });
});

test("contract lease treats unlabeled paths as modify and requires base existence", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-UNLABELED", baseCommit, ["src/new.ts"]);

    const result = await requestLeaseForContract(repo, "T-UNLABELED");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /src\/new\.ts.*not a tracked file at base/);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("CLI lease refuses contract files that do not exist at the contract base commit", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "LATER.md"), "later\n");
    await git(repo, ["add", "LATER.md"]);
    await git(repo, ["commit", "-m", "add later"]);
    await writeContract(repo, "T-STALE", baseCommit, ["LATER.md"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-STALE"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /LATER\.md.*not a tracked file at base/);
        return true;
      }
    );
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("CLI lease rejects contract globs and overlapping leases", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeContract(repo, "T-002", baseCommit, ["README.md"]);
    await writeContract(repo, "T-003", baseCommit, ["src/*.ts"]);
    await execFileAsync("node", [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-002"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /README\.md held by T-001/);
        return true;
      }
    );

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-003"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /uses a glob; contract lease scopes must be concrete files/);
        return true;
      }
    );
  });
});

test("CLI lease rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "lease"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind lease <id> \[--release\]/);
        return true;
      }
    );
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-lease-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = true;\n");
    await writeFile(path.join(repo, "src", "other.ts"), "export const other = true;\n");
    await git(repo, ["add", "README.md", "src/feature.ts", "src/other.ts"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
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
        title: "Lease files",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Lease fixture grants one concrete scope.",
        allowed_files: allowedFiles,
        ...(allowedFileIntents === undefined ? {} : { allowed_file_intents: allowedFileIntents }),
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
  const review = JSON.parse((await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--review"], { cwd: repo, windowsHide: true })).stdout) as { plan_hash: string };
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ratify", review.plan_hash], { cwd: repo, windowsHide: true });
}

function planTask(taskId: string, allowedFile: string, dependsOn: string[] = []): Record<string, unknown> {
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

async function readActive(repo: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8")) as Record<string, string>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}

function activeLockPath(repo: string): string {
  return path.join(repo, ".hivemind", "leases", "active.lock");
}

async function writeLockRecord(lockPath: string, pid: number): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      version: 1,
      lock_id: randomUUID(),
      pid
    })}\n`
  );
}

async function startLeaseLockHolder(repo: string): Promise<ChildProcessWithoutNullStreams> {
  const moduleUrl = pathToFileURL(path.resolve(testDir, "../src/lease-lock.js")).href;
  const script = [
    `const { withLeaseLock } = await import(${JSON.stringify(moduleUrl)});`,
    `const result = await withLeaseLock(${JSON.stringify(repo)}, async () => {`,
    `  console.log("LOCKED");`,
    `  await new Promise((resolve) => process.stdin.once("data", resolve));`,
    `  return { ok: true, value: null };`,
    `});`,
    `if (!result.ok) { console.error(result.reason); }`,
    `process.exit(result.ok ? 0 : 1);`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  await waitForChildOutput(child, "LOCKED");
  return child;
}

async function releaseLeaseLockHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.stdin.write("release\n");
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
}

async function crashLeaseLockHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const killed = child.kill();
  assert.equal(killed, true);
  await once(child, "exit");
}

async function waitForChildOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill();
  }, 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      const onStdout = (chunk: string): void => {
        stdout += chunk;
        if (stdout.includes(expected)) {
          cleanup();
          resolve();
        }
      };
      const onStderr = (chunk: string): void => {
        stderr += chunk;
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error(`lock holder exited before ${expected}; stdout=${stdout}; stderr=${stderr}`));
      };
      const cleanup = (): void => {
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("exit", onExit);
      };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("exit", onExit);
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestLeaseInSeparateProcess(
  repo: string,
  taskId: string,
  files: string[]
): Promise<{ ok: true; value: { task_id: string; granted: string[] } } | { ok: false; reason: string }> {
  const moduleUrl = pathToFileURL(path.resolve(testDir, "../src/lease.js")).href;
  const script = [
    `const { requestLease } = await import(${JSON.stringify(moduleUrl)});`,
    `const result = await requestLease(${JSON.stringify(repo)}, ${JSON.stringify(taskId)}, ${JSON.stringify(files)});`,
    `console.log(JSON.stringify(result));`
  ].join("\n");
  const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    windowsHide: true
  });
  return JSON.parse(result.stdout) as
    | { ok: true; value: { task_id: string; granted: string[] } }
    | { ok: false; reason: string };
}

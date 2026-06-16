import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { readActiveLeases } from "../src/lease.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
  repoRoot: string;
}

test("daemon serializes concurrent lease requests and re-reads committed state after restart", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeContract(repo, "T-002", baseCommit, ["README.md"]);
    let daemon = await startDaemon(repo);
    try {
      const [first, second] = await Promise.allSettled([
        execCli(repo, daemon.url, ["lease", "T-001"]),
        execCli(repo, daemon.url, ["lease", "T-002"])
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      const rejected = [first, second].filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (!store.ok) {
        return;
      }
      assert.equal(Object.keys(store.store).length, 1);
      assert.match(store.store["README.md"] ?? "", /^T-00[12]$/);
    } finally {
      await stopDaemon(daemon);
    }

    daemon = await startDaemon(repo);
    try {
      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (!store.ok) {
        return;
      }
      const winner = store.store["README.md"];
      const loser = winner === "T-001" ? "T-002" : "T-001";
      await assert.rejects(
        execCli(repo, daemon.url, ["lease", loser]),
        (error: unknown) => {
          assert.equal((error as { code?: number }).code, 1);
          assert.match(String((error as { stderr?: string }).stderr), new RegExp(`lease conflict: README\\.md held by ${winner}`));
          return true;
        }
      );

      await execCli(repo, daemon.url, ["lease", winner, "--release"]);
      const granted = await execCli(repo, daemon.url, ["lease", loser]);
      const parsed = JSON.parse(granted.stdout) as { task_id: string; granted: string[] };
      assert.equal(parsed.task_id, loser);
      assert.deepEqual(parsed.granted, ["README.md"]);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("lease command falls back to direct single-writer mode without a daemon URL", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    const result = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });

    const parsed = JSON.parse(result.stdout) as { task_id: string; granted: string[] };
    assert.equal(parsed.task_id, "T-001");
    assert.deepEqual(parsed.granted, ["README.md"]);
  });
});

test("lease command discovers a live daemon without HIVEMIND_DAEMON_URL before falling back to direct mode", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeContract(repo, "T-002", baseCommit, ["README.md"]);

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { task_id: string; granted: string[] };
      assert.equal(parsed.task_id, "T-001");
      assert.deepEqual(parsed.granted, ["README.md"]);
    } finally {
      await stopDaemon(daemon);
    }

    await writeFile(path.join(repo, ".hivemind", "daemon.json"), JSON.stringify({ version: 1, pid: 99999999, url: "http://127.0.0.1:1", repo_root: repo, started_at: new Date().toISOString() }));
    const released = await execFileAsync(process.execPath, [cliPath, "lease", "T-001", "--release"], {
      cwd: repo,
      env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
      windowsHide: true
    });
    assert.equal(JSON.parse(released.stdout).task_id, "T-001");

    const direct = await execFileAsync(process.execPath, [cliPath, "lease", "T-002"], {
      cwd: repo,
      env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
      windowsHide: true
    });
    assert.equal(JSON.parse(direct.stdout).task_id, "T-002");
  });
});

test("lease command rejects a daemon for a different repo before mutating", async () => {
  await withTempRepo(async ({ repo: daemonRepo }) => {
    await withTempRepo(async ({ repo: commandRepo, baseCommit }) => {
      await writeContract(commandRepo, "T-001", baseCommit, ["README.md"]);
      const daemon = await startDaemon(daemonRepo);
      try {
        await assert.rejects(
          execCli(commandRepo, daemon.url, ["lease", "T-001"]),
          (error: unknown) => {
            assert.equal((error as { code?: number }).code, 1);
            assert.match(String((error as { stderr?: string }).stderr), /daemon repo_root does not match/);
            return true;
          }
        );

        const commandStore = await readActiveLeases(commandRepo);
        const daemonStore = await readActiveLeases(daemonRepo);
        assert.equal(commandStore.ok, true);
        assert.equal(daemonStore.ok, true);
        if (!commandStore.ok || !daemonStore.ok) {
          return;
        }
        assert.deepEqual(commandStore.store, {});
        assert.deepEqual(daemonStore.store, {});
      } finally {
        await stopDaemon(daemon);
      }
    });
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-daemon-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string; repo_root: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url, repoRoot: parsed.repo_root };
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    daemon.child.once("exit", () => resolve());
    daemon.child.kill();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(stdout.slice(0, newline).trim());
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before ready with code ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function execCli(repo: string, daemonUrl: string, args: string[]) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: daemonUrl },
    windowsHide: true
  });
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Daemon lease test",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: [],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function cleanupTempRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

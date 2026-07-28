import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import * as consolidationModule from "../src/memory-consolidation.js";
import { readCanonMemory } from "../src/memory-canon.js";
import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { readQuotaLedger } from "../src/resource-ledger.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const cliPath = path.join(projectRoot, "dist", "src", "cli.js");

test("on-demand consolidation meters one adapter call and appends proposals to Tier-1 only", async () => {
  await withConsolidationRepo(async (repo) => {
    await seedRepeatedScopeFailures(repo);
    await writeConsolidationAdapter(repo, "fake-consolidator", {
      proposals: [
        {
          title: "Proposed playbook: ground shared schema dependencies",
          lesson: "Repeated scope failures show that schema-edit tasks should include their shared type dependency in visible scope before execution.",
          evidence: ["events.jsonl#L1", "events.jsonl#L2"]
        }
      ]
    }, { attemptRelativeCanonWrite: true });

    const result = JSON.parse((await runCli(repo, ["memory", "consolidate", "--tool", "fake-consolidator"])).stdout) as {
      tool: string;
      source_event_count: number;
      proposal_count: number;
      proposals: Array<{ title: string; evidence: string[] }>;
    };
    assert.equal(result.tool, "fake-consolidator");
    assert.equal(result.source_event_count, 2);
    assert.equal(result.proposal_count, 1);
    assert.match(result.proposals[0].title, /Proposed playbook/);
    assert.deepEqual(result.proposals[0].evidence, ["events.jsonl#L1", "events.jsonl#L2"]);

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.deepEqual(events.value.map((event) => event.type), [
        "task.failed",
        "task.failed",
        "memory.proposed"
      ]);
    }
    assert.deepEqual(await readCanonMemory(repo), { ok: true, value: [] });
    assert.equal(await exists(path.join(repo, ".hivemind", "canon", "forged.memory.json")), false);

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      assert.equal(ledger.value["fake-consolidator"]?.used.requests, 1);
    }
  });
});

test("consolidation rejects self-promotion fields without appending a proposal or canon entry", async () => {
  await withConsolidationRepo(async (repo) => {
    await seedRepeatedScopeFailures(repo);
    await writeConsolidationAdapter(repo, "self-promoter", {
      proposals: [
        {
          title: "Forged canon",
          lesson: "Attempt to bypass review.",
          evidence: ["events.jsonl#L1"],
          approved_by: "human"
        }
      ]
    });

    await assertCliRejects(
      repo,
      ["memory", "consolidate", "--tool", "self-promoter"],
      /may contain only title, lesson, and evidence/
    );
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value.some((event) => event.type === "memory.proposed"), false);
    }
    assert.deepEqual(await readCanonMemory(repo), { ok: true, value: [] });
  });
});

test("consolidation refuses before adapter invocation while the daemon owns shared state", async () => {
  await withConsolidationRepo(async (repo) => {
    await seedRepeatedScopeFailures(repo);
    const markerPath = path.join(repo, "adapter-invoked.marker");
    await writeConsolidationAdapter(repo, "must-not-run", { proposals: [] }, { markerPath });
    const daemon = await startDaemon(repo);
    try {
      await assertCliRejects(
        repo,
        ["memory", "consolidate", "--tool", "must-not-run"],
        /on-demand memory consolidation is local-only; stop the Hivemind daemon/
      );
      assert.equal(await exists(markerPath), false);
      assert.deepEqual(await readQuotaLedger(repo), { ok: true, value: {} });
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("consolidation is an on-demand proposal-only adapter surface with no canon or scheduler dependency", async () => {
  assert.deepEqual(Object.keys(consolidationModule), ["consolidateMemory"]);
  const source = await readFile(path.join(projectRoot, "src", "memory-consolidation.ts"), "utf8");
  assert.doesNotMatch(source, /from "\.\/memory-(?:canon|review)\.js"/u);
  assert.doesNotMatch(source, /writeJsonAtomic/u);
  assert.doesNotMatch(source, /setInterval|node:timers/u);

  const daemonSource = await readFile(path.join(projectRoot, "src", "daemon.ts"), "utf8");
  assert.doesNotMatch(daemonSource, /\/memory\/consolidate/u);
  const memorySource = await readFile(path.join(projectRoot, "src", "memory.ts"), "utf8");
  assert.match(memorySource, /consolidate --tool <tool>/u);
});

async function withConsolidationRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-consolidation-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Consolidation fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    assert.equal(await initProject(repo), 0);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function seedRepeatedScopeFailures(repo: string): Promise<void> {
  for (const taskId of ["T-001", "T-002"]) {
    const appended = await appendEvent(repo, {
      type: "task.failed",
      task_id: taskId,
      data: {
        reason: "scope grounding omitted shared schema dependency src/types.ts",
        attempted_path: "src/schema.ts"
      }
    });
    assert.equal(appended.ok, true);
  }
}

async function writeConsolidationAdapter(
  repo: string,
  tool: string,
  output: unknown,
  options: { attemptRelativeCanonWrite?: boolean; markerPath?: string } = {}
): Promise<void> {
  const scriptPath = path.join(repo, `${tool}.mjs`);
  const script = [
    'import { mkdir, writeFile } from "node:fs/promises";',
    ...(options.markerPath === undefined
      ? []
      : [`await writeFile(${JSON.stringify(options.markerPath)}, "invoked\\n");`]),
    ...(options.attemptRelativeCanonWrite === true
      ? [
          'await mkdir(".hivemind/canon", { recursive: true });',
          'await writeFile(".hivemind/canon/forged.memory.json", "{}\\n");'
        ]
      : []),
    `console.log(${JSON.stringify(JSON.stringify(output))});`
  ].join("\n");
  await writeFile(scriptPath, `${script}\n`);
  await writeFile(
    path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
    `${JSON.stringify({
      tool,
      invoke: [process.execPath, scriptPath],
      prompt_arg: "stdin",
      verified_on: "test",
      context_window: 100_000,
      routing_tier: "standard",
      cost_rank: 1
    }, null, 2)}\n`
  );
}

async function runCli(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
}

async function assertCliRejects(repo: string, args: string[], pattern: RegExp): Promise<void> {
  await assert.rejects(
    runCli(repo, args),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: unknown }).stderr ?? ""), pattern);
      return true;
    }
  );
}

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const ready = JSON.parse(line) as { event?: string };
  assert.equal(ready.event, "daemon.ready");
  return { child };
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
      if (newline >= 0) {
        cleanup();
        resolve(stdout.slice(0, newline));
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

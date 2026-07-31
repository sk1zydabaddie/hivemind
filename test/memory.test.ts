import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { readCanonMemory } from "../src/memory-canon.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import * as memoryReviewModule from "../src/memory-review.js";
import { memoryCommand } from "../src/memory.js";
import { mcpToolDefinitions } from "../src/mcp.js";
import { buildPlanningGenerationPrompt } from "../src/planning-prompt.js";
import { readEvents } from "../src/events.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const cliPath = path.resolve(testDir, "../src/cli.js");

test("memory proposal stays Tier-1 until explicit human review promotes it into planning canon", async () => {
  await withMemoryRepo(async (repo) => {
    const lesson = "Ledger writes must preserve a final newline.";
    const proposalFile = path.join(repo, "proposal.json");
    await writeFile(
      proposalFile,
      `${JSON.stringify({
        title: "Preserve ledger newline",
        lesson,
        evidence: ["task T-014 patch rejected after newline removal"]
      }, null, 2)}\n`
    );

    const proposed = await runCli(repo, ["memory", "propose", "proposal.json"]);
    const proposal = JSON.parse(proposed.stdout) as { proposal_id: string };
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.filter((event) => event.type === "memory.proposed").length, 1);
    assert.deepEqual(await readCanonMemory(repo), { ok: true, value: [] });

    const beforeReview = await planningPrompt(repo);
    assert.equal(beforeReview.ok, true);
    if (beforeReview.ok) {
      assert.doesNotMatch(beforeReview.value, new RegExp(escapeRegExp(lesson)));
      assert.match(beforeReview.value, /Human-reviewed project canon:\n\(none\)/);
    }

    await assertCliRejects(
      repo,
      ["memory", "review", proposal.proposal_id, "--approve"],
      /canon promotion requires an interactive TTY human review/
    );
    await assertCliRejects(repo, ["memory", "canon", proposal.proposal_id], /usage: hivemind memory/);
    assert.deepEqual(await readCanonMemory(repo), { ok: true, value: [] });

    assert.equal(await runInteractiveReview(repo, proposal.proposal_id), 0);

    const canon = await readCanonMemory(repo);
    assert.equal(canon.ok, true);
    if (canon.ok) {
      assert.equal(canon.value.length, 1);
      assert.equal(canon.value[0].lesson, lesson);
      assert.deepEqual(canon.value[0].evidence_acknowledged, [proposal.proposal_id]);
    }
    const workspace = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(workspace.ok, true);
    if (workspace.ok) {
      const memory = (workspace.value as { memory: { canon: Array<{ canon_id: string; lesson: string }>; pending_lessons: unknown[] } }).memory;
      assert.deepEqual(memory.canon.map((entry) => ({ canon_id: entry.canon_id, lesson: entry.lesson })), [{
        canon_id: proposal.proposal_id,
        lesson
      }]);
      assert.equal(memory.pending_lessons.length, 0);
    }
    const afterReview = await planningPrompt(repo);
    assert.equal(afterReview.ok, true);
    if (afterReview.ok) {
      assert.match(afterReview.value, new RegExp(escapeRegExp(lesson)));
      assert.match(afterReview.value, /task T-014 patch rejected after newline removal/);
    }
  });
});

test("Tier-1 memory is append-only and exposes no rewrite or delete command", async () => {
  await withMemoryRepo(async (repo) => {
    const first = await proposeMemoryLesson(repo, {
      title: "First observation",
      lesson: "First lesson remains immutable.",
      evidence: ["event one"]
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const eventPath = path.join(repo, ".hivemind", "log", "events.jsonl");
    const before = await readFile(eventPath, "utf8");

    await assertCliRejects(repo, ["memory", "rewrite", first.value.proposal_id], /usage: hivemind memory/);
    await assertCliRejects(repo, ["memory", "delete", first.value.proposal_id], /usage: hivemind memory/);
    assert.equal(await readFile(eventPath, "utf8"), before);

    const second = await proposeMemoryLesson(repo, {
      title: "Second observation",
      lesson: "Second lesson appends after the first.",
      evidence: ["event two"]
    });
    assert.equal(second.ok, true);
    const after = await readFile(eventPath, "utf8");
    assert.equal(after.startsWith(before), true);
    assert.equal(after.slice(0, before.length), before);
    assert.equal(after.trimEnd().split(/\r?\n/u).length, 2);
  });
});

test("memory proposals route through the daemon while programmatic daemon promotion is absent", async () => {
  await withMemoryRepo(async (repo) => {
    const daemon = await startDaemon(repo);
    try {
      await writeFile(
        path.join(repo, "daemon-proposal.json"),
        `${JSON.stringify({
          title: "Daemon-routed proposal",
          lesson: "Shared memory mutations use the daemon when it is live.",
          evidence: ["daemon routing acceptance fixture"]
        }, null, 2)}\n`
      );
      const proposed = await runCli(repo, ["memory", "propose", "daemon-proposal.json"]);
      const proposal = JSON.parse(proposed.stdout) as { proposal_id: string };
      const response = await fetch(`${daemon.url}/memory/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal_id: proposal.proposal_id,
          review: { decision: "approve", evidence_reviewed: true, reviewer: "human" }
        })
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, reason: "unknown daemon route" });
      await assertCliRejects(
        repo,
        ["memory", "review", proposal.proposal_id, "--approve"],
        /interactive canon review is local-only; stop the Hivemind daemon before reviewing/
      );
      assert.deepEqual(await readCanonMemory(repo), { ok: true, value: [] });
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("planning prompt assembly is structurally canon-only and MCP exposes no promotion door", async () => {
  const sourceDir = path.join(projectRoot, "src");
  const sourceNames = (await readdir(sourceDir)).filter((name) => name.endsWith(".ts"));
  const dependencyMap = new Map<string, string[]>();
  const sourceByName = new Map<string, string>();
  for (const name of sourceNames) {
    const repoPath = `src/${name}`;
    const source = await readFile(path.join(sourceDir, name), "utf8");
    sourceByName.set(name, source);
    dependencyMap.set(repoPath, relativeSourceImports(repoPath, source));
  }

  assert.equal(reachesModule("src/planning-prompt.ts", "src/events.ts", dependencyMap), false);
  assert.equal(reachesModule("src/planning-prompt.ts", "src/memory-log.ts", dependencyMap), false);
  assert.equal(reachesModule("src/planning-prompt.ts", "src/memory-review.ts", dependencyMap), false);
  assert.equal(reachesModule("src/memory-log.ts", "src/memory-review.ts", dependencyMap), false);
  assert.equal(reachesModule("src/memory-log.ts", "src/memory-canon.ts", dependencyMap), false);

  const planningPromptSource = await readFile(path.join(sourceDir, "planning-prompt.ts"), "utf8");
  assert.doesNotMatch(planningPromptSource, /\.hivemind[\\/]log|events\.jsonl|readEvents|memory\.proposed/u);
  const canonSource = await readFile(path.join(sourceDir, "memory-canon.ts"), "utf8");
  assert.doesNotMatch(canonSource, /writeFile|writeJsonAtomic|appendFile|rm\(/u);
  const planSource = await readFile(path.join(sourceDir, "plan.ts"), "utf8");
  assert.match(planSource, /import \{ buildPlanningGenerationPrompt \} from "\.\/planning-prompt\.js"/u);
  assert.doesNotMatch(planSource, /Human-reviewed project canon:/u);
  const canonWriters = [...sourceByName]
    .filter(([, source]) =>
      /path\.join\(repoRoot,\s*["']\.hivemind["'],\s*["']canon["']/u.test(source) &&
      /writeJsonAtomic/u.test(source)
    )
    .map(([name]) => name);
  assert.deepEqual(canonWriters, ["memory-review.ts"]);
  assert.deepEqual(
    Object.keys(memoryReviewModule).sort(),
    ["reviewMemoryProposalInteractively"],
    "memory-review must not expose a programmatic canon-promotion surface"
  );
  const interactiveReviewCallers = [...sourceByName]
    .filter(([, source]) => source.includes("reviewMemoryProposalInteractively"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(interactiveReviewCallers, ["memory-review.ts", "memory.ts"]);
  const daemonSource = await readFile(path.join(sourceDir, "daemon.ts"), "utf8");
  assert.doesNotMatch(daemonSource, /\/memory\/review/u);
  assert.equal(mcpToolDefinitions.some((tool) => /memory|canon|promot/iu.test(tool.name)), false);
});

async function withMemoryRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-memory-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Memory fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    assert.equal(await initProject(repo), 0);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function planningPrompt(repo: string) {
  return buildPlanningGenerationPrompt({
    repoRoot: repo,
    specId: "S-001",
    specMarkdown: "# Spec\nstatus: ratified\n",
    baseCommit: "fixture-base",
    trackedFiles: ["README.md"]
  });
}

async function runCli(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
}

async function runInteractiveReview(repo: string, proposalId: string): Promise<number> {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(output, "isTTY", { value: true });
  output.resume();

  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  const originalLog = console.log;
  if (stdinDescriptor === undefined || stderrDescriptor === undefined) {
    throw new Error("process stdio descriptors are unavailable");
  }
  Object.defineProperty(process, "stdin", { configurable: true, enumerable: true, get: () => input });
  Object.defineProperty(process, "stderr", { configurable: true, enumerable: true, get: () => output });
  console.log = () => {};
  input.end(`approve ${proposalId}\n`);
  try {
    return await memoryCommand(repo, ["review", proposalId, "--approve"]);
  } finally {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stderr", stderrDescriptor);
    console.log = originalLog;
  }
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function relativeSourceImports(repoPath: string, source: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["'](\.[^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), specifier))
      .replace(/\.js$/u, ".ts");
    imports.add(resolved);
  }
  return [...imports].sort();
}

function reachesModule(
  start: string,
  target: string,
  dependencyMap: Map<string, string[]>,
  visited = new Set<string>()
): boolean {
  if (start === target) {
    return true;
  }
  if (visited.has(start)) {
    return false;
  }
  visited.add(start);
  return (dependencyMap.get(start) ?? []).some((dependency) =>
    reachesModule(dependency, target, dependencyMap, visited)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const ready = JSON.parse(line) as { event?: string; url?: string };
  assert.equal(ready.event, "daemon.ready");
  assert.equal(typeof ready.url, "string");
  return { child, url: String(ready.url) };
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

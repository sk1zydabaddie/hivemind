import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { invokeAgent } from "../src/adapter.js";
import type { TaskContract } from "../src/contract.js";
import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { assembleAgentPrompt, readCachedRepoFile, readCacheMetrics } from "../src/prompt-cache.js";
import { createTaskWorktree } from "../src/worktree.js";

const execFileAsync = promisify(execFile);

test("assembleAgentPrompt keeps sibling shared prefixes byte-identical and stable", async () => {
  await withTempDir(async (repo) => {
    await writeFile(path.join(repo, "AGENTS.md"), "Project instructions\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = true;\n");

    const first = await assembleAgentPrompt(repo, contractFor({ task_id: "T-001", title: "First", allowed_files: ["README.md"] }));
    const second = await assembleAgentPrompt(repo, contractFor({ task_id: "T-002", title: "Second", allowed_files: ["src/feature.ts"] }));
    const repeat = await assembleAgentPrompt(repo, contractFor({ task_id: "T-001", title: "First", allowed_files: ["README.md"] }));

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(repeat.ok, true);
    if (!first.ok || !second.ok || !repeat.ok) {
      return;
    }
    assert.equal(first.value.shared_prefix, second.value.shared_prefix);
    assert.equal(first.value.full_prompt, repeat.value.full_prompt);
    assert.doesNotMatch(first.value.shared_prefix, /Task ID: T-001/);
    assert.match(first.value.layers.task_context_pack, /Task ID: T-001/);
    assert.match(first.value.layers.repo_substrate, /Project instructions/);
  });
});

test("readCachedRepoFile records a miss then serves an unchanged exact-hash hit", async () => {
  await withTempDir(async (repo) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");

    const first = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });
    const second = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });
    const metrics = await readCacheMetrics(repo);
    const events = await readEvents(repo);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(metrics.ok, true);
    assert.equal(events.ok, true);
    if (!first.ok || !second.ok || !metrics.ok || !events.ok) {
      return;
    }
    assert.equal(first.value.cache, "miss");
    assert.equal(second.value.cache, "hit");
    assert.equal(first.value.content_hash, second.value.content_hash);
    assert.equal(second.value.content, "# Fixture\n");
    assert.deepEqual(metrics.value, { reads: 2, hits: 1, misses: 1, hit_rate: 0.5 });
    assert.deepEqual(
      events.value.filter((event) => event.type === "cache.read").map((event) => event.data.result),
      ["miss", "hit"]
    );
  });
});

test("readCachedRepoFile misses after content changes and never reuses the old cached content", async () => {
  await withTempDir(async (repo) => {
    await writeFile(path.join(repo, "README.md"), "before\n");

    const first = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });
    await writeFile(path.join(repo, "README.md"), "after\n");
    const second = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.cache, "miss");
    assert.equal(second.value.cache, "miss");
    assert.notEqual(first.value.content_hash, second.value.content_hash);
    assert.equal(second.value.content, "after\n");
  });
});

test("readCachedRepoFile replaces malformed exact-hash cache entries instead of trusting them", async () => {
  await withTempDir(async (repo) => {
    await writeFile(path.join(repo, "README.md"), "safe content\n");
    const first = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    await writeFile(path.join(repo, first.value.cache_path), "{\"version\":1,\"path\":\"README.md\",\"content_hash\":\"bad\",\"bytes\":1,\"content\":\"stale\"}\n");

    const second = await readCachedRepoFile(repo, "README.md", { taskId: "T-001" });

    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.value.cache, "miss");
    assert.equal(second.value.content, "safe content\n");
    assert.equal(JSON.parse(await readFile(path.join(repo, second.value.cache_path), "utf8")).content, "safe content\n");
  });
});

test("invokeAgent sends layered prompt and records cache-read events", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(
      path.join(worktree.value.worktree, "prompt-agent.mjs"),
      [
        "let prompt = '';",
        "for await (const chunk of process.stdin) prompt += chunk;",
        "console.log(JSON.stringify({ layered: prompt.includes('Repo substrate:') && prompt.includes('Task context pack:') && prompt.includes('Per-turn delta:') }));"
      ].join("\n")
    );
    await writeProfile(repo, "fake", ["node", "prompt-agent.mjs"]);

    const result = await invokeAgent(repo, "T-001", "fake");
    const events = await readEvents(repo);

    assert.equal(result.ok, true);
    assert.equal(events.ok, true);
    if (!result.ok || !events.ok) {
      return;
    }
    assert.match(await readFile(result.value.logPath, "utf8"), /"layered":true/);
    assert.equal(events.value.some((event) => event.type === "cache.read" && event.task_id === "T-001"), true);
  });
});

async function withTempDir(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-prompt-cache-test-"));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-prompt-cache-adapter-test-"));
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
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Prompt cache task",
    agent_role: "builder",
    base_commit: "abc123",
    allowed_files: ["README.md"],
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: [],
    patch_requirements: [],
    ...overrides
  };
}

async function writeContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`),
    `${JSON.stringify({ ...contractFor({ task_id: taskId, base_commit: baseCommit }), allowed_files: ["README.md"] }, null, 2)}\n`
  );
}

async function writeProfile(repo: string, tool: string, invoke: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "adapters"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke,
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024
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

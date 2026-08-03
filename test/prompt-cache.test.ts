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
import {
  assembleAgentPrompt,
  assembleAgentPromptFromVerifiedCheckout,
  buildContractTaskContextLayer,
  readCachedRepoFile,
  readCacheMetrics
} from "../src/prompt-cache.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

test("assembleAgentPrompt keeps sibling shared prefixes byte-identical and stable", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeContract(repo, "T-002", baseCommit, ["src/feature.ts"]);
    const firstWorktree = await createTaskWorktree(repo, "T-001");
    const secondWorktree = await createTaskWorktree(repo, "T-002");
    assert.equal(firstWorktree.ok, true);
    assert.equal(secondWorktree.ok, true);

    const first = await assembleAgentPrompt(repo, contractFor({ task_id: "T-001", title: "First", base_commit: baseCommit, allowed_files: ["README.md"] }));
    const second = await assembleAgentPrompt(repo, contractFor({ task_id: "T-002", title: "Second", base_commit: baseCommit, allowed_files: ["src/feature.ts"] }));
    const repeat = await assembleAgentPrompt(repo, contractFor({ task_id: "T-001", title: "First", base_commit: baseCommit, allowed_files: ["README.md"] }));

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
    assert.match(first.value.layers.task_context_pack, /Acceptance criterion: Prompt cache fixture assembles one prompt\./);
    assert.match(first.value.layers.task_context_pack, /Deterministic validity check: \(none\)/);
    assert.match(first.value.layers.task_context_pack, /Allowed file intents:\n- README\.md: modify/);
    assert.match(first.value.layers.task_context_pack, /Patch requirements:/);
    assert.match(first.value.layers.repo_substrate, /Project instructions/);
  });
});

test("worker context fails closed when the acceptance criterion or patch requirements are unavailable", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-SPEC", baseCommit, ["README.md"]);
    assert.equal((await createTaskWorktree(repo, "T-SPEC")).ok, true);

    const missingAcceptance = await assembleAgentPrompt(repo, {
      ...contractFor({ task_id: "T-SPEC", base_commit: baseCommit }),
      acceptance_criterion: ""
    });
    const missingRequirements = await assembleAgentPrompt(repo, {
      ...contractFor({ task_id: "T-SPEC", base_commit: baseCommit }),
      patch_requirements: undefined
    } as unknown as TaskContract);

    assert.deepEqual(missingAcceptance, {
      ok: false,
      reason: "worker context refused: contract acceptance_criterion is missing"
    });
    assert.deepEqual(missingRequirements, {
      ok: false,
      reason: "worker context refused: contract patch_requirements is missing or malformed"
    });
    assert.throws(
      () => buildContractTaskContextLayer({
        ...contractFor({ task_id: "T-SPEC", base_commit: baseCommit }),
        acceptance_criterion: ""
      }),
      /worker context refused: contract acceptance_criterion is missing/
    );
  });
});

test("worker context cannot omit a plan-authored observable-interface validity check", async () => {
  const criterion = "The CLI accepts --input <path> and supports optional --json output.";
  assert.throws(
    () => buildContractTaskContextLayer(contractFor({ acceptance_criterion: criterion })),
    /worker context refused: observable interface has no deterministic_validity_check/
  );
  assert.match(
    buildContractTaskContextLayer(
      contractFor({
        acceptance_criterion: criterion,
        deterministic_validity_check: "node verify-cli-interface.mjs"
      })
    ),
    /Deterministic validity check: node verify-cli-interface\.mjs/
  );
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

test("assembleAgentPrompt reads write-context files from the task base worktree instead of newer root content", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-BASE", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-BASE");
    assert.equal(worktree.ok, true);

    await writeFile(path.join(repo, "README.md"), "newer root content\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "advance root"]);

    const prompt = await assembleAgentPrompt(repo, contractFor({ task_id: "T-BASE", base_commit: baseCommit, allowed_files: ["README.md"] }));

    assert.equal(prompt.ok, true);
    if (!prompt.ok) {
      return;
    }
    assert.match(prompt.value.full_prompt, /# Fixture/);
    assert.doesNotMatch(prompt.value.full_prompt, /newer root content/);
  });
});

test("an alternate prompt checkout is refused unless its HEAD is the verified authoring base", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "advanced root\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "advance root for mismatch"]);

    const prompt = await assembleAgentPromptFromVerifiedCheckout(
      repo,
      contractFor({ task_id: "T-ALT", base_commit: baseCommit, allowed_files: ["README.md"] }),
      repo
    );

    assert.equal(prompt.ok, false);
    assert.match(prompt.ok ? "" : prompt.reason, /expected verified authoring base/u);
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
    await writeFile(path.join(repo, "AGENTS.md"), "Project instructions\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = true;\n");
    await git(repo, ["add", "AGENTS.md", "README.md", "src/feature.ts"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
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
    routing_task_type: "other",
    base_commit: "abc123",
    acceptance_criterion: "Prompt cache fixture assembles one prompt.",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: [],
    ...overrides
  };
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[] = ["README.md"]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        ...contractFor({ task_id: taskId, base_commit: baseCommit }),
        allowed_files: allowedFiles,
        allowed_file_intents: Object.fromEntries(allowedFiles.map((file) => [file, "modify"]))
      },
      null,
      2
    )}\n`
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

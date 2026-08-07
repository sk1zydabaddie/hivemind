import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { inspectWorkspace } from "../src/workspace-inspection.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

const REQUEST = "Add a dark mode toggle to the settings page, and remember it between launches.";

test("the planning request text is durable and survives a reload", async () => {
  await withPlanningRepo(async (repo) => {
    const prepared = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: `  ${REQUEST}  `, tool: "fixture-planner" }
    });
    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.reason);

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) return;
    const recorded = events.value.find((event) => event.type === "plan.prepared");
    assert.notEqual(recorded, undefined);

    // The request is stored normalized, exactly as guidance stores its message.
    assert.equal(recorded?.data.prompt, REQUEST);

    // The hash stays, and still describes the same normalized text, so existing
    // readers keep working and the two can never disagree.
    assert.equal(
      recorded?.data.prompt_hash,
      createHash("sha256").update(REQUEST).digest("hex")
    );

    // Durable on disk: a reader that never saw this process gets the same text.
    const log = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8");
    const reloaded = log
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .find((event) => event.type === "plan.prepared");
    assert.equal(reloaded?.data.prompt, REQUEST);

    const rereadEvents = await readEvents(repo);
    assert.equal(rereadEvents.ok, true);
    if (!rereadEvents.ok) return;
    assert.equal(
      rereadEvents.value.find((event) => event.type === "plan.prepared")?.data.prompt,
      REQUEST
    );
  });
});

test("an oversized planning request is refused and records nothing", async () => {
  await withPlanningRepo(async (repo) => {
    const refused = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "x".repeat(20_001), tool: "fixture-planner" }
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /at most 20000 characters/u);

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) return;
    assert.equal(events.value.some((event) => event.type === "plan.prepared"), false);
  });
});

test("the workspace projection reports the active spec title", async () => {
  await withPlanningRepo(async (repo) => {
    const inspected = await inspectWorkspace(repo);
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    assert.equal(inspected.value.active_spec_id, "S-001");
    assert.equal(inspected.value.active_spec_title, "Test spec");
  });
});

async function withPlanningRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-plan-prompt-test-"));
  try {
    await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
    await initProject(repo);
    await createRatifiedSpec(repo, "S-001");
    await setTierGlobs(repo);
    await writePlanningAdapter(repo, "fixture-planner");
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function setTierGlobs(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    low_globs: ["README.md", "docs/**"],
    medium_globs: ["src/**", "test/**"],
    high_globs: ["package.json"],
    critical_globs: ["src/gates/**"],
    manager_autonomy: { level: "review_everything" }
  }, null, 2)}\n`);
}

async function writePlanningAdapter(repo: string, tool: string): Promise<void> {
  const plan = {
    tasks: [
      {
        task_id: "T-001",
        title: "Document the behavior",
        task_type: "deterministic",
        routing_task_type: "documentation",
        mode: "write",
        agent_role: "builder",
        draft_scope: {
          allowed_files: ["README.md"],
          read_only_files: [],
          forbidden_files: [],
          must_not_change: []
        },
        depends_on: [],
        parallel_safe: false,
        acceptance_criterion: "README documents the exact behavior.",
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: ["Keep documentation concise."],
        critical_path_approved: false
      }
    ],
    execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: ["T-001"] }]
  };
  const agent = path.join(repo, `${tool}.mjs`);
  await writeFile(agent, [
    "let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
    `console.log(${JSON.stringify(JSON.stringify(plan))});`
  ].join("\n"));
  await writeFile(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), `${JSON.stringify({
    tool,
    invoke: [process.execPath, agent],
    prompt_arg: "stdin",
    verified_on: "fixture",
    context_window: 16_000,
    timeout_ms: 5_000,
    routing_tier: "strong",
    cost_rank: 1
  }, null, 2)}\n`);
}

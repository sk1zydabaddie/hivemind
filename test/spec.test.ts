import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { createSpec, ratifySpec } from "../src/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("spec create writes the PRD template as draft and marks it active", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await createSpec(repo, "S-001", "Improve missions");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "draft");
    assert.equal(result.value.active, true);
    assert.equal(result.value.open_questions_empty, true);
    assert.equal(result.value.sections["Problem / goal"], true);
    assert.equal(result.value.sections["Open questions"], true);
    assert.match(await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8"), /^status: draft$/m);
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".hivemind", "spec", "active.json"), "utf8")), {
      version: 1,
      spec_id: "S-001"
    });
  });
});

test("spec validate rejects malformed status and missing sections", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, ".hivemind", "spec"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "spec", "S-BAD.md"), "# Spec: Bad\nstatus: done\n## Problem / goal\n");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "spec", "S-BAD", "--validate"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /spec status must be draft or ratified/);
        assert.match(String((error as { stderr?: string }).stderr), /spec is missing required section: Context/);
        return true;
      }
    );
  });
});

test("spec ratify rejects non-empty open questions and then flips status when cleared", async () => {
  await withTempRepo(async ({ repo }) => {
    const created = await createSpec(repo, "S-001", "Clarify target");
    assert.equal(created.ok, true);
    await writeFile(
      path.join(repo, ".hivemind", "spec", "S-001.md"),
      (await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8")).replace("## Open questions\n", "## Open questions\n- Which API?\n")
    );

    const blocked = await ratifySpec(repo, "S-001");
    assert.equal(blocked.ok, false);
    if (blocked.ok) {
      return;
    }
    assert.match(blocked.reason, /Open questions must be empty/);

    await writeFile(
      path.join(repo, ".hivemind", "spec", "S-001.md"),
      (await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8")).replace("- Which API?\n", "")
    );
    const ratified = await ratifySpec(repo, "S-001");

    assert.deepEqual(ratified, {
      ok: true,
      value: {
        spec_id: "S-001",
        spec_path: ".hivemind/spec/S-001.md",
        status: "ratified",
        active: true
      }
    });
    assert.match(await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8"), /^status: ratified$/m);
  });
});

test("draft spec blocks planning and lease grants until ratified", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await execFileAsync(process.execPath, [cliPath, "spec", "S-001", "--create", "--title", "Draft work"], { cwd: repo, windowsHide: true });
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--check"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-001 is draft/);
        return true;
      }
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-001 is draft/);
        return true;
      }
    );
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));

    await execFileAsync(process.execPath, [cliPath, "spec", "S-001", "--ratify"], { cwd: repo, windowsHide: true });
    const plan = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--check"], { cwd: repo, windowsHide: true });
    const lease = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });

    assert.deepEqual(JSON.parse(plan.stdout), { spec_id: "S-001", status: "ratified", planning: "allowed" });
    assert.deepEqual(JSON.parse(lease.stdout), { task_id: "T-001", granted: ["README.md"] });
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-spec-test-"));
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

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Spec gate task",
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

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { startManagerSession } from "../src/manager.js";
import { createSpec } from "../src/spec.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("manager session shell records a user message against the active ratified spec", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const result = await startManagerSession(repo, "Build the next safe slice");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.spec_id, "S-001");
    assert.equal(result.value.proposed_action.type, "await_planning_loop");
    assert.equal(result.value.proposed_action.requires, "M5.4");

    const session = JSON.parse(await readFile(path.join(repo, result.value.session_path), "utf8")) as {
      version: number;
      spec_id: string;
      working_set: { spec: { title: string; status: string }; status: { task_count: number; active_lease_count: number } };
      turns: Array<{ role: string; content: string }>;
      proposed_action: { type: string };
    };
    assert.equal(session.version, 1);
    assert.equal(session.spec_id, "S-001");
    assert.equal(session.working_set.spec.title, "Test spec");
    assert.equal(session.working_set.spec.status, "ratified");
    assert.equal(session.working_set.status.task_count, 0);
    assert.equal(session.working_set.status.active_lease_count, 0);
    assert.deepEqual(session.turns.map((turn) => turn.role), ["user", "manager"]);
    assert.equal(session.turns[0].content, "Build the next safe slice");
    assert.equal(session.proposed_action.type, "await_planning_loop");
  });
});

test("manager CLI writes only the session artifact and does not create task execution state", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Start from the ratified spec"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { session_path: string; proposed_action: { type: string } };

    assert.equal(parsed.proposed_action.type, "await_planning_loop");
    await assertExists(path.join(repo, parsed.session_path));
    assert.deepEqual(await contractFiles(repo), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "leases", "active.json")), false);
    assert.deepEqual(await childNames(path.join(repo, ".hivemind", "patches")), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "integration", "status.json")), false);
  });
});

test("manager chat fails closed for draft or missing specs and records no session", async () => {
  await withTempRepo(async ({ repo }) => {
    const draft = await createSpec(repo, "S-DRAFT", "Draft manager gate");
    assert.equal(draft.ok, true);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-DRAFT is draft/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });

  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /no active spec/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager CLI rejects empty messages before writing a session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "   "], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /manager message must not be empty/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

async function withTempRepo(run: (context: { repo: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-manager-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function contractFiles(repo: string): Promise<string[]> {
  return (await childNames(path.join(repo, ".hivemind", "tasks"))).filter((name) => name.endsWith(".contract.json"));
}

async function childNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
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

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import {
  DEFAULT_RUN_TOKEN_CEILING,
  DEFAULT_SESSION_TOKEN_CEILING,
  type HivemindConfig
} from "./config.js";
import { findGitRoot } from "./repo.js";

const hivemindDirs = ["tasks", "log", "patches", "worktrees", "adapters", "canon"] as const;
const execFileAsync = promisify(execFile);

export async function initProject(cwd: string): Promise<number> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const hivemindRoot = path.join(repoRoot, ".hivemind");
  const configPath = path.join(hivemindRoot, "config.json");

  if (await exists(configPath)) {
    const migration = await ensureBaseBranchRecorded(repoRoot, configPath);
    if (!migration.ok) {
      console.error(`error: ${migration.reason}`);
      return 1;
    }
    console.log("already initialized");
    return 0;
  }

  const baseBranch = await resolveCurrentBranch(repoRoot);
  if (!baseBranch.ok) {
    console.error(`error: ${baseBranch.reason}`);
    return 1;
  }

  await mkdir(hivemindRoot, { recursive: true });
  await Promise.all(hivemindDirs.map((dir) => mkdir(path.join(hivemindRoot, dir), { recursive: true })));
  await writeFile(path.join(hivemindRoot, "log", "events.jsonl"), "", { flag: "a" });

  const config: HivemindConfig = {
    version: 1,
    stack: "typescript-node",
    repo_root: repoRoot,
    base_branch: baseBranch.value,
    test_command: await detectTestCommand(repoRoot),
    allowed_globs: [],
    forbidden_globs: ["**/*.lock", "**/package.json", "**/.git/**"],
    resource_policy: {
      run_ceiling: { tokens: DEFAULT_RUN_TOKEN_CEILING },
      session_ceiling: { tokens: DEFAULT_SESSION_TOKEN_CEILING }
    }
  };

  await writeJsonAtomic(configPath, config);
  console.log("initialized hivemind project");
  return 0;
}

async function ensureBaseBranchRecorded(
  repoRoot: string,
  configPath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return { ok: false, reason: "existing .hivemind/config.json is not valid JSON" };
  }
  if (!isRecord(config)) {
    return { ok: false, reason: "existing .hivemind/config.json must be an object" };
  }
  if (typeof config.base_branch === "string" && config.base_branch.trim() !== "") {
    return { ok: true };
  }
  const branch = await resolveCurrentBranch(repoRoot);
  if (!branch.ok) return branch;
  await writeJsonAtomic(configPath, { ...config, base_branch: branch.value });
  return { ok: true };
}

async function resolveCurrentBranch(
  repoRoot: string
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repoRoot, windowsHide: true }
    );
    const branch = stdout.trim();
    if (branch === "") {
      return { ok: false, reason: "cannot determine the repository base branch from symbolic HEAD" };
    }
    await execFileAsync("git", ["check-ref-format", "--branch", branch], {
      cwd: repoRoot,
      windowsHide: true
    });
    return { ok: true, value: branch };
  } catch {
    return {
      ok: false,
      reason: "cannot determine the repository base branch from symbolic HEAD; check out the intended base branch and run hivemind init again"
    };
  }
}

async function detectTestCommand(repoRoot: string): Promise<string> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.test === "string" ? "npm test" : "";
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return "";
    }
    return "";
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

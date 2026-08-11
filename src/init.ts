import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import {
  DEFAULT_RUN_TOKEN_CEILING,
  DEFAULT_SESSION_TOKEN_CEILING,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  type HivemindConfig
} from "./config.js";
import {
  DEFAULT_TIER_WORKERS,
  defaultTierWorkerProfile,
  REQUIRED_ADAPTER_TOOLS,
  TIER_GLOB_KEYS,
  defaultAdapterProfile,
  defaultTierGlobs
} from "./project-defaults.js";
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
    const globs = await ensureTierGlobsRecorded(configPath);
    if (!globs.ok) {
      console.error(`error: ${globs.reason}`);
      return 1;
    }
    await ensureRequiredAdapterProfiles(hivemindRoot);
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
    ...defaultTierGlobs(),
    manager_autonomy: { level: "auto" },
    execution: { max_concurrent_workers: DEFAULT_MAX_CONCURRENT_WORKERS },
    resource_policy: {
      run_ceiling: { tokens: DEFAULT_RUN_TOKEN_CEILING },
      session_ceiling: { tokens: DEFAULT_SESSION_TOKEN_CEILING }
    }
  };

  await writeJsonAtomic(configPath, config);
  await ensureRequiredAdapterProfiles(hivemindRoot);
  console.log("initialized hivemind project");
  return 0;
}

/**
 * Absence is the only evidence we have that a value was never authored. A key
 * that is present -- even as an empty list -- is a decision someone made, so it
 * is left alone. Only missing keys are filled in.
 */
async function ensureTierGlobsRecorded(configPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return { ok: false, reason: "existing .hivemind/config.json is not valid JSON" };
  }
  if (!isRecord(config)) {
    return { ok: false, reason: "existing .hivemind/config.json must be an object" };
  }
  const defaults = defaultTierGlobs();
  const missing = TIER_GLOB_KEYS.filter((key) => !(key in config));
  if (missing.length === 0) {
    return { ok: true };
  }
  await writeJsonAtomic(configPath, {
    ...config,
    ...Object.fromEntries(missing.map((key) => [key, defaults[key]]))
  });
  return { ok: true };
}

/**
 * Two are resolved by name on a first prompt; the third is the worker routing
 * has to be able to find, since `run_worker` names no tool. A profile that
 * already exists is a choice made in setup, so it is never rewritten.
 */
async function ensureRequiredAdapterProfiles(hivemindRoot: string): Promise<void> {
  const adaptersDir = path.join(hivemindRoot, "adapters");
  await mkdir(adaptersDir, { recursive: true });
  for (const tool of REQUIRED_ADAPTER_TOOLS) {
    const profilePath = path.join(adaptersDir, `${tool}.profile.json`);
    if (await exists(profilePath)) {
      continue;
    }
    await writeJsonAtomic(profilePath, defaultAdapterProfile(tool));
  }
  /* The tier ladder. Without these the routing floor computes the right tier and
     has nowhere to fall, so every task runs on the flagship. */
  for (const entry of DEFAULT_TIER_WORKERS) {
    const profilePath = path.join(adaptersDir, `${entry.tool}.profile.json`);
    if (await exists(profilePath)) continue;
    await writeJsonAtomic(profilePath, defaultTierWorkerProfile(entry));
  }
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

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  TIER_GLOB_KEYS,
  defaultTierGlobs
} from "./project-defaults.js";
import { writeIgnoreRules } from "./project-sharing.js";
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
    await removeLegacyDefaultAdapterProfiles(hivemindRoot);
    /* Converge an already-initialised project onto the rules as well, so a
       project set up before the split stops sharing its machine evidence the
       next time init runs. */
    await writeIgnoreRules(repoRoot);
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
  /* Before anything machine-specific is written, so no window exists in which
     a `git add -A` could capture it. */
  await writeIgnoreRules(repoRoot);

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
  await removeLegacyDefaultAdapterProfiles(hivemindRoot);
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

/** Remove only the exact class of profiles older init versions invented.
 * Provider selection is an explicit paid capability check, so setup cannot
 * claim Codex—or any provider—without running that check. A profile written by
 * a real connection has a measured timestamp and is left alone. */
async function removeLegacyDefaultAdapterProfiles(hivemindRoot: string): Promise<void> {
  const adaptersDir = path.join(hivemindRoot, "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const names = await readdir(adaptersDir);
  for (const name of names.filter((entry) => entry.endsWith(".profile.json"))) {
    const profilePath = path.join(adaptersDir, name);
    let profile: unknown;
    try {
      profile = JSON.parse(await readFile(profilePath, "utf8"));
    } catch {
      continue;
    }
    if (isRecord(profile) && profile.verified_on === "configured-by-init") {
      await rm(profilePath);
    }
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

/**
 * A missing test command and an unreadable one are not the same thing.
 *
 * Both used to produce `""` in silence, so a project whose package.json could
 * not be parsed was set up with no checks and nothing said so. On Windows the
 * usual cause is a byte-order mark: PowerShell's `Set-Content -Encoding utf8`
 * writes one, `JSON.parse` rejects it, and the catch swallowed the whole thing.
 * The BOM is now stripped, and a package.json that still will not parse is
 * reported rather than absorbed -- absence of a package.json stays silent,
 * because that is a project with nothing to detect rather than a broken one.
 */
async function detectTestCommand(repoRoot: string): Promise<string> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  let contents: string;
  try {
    contents = await readFile(packageJsonPath, "utf8");
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return "";
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(contents.replace(/^﻿/u, "")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.test === "string" ? "npm test" : "";
  } catch {
    console.error(
      "warning: package.json could not be read, so no test command was recorded. " +
        "Set test_command in .hivemind/config.json once package.json parses."
    );
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

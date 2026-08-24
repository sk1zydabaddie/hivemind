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
  const fromPackageJson = await detectNodeTestCommand(repoRoot);
  if (fromPackageJson !== "") return fromPackageJson;

  /* The obvious equivalents in other ecosystems, each keyed on the manifest
     that guarantees its standard runner exists. A manifest is evidence the
     TOOLCHAIN is present, not that tests are -- a Rust crate with zero tests
     still runs `cargo test` green, which is the honest vacuous answer. What
     this must never do is guess: a detection here becomes the command
     verification actually runs, so every entry names a file that ships with
     the runner it implies. Where nothing matches, setup asks the person
     rather than proceeding (A-03) -- an empty answer here no longer reads as
     setup-complete. */
  const manifests: Array<{ files: string[]; command: string }> = [
    /* Both runners exit 0 on a project with zero tests, so a manifest alone
       is a safe detection. */
    { files: ["Cargo.toml"], command: "cargo test" },
    { files: ["go.mod"], command: "go test ./..." }
  ];
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      if (await exists(path.join(repoRoot, file))) {
        return manifest.command;
      }
    }
  }
  /* pytest exits 5 when it collects nothing, so its detection needs evidence
     pytest is actually configured, not merely that the project is Python. */
  if (await exists(path.join(repoRoot, "pytest.ini")) || await exists(path.join(repoRoot, "tox.ini"))) {
    return "pytest";
  }
  try {
    const pyproject = await readFile(path.join(repoRoot, "pyproject.toml"), "utf8");
    if (pyproject.includes("[tool.pytest")) return "pytest";
  } catch (error: unknown) {
    if (!isFileMissing(error)) throw error;
  }

  /* EVIDENCE-GATED detections: a manifest here proves the toolchain, not that
     there is anything to run, and these runners do NOT all exit 0 on an empty
     project. So each pairs its manifest with something that only exists when
     tests do -- a directory, a target, a declared script. The gate is the
     point: a guessed command becomes the command verification runs, and a
     guaranteed-red check is worse than asking.

     Ordered from most to least specific so a polyglot repository answers with
     the runner that owns its root. */
  const gated: Array<{ manifest: string; evidence: string[]; command: string }> = [
    /* Gradle and Maven both fail a build with no test sources configured, so
       the source directory is the evidence. */
    { manifest: "build.gradle", evidence: ["src/test"], command: "gradle test" },
    { manifest: "build.gradle.kts", evidence: ["src/test"], command: "gradle test" },
    { manifest: "pom.xml", evidence: ["src/test"], command: "mvn -q test" },
    /* `mix test` needs the test directory to exist. */
    { manifest: "mix.exs", evidence: ["test"], command: "mix test" },
    /* `deno test` with no files exits non-zero. */
    { manifest: "deno.json", evidence: ["test", "tests"], command: "deno test -A" },
    { manifest: "deno.jsonc", evidence: ["test", "tests"], command: "deno test -A" },
    /* rspec is the near-universal Ruby answer, and `spec/` is its evidence. */
    { manifest: "Gemfile", evidence: ["spec"], command: "bundle exec rspec" }
  ];
  for (const entry of gated) {
    if (!(await exists(path.join(repoRoot, entry.manifest)))) continue;
    for (const evidence of entry.evidence) {
      if (await exists(path.join(repoRoot, evidence))) return entry.command;
    }
  }

  /* A wrapper script is stronger evidence than the manifest it wraps, because
     somebody committed it deliberately. Checked after the manifests so the
     wrapper form wins only when it is actually present. */
  for (const [wrapper, command] of [
    ["gradlew.bat", "gradlew test"],
    ["gradlew", "./gradlew test"],
    ["mvnw.cmd", "mvnw -q test"],
    ["mvnw", "./mvnw -q test"]
  ] as const) {
    if ((await exists(path.join(repoRoot, wrapper))) && (await exists(path.join(repoRoot, "src/test")))) {
      return command;
    }
  }

  /* A Makefile with a `test:` target is an explicit statement by the author
     that this is how the project is checked. Parsed rather than guessed: the
     target must start a line, which is what make itself requires. */
  try {
    const makefile = await readFile(path.join(repoRoot, "Makefile"), "utf8");
    if (/^test\s*:/mu.test(makefile)) return "make test";
  } catch (error: unknown) {
    if (!isFileMissing(error)) throw error;
  }

  /* .NET: `dotnet test` needs a test project, and a solution with none exits
     non-zero. A `*Tests*` project file is the evidence. */
  if (await exists(path.join(repoRoot, "global.json"))) {
    if (await hasTestProject(repoRoot)) return "dotnet test";
  }
  for (const solutionish of await listShallow(repoRoot)) {
    if (!/\.(sln|slnx)$/iu.test(solutionish)) continue;
    if (await hasTestProject(repoRoot)) return "dotnet test";
    break;
  }

  return "";
}

/** A `*Tests.csproj` / `*.Tests/` anywhere shallow, which is what `dotnet test` needs. */
async function hasTestProject(repoRoot: string): Promise<boolean> {
  for (const entry of await listShallow(repoRoot)) {
    if (/tests?$/iu.test(entry) || /tests?\.(cs|fs|vb)proj$/iu.test(entry)) return true;
  }
  return false;
}

/** Entry names one level down, or an empty list when the folder cannot be read. */
async function listShallow(repoRoot: string): Promise<string[]> {
  try {
    return await readdir(repoRoot);
  } catch (error: unknown) {
    if (isFileMissing(error)) return [];
    throw error;
  }
}

async function detectNodeTestCommand(repoRoot: string): Promise<string> {
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
    const scripts = parsed.scripts ?? {};
    /* `test` first because it is the convention, then the two names projects
       use when "test" would be misleading -- a `check` script that runs types
       and tests together is a better answer than nothing, and it is the
       author's own word for how the project is checked. Anything else is not
       guessed at. */
    const script = ["test", "check", "verify"].find((name) => typeof scripts[name] === "string");
    if (script === undefined) return "";
    /* The project's own package manager, from its lockfile. `npm test` in a
       pnpm workspace works often enough to look fine and fails in exactly the
       repositories where workspace resolution matters. */
    const runner = (await exists(path.join(repoRoot, "pnpm-lock.yaml")))
      ? "pnpm"
      : (await exists(path.join(repoRoot, "yarn.lock")))
        ? "yarn"
        : (await exists(path.join(repoRoot, "bun.lockb"))) || (await exists(path.join(repoRoot, "bun.lock")))
          ? "bun"
          : "npm";
    /* `yarn test` and `pnpm test` take the bare script name; npm and bun are
       happiest with `run` for anything that is not literally `test`. */
    if (script === "test") return `${runner} test`;
    return runner === "yarn" || runner === "pnpm" ? `${runner} ${script}` : `${runner} run ${script}`;
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

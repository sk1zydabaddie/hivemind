import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import {
  DEFAULT_RUN_TOKEN_CEILING,
  DEFAULT_SESSION_TOKEN_CEILING,
  type HivemindConfig
} from "./config.js";
import { findGitRoot } from "./repo.js";

const hivemindDirs = ["tasks", "log", "patches", "worktrees", "adapters", "canon"] as const;

export async function initProject(cwd: string): Promise<number> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const hivemindRoot = path.join(repoRoot, ".hivemind");
  const configPath = path.join(hivemindRoot, "config.json");

  if (await exists(configPath)) {
    console.log("already initialized");
    return 0;
  }

  await mkdir(hivemindRoot, { recursive: true });
  await Promise.all(hivemindDirs.map((dir) => mkdir(path.join(hivemindRoot, dir), { recursive: true })));
  await writeFile(path.join(hivemindRoot, "log", "events.jsonl"), "", { flag: "a" });

  const config: HivemindConfig = {
    version: 1,
    stack: "typescript-node",
    repo_root: repoRoot,
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

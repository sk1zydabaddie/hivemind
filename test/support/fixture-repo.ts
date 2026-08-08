import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REQUIRED_ADAPTER_TOOLS } from "../../src/project-defaults.js";

/**
 * Building a fixture repository costs about ten process spawns (git init,
 * two config writes, add, commit, then initProject's own git calls). Measured
 * at ~1.1s each on Windows, against ~490 fixtures across the suite.
 *
 * A template is built once per shape per test process and copied per test.
 * Each test still gets its own directory, so isolation is unchanged; only the
 * construction method differs. Measured at 6.9x faster per fixture.
 *
 * A fresh fixture embeds its absolute path in exactly one file --
 * .hivemind/config.json's repo_root -- which loadConfig validates against the
 * real git root. The copy rewrites it. If a shape ever stores an absolute path
 * elsewhere, that shape must keep building from scratch instead.
 */

const templates = new Map<string, Promise<string>>();
const templateRoots: string[] = [];
let cleanupRegistered = false;

function registerTemplateCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on("exit", () => {
    for (const root of templateRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort: the process is exiting and the OS temp directory is
        // disposable. Never mask a test result with a cleanup failure.
      }
    }
  });
}

async function templateFor(shape: string, build: (repo: string) => Promise<void>): Promise<string> {
  const existing = templates.get(shape);
  if (existing !== undefined) return existing;

  const created = (async () => {
    registerTemplateCleanup();
    const root = await mkdtemp(path.join(tmpdir(), "hivemind-template-"));
    templateRoots.push(root);
    await build(root);
    return root;
  })();
  templates.set(shape, created);
  try {
    return await created;
  } catch (error: unknown) {
    // A failed template must not be cached, or every later test in this file
    // fails with the same stale rejection instead of its own error.
    templates.delete(shape);
    throw error;
  }
}

async function rebindRepoRoot(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    // Shapes that never run initProject have no config to rebind.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.repo_root = repo;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Removes the profiles init writes so a fresh project can reach a first run.
 *
 * A fixture that writes its own adapter profiles is declaring its provider
 * set, and routing chooses from every worker profile on disk. A fixture whose
 * assertion is "nothing eligible remains" cannot leave init's default worker
 * behind, or it is asserting against a provider it never named.
 *
 * This is not a workaround for the default worker outranking anything -- it is
 * ranked last on purpose and cannot. It is only for fixtures that need the set
 * to be *exactly* what they wrote.
 */
export async function useOnlyFixtureAdapterProfiles(repo: string): Promise<void> {
  for (const tool of REQUIRED_ADAPTER_TOOLS) {
    await rm(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), { force: true });
  }
}

/**
 * Runs `run` against a private copy of the `shape` template, building the
 * template on first use in this process. `prefix` only names the temp
 * directory, so failures stay attributable to the file that created them.
 */
export async function withTemplateRepo<T>(
  shape: string,
  build: (repo: string) => Promise<void>,
  run: (repo: string) => Promise<T>,
  prefix = "hivemind-fixture-",
  cleanup?: (repo: string) => Promise<void>
): Promise<T> {
  const template = await templateFor(shape, build);
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await cp(template, repo, { recursive: true });
    await rebindRepoRoot(repo);
    return await run(repo);
  } finally {
    // Files that create git worktrees must detach them before removal, so they
    // pass their own cleanup rather than relying on a plain recursive delete.
    if (cleanup === undefined) {
      await rm(repo, { recursive: true, force: true, maxRetries: 3 });
    } else {
      await cleanup(repo);
    }
  }
}

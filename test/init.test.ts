import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  DEFAULT_RUN_TOKEN_CEILING,
  DEFAULT_SESSION_TOKEN_CEILING,
  loadConfig
} from "../src/config.js";
import {
  findDangerousAdapterArgs,
  findRefusedAdapterModes,
  loadAdapterProfile,
  profileAdmitsRole
} from "../src/adapter.js";
import { initProject } from "../src/init.js";
import { inferAllowedFilesTier } from "../src/routing.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("init creates the M0.1 .hivemind scaffold inside a git repo", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init", "-b", "master"]);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));

    const code = await initProject(repo);

    assert.equal(code, 0);
    await assertExists(path.join(repo, ".hivemind", "tasks"));
    await assertExists(path.join(repo, ".hivemind", "log"));
    await assertExists(path.join(repo, ".hivemind", "patches"));
    await assertExists(path.join(repo, ".hivemind", "worktrees"));
    await assertExists(path.join(repo, ".hivemind", "adapters"));
    await assertExists(path.join(repo, ".hivemind", "canon"));
    assert.equal(await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8"), "");
    // The desktop asks Core for these two tools by name on a first prompt.
    await assertExists(path.join(repo, ".hivemind", "adapters", "planner.profile.json"));
    await assertExists(path.join(repo, ".hivemind", "adapters", "manager.profile.json"));
    // The manager proposes run_worker without naming a tool, so routing has to
    // be able to FIND a worker. Without this the orchestrator scoping below
    // would leave a clean install able to plan but never build.
    await assertExists(path.join(repo, ".hivemind", "adapters", "worker.profile.json"));

    const config = JSON.parse(await readFile(path.join(repo, ".hivemind", "config.json"), "utf8")) as {
      version: number;
      stack: string;
      repo_root: string;
      base_branch: string;
      test_command: string;
      allowed_globs: string[];
      forbidden_globs: string[];
      low_globs: string[];
      medium_globs: string[];
      high_globs: string[];
      critical_globs: string[];
      resource_policy: {
        run_ceiling: { tokens: number };
        session_ceiling: { tokens: number };
      };
      execution: { max_concurrent_workers: number };
      manager_autonomy: { level: string };
    };

    assert.deepEqual(config, {
      version: 1,
      stack: "typescript-node",
      repo_root: repo.replaceAll("\\", "/"),
      base_branch: "master",
      test_command: "npm test",
      allowed_globs: [],
      forbidden_globs: ["**/*.lock", "**/package.json", "**/.git/**"],
      // Cost tiers ship by default: without them every path fell through to
      // the High fallback, which only a strong provider may serve.
      low_globs: ["docs/**", "**/*.md", "**/*.txt"],
      medium_globs: ["src/**", "app/**", "lib/**", "test/**", "tests/**"],
      high_globs: ["package.json", "tsconfig.json", "**/*.config.*"],
      critical_globs: [".github/**", "infra/**", "**/auth/**"],
      manager_autonomy: { level: "auto" },
      execution: { max_concurrent_workers: DEFAULT_MAX_CONCURRENT_WORKERS },
      resource_policy: {
        run_ceiling: { tokens: DEFAULT_RUN_TOKEN_CEILING },
        session_ceiling: { tokens: DEFAULT_SESSION_TOKEN_CEILING }
      }
    });
  });
});

test("loadConfig applies safe token defaults to legacy config and preserves deliberate overrides", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    delete config.resource_policy;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const legacy = await loadConfig(repo);

    assert.equal(legacy.ok, true);
    if (!legacy.ok) {
      return;
    }
    assert.equal(legacy.config.resource_policy?.run_ceiling?.tokens, DEFAULT_RUN_TOKEN_CEILING);
    assert.equal(legacy.config.resource_policy?.session_ceiling?.tokens, DEFAULT_SESSION_TOKEN_CEILING);

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          resource_policy: {
            run_ceiling: { requests: 3, tokens: 200_000 },
            session_ceiling: { tokens: 2_000_000 }
          }
        },
        null,
        2
      )}\n`
    );

    const overridden = await loadConfig(repo);

    assert.equal(overridden.ok, true);
    if (!overridden.ok) {
      return;
    }
    assert.deepEqual(overridden.config.resource_policy, {
      run_ceiling: { requests: 3, tokens: 200_000 },
      session_ceiling: { tokens: 2_000_000 }
    });
  });
});

test("loadConfig validates and normalizes opt-in LCOV configuration", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        verification: {
          checks: [{ id: "unit", command: "npm test", entry_files: ["test/unit.test.ts"] }],
          coverage: {
            command: " npm run coverage ",
            report_path: ".\\coverage\\lcov.info",
            format: "lcov"
          }
        }
      }, null, 2)}\n`
    );

    const loaded = await loadConfig(repo);

    assert.equal(loaded.ok, true);
    if (!loaded.ok) {
      return;
    }
    assert.deepEqual(loaded.config.verification?.coverage, {
      command: "npm run coverage",
      report_path: "coverage/lcov.info",
      format: "lcov"
    });

    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        verification: {
          checks: [{ id: "unit", command: "npm test", entry_files: ["test/unit.test.ts"] }],
          coverage: {
            command: "npm run coverage",
            report_path: "../outside.info",
            format: "json"
          }
        }
      }, null, 2)}\n`
    );
    const invalid = await loadConfig(repo);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.match(invalid.reason, /report_path must be a confined repository-relative path/);
      assert.match(invalid.reason, /format must be "lcov"/);
    }
  });
});

test("loadConfig validates repository-authored characterization test paths", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const checks = [{ id: "unit", command: "npm test", entry_files: ["test/unit.test.ts"] }];
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        verification: {
          checks,
          test_paths: [".\\test\\**\\*.test.ts", "test/**/*.test.ts", "src/parser.spec.ts"]
        }
      }, null, 2)}\n`
    );

    const loaded = await loadConfig(repo);

    assert.equal(loaded.ok, true);
    if (!loaded.ok) {
      return;
    }
    assert.deepEqual(loaded.config.verification?.test_paths, [
      "test/**/*.test.ts",
      "src/parser.spec.ts"
    ]);

    for (const testPaths of [["../test/**"], [path.resolve(repo, "test", "**")], ["src/**"], ["**/*.ts"]]) {
      await writeFile(
        configPath,
        `${JSON.stringify({
          ...config,
          verification: { checks, test_paths: testPaths }
        }, null, 2)}\n`
      );
      const invalid = await loadConfig(repo);
      assert.equal(invalid.ok, false);
      if (!invalid.ok) {
        assert.match(
          invalid.reason,
          /verification\.test_paths\[0\] (?:is invalid|must be confined)/
        );
      }
    }

    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        verification: { checks, test_paths: [] }
      }, null, 2)}\n`
    );
    const empty = await loadConfig(repo);
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.deepEqual(empty.config.verification?.test_paths, []);
    }
  });
});

test("init fails outside a git repo", async () => {
  await withTempDir(async (dir) => {
    const code = await initProject(dir);
    assert.equal(code, 1);
  });
});

test("init is idempotent and does not overwrite config", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);

    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const original = await readFile(configPath, "utf8");
    const edited = original.replace('"test_command": ""', '"test_command": "custom"');
    await writeFile(configPath, edited);

    assert.equal(await initProject(repo), 0);
    assert.equal(await readFile(configPath, "utf8"), edited);
  });
});

test("init records the current branch in legacy config without changing existing settings", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init", "-b", "master"]);
    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    delete config.base_branch;
    config.test_command = "custom verification";
    config.custom_setting = { preserved: true };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    assert.equal(await initProject(repo), 0);

    const migrated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(migrated.base_branch, "master");
    assert.equal(migrated.test_command, "custom verification");
    assert.deepEqual(migrated.custom_setting, { preserved: true });
  });
});

test("init fails closed when symbolic HEAD cannot identify a base branch", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Detached fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["checkout", "--detach", "HEAD"]);

    assert.equal(await initProject(repo), 1);
    await assert.rejects(stat(path.join(repo, ".hivemind", "config.json")));
  });
});

test("CLI init reports exact success and outside-git failure behavior", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);

    const success = await execFileAsync("node", [cliPath, "init"], { cwd: repo, windowsHide: true });
    assert.equal(success.stdout.trim(), "initialized hivemind project");
    assert.equal(success.stderr, "");
  });

  await withTempDir(async (dir) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "init"], { cwd: dir, windowsHide: true }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.notEqual(error, null);
        assert.equal((error as { code?: number }).code, 1);
        assert.equal((error as { stderr?: string }).stderr?.trim(), "error: not a git repository");
        return true;
      }
    );
  });
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-init-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}

test("a fresh project routes by cost tier instead of forcing the strongest provider", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);
    const config = await loadConfig(repo);
    assert.equal(config.ok, true, config.ok ? undefined : config.reason);
    if (!config.ok) return;

    // Without globs every path fell through to the "high" fallback, and High
    // requires a strong provider, so cheap providers were ineligible rather
    // than deprioritised: a new project could only use the most expensive one.
    assert.equal(inferAllowedFilesTier(["docs/guide.md"], config.config), "low");
    assert.equal(inferAllowedFilesTier(["src/feature.ts"], config.config), "medium");
    assert.equal(inferAllowedFilesTier([".github/workflows/ci.yml"], config.config), "critical");
    // The floor is unchanged: anything the globs do not name is still High.
    assert.equal(inferAllowedFilesTier(["unmatched/elsewhere.bin"], config.config), "high");
    // And the highest scope in a task still wins.
    assert.equal(inferAllowedFilesTier(["docs/guide.md", ".github/workflows/ci.yml"], config.config), "critical");
  });
});

test("a fresh project can reach a first run without hand-written adapter profiles", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);

    for (const tool of ["planner", "manager", "worker"]) {
      const loaded = await loadAdapterProfile(repo, tool);
      assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.reason);
      if (!loaded.ok) continue;
      assert.equal(loaded.profile.tool, tool);
      // Confined and explicit: every setting the run depends on is stated, so
      // an unstated one cannot stay whatever the user's agent config left it.
      assert.deepEqual(findDangerousAdapterArgs(loaded.profile.invoke), []);
      assert.equal(loaded.profile.invoke.includes("--model"), true);
      assert.equal(loaded.profile.invoke.includes("--sandbox"), true);
      assert.equal(loaded.profile.invoke.includes("workspace-write"), true);
      assert.equal(loaded.profile.invoke.some((arg) => /ultra|ignore-user-config/iu.test(arg)), false);
      assert.deepEqual(findRefusedAdapterModes(loaded.profile), []);
      // Every default states its role. planner and manager are resolved by
      // name and must never be FOUND by the worker search: offering them as
      // worker candidates let a default outrank a deliberately configured
      // provider, and turned a quota pause into a reroute, both without
      // anyone choosing it.
      const expected = tool === "worker" ? ["worker"] : ["orchestrator"];
      assert.deepEqual(loaded.profile.roles, expected);
      assert.equal(profileAdmitsRole(loaded.profile, "worker"), tool === "worker");
      assert.equal(profileAdmitsRole(loaded.profile, "orchestrator"), tool !== "worker");
    }
  });
});

test("init fills only absent tier globs and never rewrites an authored value", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");

    // A deliberately empty list is a decision, not an absence.
    const authored = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    authored.low_globs = [];
    authored.medium_globs = ["only/mine/**"];
    delete authored.critical_globs;
    await writeFile(configPath, `${JSON.stringify(authored, null, 2)}\n`);

    assert.equal(await initProject(repo), 0);
    const after = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(after.low_globs, [], "an authored empty list was overwritten");
    assert.deepEqual(after.medium_globs, ["only/mine/**"], "an authored list was overwritten");
    assert.deepEqual(after.critical_globs, [".github/**", "infra/**", "**/auth/**"]);

    // An existing profile is a setup choice and is never rewritten.
    const plannerPath = path.join(repo, ".hivemind", "adapters", "planner.profile.json");
    await writeFile(plannerPath, `${JSON.stringify({ tool: "planner", mine: true }, null, 2)}\n`);
    assert.equal(await initProject(repo), 0);
    assert.deepEqual(JSON.parse(await readFile(plannerPath, "utf8")), { tool: "planner", mine: true });
  });
});

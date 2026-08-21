import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_RUN_TOKEN_CEILING, DEFAULT_SESSION_TOKEN_CEILING, loadConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { MEASURED_WORST_SINGLE_CALL_TOKENS } from "../src/project-defaults.js";

const execFileAsync = promisify(execFile);

/**
 * A fresh project's budgets have to work *together*.
 *
 * They did not. Tier globs were written correctly and only strong-tier profiles
 * existed, so every task ran on the flagship; and the run ceiling was 150,000
 * while one flagship worker call cost 152,229. Each number was defensible on its
 * own. Together they guaranteed that a first run stopped on quota *after* the
 * work was done and the money was spent.
 *
 * Provider profiles are now explicit checked choices, not defaults. These
 * assertions still ensure an admitted large call fits inside the budget.
 */

test("the default ceiling clears the worst measured admitted call", () => {
  /* The trap, stated as a property. Not "the ceiling is 300,000" -- that number
     may move -- but "a default run can afford its own most expensive call". */
  assert.ok(
    DEFAULT_RUN_TOKEN_CEILING > MEASURED_WORST_SINGLE_CALL_TOKENS,
    `run ceiling ${DEFAULT_RUN_TOKEN_CEILING} must exceed the worst measured single call ${MEASURED_WORST_SINGLE_CALL_TOKENS}`
  );
  // With enough room that a call running longer than the measured one still fits.
  assert.ok(
    DEFAULT_RUN_TOKEN_CEILING >= Math.ceil(MEASURED_WORST_SINGLE_CALL_TOKENS * 1.5),
    "a run ceiling with no headroom is a trap waiting for a slightly longer call"
  );
  /* And a session has to hold a real run: drafting, planning, and several
     workers, plus the revisions a normal run makes. */
  assert.ok(
    DEFAULT_SESSION_TOKEN_CEILING >= DEFAULT_RUN_TOKEN_CEILING * 5,
    "a session ceiling must hold a multi-task run, not one call"
  );
});

test("a fresh project invents no provider or model choice", async () => {
  await withFreshProject(async (repo) => {
    const profiles = (await readdir(path.join(repo, ".hivemind", "adapters")))
      .filter((name) => name.endsWith(".profile.json"));
    assert.deepEqual(profiles, []);
  });
});

async function withFreshProject(
  run: (repo: string) => Promise<void>,
  options: { bom?: boolean } = {}
): Promise<void> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-defaults-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const packageJson = `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`;
    await writeFile(
      path.join(repo, "package.json"),
      options.bom === true ? `﻿${packageJson}` : packageJson,
      "utf8"
    );
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await initProject(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("a byte-order mark does not silently cost a project its checks", async () => {
  /* PowerShell's `Set-Content -Encoding utf8` writes a BOM. JSON.parse rejects
     it, and init used to absorb that into an empty test command -- a project set
     up with no checks and nothing saying so. Found by walking, not by a unit. */
  await withFreshProject(async (repo) => {
    const config = await loadConfig(repo);
    assert.equal(config.ok, true);
    if (config.ok) {
      assert.equal(
        config.config.test_command,
        "npm test",
        "a BOM in package.json must not cost the project its test command"
      );
    }
  }, { bom: true });
});

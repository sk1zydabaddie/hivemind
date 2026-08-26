import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { setProjectConfig } from "../src/config-actions.js";
import { loadConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { draftSpecFromPrompt } from "../src/spec-draft-action.js";
import { readProjectFile } from "../src/project-files.js";

const run = promisify(execFile);

/**
 * A-03: setup read complete with an empty test_command, Work was enabled,
 * and integration rejected the project AFTER planning and worker calls were
 * already paid for. First hour, ordinary projects, fail-open in a
 * fail-closed product.
 *
 * The invariant: setup cannot read complete while a value integration will
 * later require is absent. Either detection found a command, the person
 * supplies one, or the person records that this project has no tests -- and
 * the money gate holds at the FIRST paid call, where a refusal costs
 * nothing, not at integration, where it costs a whole run.
 */

async function scratchRepo(
  files: Record<string, string>,
  /* Directories, because half of the detections are EVIDENCE-GATED: a manifest
     proves the toolchain and a `src/test` or `spec` proves there is something
     to run. A fixture that cannot express the difference cannot test the gate. */
  dirs: string[] = []
): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-verification-absence-"));
  await run("git", ["init"], { cwd: repo });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: repo });
  await run("git", ["config", "user.name", "t"], { cwd: repo });
  for (const relative of dirs) {
    await mkdir(path.join(repo, relative), { recursive: true });
    await writeFile(path.join(repo, relative, ".keep"), "\n", "utf8");
  }
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(repo, name), contents, "utf8");
  }
  if (Object.keys(files).length === 0) {
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  }
  await run("git", ["add", "-A"], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  await initProject(repo);
  return repo;
}

async function configuredCommand(repo: string): Promise<string> {
  const config = await loadConfig(repo);
  assert.equal(config.ok, true, config.ok ? undefined : config.reason);
  return config.ok ? config.config.test_command : "";
}

test("detection reads the manifests that guarantee a runner, and only those", async () => {
  assert.equal(
    await configuredCommand(await scratchRepo({ "Cargo.toml": "[package]\nname = \"t\"\n" })),
    "cargo test"
  );
  assert.equal(
    await configuredCommand(await scratchRepo({ "go.mod": "module example.test/t\n" })),
    "go test ./..."
  );
  assert.equal(
    await configuredCommand(await scratchRepo({ "pytest.ini": "[pytest]\n" })),
    "pytest"
  );
  assert.equal(
    await configuredCommand(
      await scratchRepo({ "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n" })
    ),
    "pytest"
  );
  /* pytest exits 5 on a project where it collects nothing, so Python alone
     is not evidence -- a detection here becomes the command verification
     actually runs, and a guessed command is a guaranteed red run. */
  assert.equal(
    await configuredCommand(await scratchRepo({ "pyproject.toml": "[project]\nname = \"t\"\n" })),
    ""
  );
  assert.equal(await configuredCommand(await scratchRepo({})), "");
});

test("declaring no tests is explicit, recorded, and replaced by a real command", async () => {
  const repo = await scratchRepo({});

  /* Anything less explicit than `true` is refused: the declaration is a
     recorded decision, not a flag that drifts in. */
  const vague = await setProjectConfig(repo, { no_tests_declared: "yes" });
  assert.equal(vague.ok, false);

  const declared = await setProjectConfig(repo, { no_tests_declared: true });
  assert.equal(declared.ok, true, declared.ok ? undefined : declared.reason);
  const afterDeclare = await loadConfig(repo);
  assert.equal(afterDeclare.ok && afterDeclare.config.no_tests_declared, true);

  /* A real command supersedes the recorded absence -- the two must never
     coexist in the durable record. */
  const commanded = await setProjectConfig(repo, { test_command: "node --test" });
  assert.equal(commanded.ok, true, commanded.ok ? undefined : commanded.reason);
  const afterCommand = await loadConfig(repo);
  assert.equal(afterCommand.ok && afterCommand.config.test_command, "node --test");
  assert.equal(afterCommand.ok && afterCommand.config.no_tests_declared === undefined, true);
});

test("the money gate refuses before the first paid call, and the declaration opens it", async () => {
  const repo = await scratchRepo({});
  const counter = await installDrafter(repo);

  const refused = await draftSpecFromPrompt(repo, "Add a thing.", "planner", {
    readProjectFile: (filePath) => readProjectFile(repo, filePath)
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.match(refused.reason, /has not declared that it has no tests/u);
  }
  assert.equal(
    await callCount(counter),
    0,
    "the refusal must cost nothing: no provider process may start"
  );

  const declared = await setProjectConfig(repo, { no_tests_declared: true });
  assert.equal(declared.ok, true, declared.ok ? undefined : declared.reason);

  const drafted = await draftSpecFromPrompt(repo, "Add a thing.", "planner", {
    readProjectFile: (filePath) => readProjectFile(repo, filePath)
  });
  assert.equal(drafted.ok, true, drafted.ok ? undefined : drafted.reason);
  assert.equal(await callCount(counter), 1);
});

/* ── fixtures (the drafter shim mirrors spec-draft-retry.test.ts) ────── */

const VALID_DRAFT = JSON.stringify({
  title: "Add a thing",
  goal: "Add a thing with a check.",
  non_goals: [],
  acceptance: ["the thing exists"],
  open_questions: [],
  assumptions: ["Nothing surprising."],
  alternatives: [
    { title: "One file", tradeoffs: ["Simple."] },
    { title: "A module", tradeoffs: ["Heavier."] }
  ],
  self_critique: { weakest_point: "Thin.", cut_or_change: "Nothing." }
});

async function installDrafter(repo: string): Promise<string> {
  const binDir = path.join(repo, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const counter = path.join(binDir, "calls.txt");
  const script = path.join(binDir, "drafter.mjs");
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(counter)}, 'call\\n');`,
      `process.stdout.write(${JSON.stringify(VALID_DRAFT)});`
    ].join("\n"),
    "utf8"
  );
  let invoke: string[];
  if (process.platform === "win32") {
    const shim = path.join(binDir, "drafter.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0drafter.mjs" %*\r\n`, "utf8");
    invoke = ["cmd.exe", "/d", "/s", "/c", shim];
  } else {
    const shim = path.join(binDir, "drafter");
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/drafter.mjs" "$@"\n`, "utf8");
    await chmod(shim, 0o755);
    invoke = [shim];
  }
  await mkdir(path.join(repo, ".hivemind", "adapters"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "adapters", "planner.profile.json"),
    `${JSON.stringify(
      {
        tool: "planner",
        invoke,
        prompt_arg: "stdin",
        verified_on: "test",
        context_window: 200_000,
        timeout_ms: 60_000,
        routing_tier: "cheap",
        cost_rank: 1,
        roles: ["orchestrator"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return counter;
}

async function callCount(counter: string): Promise<number> {
  try {
    return (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/* ── Detection reaches further, and still refuses to guess ────────────────
 *
 * The check question was the most-complained-about screen in setup, and the
 * complaint was not that it exists -- it exists because setup used to read
 * complete and integration then rejected the project after a plan and workers
 * had been paid for. The complaint was being ASKED when the project already
 * answers. So detection reaches into more ecosystems, and every new entry is
 * EVIDENCE-GATED: a manifest proves the toolchain, not that there is anything
 * to run, and these runners do not all exit 0 on an empty project. A guessed
 * command fails every change instead of checking it, which is worse than the
 * question. */
test("detection reads the project's own package manager and its own script name", async () => {
  const cases: Array<{ files: Record<string, string>; expected: string }> = [
    /* The convention, with the default runner. */
    { files: { "package.json": '{"scripts":{"test":"node --test"}}' }, expected: "npm test" },
    /* The project's own package manager, from its lockfile: `npm test` in a
       pnpm workspace works often enough to look fine and fails where
       workspace resolution matters. */
    {
      files: { "package.json": '{"scripts":{"test":"vitest"}}', "pnpm-lock.yaml": "lockfileVersion: 9\n" },
      expected: "pnpm test"
    },
    {
      files: { "package.json": '{"scripts":{"test":"jest"}}', "yarn.lock": "# yarn\n" },
      expected: "yarn test"
    },
    /* The author's own word for checking, when "test" is not the script they
       wrote. `run` for the runners that want it. */
    {
      files: { "package.json": '{"scripts":{"check":"tsc && vitest run"}}' },
      expected: "npm run check"
    },
    {
      files: { "package.json": '{"scripts":{"verify":"make ci"}}', "yarn.lock": "# yarn\n" },
      expected: "yarn verify"
    },
    /* A script that is neither test, check nor verify is not guessed at. */
    { files: { "package.json": '{"scripts":{"lint":"eslint ."}}' }, expected: "" }
  ];
  for (const entry of cases) {
    const repo = await scratchRepo(entry.files);
    try {
      const loaded = await loadConfig(repo);
      assert.equal(loaded.ok, true);
      assert.equal(
        loaded.ok ? loaded.config.test_command : "<unreadable>",
        entry.expected,
        `files ${Object.keys(entry.files).join(", ")}`
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("a manifest alone never answers for a runner that fails on an empty project", async () => {
  const cases: Array<{ files: Record<string, string>; dirs?: string[]; expected: string }> = [
    /* Gradle, Maven, mix, deno, rspec: manifest WITHOUT the evidence answers
       nothing, so setup asks rather than recording a red command. */
    { files: { "build.gradle": "plugins { id 'java' }\n" }, expected: "" },
    { files: { "pom.xml": "<project/>\n" }, expected: "" },
    { files: { "mix.exs": "defmodule X do\nend\n" }, expected: "" },
    { files: { "Gemfile": "source 'https://rubygems.org'\n" }, expected: "" },
    /* And WITH it, the standard runner for that ecosystem. */
    { files: { "build.gradle": "plugins { id 'java' }\n" }, dirs: ["src/test"], expected: "gradle test" },
    { files: { "pom.xml": "<project/>\n" }, dirs: ["src/test"], expected: "mvn -q test" },
    { files: { "mix.exs": "defmodule X do\nend\n" }, dirs: ["test"], expected: "mix test" },
    { files: { "Gemfile": "source 'x'\n" }, dirs: ["spec"], expected: "bundle exec rspec" },
    /* A Makefile target is the author saying it outright. */
    { files: { Makefile: "build:\n\tcc x.c\n\ntest:\n\t./run-tests\n" }, expected: "make test" },
    /* A Makefile without one is not a detection. */
    { files: { Makefile: "build:\n\tcc x.c\n" }, expected: "" }
  ];
  for (const entry of cases) {
    const repo = await scratchRepo(entry.files, entry.dirs ?? []);
    try {
      const loaded = await loadConfig(repo);
      assert.equal(loaded.ok, true);
      assert.equal(
        loaded.ok ? loaded.config.test_command : "<unreadable>",
        entry.expected,
        `${Object.keys(entry.files).join(", ")} + [${(entry.dirs ?? []).join(", ")}]`
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

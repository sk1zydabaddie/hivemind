import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initProject } from "../src/init.js";
import { draftSpecFromPrompt } from "../src/spec-draft-action.js";

const run = promisify(execFile);

/**
 * The front door failing intermittently.
 *
 * A real Linux first run hit `spec drafter returned invalid JSON`; the same
 * prompt succeeded on the very next attempt with the same model. The drafter is
 * a cheap model by default, so malformed output is sampling variance, and a
 * first-time user met a hard refusal with no hint that pressing again was the
 * right move.
 *
 * What must NOT be retried away is the drafter's judgement. A blocking question
 * is a successful parse, so these tests pin both directions.
 */

const VALID = {
  title: "Add a greet helper",
  goal: "Add a greet(name) helper with its own tests.",
  non_goals: [],
  acceptance: ["greet('a') returns 'Hello, a!'"],
  open_questions: [],
  assumptions: ["Practical greeting format."],
  alternatives: [
    { title: "One file", tradeoffs: ["Simple, but it grows badly."] },
    { title: "A module", tradeoffs: ["More structure than this needs."] }
  ],
  self_critique: { weakest_point: "Thin.", cut_or_change: "Nothing." }
};

/** A fake drafter whose reply depends on how many times it has been called. */
async function installDrafter(repo: string, replies: string[]): Promise<string> {
  const binDir = path.join(repo, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const counter = path.join(binDir, "calls.txt");
  const script = path.join(binDir, "drafter.mjs");
  await writeFile(
    script,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const counter = ${JSON.stringify(counter)};`,
      `const replies = ${JSON.stringify(replies)};`,
      "let seen = 0;",
      "try { seen = readFileSync(counter, 'utf8').trim().split('\\n').filter(Boolean).length; } catch {}",
      "appendFileSync(counter, 'call\\n');",
      "process.stdout.write(replies[Math.min(seen, replies.length - 1)]);"
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
    await writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/drafter.mjs" "$@"\n`,
      "utf8"
    );
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

async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-draft-retry-"));
  await run("git", ["init"], { cwd: repo });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: repo });
  await run("git", ["config", "user.name", "t"], { cwd: repo });
  await writeFile(path.join(repo, "package.json"), '{"name":"t","scripts":{"test":"node --test"}}\n', "utf8");
  await run("git", ["add", "-A"], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  await initProject(repo);
  return repo;
}

async function callCount(counter: string): Promise<number> {
  try {
    return (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("unreadable output is retried, and the same prompt succeeding second is enough", async () => {
  const repo = await scratchRepo();
  try {
    const counter = await installDrafter(repo, ["not json at all", JSON.stringify(VALID)]);
    const result = await draftSpecFromPrompt(repo, "Add a greet helper.", "planner");
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    assert.equal(await callCount(counter), 2, "the drafter should have been asked exactly twice");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a readable answer is never retried", async () => {
  const repo = await scratchRepo();
  try {
    const counter = await installDrafter(repo, [JSON.stringify(VALID)]);
    const result = await draftSpecFromPrompt(repo, "Add a greet helper.", "planner");
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    assert.equal(await callCount(counter), 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * The property that makes retrying safe at all: the drafter's judgement lives
 * in the parsed value, never in a parse error. A question that stops the run is
 * a SUCCESS here, so no retry can erase it.
 */
test("a blocking question is a successful draft and is never retried away", async () => {
  const repo = await scratchRepo();
  try {
    const blocking = {
      ...VALID,
      open_questions: ["Which of the three services should this live in?"]
    };
    const counter = await installDrafter(repo, [JSON.stringify(blocking), JSON.stringify(VALID)]);
    const result = await draftSpecFromPrompt(repo, "Add a thing.", "planner");
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.deepEqual(result.value.open_questions, [
      "Which of the three services should this live in?"
    ]);
    assert.equal(await callCount(counter), 1, "a blocking question must not be re-rolled");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("retries are bounded, and the refusal says what to do about it", async () => {
  const repo = await scratchRepo();
  try {
    const counter = await installDrafter(repo, ["still not json"]);
    const result = await draftSpecFromPrompt(repo, "Add a greet helper.", "planner");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(await callCount(counter), 3, "the bound is three attempts, not unbounded");
    /* A person has to be able to act on this. */
    assert.match(result.reason, /sending the same thing again often works/u);
    assert.match(result.reason, /more detail|stronger/u);
    assert.match(result.reason, /Nothing has been written/u);
    /* And it must be true that nothing was written. */
    const specs = await readdir(path.join(repo, ".hivemind", "spec")).catch(() => []);
    assert.equal(
      specs.some((name) => name.endsWith(".md")),
      false,
      "a failed draft must leave no spec behind"
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * An adapter failure is not sampling variance. Retrying a quota wall or a
 * timeout spends money against a wall that is still there, and the reason is
 * already accurate.
 */
test("an adapter failure is returned at once, not retried", async () => {
  const repo = await scratchRepo();
  try {
    const binDir = path.join(repo, "fake-bin");
    await mkdir(binDir, { recursive: true });
    const counter = path.join(binDir, "calls.txt");
    const script = path.join(binDir, "drafter.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(counter)}, 'call\\n');`,
        "process.stderr.write('provider quota exhausted');",
        "process.exit(3);"
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
      await writeFile(
        shim,
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/drafter.mjs" "$@"\n`,
        "utf8"
      );
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

    const result = await draftSpecFromPrompt(repo, "Add a greet helper.", "planner");
    assert.equal(result.ok, false);
    assert.equal(await callCount(counter), 1, "an adapter failure must not be retried");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

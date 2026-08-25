import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import { draftSpecFromPrompt } from "../src/spec-draft-action.js";

const run = promisify(execFile);

/**
 * The front door failing intermittently.
 *
 * A real first run discarded a valid streamed Claude reply and silently made
 * two more paid calls. One submitted request must make one drafting call; a
 * retry is a new user action rather than hidden spending.
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

test("unreadable output is not retried and its conversation failure is durable", async () => {
  const repo = await scratchRepo();
  try {
    const counter = await installDrafter(repo, ["not json at all", JSON.stringify(VALID)]);
    const result = await draftSpecFromPrompt(repo, "Add a greet helper.", "planner");
    assert.equal(result.ok, false);
    assert.equal(await callCount(counter), 1, "one submitted request must mean one provider call");
    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (!events.ok) return;
    assert.deepEqual(
      events.value.slice(-3).map((event) => event.type),
      ["conversation.message_recorded", "spec.draft_started", "spec.draft_failed"]
    );
    /* Was the fixed sentence "I couldn't finish preparing a plan. No project
       source files were changed." -- shown for EVERY drafting failure, next to
       a technical detail describing something else. Two unrelated statements
       about one event, and the second reassuring about a risk drafting never
       runs, since it does not touch project source at all. The message now
       comes from the reason, so it describes what actually failed. */
    assert.equal(
      events.value.at(-1)?.data.message,
      "The planner's answer came back in a form Hivemind could not read. Nothing was created. Sending the request again usually resolves it."
    );
    /* And the machine detail is preserved unchanged beside it, because other
       code matches on it. */
    assert.match(String(events.value.at(-1)?.data.detail ?? ""), /planner's reply/u);
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
    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (!events.ok) return;
    assert.deepEqual(
      events.value.slice(-3).map((event) => event.type),
      ["conversation.message_recorded", "spec.draft_started", "spec.draft_completed"]
    );
    assert.equal(events.value.at(-1)?.data.goal, VALID.goal);
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
    /* `spec.draft` now answers with a discriminated outcome: a draft, or a
       reply when the message was not a build request. Narrowing here asserts
       the drafting path was taken at all, which the old shape could not. */
    assert.equal(result.value.status, "draft");
    if (result.value.status !== "draft") return;
    assert.deepEqual(result.value.open_questions, [
      "Which of the three services should this live in?"
    ]);
    assert.equal(await callCount(counter), 1, "a blocking question must not be re-rolled");
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

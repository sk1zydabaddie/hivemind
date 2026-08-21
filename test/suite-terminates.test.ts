import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { stopChildProcess } from "./support/child-process.js";

const execFileAsync = promisify(execFile);

/**
 * The suite must be able to fail. It must not be able to hang.
 *
 * A third outcome is worse than a failing one. On 2026-08-15 a run of
 * `daemon.test.ts` sat for 233 minutes inside an unbounded `once("exit")`,
 * printing nothing — so it was indistinguishable from a slow suite, and it held
 * a live daemon that would have broken the next run. Pass, fail, and
 * never-answers are three states, and only two of them are evidence.
 *
 * These assert the two ceilings that turn the third state back into the second.
 */

test("the runner puts a ceiling on every test", async () => {
  const scripts = (
    JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> }
  ).scripts;

  const timeout = /--test-timeout=(\d+)/u.exec(scripts.test);
  assert.notEqual(timeout, null, "node --test needs an explicit per-test timeout");

  /* VERY generous, and the first number here was wrong in an instructive way.
     It was sized at 300s against the slowest individual TEST (~67s), which
     looked like a 4x margin. But `--test-timeout` also bounds the file-level
     subtest, and `manager.test.ts` takes 199s on its own -- so under the
     contention of a full parallel run it crossed 300s and the guard cancelled
     53 passing tests. A ceiling that fails honest work gets raised or deleted
     by whoever it blocks, and then the hang comes back.

     So: 30 minutes. Nine times the slowest file's solo run, which no amount of
     contention will reach, and still turns an indefinite hang into a failure.
     The guard's job is "never waits forever", not "runs fast". */
  assert.ok(
    Number(timeout![1]) >= 900_000,
    "a tight ceiling fails slow-but-honest files and gets removed"
  );
});

/* The helper that hung, checked for the shape rather than the wording: a wait
   on a process exiting must carry its own ceiling. */
test("stopping any test child cannot wait forever", async () => {
  const body = await readFile("test/support/child-process.ts", "utf8");

  assert.match(body, /setTimeout/u, "the wait must be bounded");
  assert.match(body, /SIGKILL/u, "and it must escalate rather than give up quietly");
  assert.match(body, /process\.kill\(pid, 0\)/u, "POSIX cleanup must verify the OS process is gone");
  assert.match(body, /tasklist/u, "Windows cleanup must verify the OS process is gone");
  assert.match(body, /taskkill/u, "Windows cleanup must have a bounded process-tree fallback");
  assert.doesNotMatch(
    body,
    /exitCode !== null \|\| child\.signalCode !== null/u,
    "sending a Windows signal is not proof the process released its handles"
  );
  /* A daemon that survives both signals is a finding, not something for the
     cleanup path to swallow. */
  assert.match(body, /throw new Error/u);
});

test("stopping a live child is visible in the OS process table", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  assert.notEqual(child.pid, undefined);
  const pid = child.pid!;

  await stopChildProcess(child, "the process-table regression fixture");

  if (process.platform === "win32") {
    const listed = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"],
      { windowsHide: true }
    );
    assert.doesNotMatch(
      listed.stdout,
      new RegExp(`^\"[^\"]*\",\"${String(pid)}\"(?:,|$)`, "mu"),
      "the stopped child is still present in the Windows process table"
    );
  } else {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

/**
 * The instrument, checked against the thing it is supposed to catch.
 *
 * An assertion that only ever sees a well-behaved runner cannot fail on the
 * case this whole file is about, so this spawns a real `node --test` over a
 * test that never resolves and asserts the runner ends it. Without
 * `--test-timeout` this process would run until the harness killed it — which
 * is precisely the bug, demonstrated rather than described.
 */
test("a test that never resolves is failed rather than waited on", async () => {
  /* A real file rather than `--eval`: node refuses `--test` and `--eval`
     together, which this test found by failing on its first run.

     And the fixture HOLDS THE EVENT LOOP OPEN. A bare `new Promise(() => {})`
     is not the bug -- node drains the loop and cancels it on its own, so a
     proof built on that would pass with or without the flag and prove nothing.
     The real hang had a live daemon keeping the loop busy, which is why only a
     timeout could ever have ended it. Checked both ways below. */
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-hang-"));
  await writeFile(
    path.join(dir, "hangs.test.cjs"),
    [
      'const test = require("node:test");',
      'test("holds the loop open and never resolves", () => new Promise(() => {',
      "  setInterval(() => {}, 1000);",
      "}));",
      ""
    ].join("\n"),
    "utf8"
  );

  /* `node --test` exports `NODE_TEST_CONTEXT=child-v8` into every test file it
     runs, and a nested runner that inherits it switches into child-reporter
     mode and stops behaving like a standalone run. Measured: with it, the
     child returned an exit code in 78ms instead of hanging, so the proof
     "passed" the wrong way and reported that the guard was unnecessary. An
     instrument inheriting its parent's context is not measuring the thing it
     was pointed at. */
  const { NODE_TEST_CONTEXT: _inherited, ...standalone } = process.env;

  const run = async (args: string[], budgetMs: number): Promise<{ code: number | null; out: string }> => {
    const child = spawn(process.execPath, [...args, "hangs.test.cjs"], {
      cwd: dir,
      env: standalone,
      windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    /* Bounded itself, or a broken runner would hang the file that exists to
       prove the runner cannot hang. `null` means it was still going. */
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, budgetMs);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, out };
  };

  /* The guard is NECESSARY: without it, the runner is still going when cut
     off. This is the 233-minute failure in miniature. */
  const unguarded = await run(["--test"], 6000);
  assert.equal(unguarded.code, null, "without a timeout a hanging test should never end");

  /* And SUFFICIENT: with it, the hang becomes a failure. */
  const guarded = await run(["--test", "--test-timeout=1500"], 30_000);
  assert.notEqual(guarded.code, null, "the runner did not terminate a hanging test");
  assert.notEqual(guarded.code, 0, "a hanging test must fail rather than pass");
  assert.match(guarded.out, /timed out/iu);
});

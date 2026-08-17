import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Rust with its comments removed.
 *
 * Every one of these assertions is about what the CODE does, and the code is
 * surrounded by prose explaining the very rules being asserted. Three of these
 * tests failed on their first run by matching their own documentation: the
 * `:gaveup` block "mentions the installer" because a comment says it must not
 * run one, and the ban on `attempted != running` matched the doc comment
 * recording that it used to say exactly that.
 *
 * STATE.md calls this the project's most-repeated trap and it was hit three
 * times in one new file. So it is not a habit to be more careful about; it is a
 * helper, and reading source without it is the mistake.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");

const helperSource = async (): Promise<string> =>
  withoutComments(
    await readFile(path.join(desktopRoot, "src-tauri", "src", "selfbuild.rs"), "utf8")
  );

const versionSource = async (): Promise<string> =>
  withoutComments(
    await readFile(path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"), "utf8")
  );

/** The batch the helper actually runs, isolated from the Rust around it. */
const script = async (): Promise<string> => {
  const source = await helperSource();
  const from = source.indexOf("let script_body");
  const to = source.indexOf("std::fs::write(&script_path");
  expect(from, "the helper script is no longer built where this expects").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

/**
 * The swap helper, after it failed a second time in a new way.
 *
 * The walk that proved this feature went `helper started → app exited →
 * installing → exit 0 → restarted`, end to end, on the real artifact. The next
 * real run stopped after the FIRST line and left the helper alive and blocked
 * for hours, found still running by `Get-CimInstance` long after the app had
 * gone.
 *
 * So the walk was not wrong and did not rot — it simply could not see any of
 * this. Every defect below is about the SHAPE of the wait rather than about
 * whether the wait runs, and a successful walk is evidence about the second
 * thing only. That is precisely why these are assertions and not a third walk:
 * **a path that works once has been shown to work under one set of conditions,
 * and the conditions are the part nobody writes down.**
 */
describe("the swap helper cannot hang", () => {
  /* `timeout /t N /nobreak` refuses whenever stdin is redirected or absent and
     returns errorlevel 125 instantly. Measured in both configurations that
     matter: with no console at all, and with a hidden console plus null stdin.
     The helper has neither a console nor stdin by design, so every `timeout` in
     the wait loop was a no-op -- the "one second poll" was a hot loop spawning
     `tasklist` as fast as Windows could start one, for twenty minutes. */
  test("it does not wait with a command that needs a console", async () => {
    const body = await script();
    expect(body, "timeout does not wait without a console and stdin").not.toMatch(/timeout\s+\/t/u);
    expect(body, "ping waits without needing either").toMatch(/ping -n \d+ 127\.0\.0\.1/u);
  });

  /* An unbounded wait is how "the update did not take" becomes "and nothing
     ever happens again". The deadline turns a stuck helper into a logged
     refusal, which is a thing a person can read and act on. */
  test("the wait is bounded, and giving up installs nothing", async () => {
    const body = await script();
    expect(body, "the wait must have a deadline").toMatch(/if %checks% GTR \d+ goto gaveup/u);
    expect(body).toMatch(/gave up/u);

    /* Running an installer against a binary something still holds is how a
       half-replaced install happens, and a half-replaced install is worse than
       no update at all. */
    const gaveUp = body.slice(body.indexOf(":gaveup"), body.indexOf(":released"));
    expect(gaveUp.length).toBeGreaterThan(0);
    expect(gaveUp, "a helper that gave up must not install anything").not.toMatch(/installer/u);
    expect(gaveUp).toMatch(/exit \/b 1/u);
  });

  /* THE ACTUAL FAILURE. cmd.exe asked "Terminate batch job (Y/N)?" -- three
     times, recorded in the captured stdout -- and stdin was inherited from a
     windowless GUI app, so nothing could answer and the helper parked forever.
     Null makes an unanswerable question fatal instead. A helper that dies is one
     the marker file reports on the next launch; a helper that hangs reports
     nothing and blocks every future attempt. */
  test("stdin is explicitly null, so no prompt can park it", async () => {
    const source = await helperSource();
    const spawn = source.slice(source.indexOf("let mut child = Command::new(&cmd_exe)"));
    expect(spawn, "inherited stdin is what blocked for hours").toMatch(
      /\.stdin\(std::process::Stdio::null\(\)\)/u
    );
  });

  /* A gone PID is a PROXY for "the binary can be replaced", and a bad one in
     both directions: Windows reuses PIDs, so the wait can outlive its subject
     forever, and a process can be gone while its file is still held, so the
     wait can end too early. The lock test asks the real question instead. */
  test("it waits on the binary being released, not on a process id", async () => {
    const body = await script();
    expect(body, "polling tasklist by pid asks the wrong question").not.toMatch(/tasklist/u);
    /* Opens the target for append and writes nothing: succeeds only when
       nothing holds the file, and cannot alter it. Verified three ways before
       being relied on -- it waits while locked, proceeds within a second of
       release, and leaves the file byte-identical. */
    expect(body).toMatch(/2>nul \(>>/u);
    expect(body).toMatch(/type nul\) && goto released/u);
  });

  /* Two helpers racing for one binary is strictly worse than one, and the last
     failure left one alive -- so a retry had to be made safe before it could be
     offered at all. */
  test("a leftover helper is ended before another starts", async () => {
    const source = await helperSource();
    expect(source).toMatch(/pub fn clear_stale_helper/u);
    expect(source).toMatch(/fn helper_pid_path/u);
    /* The pid is recorded from Rust, because the process that knows it is this
       one. Finding the helper again by matching its command line would be the
       string-matched boundary this project keeps getting caught by. */
    expect(source).toMatch(/std::fs::write\(helper_pid_path\(\), child\.id\(\)\.to_string\(\)\)/u);

    const spawn = source.slice(
      source.indexOf("fn spawn_swap"),
      source.indexOf("let log = swap_log_path")
    );
    expect(spawn, "the cleanup must run before a new helper is created").toMatch(
      /clear_stale_helper\(\)/u
    );
  });

  /* Its own hidden console rather than none: `ping` and the installer behave
     normally, and it is still not attached to whatever terminal launched the
     app -- which matters, because this app is routinely started from a shell
     during development, and a shared console is a console whose interrupts
     arrive at the helper. */
  test("the helper gets its own console, not the launching terminal's", async () => {
    const source = await helperSource();
    expect(source).toMatch(/const NO_WINDOW: u32 = 0x0800_0000/u);
    expect(source).toMatch(/const NEW_GROUP: u32 = 0x0000_0200/u);
    expect(source).toMatch(/\.creation_flags\(NO_WINDOW \| NEW_GROUP\)/u);
    expect(source, "DETACHED_PROCESS leaves it with no console at all").not.toMatch(
      /creation_flags\(DETACHED/u
    );
  });

  /**
   * The installer's exit code reaches the LOG.
   *
   * A walk that succeeded end to end still produced a log reading
   * `installing / restarted` with the `installer returned` line missing --
   * the identical shape to the verbatim-prefix bug, a gap between two present
   * lines, and the very line that identified that bug.
   *
   * `echo ... %errorlevel%>>"file"` with a code of 0 expands to
   * `echo ... 0>>"file"`, and `0>>` redirects STDIN: the log is created empty
   * and the text goes to the real stdout. Every single-digit code — which is
   * every code an installer actually returns — is parsed as a file handle.
   *
   * So the diagnostic disappeared exactly when a failure would need it, while
   * the run still looked clean. Two things prevent it: capture into a variable,
   * and keep whitespace between the value and the `>>`.
   */
  test("the installer's exit code cannot be swallowed by a redirect", async () => {
    const body = await script();
    expect(body, "the code must be captured before an echo can reset it").toMatch(
      /set code=%errorlevel%/u
    );
    /* No bare `%errorlevel%>>` anywhere: that is the shape that redirects a
       handle instead of writing the number. */
    expect(body, "%errorlevel% immediately before >> is parsed as a file handle").not.toMatch(
      /%errorlevel%>>/u
    );
    /* And the value keeps a space before the redirect. */
    expect(body).toMatch(/installer returned %code% >>/u);
    /* The failure branch tests the captured copy, quoted, so it cannot be
       reading the errorlevel of the echo that just ran. */
    /* The quotes are escaped in the Rust string literal, so the source reads
       `if not \"%code%\"==\"0\"`. Matching the unescaped form found nothing --
       which would have been a rule that passes for the wrong reason had the
       assertion been written the other way round. */
    expect(body).toMatch(/if not \\"%code%\\"==\\"0\\"/u);
  });

  /* Every line dated. The last failure had to be reconstructed from file
     modification times, because the log carried none of its own -- and the first
     thing anybody needed was whether it stopped before or after the app
     reopened. */
  test("every log line is timestamped", async () => {
    const body = await script();
    /* The character class excludes a quote, so a match cannot run past the end
       of one Rust string literal into a later `>>` -- which is how the first
       version of this "found" an undated line in `@echo off`. */
    const lines = [...body.matchAll(/echo (\[%TIME%\])?[^">]*>>/gu)];
    expect(lines.length, "the helper writes almost nothing to its log").toBeGreaterThan(3);
    for (const [whole, stamp] of lines) {
      expect(stamp, `an undated log line: ${whole.slice(0, 60)}`).toBe("[%TIME%]");
    }
  });
});

/**
 * A report you cannot act on is a dead end with a good error message in it.
 *
 * `DidNotTake` was honest and offered nothing — it said the update failed and
 * left no button. That is only marginally better than the silence it replaced,
 * and it is the same shape as the other correct-but-unreachable findings in
 * STATE.md: the information exists, and no path leads anywhere from it.
 */
describe("a failed update can be retried", () => {
  test("the retry re-runs the swap and not the build", async () => {
    const source = await versionSource();
    const take = source.slice(source.indexOf("pub async fn take_newer_version"));
    /* Via `install_built_and_restart`, and BEFORE the build route: the build
       already happened and its installer is on disk. What failed was the swap,
       so rebuilding would spend minutes redoing the one part that worked. */
    const retryAt = take.indexOf("install_built_and_restart");
    const buildAt = take.indexOf("build_and_install");
    expect(retryAt, "the retry path is missing").toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(retryAt, "a retry must not rebuild first").toBeLessThan(buildAt);
  });

  /* The marker records what was ATTEMPTED, so asking whether it EQUALS the
     running version turns two real successes into reported failures: a build
     installed by hand while an older marker sits on disk, and a newer version
     arriving by the release route while a source attempt is outstanding. */
  test("running something newer than the attempt counts as landed", async () => {
    const source = await versionSource();
    expect(source).toMatch(/fn attempt_landed/u);
    expect(source).toMatch(/version_parts\(running\) >= version_parts\(attempted\)/u);
    expect(source, "an equality check reports success as failure").not.toMatch(
      /attempted != running\b/u
    );
  });

  test("the bar offers the retry, and only where it can work", async () => {
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    const code = withoutComments(bar);
    expect(code).toMatch(/answer\.source === "did_not_take" && projectPath !== ""/u);
    /* Named for what it will do. "Try again" reads as repeating the whole
       multi-minute build, which is not what happens. */
    expect(code).toMatch(/"Install it again"/u);
    /* With no project open there is no installer to re-run, so the bar names
       what would change that rather than offering a button that repeats one
       answer -- the rule the `unknown` state already follows. */
    const failed = bar.slice(bar.indexOf('answer.source === "did_not_take" ? ('));
    expect(failed.slice(0, 1200)).toMatch(/Open your Hivemind project/u);
  });
});

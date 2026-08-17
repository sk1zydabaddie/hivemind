//! Closing the loop between "you pushed" and "I am running it".
//!
//! Three rounds of work were spent testing fixes that were never installed. The
//! sequence that produced it is short and repeats: a commit lands, the app is
//! opened, and the app is the previous build. `install:local` exists and
//! verifies itself, and it did not help — because the failing step is
//! *remembering to run it*, and a fix whose first requirement is remembering is
//! not a fix.
//!
//! So the app answers the question itself: **is what I am running older than
//! the source I have open?**
//!
//! ## What "older" is measured against
//!
//! The commit time of `HEAD` in the open repository, compared to the modified
//! time of the binary that is actually running. Both are facts on disk. Nothing
//! here reads a version string and reasons about it: the calendar version is
//! stamped at build time, so comparing versions would only say what the build
//! *claimed*, and the failure being closed is a build that never happened at
//! all.
//!
//! Uncommitted work counts too — the newest modified time under the directories
//! a build actually reads. Editing a file and testing it without rebuilding is
//! the same loss as pulling and not rebuilding.
//!
//! ## Why this only ever offers, and only for one repository
//!
//! It refuses unless the open project IS this application's own source, checked
//! by reading the identifier out of its `tauri.conf.json` rather than by the
//! folder's name. Offering to rebuild the app from somebody's unrelated project
//! would be absurd, and doing it from a repository that merely looks similar
//! would be worse.
//!
//! And it never acts on its own. Rebuilding costs minutes of CPU, and
//! installing replaces the binary that is running — neither is something to do
//! to somebody who did not ask. The detection is automatic; the act is a click.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

use crate::newer_version::{report_progress, UpdateProgress};

/// This application's own identifier, as declared in `tauri.conf.json`.
const IDENTIFIER: &str = "ai.hivemind.desktop";

/// Where a build actually reads from. A change anywhere else cannot change the
/// binary, so it must not be reported as staleness.
const SOURCE_DIRS: [&str; 4] = ["src", "desktop/src", "desktop/src-tauri/src", "desktop/tools"];

#[derive(Debug, Serialize)]
pub struct BuildStanding {
    /// Whether the open project is this app's own source at all.
    pub is_own_source: bool,
    /// Whether the running binary predates that source.
    pub stale: bool,
    /// The running build's version, for a person to read.
    pub running_version: String,
    /// One sentence naming what is newer, or why nothing can be said.
    pub detail: String,
}

fn seconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// The newest modification time under the directories a build reads.
fn newest_source(root: &Path) -> Option<i64> {
    let mut newest: Option<i64> = None;
    for relative in SOURCE_DIRS {
        let dir = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        walk(&dir, &mut newest, 0);
    }
    newest
}

fn walk(dir: &Path, newest: &mut Option<i64>, depth: usize) {
    // Bounded rather than unbounded: a source tree is shallow, and a runaway
    // walk on somebody's project would be a visible stall for no gain.
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == "target" || name == "dist" || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(&path, newest, depth + 1);
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                let at = seconds(modified);
                if newest.is_none_or(|current| at > current) {
                    *newest = Some(at);
                }
            }
        }
    }
}

fn head_commit_seconds(root: &Path) -> Option<i64> {
    let output = super::project::hidden_command_for_selfbuild("git")
        .args(["-C", &root.to_string_lossy(), "log", "-1", "--format=%ct"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Is this repository the source of the application asking?
fn is_own_source(root: &Path) -> bool {
    let config = root
        .join("desktop")
        .join("src-tauri")
        .join("tauri.conf.json");
    let Ok(text) = std::fs::read_to_string(&config) else {
        return false;
    };
    text.contains(IDENTIFIER)
}

fn running_binary() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// The same answer as `inspect_build_staleness`, callable from another module.
///
/// Split out so `newer_version` can ask one question of two sources without
/// going back through the command layer -- a command calling a command would
/// put the decision in the client again, which is the shape being removed.
///
/// ASYNC, and that is not cosmetic. The first version called `block_on` here,
/// which blocks a worker of the very runtime the caller is running on: the
/// command never returned, the bar span forever, and the app looked hung rather
/// than wrong. Found by driving the real build, not by review -- a deadlock has
/// no error to read.
pub async fn source_standing(
    app: &tauri::AppHandle,
    project_path: &str,
) -> Result<BuildStanding, String> {
    inspect_build_staleness(app.clone(), project_path.to_string()).await
}

/// Build this checkout and install it, as one step.
///
/// Two commands with two buttons was two chances to stop halfway, and the
/// halfway state -- built but not installed -- is one nobody can act on. This
/// is deliberately one call that ends with the app exiting into its
/// replacement.
pub async fn build_and_install(
    app: tauri::AppHandle,
    project_path: String,
    progress: Channel<UpdateProgress>,
) -> Result<String, String> {
    rebuild_app(project_path.clone(), progress.clone()).await?;
    let version = std::fs::read_to_string(
        std::fs::canonicalize(&project_path)
            .map_err(|error| format!("could not read that folder: {error}"))?
            .join("desktop")
            .join("src-tauri")
            .join("gen")
            .join("app-version.txt"),
    )
    .map_err(|_| "the build produced no version file".to_string())?
    .trim()
    .to_string();
    report_progress(
        &progress,
        UpdateProgress::Stage {
            label: "Installing the new build".to_string(),
        },
    );
    install_built_and_restart(app, project_path).await?;
    Ok(version)
}

/* No longer a #[tauri::command]. It is reached only through
   `newer_version::take_newer_version`, which holds the idleness gate --
   exposing it to the webview as well would be a second door to the same
   room, and the gate is only on one of them. */
pub async fn inspect_build_staleness(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<BuildStanding, String> {
    let version = app.package_info().version.to_string();
    let root = std::fs::canonicalize(&project_path)
        .map_err(|error| format!("could not read that folder: {error}"))?;

    if !is_own_source(&root) {
        return Ok(BuildStanding {
            is_own_source: false,
            stale: false,
            running_version: version,
            detail: "This project is not Hivemind's own source, so there is nothing to compare."
                .to_string(),
        });
    }

    let Some(binary) = running_binary() else {
        return Ok(BuildStanding {
            is_own_source: true,
            stale: false,
            running_version: version,
            detail: "Hivemind could not find its own program file, so it cannot tell how old it is."
                .to_string(),
        });
    };
    let Ok(built_at) = binary.metadata().and_then(|meta| meta.modified()).map(seconds) else {
        return Ok(BuildStanding {
            is_own_source: true,
            stale: false,
            running_version: version,
            detail: "Hivemind could not read when its own program file was written.".to_string(),
        });
    };

    // The newest of the two signals, because either alone misses a real case:
    // a pull with no local edits moves only the commit, and an unsaved-then-
    // saved edit moves only the file.
    let commit_at = head_commit_seconds(&root);
    let source_at = newest_source(&root);
    let newest = match (commit_at, source_at) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    };

    let Some(newest) = newest else {
        return Ok(BuildStanding {
            is_own_source: true,
            stale: false,
            running_version: version,
            detail: "Hivemind could not read this repository's history or files.".to_string(),
        });
    };

    // A minute of slack. A build writes its own binary, so the source it was
    // built from is always a few seconds older than the result -- without slack
    // a fresh install would report itself stale immediately.
    let stale = newest > built_at + 60;
    let detail = if stale {
        let minutes = (newest - built_at) / 60;
        if minutes < 90 {
            format!("The source is {minutes} minutes newer than the copy you are running.")
        } else {
            format!(
                "The source is {} hours newer than the copy you are running.",
                minutes / 60
            )
        }
    } else {
        "You are running the current source.".to_string()
    };

    Ok(BuildStanding {
        is_own_source: true,
        stale,
        running_version: version,
        detail,
    })
}

/// Build the app from the open source. Does NOT install: see below.
///
/// Installing replaces the binary that is running, and Windows holds an open
/// executable locked -- `install-local.mjs` already names that as the usual
/// cause of an install silently not taking. So the two halves are separate
/// commands and separate decisions: this one is safe to run while the app is
/// open and takes the minutes, and `install_built_and_restart` does the swap at
/// the one moment it can, which is on the way out.
/* No longer a #[tauri::command]. It is reached only through
   `newer_version::take_newer_version`, which holds the idleness gate --
   exposing it to the webview as well would be a second door to the same
   room, and the gate is only on one of them. */
pub async fn rebuild_app(
    project_path: String,
    progress: Channel<UpdateProgress>,
) -> Result<String, String> {
    let root = std::fs::canonicalize(&project_path)
        .map_err(|error| format!("could not read that folder: {error}"))?;
    if !is_own_source(&root) {
        return Err("This project is not Hivemind's own source.".to_string());
    }
    let desktop = root.join("desktop");
    tauri::async_runtime::spawn_blocking(move || {
        report_progress(
            &progress,
            UpdateProgress::Stage {
                label: "Preparing the source build".to_string(),
            },
        );
        let mut child = npm_command()
            .args(["run", "tauri:build"])
            .current_dir(&desktop)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start the build: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the build produced no output stream".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "the build produced no error stream".to_string())?;
        let current_stage = Arc::new(Mutex::new(0_u8));
        let stdout_reader = read_build_stream(
            stdout,
            progress.clone(),
            Arc::clone(&current_stage),
        );
        let stderr_reader = read_build_stream(stderr, progress, current_stage);
        let status = child
            .wait()
            .map_err(|error| format!("could not wait for the build: {error}"))?;
        let stdout = stdout_reader
            .join()
            .map_err(|_| "the build output reader stopped unexpectedly".to_string())??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| "the build error reader stopped unexpectedly".to_string())??;

        if status.success() {
            return Ok(stdout
                .iter()
                .map(String::as_str)
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .join(" | "));
        }
        // The tail is what says why. The head of a Tauri build is pages of
        // progress nobody needs.
        let failure_lines = if stderr.is_empty() { &stdout } else { &stderr };
        let tail: Vec<&str> = failure_lines.iter().rev().take(12).map(String::as_str).collect();
        Err(format!(
            "The build failed. {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" ")
        ))
    })
    .await
    .map_err(|error| format!("build task failed: {error}"))?
}

/// Read both build pipes concurrently. `.output()` buffered them until the
/// process exited, which made honest stages impossible and can deadlock a noisy
/// child when one pipe fills. Lines are retained only for the existing result
/// tail; progress is emitted when a line proves that a new stage began.
fn read_build_stream<R: Read + Send + 'static>(
    stream: R,
    progress: Channel<UpdateProgress>,
    current_stage: Arc<Mutex<u8>>,
) -> thread::JoinHandle<Result<Vec<String>, String>> {
    thread::spawn(move || {
        let mut lines = Vec::new();
        for line in BufReader::new(stream).lines() {
            let line = line.map_err(|error| format!("could not read build output: {error}"))?;
            if let Some((rank, stage)) = build_stage(&line) {
                let changed = current_stage
                    .lock()
                    .map(|mut current| {
                        /* stdout and stderr are consumed concurrently. Rank
                           prevents a late line from an earlier pipe making the
                           UI claim the build moved backwards. */
                        if rank <= *current {
                            false
                        } else {
                            *current = rank;
                            true
                        }
                    })
                    .unwrap_or(false);
                if changed {
                    report_progress(
                        &progress,
                        UpdateProgress::Stage {
                            label: stage.to_string(),
                        },
                    );
                }
            }
            lines.push(line);
        }
        Ok(lines)
    })
}

fn build_stage(line: &str) -> Option<(u8, &'static str)> {
    let line = line.to_ascii_lowercase();
    if line.contains("vite") && line.contains("building for production") {
        Some((1, "Building the interface"))
    } else if line.contains("compiling ") || line.contains("cargo build") {
        Some((2, "Compiling the desktop shell"))
    } else if line.contains("bundling ") || line.contains("bundle/nsis") {
        Some((3, "Packaging the installer"))
    } else if line.contains("finished 1 bundle") {
        Some((4, "Finishing the build"))
    } else {
        None
    }
}

/// Install what was just built, then start the new copy — after this one exits.
///
/// A process cannot replace its own executable while it is running, so this
/// hands the job to a detached helper that waits for this process to go, runs
/// the installer, and starts the result. The app then exits, which is the
/// signal the helper is waiting for.
///
/// The daemon is deliberately NOT touched. It survives app close by design so a
/// run is not orphaned, and it is a separate process from the one being
/// replaced. The caller checks idleness before offering this at all.
/* No longer a #[tauri::command]. It is reached only through
   `newer_version::take_newer_version`, which holds the idleness gate --
   exposing it to the webview as well would be a second door to the same
   room, and the gate is only on one of them. */
pub async fn install_built_and_restart(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<(), String> {
    let root = std::fs::canonicalize(&project_path)
        .map_err(|error| format!("could not read that folder: {error}"))?;
    if !is_own_source(&root) {
        return Err("This project is not Hivemind's own source.".to_string());
    }
    let version = std::fs::read_to_string(
        root.join("desktop")
            .join("src-tauri")
            .join("gen")
            .join("app-version.txt"),
    )
    .map_err(|_| "There is no built version to install. Build it first.".to_string())?;
    let version = version.trim().to_string();
    let installer = root
        .join("desktop")
        .join("src-tauri")
        .join("target")
        .join("release")
        .join("bundle")
        .join("nsis")
        .join(format!("Hivemind AI_{version}_x64-setup.exe"));
    if !installer.is_file() {
        return Err(format!(
            "The installer for {version} is not there. Build it first."
        ));
    }

    let exe = running_binary().ok_or_else(|| "could not resolve this program".to_string())?;
    /* Written BEFORE the swap and read on the next launch. If the app comes
       back on a version that is not this one, the update did not take and the
       person is told -- rather than reopening on the old build with nothing to
       read, which is precisely the failure that made this whole feature
       necessary. */
    /* Marker AFTER proof of life. Written before, a helper that never started
       would report on the next launch as "the update did not take", which is a
       true sentence about the wrong failure -- nothing was ever attempted. */
    spawn_swap(std::process::id(), &installer, &exe)?;
    let _ = std::fs::write(swap_marker_path(), &version);
    // The helper is waiting for this process to go.
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
/// Strip Windows' `\?\` verbatim prefix.
///
/// `std::fs::canonicalize` returns verbatim paths, and **cmd.exe cannot execute
/// one**. The batch helper therefore ran its whole sequence -- waited for the
/// app, restarted it -- while silently skipping the single line that mattered,
/// because the installer path began `\?\`. The log read
/// `helper started | app exited | restarted` with no `installer returned`
/// between them, which is what named it.
///
/// `project.rs` already records this trap for node CLI paths
/// (`node_cli_paths_drop_windows_verbatim_prefixes`). Same trap, different
/// consumer.
fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r#"\\?\"#).map(str::to_string).unwrap_or(text)
}

fn spawn_swap(pid: u32, installer: &Path, exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    /* The app cannot replace its own running executable, so a detached helper
       waits for it to exit and then installs. Two things went wrong here and
       both were invisible:
       
       1. A Tauri app runs inside a Windows JOB OBJECT, and a child inherits
          membership. When the parent exits the job closes and takes the child
          with it -- so the helper was killed microseconds after being spawned,
          every time. CREATE_BREAKAWAY_FROM_JOB escapes that, when the job
          permits it.
       2. The app called `exit(0)` immediately after `spawn()`, which returns as
          soon as CreateProcess succeeds rather than when the child has run
          anything. So even a surviving helper was racing the shutdown.

       The failure mode of both was identical and perfectly silent: the build
       succeeded, the installer existed, the app closed, the version never moved
       and nothing was written anywhere. So the helper now ANNOUNCES ITSELF, and
       this function refuses to return until it has -- which means the caller
       can keep the app open and say so rather than closing on a broken update. */
    /* A leftover helper is killed before a new one starts. The last failure left
       one alive and blocked for hours, and two helpers racing for the same
       binary is strictly worse than one -- the second could begin installing
       while the first still held a handle. This is also what makes a retry
       safe to offer. */
    clear_stale_helper();

    let log = swap_log_path();
    let _ = std::fs::remove_file(&log);

    /* The helper is a FILE, not a command line, and that is the whole point.
       The previous version nested three levels of quoting -- Rust format into
       PowerShell `-Command`, into a WMI `CommandLine` argument, into a second
       PowerShell `-Command` -- and died on its own escaping before it could
       write a single line. Every attempt to fix the escaping produced another
       silent variant of the same failure. A script on disk has no nesting at
       all: `powershell -File <path>` takes one argument and that argument is a
       path.

       WMI creates the process, and that is the other half. `Win32_Process.Create`
       is executed by the WMI provider service, so what it makes is a child of
       THAT service rather than of this app -- outside this app's job object,
       where a directly-spawned child is killed the moment the app exits. */
    let script_path = log.with_file_name("update-swap.cmd");
    /* A batch file run by cmd.exe, not a PowerShell script.
       
       The observation that decided this: the app spawned
       `powershell -NoProfile -ExecutionPolicy Bypass -File <path>` and got exit
       code 0 with no output and no effect, while the IDENTICAL command run by
       hand executed the whole script. Same executable, same arguments, same
       file -- only the parent process differed. Rather than form a fourth
       hypothesis about why PowerShell behaves differently under this parent,
       the outer layer stopped being PowerShell.
       
       `cmd.exe` is resolved from `%SystemRoot%` rather than from PATH, because
       a GUI-launched process does not necessarily have System32 on it -- the
       same trap `adapter-command.ts` already records for finding the agent. */
    /* ── The second failure of this feature, and what the log said ───────────
     *
     * It stopped after ONE line -- `helper started` -- and the helper was still
     * alive hours later, blocked on `Terminate batch job (Y/N)?` with stdin
     * inherited from a windowless GUI app and therefore nothing able to answer.
     * Three defects, all of which had to be true at once, and none of which the
     * end-to-end walk could have caught because they are all about the SHAPE of
     * the wait rather than about whether it runs:
     *
     * 1. `timeout /t 1 /nobreak` NEVER WAITS HERE. It refuses whenever stdin is
     *    redirected or absent (errorlevel 125), and this helper has no console
     *    and no stdin by design. Measured in both configurations. So the poll
     *    was not a one-second poll; it was a hot loop spawning `tasklist` as
     *    fast as Windows could start it, for twenty minutes. `ping -n 2` waits
     *    without needing either.
     *
     * 2. THE WAIT WAS UNBOUNDED. `tasklist /FI "PID eq N"` also asks the wrong
     *    question: a gone PID is a PROXY for "the binary can be replaced", and a
     *    bad one in both directions -- Windows reuses PIDs, and a process can be
     *    gone while its file is still held. It now tests the actual
     *    precondition by opening the target for append and writing nothing,
     *    which fails while anything holds it and cannot alter the file. Proven
     *    three ways before being relied on: it waits while locked, proceeds
     *    within a second of release, and gives up rather than waiting forever.
     *
     * 3. NOTHING COULD ANSWER A QUESTION. Any prompt was fatal-but-silent. The
     *    helper now runs with stdin explicitly null.
     *
     * What sent the three interrupts is still unidentified. Four probes failed
     * to reproduce it -- a Ctrl+C to the parent's console group, a CTRL_BREAK to
     * the helper's own group, the parent exiting mid-wait, and the console-less
     * timeout -- so it is NOT one of those, and the design no longer depends on
     * knowing. An interrupt can now only end the helper, never park it: the
     * deadline bounds the wait, and the marker file the app reads on next
     * launch turns any incomplete run into a reported failure with a retry
     * rather than a version that quietly did not move.
     */
    let script_body = format!(
        concat!(
            "@echo off\r\n",
            "echo [%TIME%] helper started, waiting for the app to release its binary>>\"{log}\"\r\n",
            "set /a checks=0\r\n",
            ":wait\r\n",
            "set /a checks+=1\r\n",
            /* The deadline. 90 checks at ~1s: long enough for a slow shutdown,
               short enough that a person is still watching. */
            "if %checks% GTR 90 goto gaveup\r\n",
            /* Opens for append and writes zero bytes: succeeds only when
               nothing holds the file, and never modifies it. */
            "2>nul (>>\"{exe}\" type nul) && goto released\r\n",
            "ping -n 2 127.0.0.1 >nul\r\n",
            "goto wait\r\n",
            ":gaveup\r\n",
            "echo [%TIME%] gave up: the app still held its binary after %checks% checks>>\"{log}\"\r\n",
            /* Deliberately does NOT install. An installer run against a locked
               binary is how a half-replaced install happens, and a half-replaced
               install is worse than no update. */
            "exit /b 1\r\n",
            ":released\r\n",
            "echo [%TIME%] app exited, binary released after %checks% checks>>\"{log}\"\r\n",
            "echo [%TIME%] installing>>\"{log}\"\r\n",
            "\"{installer}\" /S\r\n",
            /* CAPTURED FIRST, and with a space before the redirect. Both halves
               are load-bearing, and the walk that proved this feature work
               *again* still had this wrong -- the log came back
               `installing / restarted` with the `installer returned` line
               MISSING, which is the identical shape to the `\\?\` bug: a gap
               between two present lines.
               `echo ... %errorlevel%>>"file"` with a code of 0 expands to
               `echo ... 0>>"file"`, and **`0>>` redirects STDIN**. cmd creates
               the log empty and sends the text to the real stdout. Every
               single-digit code -- which is every code an installer actually
               returns -- is parsed as a file handle the same way. Verified all
               four shapes: bare `%errorlevel%>>` loses the line, a space before
               the redirect keeps it, and only a captured variable survives the
               echo to be tested afterwards. */
            "set code=%errorlevel%\r\n",
            "echo [%TIME%] installer returned %code% >>\"{log}\"\r\n",
            "if not \"%code%\"==\"0\" (echo [%TIME%] the installer failed, not restarting>>\"{log}\" & exit /b 1)\r\n",
            "start \"\" \"{exe}\"\r\n",
            "echo [%TIME%] restarted>>\"{log}\"\r\n"
        ),
        log = log.display(),
        installer = plain_path(installer),
        exe = plain_path(exe)
    );
    /* `pid` is no longer what the wait turns on -- the lock is -- but it is
       recorded so a log can be tied back to a specific run of the app. */
    let _ = pid;
    std::fs::write(&script_path, script_body)
        .map_err(|error| format!("could not write the installer helper: {error}"))?;

    /* SPAWN IT. This line was missing: an edit removed the spawn block while
       leaving the script-building above and the proof-of-life wait below, so
       the code composed a command, started nothing, and then waited for a log
       that nothing would ever write. Every hypothesis about job objects,
       transcript hosts and quoting was chasing a process that was never
       created -- and the symptom was identical to all of them, because a
       process that does not exist and a process that dies instantly leave the
       same evidence: nothing.

       Instrumented rather than detached blind. stdout and stderr go to FILES,
       which survive the child however it ends, and the exit code is recorded.
       A spawn that fails now says why instead of presenting as silence -- and
       that instrumentation is what produced the sentence "it exited with exit
       code: 0, it printed nothing", which is what identified the quoting rather
       than the job object as the culprit. */
    let out_path = log.with_file_name("update-spawn.out");
    let err_path = log.with_file_name("update-spawn.err");
    /* CREATE_NO_WINDOW rather than DETACHED_PROCESS: the helper gets a console
       of its OWN, hidden, instead of no console at all. It is still not attached
       to whatever terminal launched the app -- which matters, because this app
       is routinely started from a shell during development, and a console its
       helper shares is a console whose Ctrl+C reaches the helper.
       CREATE_NEW_PROCESS_GROUP keeps group-directed events out. */
    const NO_WINDOW: u32 = 0x0800_0000;
    const NEW_GROUP: u32 = 0x0000_0200;
    let cmd_exe = std::path::Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()))
        .join("System32")
        .join("cmd.exe");
    let mut child = Command::new(&cmd_exe)
        /* One argument that is a path. No script text crosses a quoting layer. */
        .args(["/c", script_path.to_string_lossy().as_ref()])
        /* Explicitly null, never inherited. The shipped version inherited stdin
           from a GUI app, so when cmd.exe asked "Terminate batch job (Y/N)?"
           there was nothing to answer with and the helper parked forever --
           found still running hours later. Null makes an unanswerable question
           fatal instead, and a helper that dies is one the marker file reports;
           a helper that hangs is a dead end. */
        .stdin(std::process::Stdio::null())
        .stdout(std::fs::File::create(&out_path).map_err(|e| format!("stdout: {e}"))?)
        .stderr(std::fs::File::create(&err_path).map_err(|e| format!("stderr: {e}"))?)
        .creation_flags(NO_WINDOW | NEW_GROUP)
        .spawn()
        .map_err(|error| format!("Windows would not start the installer helper: {error}"))?;

    /* Recorded so a later run can kill it. Without a pid on disk there is no
       way to find a stuck helper again -- matching on a command line is the
       string-matched boundary this project keeps getting caught by, and the
       process that knows the pid is this one. */
    let _ = std::fs::write(helper_pid_path(), child.id().to_string());

    /* Proof of life before the app is allowed to close. Without this the
       caller cannot tell a helper that is running from one that was killed on
       creation, and both end with the app gone and the version unchanged. */
    for _ in 0..40 {
        if log.exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    /* It did not announce itself. Say what the process actually did rather
       than guessing -- the exit code and its own stderr are on disk. */
    let status = match child.try_wait() {
        Ok(Some(code)) => format!("it exited with {code}"),
        Ok(None) => "it is still running but wrote nothing".to_string(),
        Err(error) => format!("its state could not be read ({error})"),
    };
    let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
    let stderr = stderr.trim();
    Err(format!(
        "The installer helper did not start. {status}.{}",
        if stderr.is_empty() {
            " It printed nothing.".to_string()
        } else {
            format!(" It said: {}", &stderr[..stderr.len().min(300)])
        }
    ))
}

/// The helper's process id, so a stuck one can be found and ended.
pub fn helper_pid_path() -> std::path::PathBuf {
    swap_log_path().with_file_name("update-helper.pid")
}

/// End a helper left over from a previous attempt, if one is still running.
///
/// The second failure of this feature left a helper alive and parked for hours.
/// Nothing looked for it, so a retry would have started a second one against the
/// same binary. This is deliberately quiet about a pid that is already gone --
/// the common case is a completed helper whose file was never cleaned up, and
/// that is not a fault worth reporting.
#[cfg(windows)]
pub fn clear_stale_helper() {
    use std::os::windows::process::CommandExt;
    let path = helper_pid_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(pid) = text.trim().parse::<u32>() else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    /* `/T` because the helper spawns `ping` and the installer as children, and
       killing only the parent leaves those holding handles. */
    let killed = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .output();
    if let Ok(output) = killed {
        if output.status.success() {
            /* Worth a line in the log the next attempt will overwrite -- but
               the log is about to be removed, so it goes to the app's stderr
               where a dev build shows it. */
            eprintln!("update: ended a leftover installer helper (pid {pid})");
        }
    }
    let _ = std::fs::remove_file(&path);
}

#[cfg(not(windows))]
pub fn clear_stale_helper() {}

/// Where the swap transcribes itself, beside the binary it is replacing.
pub fn swap_log_path() -> std::path::PathBuf {
    running_binary()
        .and_then(|exe| exe.parent().map(|dir| dir.join("update-swap.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("update-swap.log"))
}

/// What the last swap attempt was for, written before the app exits.
pub fn swap_marker_path() -> std::path::PathBuf {
    running_binary()
        .and_then(|exe| exe.parent().map(|dir| dir.join("update-attempted.txt")))
        .unwrap_or_else(|| std::path::PathBuf::from("update-attempted.txt"))
}

#[cfg(not(windows))]
fn spawn_swap(_pid: u32, _installer: &Path, _exe: &Path) -> Result<(), String> {
    /* Deliberate, and the same reasoning as `install:local` refusing here:
       installing the .deb on a machine that BUILDS Hivemind is what put a stale
       copy into WSL's application list in the first place. On Linux the built
       artifacts are named and the install stays a decision. */
    Err(
        "Installing from inside the app is Windows-only. On Linux install the .deb from desktop/src-tauri/target/release/bundle/deb."
            .to_string(),
    )
}

fn npm_command() -> Command {
    // npm is a .cmd shim on Windows and cannot be spawned directly.
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", "npm"]);
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new("npm")
    }
}

#[cfg(test)]
mod tests {
    use super::build_stage;

    #[test]
    fn build_stages_come_only_from_parseable_tool_output() {
        assert_eq!(
            build_stage("vite v6.4.3 building for production..."),
            Some((1, "Building the interface"))
        );
        assert_eq!(
            build_stage("   Compiling hivemind-desktop v0.1.0"),
            Some((2, "Compiling the desktop shell"))
        );
        assert_eq!(
            build_stage("    Bundling Hivemind_26.817_x64-setup.exe"),
            Some((3, "Packaging the installer"))
        );
        assert_eq!(build_stage("transforming..."), None);
    }
}

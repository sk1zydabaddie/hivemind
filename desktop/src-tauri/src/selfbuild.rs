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
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
) -> Result<String, String> {
    rebuild_app(project_path.clone()).await?;
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
pub async fn rebuild_app(project_path: String) -> Result<String, String> {
    let root = std::fs::canonicalize(&project_path)
        .map_err(|error| format!("could not read that folder: {error}"))?;
    if !is_own_source(&root) {
        return Err("This project is not Hivemind's own source.".to_string());
    }
    let desktop = root.join("desktop");
    tauri::async_runtime::spawn_blocking(move || {
        let output = npm_command()
            .args(["run", "tauri:build"])
            .current_dir(&desktop)
            .output()
            .map_err(|error| format!("could not start the build: {error}"))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .join(" | "));
        }
        // The tail is what says why. The head of a Tauri build is pages of
        // progress nobody needs.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(12).collect();
        Err(format!(
            "The build failed. {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" ")
        ))
    })
    .await
    .map_err(|error| format!("build task failed: {error}"))?
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
    let script_path = log.with_file_name("update-swap.ps1");
    let script_body = format!(
        "Add-Content -LiteralPath '{log}' -Value 'helper started'
try {{ Wait-Process -Id {pid} -Timeout 90 -ErrorAction Stop }} catch {{ Add-Content -LiteralPath '{log}' -Value 'app already gone' }}
Add-Content -LiteralPath '{log}' -Value 'installing'
$p = Start-Process -Wait -PassThru -FilePath '{installer}' -ArgumentList '/S'
Add-Content -LiteralPath '{log}' -Value ('installer exit: ' + $p.ExitCode)
Start-Process -FilePath '{exe}'
Add-Content -LiteralPath '{log}' -Value 'restarted'
",
        log = log.display(),
        pid = pid,
        installer = installer.display(),
        exe = exe.display()
    );
    std::fs::write(&script_path, script_body)
        .map_err(|error| format!("could not write the installer helper: {error}"))?;

    let script = format!(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{script_path}\"' }};          if ($r.ReturnValue -ne 0) {{ Add-Content -LiteralPath '{log}' -Value ('wmi refused: ' + $r.ReturnValue) }}",
        script_path = script_path.display(),
        log = log.display()
    );

    /* Proof of life before the app is allowed to close. Without this the
       caller cannot tell a helper that is running from one that was killed on
       creation, and both end with the app gone and the version unchanged. */
    for _ in 0..40 {
        if log.exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err(
        "The installer helper was started but never ran -- Windows stopped it with this app. Nothing was installed and Hivemind has stayed open."
            .to_string(),
    )
}

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

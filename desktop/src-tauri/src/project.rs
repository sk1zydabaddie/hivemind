use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);
// Workspace actions can include bounded provider and worker runs. Their own Core
// ceilings remain authoritative; this transport bound only prevents the shell
// from abandoning a valid long-running response after the health-check timeout.
const WORKSPACE_ACTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const EMBEDDED_SHELL_BUILD_ID: &str = env!(
    "HIVEMIND_SHELL_BUILD_ID",
    "desktop shell build identity must be embedded at compile time"
);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ProjectConnection {
    project_root: String,
    daemon_url: String,
    build_id: String,
    shell_build_id: String,
    expected_shell_build_id: String,
    status: String,
}

#[tauri::command]
pub async fn choose_project_folder(
    app: tauri::AppHandle,
    initial_path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app
            .dialog()
            .file()
            .set_title("Choose a project folder");
        let initial = PathBuf::from(initial_path.trim());
        if initial.is_dir() {
            picker = picker.set_directory(initial);
        }
        picker
            .blocking_pick_folder()
            .map(|selected| {
                selected
                    .into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| format!("the selected folder is not a local path: {error}"))
            })
            .transpose()
    })
    .await
    .map_err(|error| format!("the folder picker stopped unexpectedly: {error}"))?
}

/// Why opening a project failed, as a CODE the shell can branch on.
///
/// The shell used to decide what to offer a person by matching the prose of
/// this error: `/not a git repository|git root/` picked the "start tracking
/// this folder" button. `canonical_git_root` actually says "selected directory
/// is not **inside** a git repository", which that pattern does not match, so
/// the button was unreachable from the day it was written -- the most ordinary
/// first-run case there is fell through to a generic failure with an internal
/// sentence as its body.
///
/// STANDING RULE, and this is its fourth instance: **control flow never depends
/// on message text.** The uncomfortable part is that the previous three were
/// recorded in `docs/STATE.md` BEFORE this one was written. Writing a rule down
/// does not enforce it. What enforces it is that the message is no longer
/// reachable from the branch: the shell sees `code`, and `message` is only ever
/// displayed.
///
/// A code is assigned where the failure is CREATED, never inferred from a
/// string afterwards -- inferring it at the boundary would be the same bug one
/// layer up. An unclassified failure gets `unknown`, which renders as the
/// generic message and offers nothing. That is the safe direction: a wrong
/// button is worse than no button.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ProjectFault {
    pub code: &'static str,
    pub message: String,
}

pub const FAULT_NOT_A_GIT_REPOSITORY: &str = "not_a_git_repository";
pub const FAULT_NO_PROJECT_SELECTED: &str = "no_project_selected";
pub const FAULT_NOT_INITIALIZED: &str = "not_initialized_for_hivemind";
pub const FAULT_DESKTOP_UPDATE_REQUIRED: &str = "desktop_update_required";
pub const FAULT_DAEMON_UNAVAILABLE: &str = "daemon_unavailable";
/// The daemon running this project is from a different build than the shell.
pub const FAULT_DAEMON_BUILD_MISMATCH: &str = "daemon_build_mismatch";
pub const FAULT_UNKNOWN: &str = "unknown";

impl ProjectFault {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

// Anything that has not been classified is `unknown` rather than guessed at.
impl From<String> for ProjectFault {
    fn from(message: String) -> Self {
        Self::new(FAULT_UNKNOWN, message)
    }
}

// No deny_unknown_fields. The shell and Core ship as separate binaries and are
// routinely at different versions on the same machine, so Core adding one
// field to daemon.json would otherwise stop the shell attaching to its own
// daemon -- a total outage from a purely additive change.
//
// Tolerating unknown fields is safe HERE specifically because daemon.json
// authorizes nothing. It is a rendezvous record: where the daemon is, and
// which build it is. `version` is still checked, and `build_id` is still
// compared against the expected shell build; neither check is weakened by
// ignoring a field this binary has never heard of. Do not copy this to a
// format that grants anything.
#[derive(Debug, Deserialize)]
struct DaemonState {
    version: u8,
    #[serde(default, deserialize_with = "deserialize_optional_pid")]
    pid: Option<u32>,
    url: String,
    repo_root: String,
    #[serde(default)]
    build_id: Option<String>,
    started_at: String,
}

// Same reasoning as DaemonState: this is the daemon's own /health response,
// read across a version boundary, and it authorizes nothing.
#[derive(Debug, Deserialize)]
struct DaemonHealth {
    ok: bool,
    repo_root: String,
    #[serde(default)]
    build_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessLiveness {
    Alive,
    Dead,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessProbeResult {
    Alive,
    NoSuchProcess,
    PermissionDenied,
    Ambiguous,
}

#[tauri::command]
pub async fn select_project(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<ProjectConnection, ProjectFault> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("could not resolve desktop resources: {error}"),
        )
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        connect_project_with(
            &project_path,
            &mut |project_root| start_daemon(project_root, Some(&resource_dir)),
            &query_daemon_health,
            &|project_root| query_cli_build_identity(project_root, Some(&resource_dir)),
            &|project_root| query_expected_shell_build_identity(project_root, Some(&resource_dir)),
            EMBEDDED_SHELL_BUILD_ID,
            &process_liveness,
            STARTUP_TIMEOUT,
        )
    })
    .await
    .map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("project selection task failed: {error}"),
        )
    })?
}

/// Sets a repository up and opens it, without a terminal.
///
/// The daemon refuses to attach to a repository that has no config, so this
/// cannot be an audited workspace action: there is no daemon yet to route one
/// to. The shell therefore runs Core's own `init` command, exactly as it
/// already runs `build-id` and `daemon`. It does not reimplement any part of
/// initialisation; Core remains the only thing that decides what a project
/// contains.
#[tauri::command]
pub async fn initialize_project(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<ProjectConnection, ProjectFault> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("could not resolve desktop resources: {error}"),
        )
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = canonical_git_root(&project_path)?;
        run_core_init(&project_root, Some(&resource_dir))?;
        connect_project_with(
            &project_path,
            &mut |root| start_daemon(root, Some(&resource_dir)),
            &query_daemon_health,
            &|root| query_cli_build_identity(root, Some(&resource_dir)),
            &|root| query_expected_shell_build_identity(root, Some(&resource_dir)),
            EMBEDDED_SHELL_BUILD_ID,
            &process_liveness,
            STARTUP_TIMEOUT,
        )
    })
    .await
    .map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("project initialization task failed: {error}"),
        )
    })?
}

fn run_core_init(project_root: &Path, resource_dir: Option<&Path>) -> Result<(), String> {
    let output = daemon_command(resource_dir)?
        .arg("init")
        .current_dir(project_root)
        .output()
        .map_err(|error| format!("could not set up the selected project: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not set up the selected project: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn workspace_action(
    app: tauri::AppHandle,
    project_path: String,
    action: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve desktop resources: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        // A workspace action is dispatched from a workspace that is already
        // open, so its failures are shown as action errors rather than routed
        // to the setup screen. Only the message is needed here.
        let project_root = canonical_git_root(&project_path).map_err(|fault| fault.message)?;
        let state = read_daemon_state(&project_root)?
            .ok_or_else(|| "selected project's daemon is not running".to_string())?;
        validate_state_project(&project_root, &state)?;
        let expected_shell_build_id =
            query_expected_shell_build_identity(&project_root, Some(&resource_dir))?;
        validate_shell_build(EMBEDDED_SHELL_BUILD_ID, &expected_shell_build_id)?;
        let expected_build_id = query_cli_build_identity(&project_root, Some(&resource_dir))?;
        let health = query_daemon_health(&state.url)?;
        validate_health_project(&project_root, &health.repo_root)?;
        validate_daemon_build(&state, &health, &expected_build_id)?;
        post_workspace_action(&state.url, &action)
    })
    .await
    .map_err(|error| format!("workspace action task failed: {error}"))?
}

fn connect_project_with<L, H, B, S, P>(
    project_path: &str,
    launch: &mut L,
    health: &H,
    expected_build: &B,
    expected_shell_build: &S,
    embedded_shell_build_id: &str,
    liveness: &P,
    startup_timeout: Duration,
) -> Result<ProjectConnection, ProjectFault>
where
    L: FnMut(&Path) -> Result<Option<Child>, String>,
    H: Fn(&str) -> Result<DaemonHealth, String>,
    B: Fn(&Path) -> Result<String, String>,
    S: Fn(&Path) -> Result<String, String>,
    P: Fn(Option<u32>) -> ProcessLiveness,
{
    let project_root = canonical_git_root(project_path)?;
    let expected_shell_build_id = expected_shell_build(&project_root)?;
    validate_shell_build(embedded_shell_build_id, &expected_shell_build_id)
        .map_err(|message| ProjectFault::new(FAULT_DESKTOP_UPDATE_REQUIRED, message))?;
    let expected_build_id = expected_build(&project_root)?;
    let config_path = project_root.join(".hivemind").join("config.json");
    if !config_path.is_file() {
        return Err(ProjectFault::new(
            FAULT_NOT_INITIALIZED,
            "selected repository is not initialized for Hivemind",
        ));
    }

    if let Some(state) = read_daemon_state(&project_root)? {
        validate_state_project(&project_root, &state)?;
        match health(&state.url) {
            Ok(health_state) => {
                validate_health_project(&project_root, &health_state.repo_root)?;
                validate_daemon_build(&state, &health_state, &expected_build_id)
                    .map_err(|message| ProjectFault::new(FAULT_DAEMON_BUILD_MISMATCH, message))?;
                return Ok(connection(
                    &project_root,
                    &state.url,
                    &expected_build_id,
                    embedded_shell_build_id,
                    &expected_shell_build_id,
                    "attached",
                ));
            }
            Err(reason) => match liveness(state.pid) {
                ProcessLiveness::Dead => {}
                ProcessLiveness::Alive | ProcessLiveness::Unknown => {
                    return Err(ProjectFault::new(
                        FAULT_DAEMON_UNAVAILABLE,
                        format!(
                            "selected project's daemon is live or liveness is uncertain, but health failed ({reason}); refusing to start a second writer"
                        ),
                    ));
                }
            },
        }
    }

    let mut child = launch(&project_root)?;
    let deadline = Instant::now() + startup_timeout;
    loop {
        if let Some(process) = child.as_mut() {
            if let Some(status) = process.try_wait().map_err(|error| {
                ProjectFault::new(
                    FAULT_DAEMON_UNAVAILABLE,
                    format!("could not inspect started daemon: {error}"),
                )
            })? {
                return Err(ProjectFault::new(
                    FAULT_DAEMON_UNAVAILABLE,
                    format!("started daemon exited before becoming healthy: {status}"),
                ));
            }
        }

        if let Some(state) = read_daemon_state(&project_root)? {
            validate_state_project(&project_root, &state)?;
            if let Ok(health_state) = health(&state.url) {
                validate_health_project(&project_root, &health_state.repo_root)?;
                validate_daemon_build(&state, &health_state, &expected_build_id)
                    .map_err(|message| ProjectFault::new(FAULT_DAEMON_BUILD_MISMATCH, message))?;
                // Dropping Child detaches the daemon. Tauri intentionally owns no
                // shutdown hook so closing or switching the app cannot kill it.
                drop(child);
                return Ok(connection(
                    &project_root,
                    &state.url,
                    &expected_build_id,
                    embedded_shell_build_id,
                    &expected_shell_build_id,
                    "started",
                ));
            }
        }
        if Instant::now() >= deadline {
            drop(child);
            return Err(ProjectFault::new(
                FAULT_DAEMON_UNAVAILABLE,
                "started daemon did not become healthy before the startup timeout",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub(crate) fn canonical_git_root(project_path: &str) -> Result<PathBuf, ProjectFault> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err(ProjectFault::new(
            FAULT_NO_PROJECT_SELECTED,
            "no project folder has been chosen",
        ));
    }
    let output = hidden_command("git")
        .args(["-C", trimmed, "rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| {
            ProjectFault::new(
                FAULT_UNKNOWN,
                format!("could not inspect selected project: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(ProjectFault::new(
            FAULT_NOT_A_GIT_REPOSITORY,
            "selected directory is not inside a git repository",
        ));
    }
    let root = String::from_utf8(output.stdout).map_err(|_| {
        ProjectFault::new(FAULT_UNKNOWN, "git returned a non-UTF-8 repository root")
    })?;
    fs::canonicalize(root.trim()).map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("could not canonicalize selected repository: {error}"),
        )
    })
}

fn read_daemon_state(project_root: &Path) -> Result<Option<DaemonState>, String> {
    let state_path = project_root.join(".hivemind").join("daemon.json");
    let raw = match fs::read_to_string(&state_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read .hivemind/daemon.json: {error}")),
    };
    let state: DaemonState = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid .hivemind/daemon.json: {error}"))?;
    if state.version != 1 || state.started_at.trim().is_empty() {
        return Err("invalid .hivemind/daemon.json fields".to_string());
    }
    validate_loopback_url(&state.url)?;
    Ok(Some(state))
}

fn deserialize_optional_pid<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_u64()
        .and_then(|candidate| u32::try_from(candidate).ok())
        .filter(|candidate| *candidate > 0))
}

fn validate_state_project(project_root: &Path, state: &DaemonState) -> Result<(), String> {
    let recorded = fs::canonicalize(&state.repo_root)
        .map_err(|_| "daemon state repo_root cannot be canonicalized".to_string())?;
    if !same_path(project_root, &recorded) {
        return Err(
            "daemon state belongs to a different project; refusing to attach or overwrite it"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_health_project(project_root: &Path, health_root: &str) -> Result<(), String> {
    let reported = fs::canonicalize(health_root)
        .map_err(|_| "daemon health repo_root cannot be canonicalized".to_string())?;
    if !same_path(project_root, &reported) {
        return Err("daemon health belongs to a different project; refusing to attach".to_string());
    }
    Ok(())
}

fn validate_daemon_build(
    state: &DaemonState,
    health: &DaemonHealth,
    expected_build_id: &str,
) -> Result<(), String> {
    let state_build_id = state.build_id.as_deref().unwrap_or("unknown");
    let health_build_id = health.build_id.as_deref().unwrap_or("unknown");
    if state_build_id != expected_build_id || health_build_id != expected_build_id {
        return Err(format!(
            "daemon build mismatch: state {state_build_id}, running {health_build_id}, expected {expected_build_id}; restart the daemon before using this project"
        ));
    }
    Ok(())
}

fn validate_shell_build(embedded_build_id: &str, expected_build_id: &str) -> Result<(), String> {
    if !is_build_identity(embedded_build_id) || !is_build_identity(expected_build_id) {
        return Err("desktop shell build identity is missing or malformed; rebuild and restart the desktop app".to_string());
    }
    if embedded_build_id != expected_build_id {
        return Err(format!(
            "desktop shell build mismatch: running {embedded_build_id}, Core expects {expected_build_id}; rebuild and restart the desktop app before using project controls"
        ));
    }
    Ok(())
}

fn start_daemon(project_root: &Path, resource_dir: Option<&Path>) -> Result<Option<Child>, String> {
    let mut command = daemon_command(resource_dir)?;
    command
        .args(["daemon", "--port", "0"])
        .current_dir(project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut command);
    command
        .spawn()
        .map(Some)
        .map_err(|error| format!("could not start Hivemind daemon: {error}"))
}

fn daemon_command(resource_dir: Option<&Path>) -> Result<Command, String> {
    if let Ok(configured) = std::env::var("HIVEMIND_CLI_PATH") {
        let configured = PathBuf::from(configured);
        if !configured.is_file() {
            return Err("HIVEMIND_CLI_PATH does not point to a file".to_string());
        }
        return Ok(command_for_cli_path(configured));
    }

    if let Some(resource_dir) = resource_dir {
        let bundled_cli = resource_dir
            .join("core")
            .join("dist")
            .join("src")
            .join("cli.js");
        if bundled_cli.is_file() {
            return Ok(command_for_cli_path(bundled_cli));
        }
        if !cfg!(debug_assertions) {
            return Err(
                "installed Hivemind Core resource is missing; reinstall the desktop app"
                    .to_string(),
            );
        }
    }

    if cfg!(debug_assertions) {
        let development_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("dist")
            .join("src")
            .join("cli.js");
        if development_cli.is_file() {
            return Ok(command_for_cli_path(development_cli));
        }
    }
    Ok(hidden_command("hivemind"))
}

fn query_cli_build_identity(
    project_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    query_cli_identity(project_root, resource_dir, "build-id", "Core build")
}

fn query_cli_shell_build_identity(
    project_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    query_cli_identity(
        project_root,
        resource_dir,
        "shell-build-id",
        "desktop shell build",
    )
}

fn query_expected_shell_build_identity(
    project_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    if std::env::var_os("HIVEMIND_CLI_PATH").is_none() {
        if let Some(resource_dir) = resource_dir {
            let manifest = resource_dir.join("core").join("shell-build-id.txt");
            if manifest.is_file() {
                let value = fs::read_to_string(&manifest)
                    .map_err(|error| {
                        format!("could not read packaged shell build identity: {error}")
                    })?
                    .trim()
                    .to_string();
                if !is_build_identity(&value) {
                    return Err(
                        "packaged shell build identity is malformed; reinstall the desktop app"
                            .to_string(),
                    );
                }
                return Ok(value);
            }
            if !cfg!(debug_assertions) {
                return Err(
                    "packaged shell build identity is missing; reinstall the desktop app"
                        .to_string(),
                );
            }
        }
    }
    query_cli_shell_build_identity(project_root, resource_dir)
}

fn query_cli_identity(
    project_root: &Path,
    resource_dir: Option<&Path>,
    command: &str,
    label: &str,
) -> Result<String, String> {
    let output = daemon_command(resource_dir)?
        .arg(command)
        .current_dir(project_root)
        .output()
        .map_err(|error| format!("could not query Hivemind {label} identity: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Hivemind {label} identity command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let build_id = String::from_utf8(output.stdout)
        .map_err(|_| format!("Hivemind {label} identity was not UTF-8"))?
        .trim()
        .to_string();
    if !is_build_identity(&build_id) {
        return Err(format!(
            "Hivemind Core returned an invalid {label} identity"
        ));
    }
    Ok(build_id)
}

fn is_build_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn command_for_cli_path(cli_path: PathBuf) -> Command {
    if cli_path.extension().and_then(|value| value.to_str()) == Some("js") {
        let mut command = hidden_command(
            std::env::var("HIVEMIND_NODE_PATH").unwrap_or_else(|_| "node".to_string()),
        );
        command.arg(node_compatible_path(&cli_path));
        command
    } else {
        hidden_command(cli_path)
    }
}

#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    let rendered = path.to_string_lossy();
    if let Some(unc) = rendered.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(local) = rendered.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn query_daemon_health(url: &str) -> Result<DaemonHealth, String> {
    let endpoint = parse_loopback_url(url)?;
    let address = endpoint
        .to_socket_addrs()
        .map_err(|error| format!("could not resolve daemon address: {error}"))?
        .find(|candidate| candidate.ip().is_loopback())
        .ok_or_else(|| "daemon URL did not resolve to loopback".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT)
        .map_err(|error| format!("daemon health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(HEALTH_TIMEOUT))
        .map_err(|error| format!("could not configure daemon health timeout: {error}"))?;
    stream
        .set_write_timeout(Some(HEALTH_TIMEOUT))
        .map_err(|error| format!("could not configure daemon health timeout: {error}"))?;
    let host = endpoint.split(':').next().unwrap_or("127.0.0.1");
    stream
        .write_all(
            format!(
                "GET /health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|error| format!("daemon health request failed: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("daemon health response failed: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "daemon health returned malformed HTTP".to_string())?;
    if !headers.lines().next().unwrap_or("").contains(" 200 ") {
        return Err("daemon health returned a non-200 response".to_string());
    }
    let health: DaemonHealth = serde_json::from_str(body)
        .map_err(|error| format!("daemon health returned invalid JSON: {error}"))?;
    if !health.ok {
        return Err("daemon health reported not-ok".to_string());
    }
    Ok(health)
}

fn post_workspace_action(
    url: &str,
    action: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let endpoint = parse_loopback_url(url)?;
    let address = endpoint
        .to_socket_addrs()
        .map_err(|error| format!("could not resolve daemon address: {error}"))?
        .find(|candidate| candidate.ip().is_loopback())
        .ok_or_else(|| "daemon URL did not resolve to loopback".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT)
        .map_err(|error| format!("daemon action connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(WORKSPACE_ACTION_TIMEOUT))
        .map_err(|error| format!("could not configure daemon action timeout: {error}"))?;
    stream
        .set_write_timeout(Some(HEALTH_TIMEOUT))
        .map_err(|error| format!("could not configure daemon action timeout: {error}"))?;
    let body = serde_json::to_string(action)
        .map_err(|error| format!("workspace action is not JSON serializable: {error}"))?;
    let host = endpoint.split(':').next().unwrap_or("127.0.0.1");
    stream.write_all(format!(
        "POST /workspace/action HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(), body
    ).as_bytes()).map_err(|error| format!("daemon action request failed: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("daemon action response failed: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "daemon action returned malformed HTTP".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("daemon action returned invalid JSON: {error}"))?;
    if !headers.lines().next().unwrap_or("").contains(" 200 ") {
        // Core attaches `plain` to a refusal it can phrase for a person, and
        // leaves it off when the raw reason is the best there is. Preferring it
        // here keeps the client out of the business of interpreting Core's
        // failure prose -- the producer of the failure is the only thing that
        // knows what it means.
        let reason = parsed
            .get("plain")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("reason").and_then(|value| value.as_str()))
            .unwrap_or("daemon action refused");
        return Err(reason.to_string());
    }
    parsed
        .get("value")
        .cloned()
        .ok_or_else(|| "daemon action response omitted value".to_string())
}

fn validate_loopback_url(url: &str) -> Result<(), String> {
    parse_loopback_url(url).map(|_| ())
}

fn parse_loopback_url(url: &str) -> Result<String, String> {
    let value = url
        .trim()
        .strip_prefix("http://")
        .ok_or_else(|| "daemon URL must use loopback HTTP".to_string())?
        .trim_end_matches('/');
    if value.contains('/') || value.contains('?') || value.contains('#') {
        return Err("daemon URL must contain only a loopback host and port".to_string());
    }
    let (host, port) = value
        .rsplit_once(':')
        .ok_or_else(|| "daemon URL must include a port".to_string())?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("daemon URL must use 127.0.0.1 or localhost".to_string());
    }
    let port: u16 = port
        .parse()
        .map_err(|_| "daemon URL port is invalid".to_string())?;
    if port == 0 {
        return Err("daemon URL port must be non-zero".to_string());
    }
    Ok(format!("{host}:{port}"))
}

fn connection(
    project_root: &Path,
    daemon_url: &str,
    build_id: &str,
    shell_build_id: &str,
    expected_shell_build_id: &str,
    status: &str,
) -> ProjectConnection {
    ProjectConnection {
        project_root: project_root.to_string_lossy().into_owned(),
        daemon_url: daemon_url.trim_end_matches('/').to_string(),
        build_id: build_id.to_string(),
        shell_build_id: shell_build_id.to_string(),
        expected_shell_build_id: expected_shell_build_id.to_string(),
        status: status.to_string(),
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

/* The sibling module needs the same window-hiding spawn; exposing this one
   keeps a second copy of the platform detail from existing. */
pub fn hidden_command_for_selfbuild(program: impl AsRef<std::ffi::OsStr>) -> Command {
    hidden_command(program)
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    hide_window(&mut command);
    command
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(windows)]
// Implements PL-1 from Hivemind_AI_Overview.md. This is deliberately ported
// from Core because the shell must decide whether to launch before a daemon
// exists to answer it.
fn process_liveness(pid: Option<u32>) -> ProcessLiveness {
    let Some(candidate_pid) = pid.filter(|candidate| *candidate > 0) else {
        return ProcessLiveness::Unknown;
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, candidate_pid);
        if handle.is_null() {
            let probe_result = match std::io::Error::last_os_error()
                .raw_os_error()
                .map(|value| value as u32)
            {
                Some(ERROR_INVALID_PARAMETER) => ProcessProbeResult::NoSuchProcess,
                Some(ERROR_ACCESS_DENIED) => ProcessProbeResult::PermissionDenied,
                Some(_) | None => ProcessProbeResult::Ambiguous,
            };
            return classify_process_liveness(Some(candidate_pid), probe_result);
        }
        let mut exit_code = 0_u32;
        let read = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        let probe_result = if read == 0 {
            ProcessProbeResult::Ambiguous
        } else if exit_code == 259 {
            ProcessProbeResult::Alive
        } else {
            ProcessProbeResult::NoSuchProcess
        };
        classify_process_liveness(Some(candidate_pid), probe_result)
    }
}

#[cfg(unix)]
fn process_liveness(pid: Option<u32>) -> ProcessLiveness {
    let Some(candidate_pid) = pid.filter(|candidate| *candidate > 0) else {
        return ProcessLiveness::Unknown;
    };
    let result = unsafe { libc::kill(candidate_pid as i32, 0) };
    if result == 0 {
        return classify_process_liveness(Some(candidate_pid), ProcessProbeResult::Alive);
    }
    let probe_result = match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessProbeResult::NoSuchProcess,
        Some(libc::EPERM) => ProcessProbeResult::PermissionDenied,
        Some(_) | None => ProcessProbeResult::Ambiguous,
    };
    classify_process_liveness(Some(candidate_pid), probe_result)
}

#[cfg(not(any(windows, unix)))]
fn process_liveness(pid: Option<u32>) -> ProcessLiveness {
    classify_process_liveness(pid, ProcessProbeResult::Ambiguous)
}

fn classify_process_liveness(
    pid: Option<u32>,
    probe_result: ProcessProbeResult,
) -> ProcessLiveness {
    if pid.is_none() || pid == Some(0) {
        return ProcessLiveness::Unknown;
    }
    match probe_result {
        ProcessProbeResult::Alive => ProcessLiveness::Alive,
        ProcessProbeResult::NoSuchProcess => ProcessLiveness::Dead,
        ProcessProbeResult::PermissionDenied | ProcessProbeResult::Ambiguous => {
            ProcessLiveness::Unknown
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn attaches_only_when_state_and_health_match_the_selected_project() {
        let project = fixture_project("attach");
        write_state(
            &project,
            &project,
            "http://127.0.0.1:40101",
            std::process::id(),
        );
        let launch_count = Arc::new(AtomicUsize::new(0));
        let launch_count_copy = launch_count.clone();
        let mut launch = move |_root: &Path| {
            launch_count_copy.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        };

        let result = connect_project_with(
            project.to_str().unwrap(),
            &mut launch,
            &|_| Ok(test_health(&project)),
            &|_| Ok(test_build_id()),
            &|_| Ok(test_shell_build_id()),
            &test_shell_build_id(),
            &|_| ProcessLiveness::Alive,
            Duration::from_millis(20),
        )
        .unwrap();

        assert_eq!(result.status, "attached");
        assert_eq!(result.shell_build_id, test_shell_build_id());
        assert_eq!(result.expected_shell_build_id, test_shell_build_id());
        assert_eq!(launch_count.load(Ordering::SeqCst), 0);
        cleanup_fixture(&project);
    }

    #[test]
    fn stale_desktop_shell_is_refused_before_attach_launch_or_action_transport() {
        let project = fixture_project("shell-build-stale");
        let launch_count = Arc::new(AtomicUsize::new(0));
        let launch_count_copy = launch_count.clone();
        let mut launch = move |_root: &Path| {
            launch_count_copy.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        };

        let result = connect_project_with(
            project.to_str().unwrap(),
            &mut launch,
            &|_| panic!("daemon health must not be queried for a stale shell"),
            &|_| Ok(test_build_id()),
            &|_| Ok("d".repeat(64)),
            &test_shell_build_id(),
            &|_| ProcessLiveness::Alive,
            Duration::from_millis(20),
        );

        let fault = result.unwrap_err();
        assert_eq!(fault.code, FAULT_DESKTOP_UPDATE_REQUIRED);
        assert!(fault.message.contains("desktop shell build mismatch"));
        assert_eq!(launch_count.load(Ordering::SeqCst), 0);
        cleanup_fixture(&project);
    }

    #[test]
    fn every_workspace_action_rechecks_shell_identity_before_transport() {
        let source = include_str!("project.rs");
        let action = source
            .split("pub async fn workspace_action")
            .nth(1)
            .and_then(|value| value.split("fn connect_project_with").next())
            .expect("workspace_action source section");
        let shell_check = action
            .find("validate_shell_build")
            .expect("shell identity check");
        let transport = action
            .find("post_workspace_action")
            .expect("workspace action transport");
        assert!(
            shell_check < transport,
            "shell identity must be verified before action transport"
        );
    }

    #[test]
    fn workspace_action_transport_does_not_abandon_bounded_worker_runs() {
        assert!(WORKSPACE_ACTION_TIMEOUT >= Duration::from_secs(15 * 60));
        let source = include_str!("project.rs");
        let transport = source
            .split("fn post_workspace_action")
            .nth(1)
            .and_then(|value| value.split("fn parse_loopback_url").next())
            .expect("workspace action transport source section");
        assert!(transport.contains("set_read_timeout(Some(WORKSPACE_ACTION_TIMEOUT))"));
        assert!(!transport.contains("Duration::from_secs(30)"));
    }

    #[test]
    fn absent_daemon_starts_once_and_returns_the_new_project_bound_connection() {
        let project = fixture_project("start");
        let launched_project = project.clone();
        let mut launch = move |root: &Path| {
            assert!(same_path(root, &launched_project));
            write_state(root, root, "http://127.0.0.1:40102", std::process::id());
            Ok(None)
        };

        let result = connect_project_with(
            project.to_str().unwrap(),
            &mut launch,
            &|_| Ok(test_health(&project)),
            &|_| Ok(test_build_id()),
            &|_| Ok(test_shell_build_id()),
            &test_shell_build_id(),
            &|_| ProcessLiveness::Dead,
            Duration::from_millis(20),
        )
        .unwrap();

        assert_eq!(result.status, "started");
        cleanup_fixture(&project);
    }

    #[test]
    fn stale_dead_daemon_state_starts_one_replacement_without_hanging() {
        let project = fixture_project("stale-dead");
        write_state(&project, &project, "http://127.0.0.1:40112", u32::MAX);
        let launch_count = Arc::new(AtomicUsize::new(0));
        let launch_count_copy = launch_count.clone();
        let launched_project = project.clone();
        let mut launch = move |root: &Path| {
            assert!(same_path(root, &launched_project));
            launch_count_copy.fetch_add(1, Ordering::SeqCst);
            write_state(root, root, "http://127.0.0.1:40113", std::process::id());
            Ok(None)
        };

        let result = connect_project_with(
            project.to_str().unwrap(),
            &mut launch,
            &|url| {
                if url.ends_with(":40113") {
                    Ok(test_health(&project))
                } else {
                    Err("connection refused".to_string())
                }
            },
            &|_| Ok(test_build_id()),
            &|_| Ok(test_shell_build_id()),
            &test_shell_build_id(),
            &|pid| {
                if pid == Some(u32::MAX) {
                    ProcessLiveness::Dead
                } else {
                    ProcessLiveness::Alive
                }
            },
            Duration::from_millis(20),
        )
        .unwrap();

        assert_eq!(result.status, "started");
        assert_eq!(result.daemon_url, "http://127.0.0.1:40113");
        assert_eq!(launch_count.load(Ordering::SeqCst), 1);
        cleanup_fixture(&project);
    }

    #[test]
    fn foreign_daemon_state_is_surfaced_and_never_launches_or_attaches() {
        let project = fixture_project("foreign-a");
        let other = fixture_project("foreign-b");
        write_state(
            &project,
            &other,
            "http://127.0.0.1:40103",
            std::process::id(),
        );
        let launch_count = Arc::new(AtomicUsize::new(0));
        let launch_count_copy = launch_count.clone();
        let mut launch = move |_root: &Path| {
            launch_count_copy.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        };

        let result = connect_project_with(
            project.to_str().unwrap(),
            &mut launch,
            &|_| Ok(test_health(&other)),
            &|_| Ok(test_build_id()),
            &|_| Ok(test_shell_build_id()),
            &test_shell_build_id(),
            &|_| ProcessLiveness::Alive,
            Duration::from_millis(20),
        );

        assert!(result.unwrap_err().message.contains("different project"));
        assert_eq!(launch_count.load(Ordering::SeqCst), 0);
        cleanup_fixture(&project);
        cleanup_fixture(&other);
    }

    #[test]
    fn live_missing_or_stale_daemon_build_is_surfaced_and_never_used_or_replaced() {
        for missing in [false, true] {
            let project = fixture_project(if missing {
                "build-missing"
            } else {
                "build-stale"
            });
            write_state(
                &project,
                &project,
                "http://127.0.0.1:40114",
                std::process::id(),
            );
            if missing {
                let state_path = project.join(".hivemind").join("daemon.json");
                let mut state: serde_json::Value =
                    serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
                state.as_object_mut().unwrap().remove("build_id");
                fs::write(&state_path, state.to_string()).unwrap();
            }
            let launch_count = Arc::new(AtomicUsize::new(0));
            let launch_count_copy = launch_count.clone();
            let mut launch = move |_root: &Path| {
                launch_count_copy.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            };
            let mut health = test_health(&project);
            if missing {
                health.build_id = None;
            }

            let result = connect_project_with(
                project.to_str().unwrap(),
                &mut launch,
                &|_| {
                    Ok(DaemonHealth {
                        ok: health.ok,
                        repo_root: health.repo_root.clone(),
                        build_id: health.build_id.clone(),
                    })
                },
                &|_| Ok("b".repeat(64)),
                &|_| Ok(test_shell_build_id()),
                &test_shell_build_id(),
                &|_| ProcessLiveness::Alive,
                Duration::from_millis(20),
            );

            assert!(result.unwrap_err().message.contains("daemon build mismatch"));
            assert_eq!(launch_count.load(Ordering::SeqCst), 0);
            cleanup_fixture(&project);
        }
    }

    #[test]
    fn unhealthy_live_or_unknown_daemon_never_permits_a_second_writer() {
        for liveness in [ProcessLiveness::Alive, ProcessLiveness::Unknown] {
            let project = fixture_project("uncertain");
            write_state(
                &project,
                &project,
                "http://127.0.0.1:40104",
                std::process::id(),
            );
            let mut launch = |_root: &Path| panic!("must not launch");
            let result = connect_project_with(
                project.to_str().unwrap(),
                &mut launch,
                &|_| Err("connection refused".to_string()),
                &|_| Ok(test_build_id()),
                &|_| Ok(test_shell_build_id()),
                &test_shell_build_id(),
                &|_| liveness,
                Duration::from_millis(20),
            );
            let fault = result.unwrap_err();
            assert_eq!(fault.code, FAULT_DAEMON_UNAVAILABLE);
            assert!(fault.message.contains("refusing to start a second writer"));
            cleanup_fixture(&project);
        }
    }

    #[test]
    fn dropping_a_started_child_does_not_kill_it() {
        let child = if cfg!(windows) {
            let mut command = hidden_command("powershell");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            command.spawn().unwrap()
        } else {
            Command::new("sleep").arg("30").spawn().unwrap()
        };
        let pid = child.id();
        assert_eq!(process_liveness(Some(pid)), ProcessLiveness::Alive);
        drop(child);
        assert_eq!(process_liveness(Some(pid)), ProcessLiveness::Alive);
        terminate_fixture_process(pid);
    }

    #[test]
    fn pl_1_process_liveness_cases_stay_fail_closed() {
        assert_eq!(
            classify_process_liveness(Some(101), ProcessProbeResult::Alive),
            ProcessLiveness::Alive
        );
        assert_eq!(
            classify_process_liveness(Some(102), ProcessProbeResult::NoSuchProcess),
            ProcessLiveness::Dead
        );
        assert_eq!(
            classify_process_liveness(Some(103), ProcessProbeResult::PermissionDenied),
            ProcessLiveness::Unknown
        );
        assert_eq!(
            classify_process_liveness(Some(104), ProcessProbeResult::Ambiguous),
            ProcessLiveness::Unknown
        );
        assert_eq!(
            classify_process_liveness(None, ProcessProbeResult::NoSuchProcess),
            ProcessLiveness::Unknown
        );
        assert_eq!(
            classify_process_liveness(Some(0), ProcessProbeResult::NoSuchProcess),
            ProcessLiveness::Unknown
        );

        let missing: DaemonState = serde_json::from_str(
            r#"{"version":1,"url":"http://127.0.0.1:1","repo_root":"C:\\repo","started_at":"now"}"#,
        )
        .unwrap();
        let malformed: DaemonState = serde_json::from_str(
            r#"{"version":1,"pid":"not-a-pid","url":"http://127.0.0.1:1","repo_root":"C:\\repo","started_at":"now"}"#,
        )
        .unwrap();
        assert_eq!(process_liveness(missing.pid), ProcessLiveness::Unknown);
        assert_eq!(process_liveness(malformed.pid), ProcessLiveness::Unknown);
    }

    fn fixture_project(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let project = std::env::temp_dir().join(format!(
            "hivemind-desktop-project-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(project.join(".hivemind")).unwrap();
        let status = hidden_command("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap();
        assert!(status.success());
        fs::write(project.join(".hivemind").join("config.json"), "{}\n").unwrap();
        fs::canonicalize(project).unwrap()
    }

    fn write_state(container: &Path, repo_root: &Path, url: &str, pid: u32) {
        fs::write(
            container.join(".hivemind").join("daemon.json"),
            serde_json::json!({
                "version": 1,
                "pid": pid,
                "url": url,
                "repo_root": repo_root,
                "build_id": test_build_id(),
                "started_at": "2026-07-30T00:00:00.000Z"
            })
            .to_string(),
        )
        .unwrap();
    }

    fn test_build_id() -> String {
        "a".repeat(64)
    }

    fn test_shell_build_id() -> String {
        "c".repeat(64)
    }

    fn test_health(project: &Path) -> DaemonHealth {
        DaemonHealth {
            ok: true,
            repo_root: project.to_string_lossy().into_owned(),
            build_id: Some(test_build_id()),
        }
    }

    #[cfg(windows)]
    #[test]
    fn node_cli_paths_drop_windows_verbatim_prefixes() {
        assert_eq!(
            node_compatible_path(Path::new(
                r"\\?\C:\Program Files\Hivemind AI\core\dist\src\cli.js"
            )),
            PathBuf::from(r"C:\Program Files\Hivemind AI\core\dist\src\cli.js")
        );
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\UNC\server\share\core\dist\src\cli.js")),
            PathBuf::from(r"\\server\share\core\dist\src\cli.js")
        );
    }

    fn cleanup_fixture(project: &Path) {
        fs::remove_dir_all(project).unwrap();
    }

    #[cfg(windows)]
    pub(super) fn terminate_fixture_process(pid: u32) {
        let _ = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }

    #[cfg(unix)]
    pub(super) fn terminate_fixture_process(pid: u32) {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

// ── Recent projects, and why they live in the shell ────────────────────────
//
// "Which projects have I opened" is SHELL state, not project state. Putting it
// inside any one project would make one project the registry of the others,
// which is precisely the cross-project coupling the isolation work removed. So
// it lives in the app's own config directory, holds nothing but paths and the
// time each was last opened, and is read by the shell alone.
//
// Nothing about a project's WORK is stored here. No task, no run, no
// capability, no connection. Switching therefore cannot carry a verification
// across, because there is nothing here that could carry one.

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RecentProject {
    pub path: String,
    pub opened_at: String,
}

fn recents_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the app config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create the app config directory: {error}"))?;
    Ok(dir.join("recent-projects.json"))
}

fn read_recents(app: &tauri::AppHandle) -> Vec<RecentProject> {
    let Ok(file) = recents_file(app) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<RecentProject>>(&text).unwrap_or_default()
}

#[tauri::command]
pub async fn recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    // A path that no longer exists is dropped rather than offered. Opening a
    // folder that has been moved or deleted is a dead end the shell can see
    // coming, and offering it would be the same failure as a stale shortcut.
    Ok(read_recents(&app)
        .into_iter()
        .filter(|entry| std::path::Path::new(&entry.path).is_dir())
        .collect())
}

#[tauri::command]
pub async fn remember_project(app: tauri::AppHandle, project_path: String) -> Result<(), String> {
    let normalized = std::fs::canonicalize(&project_path)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or(project_path);
    let mut entries: Vec<RecentProject> = read_recents(&app)
        .into_iter()
        .filter(|entry| entry.path != normalized)
        .collect();
    entries.insert(
        0,
        RecentProject {
            path: normalized,
            opened_at: chrono_now(),
        },
    );
    entries.truncate(8);
    let file = recents_file(&app)?;
    let text = serde_json::to_string_pretty(&entries)
        .map_err(|error| format!("could not record the recent project: {error}"))?;
    std::fs::write(&file, text)
        .map_err(|error| format!("could not write the recent project list: {error}"))
}

// ── What this person has already been shown ───────────────────────────────
//
// Shell state, in the app's own config directory, for the same reason
// `recent-projects.json` lives there: it is about this INSTALLATION and this
// person, not about any project. Putting a "seen it" flag inside a project
// would make the first project you opened the authority on what you have read,
// and re-show the whole thing the moment you switched -- while also writing a
// preference into a repository that gets committed and shared.
//
// Deliberately one flat map of booleans with no schema beyond that. A dismissal
// authorizes nothing, gates nothing and is read by nothing but presentation, so
// an unknown key is simply absent and a corrupt file reads as "nothing has been
// dismissed" -- which shows guidance again rather than hiding it. Failing
// toward showing is the safe direction for something whose whole purpose is to
// stop a person being stuck.

fn dismissals_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the app config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create the app config directory: {error}"))?;
    Ok(dir.join("dismissed.json"))
}

#[tauri::command]
pub async fn dismissed_hints(
    app: tauri::AppHandle,
) -> Result<std::collections::BTreeMap<String, bool>, String> {
    let Ok(file) = dismissals_file(&app) else {
        return Ok(Default::default());
    };
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(Default::default());
    };
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

#[tauri::command]
pub async fn dismiss_hint(app: tauri::AppHandle, hint: String) -> Result<(), String> {
    let key = hint.trim().to_string();
    if key.is_empty() {
        return Err("a dismissal needs a name".to_string());
    }
    let mut all = dismissed_hints(app.clone()).await?;
    all.insert(key, true);
    let file = dismissals_file(&app)?;
    let text = serde_json::to_string_pretty(&all)
        .map_err(|error| format!("could not record the dismissal: {error}"))?;
    std::fs::write(&file, text)
        .map_err(|error| format!("could not write the dismissal list: {error}"))
}

// ── The build-mismatch exit ────────────────────────────────────────────────
//
// The daemon build check is correct and stays exactly as strict: two runs
// against a stale build cost ~38K tokens, and it exists because of them. What
// it did not have was a way out. After an update the first screen said
//
//     daemon build mismatch: state 9f9f…, running 9f9f…, expected a1b2…;
//     restart the daemon before using this project
//
// -- two 64-character hashes, the word "daemon", and an instruction naming an
// action no control in the app performs. A correct refusal with no exit is
// still a dead end, and this one is on the first screen after every update.
//
// So: say it plainly, and offer the button.
//
// ## Why the daemon outlives the app at all
//
// Closing the window must not orphan workers mid-run, which is why Tauri owns
// no shutdown hook and the daemon is deliberately detached. That reason is
// entirely about work in flight. **If nothing is running, there is nothing to
// protect**, and asking a person to make that judgement is asking them to
// answer a question the machine can answer better.
//
// ## How idleness is proved without trusting the old build
//
// Not by asking the daemon. The daemon in question is a DIFFERENT BUILD -- the
// exact thing being refused -- so any answer it gives about its own state is
// the thing under suspicion, and a field added to `/health` today would be
// absent from every daemon old enough to hit this.
//
// It is read off disk instead, from two records the daemon writes as it works:
//
// 1. `.hivemind/resource/ledger.json` -- a reservation with `status: "active"`
//    is a metered call that has been paid for and not yet settled.
// 2. `.hivemind/worktrees/` -- a task worktree exists while a task is being
//    worked in isolation.
//
// Both are the pair M10.8's cleanup already asserts on ("zero task worktrees
// and zero active reservations"), and both are build-independent. Anything
// unreadable is `Unknown`, never `Idle` -- the whole point is to be sure.

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaemonWork {
    /// Provably nothing in flight: safe to stop without orphaning anything.
    Idle,
    /// Something is running. Stopping it would abandon work.
    Busy,
    /// Could not tell. Treated as busy -- ask rather than guess.
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct DaemonStanding {
    pub work: DaemonWork,
    /// One sentence for a person, naming what was found.
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveReservations {
    total: usize,
    provider_checks: usize,
}

fn active_reservations(project_root: &Path) -> Result<ActiveReservations, ()> {
    let ledger = project_root
        .join(".hivemind")
        .join("resource")
        .join("ledger.json");
    let raw = match fs::read_to_string(&ledger) {
        Ok(value) => value,
        // No ledger at all means nothing has ever been metered here.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ActiveReservations {
                total: 0,
                provider_checks: 0,
            })
        }
        Err(_) => return Err(()),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| ())?;
    let Some(reservations) = parsed.get("reservations") else {
        // A ledger whose shape this does not recognise is not evidence of
        // idleness. Say so rather than reading zero out of an absent field.
        return Err(());
    };
    let mut active = ActiveReservations {
        total: 0,
        provider_checks: 0,
    };
    let mut count = |entry: &serde_json::Value| {
        if entry.get("status").and_then(|value| value.as_str()) != Some("active") {
            return;
        }
        active.total += 1;
        if entry
            .get("session_id")
            .and_then(|value| value.as_str())
            .is_some_and(|session| session.starts_with("probe-"))
        {
            active.provider_checks += 1;
        }
    };
    match reservations {
        serde_json::Value::Array(entries) => {
            for entry in entries {
                count(entry);
            }
        }
        serde_json::Value::Object(entries) => {
            for (_, entry) in entries {
                count(entry);
            }
        }
        _ => return Err(()),
    }
    Ok(active)
}

fn task_worktrees(project_root: &Path) -> Result<usize, ()> {
    let dir = project_root.join(".hivemind").join("worktrees");
    match fs::read_dir(&dir) {
        Ok(entries) => Ok(entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .count()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(()),
    }
}

pub(crate) fn daemon_work(project_root: &Path) -> DaemonStanding {
    let (Ok(reservations), Ok(worktrees)) =
        (active_reservations(project_root), task_worktrees(project_root))
    else {
        return DaemonStanding {
            work: DaemonWork::Unknown,
            detail: "Hivemind could not read this project's records, so it cannot tell whether anything is still running.".to_string(),
        };
    };
    if reservations.total == 0 && worktrees == 0 {
        return DaemonStanding {
            work: DaemonWork::Idle,
            detail: "Nothing is running in this project.".to_string(),
        };
    }

    /* Records of work are only evidence of work while the process that wrote
       them is alive.
       A daemon killed mid-call leaves its reservation `active` forever --
       nothing settles it, because the thing that would settle it is gone. Left
       at that, the project can never prove itself idle again and both the
       daemon restart and the build bar are disabled permanently with no way
       back. That is a quieter failure than restarting into a live run, and it
       was the one that shipped: this proof did not consult liveness at all.
       The asymmetry decides the uncertain cases. Only a DEAD daemon releases
       the guard; alive keeps it, and so does not knowing. */
    let liveness = match read_daemon_state(project_root) {
        Ok(Some(state)) => liveness_of(state.pid),
        /* No daemon is registered for this project, so nothing is running it.
           The shell finds daemons through this record, so one it cannot see is
           one it would start a replacement for anyway. */
        Ok(None) => ProcessLiveness::Dead,
        Err(_) => ProcessLiveness::Unknown,
    };

    match liveness {
        ProcessLiveness::Dead => DaemonStanding {
            work: DaemonWork::Idle,
            detail: format!(
                "Nothing is running. {} call(s) and {worktrees} task workspace(s) were left behind by a background process that is no longer alive.",
                reservations.total
            ),
        },
        ProcessLiveness::Alive => {
            let detail = if reservations.provider_checks == reservations.total
                && reservations.provider_checks > 0
                && worktrees == 0
            {
                format!(
                    "A provider check is still finishing ({} active). Try again when it completes.",
                    reservations.provider_checks
                )
            } else {
                format!(
                    "This project still has {worktrees} task workspace(s) and {} call(s) in progress.",
                    reservations.total
                )
            };
            DaemonStanding {
                work: DaemonWork::Busy,
                detail,
            }
        }
        ProcessLiveness::Unknown => DaemonStanding {
            work: DaemonWork::Unknown,
            detail: format!(
                "This project has {worktrees} task workspace(s) and {} call(s) recorded, and Hivemind cannot tell whether the process holding them is still alive.",
                reservations.total
            ),
        },
    }
}

/* Indirected so the tests can drive liveness without spawning, and so the one
   place that decides "is it still alive" is the one place that already knows
   how to ask on each platform. */
fn liveness_of(pid: Option<u32>) -> ProcessLiveness {
    process_liveness(pid)
}

#[tauri::command]
pub async fn inspect_daemon_work(project_path: String) -> Result<DaemonStanding, String> {
    let root = canonical_git_root(&project_path).map_err(|fault| fault.message)?;
    Ok(daemon_work(&root))
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err("could not open the background process to stop it".to_string());
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if ok == 0 {
            return Err("the background process refused to stop".to_string());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> Result<(), String> {
    // SIGTERM, not SIGKILL: the daemon gets to close its files. The wait below
    // is what turns "asked it to stop" into "it stopped".
    let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if result == 0 {
        return Ok(());
    }
    match std::io::Error::last_os_error().raw_os_error() {
        // Already gone is the outcome being asked for.
        Some(libc::ESRCH) => Ok(()),
        _ => Err("the background process refused to stop".to_string()),
    }
}

#[cfg(not(any(windows, unix)))]
fn terminate_process(_pid: u32) -> Result<(), String> {
    Err("stopping a background process is not supported on this platform".to_string())
}

/// Stop the daemon this project is running and open it again on the matching
/// build.
///
/// Refuses while anything is in flight. That refusal is the reason the daemon
/// outlives the app in the first place, so this must not be the thing that
/// undoes it -- a person who wants to stop a busy project stops the work first,
/// which is a decision with its own surface.
#[tauri::command]
pub async fn restart_daemon(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<ProjectConnection, ProjectFault> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        ProjectFault::new(
            FAULT_UNKNOWN,
            format!("could not resolve desktop resources: {error}"),
        )
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = canonical_git_root(&project_path)?;
        let standing = daemon_work(&project_root);
        if standing.work != DaemonWork::Idle {
            return Err(ProjectFault::new(
                FAULT_DAEMON_UNAVAILABLE,
                format!("{} Stop the run before restarting.", standing.detail),
            ));
        }

        if let Some(state) = read_daemon_state(&project_root)? {
            if let Some(pid) = state.pid {
                terminate_process(pid).map_err(|message| {
                    ProjectFault::new(FAULT_DAEMON_UNAVAILABLE, message)
                })?;
            }
            // Wait for it to actually be gone. Starting a second writer while
            // the first is still up is the exact condition `connect_project_with`
            // refuses, so racing it here would trade one dead end for another.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if process_liveness(state.pid) == ProcessLiveness::Dead {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if process_liveness(state.pid) == ProcessLiveness::Alive {
                return Err(ProjectFault::new(
                    FAULT_DAEMON_UNAVAILABLE,
                    "The previous version's background process is still running and did not stop."
                        .to_string(),
                ));
            }
            // Its rendezvous record names a daemon that no longer exists.
            let _ = fs::remove_file(project_root.join(".hivemind").join("daemon.json"));
        }

        connect_project_with(
            &project_path,
            &mut |root| start_daemon(root, Some(&resource_dir)),
            &query_daemon_health,
            &|root| query_cli_build_identity(root, Some(&resource_dir)),
            &|root| query_expected_shell_build_identity(root, Some(&resource_dir)),
            EMBEDDED_SHELL_BUILD_ID,
            &process_liveness,
            STARTUP_TIMEOUT,
        )
    })
    .await
    .map_err(|error| {
        ProjectFault::new(FAULT_UNKNOWN, format!("daemon restart task failed: {error}"))
    })?
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

// ── Git, on a folder that has none ────────────────────────────────────────
//
// Everything downstream assumes git: worktrees, base commits, diffs, and
// adoption's fast-forward. Pointing at a folder that is not a repository is a
// normal first-run case for someone who has been editing without one, and the
// front door used to explain the requirement and then stop.
//
// This offers the step instead. Known generated directories can be ignored and
// verified mechanically; secrets, built binaries, and ambiguous folder shapes
// still refuse rather than guess. There is no "commit everything and hope"
// path, because the first commit is what every later diff is measured against.

#[derive(serde::Serialize)]
pub struct GitReadiness {
    pub is_repo: bool,
    /// Files that would be committed, so the offer can name them.
    pub would_commit: Vec<String>,
    /// Generated top-level directories Hivemind can safely add to .gitignore.
    pub would_ignore: Vec<String>,
    /// Why Hivemind will not initialise this folder, when it will not.
    pub refusal: Option<String>,
}

/// Names that mean "this folder holds something a first commit must not take".
///
/// Kept, but no longer the whole check -- see `shape_refusal`. A list of names
/// can only ever refuse the secrets somebody thought to list, and the case that
/// actually mattered was not a secret at all.
const NEVER_COMMIT: [&str; 6] = [
    ".env",
    ".env.local",
    "id_rsa",
    "credentials.json",
    "secrets.json",
    ".npmrc",
];

/// Directories whose contents are installed or generated, never authored.
const NOT_AUTHORED_DIRS: [&str; 13] = [
    "node_modules",
    "vendor",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    "bower_components",
    "Pods",
    "dist",
    "build",
    "coverage",
    ".next",
    "out",
];

/// Extensions that mean "this file is built, not written".
const BINARY_EXTENSIONS: [&str; 16] = [
    "exe", "dll", "so", "dylib", "msi", "pdb", "bin", "obj", "o", "a", "lib", "class", "jar",
    "wasm", "node", "pyd",
];

/// Extensions that mean "somebody wrote this".
///
/// Deliberately generous and deliberately not exhaustive: the question it
/// answers is "does this folder contain authored work at all", and a folder
/// with even one recognised source file passes. Being wrong in the permissive
/// direction costs a refusal that should not have happened; being wrong in the
/// other direction commits somebody's build output forever.
const SOURCE_EXTENSIONS: [&str; 42] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "rb", "go", "java", "kt", "swift", "c",
    "h", "cc", "cpp", "hpp", "cs", "php", "ex", "exs", "scala", "clj", "hs", "ml", "lua", "sh",
    "ps1", "sql", "html", "css", "scss", "vue", "svelte", "md", "json", "toml", "yaml", "yml",
    "txt", "gradle",
];

/// Whether this folder has the SHAPE of a project somebody means to start
/// tracking, rather than whether it happens to contain one of six filenames.
///
/// The list-based check let the worst case straight through. The desktop used
/// to open `"."` on launch, which for an installed app is its own installation
/// directory -- and an install directory holds no `.env`, so `git init && git
/// add -A && commit` would have taken the executable, the DLLs and a bundled
/// `node_modules` into a first commit that every later diff is measured
/// against. A list can only refuse what somebody thought to list.
///
/// The shapes that require human judgment are refused, and each is stated as
/// what it IS rather than as a rule number. Known generated directories are
/// handled separately as a mechanical preparation, not flattened into this
/// human-judgment path.
fn shape_refusal(root: &Path, entries: &[String]) -> Option<String> {
    let mut binaries: Vec<&str> = Vec::new();
    let mut has_source = false;

    for name in entries {
        let path = root.join(name);
        if path.is_dir() {
            // A directory is not walked. Depth would make this slow on a large
            // tree for no gain: the shapes being refused are all visible at the
            // top level, and a folder whose only source lives three levels down
            // still reads as a project by its top-level files.
            continue;
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if BINARY_EXTENSIONS.iter().any(|needle| extension == *needle) {
            binaries.push(name);
        }
        if SOURCE_EXTENSIONS.iter().any(|needle| extension == *needle) {
            has_source = true;
        }
    }

    if !binaries.is_empty() {
        binaries.sort_unstable();
        binaries.truncate(4);
        return Some(format!(
            "This folder holds built programs rather than source ({}). That looks like an installed application or a build output directory, not a project to work on. Choose the folder your source code lives in.",
            binaries.join(", ")
        ));
    }
    if !has_source {
        return Some(
            "This folder has no source files in it, so there is nothing for Hivemind to work on yet. Choose the folder your project lives in."
                .to_string(),
        );
    }
    None
}

#[tauri::command]
pub async fn inspect_git_readiness(project_path: String) -> Result<GitReadiness, String> {
    let root = std::path::Path::new(&project_path);
    if !root.is_dir() {
        return Err("that folder does not exist".to_string());
    }
    if root.join(".git").exists() {
        return Ok(GitReadiness {
            is_repo: true,
            would_commit: Vec::new(),
            would_ignore: Vec::new(),
            refusal: None,
        });
    }

    let mut would_commit = Vec::new();
    let mut would_ignore = Vec::new();
    let mut dangerous = Vec::new();
    // Every top-level name, including the ones the display list hides. The
    // shape check has to see `node_modules` -- it is the whole reason the check
    // exists, and filtering it out of the list first is what let an install
    // directory through. `would_commit` is what a person is SHOWN; `present` is
    // what is actually there.
    let mut present = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("could not read that folder: {error}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == ".hivemind" {
            continue;
        }
        present.push(name.clone());
        if entry.path().is_dir() && NOT_AUTHORED_DIRS.iter().any(|dir| name == *dir) {
            would_ignore.push(name);
            continue;
        }
        if NEVER_COMMIT.iter().any(|needle| name == *needle) {
            dangerous.push(name.clone());
        }
        would_commit.push(name);
    }
    would_commit.sort();
    would_ignore.sort();

    // Refuse rather than guess. A .env in the folder is not something to decide
    // about on somebody's behalf -- and a first commit cannot be un-made
    // without rewriting history, which is exactly what a person who has never
    // used git cannot be asked to do.
    //
    // Named secrets first, because that refusal names the actual file and is
    // the more useful sentence when both apply.
    let refusal = if !dangerous.is_empty() {
        dangerous.sort();
        Some(format!(
            "This folder holds {} that should probably never be committed. Hivemind will not decide that for you: add a .gitignore, or set the repository up yourself, and open it again.",
            dangerous.join(", ")
        ))
    } else {
        shape_refusal(root, &present)
    };

    Ok(GitReadiness {
        is_repo: false,
        would_commit,
        would_ignore,
        refusal,
    })
}

fn add_generated_ignores(root: &Path, entries: &[String]) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let path = root.join(".gitignore");
    let existing = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read .gitignore: {error}")),
    };
    let mut next = existing.clone();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    let mut added_header = false;
    for entry in entries {
        let rule = format!("{entry}/");
        if existing.lines().any(|line| line.trim() == rule) {
            continue;
        }
        if !added_header {
            next.push_str("# Added by Hivemind before the first commit.\n");
            added_header = true;
        }
        next.push_str(&rule);
        next.push('\n');
    }
    if next != existing {
        std::fs::write(&path, next).map_err(|error| format!("could not update .gitignore: {error}"))?;
    }
    Ok(())
}

/// Make a folder into a git repository, with an explicit first commit.
///
/// Deliberately NOT a silent `git init && git add -A && git commit`. It refuses
/// on the same grounds `inspect_git_readiness` refuses, re-checked here rather
/// than trusted from the caller -- the readiness answer and the action are two
/// round trips apart, and a file can appear between them.
#[tauri::command]
pub async fn initialize_git(project_path: String) -> Result<GitReadiness, String> {
    let readiness = inspect_git_readiness(project_path.clone()).await?;
    if readiness.is_repo {
        return Ok(readiness);
    }
    if let Some(reason) = readiness.refusal {
        return Err(reason);
    }

    let root = std::path::Path::new(&project_path);
    let run = |args: &[&str]| -> Result<(), String> {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .map_err(|error| format!("git could not be started: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    };

    /* Verify git exists before changing a project file. Generated directories
       are the one refusal Hivemind can resolve without guessing: their names
       come from the closed list above, and the action verifies git ignores
       every one before staging anything. */
    run(&["--version"])?;
    add_generated_ignores(root, &readiness.would_ignore)?;
    run(&["init"])?;
    for entry in &readiness.would_ignore {
        run(&["check-ignore", "--quiet", "--", entry])?;
    }
    run(&["add", "-A"])?;
    // A message that says what it did and why, because this commit is the base
    // every later diff is measured against and somebody will read it later
    // wondering where it came from.
    run(&[
        "-c",
        "user.name=Hivemind",
        "-c",
        "user.email=setup@hivemind.local",
        "commit",
        "-m",
        "Start tracking this project\n\nCreated by Hivemind when the folder was opened, so changes can be\nkept separate until you choose to ship them. Project files that are\nnot generated or ignored are in this commit.",
    ])?;

    inspect_git_readiness(project_path).await
}

#[cfg(test)]
mod git_readiness_tests {
    use super::*;

    /// A directory no other test can be holding.
    ///
    /// It was keyed on `{name}-{process id}`, and `cargo test` runs every test
    /// in ONE process in parallel -- so two tests that happened to pick the
    /// same name got the same path. Both were called `"ordinary"`. Each one
    /// begins by deleting the directory and ends by deleting it again, so
    /// whichever started second wiped the other's files out from under it:
    /// sometimes between the write and the read (a file missing from
    /// `would_commit`), sometimes before `is_dir` (a flat "that folder does not
    /// exist"). Two symptoms, one cause, about one run in three.
    ///
    /// A counter rather than a rename, because renaming fixes the collision
    /// that happened and leaves the next one to chance.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "hivemind-git-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The case that was actually live, reproduced exactly.
    ///
    /// The desktop opened `"."` on launch, which for an installed app is its
    /// own installation directory. That folder holds no `.env`, so the
    /// name-list check passed it and the offer to `git init && git add -A`
    /// would have committed the executable, the DLLs and a bundled
    /// `node_modules`. A list refuses what somebody thought to list; this has
    /// to refuse by shape.
    #[test]
    fn an_installed_application_directory_is_refused() {
        let dir = temp_dir("install-dir");
        std::fs::write(dir.join("hivemind_desktop.exe"), "MZ").expect("exe");
        std::fs::write(dir.join("WebView2Loader.dll"), "MZ").expect("dll");
        std::fs::create_dir_all(dir.join("core").join("node_modules")).expect("bundled deps");

        let readiness = tauri::async_runtime::block_on(inspect_git_readiness(
            dir.to_string_lossy().to_string(),
        ))
        .expect("readiness");

        assert!(!readiness.is_repo);
        let refusal = readiness.refusal.expect("an install directory is refused");
        assert!(refusal.contains("built programs"), "{refusal}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_dependencies_are_offered_with_ignore_entries() {
        let dir = temp_dir("deps-only");
        std::fs::create_dir_all(dir.join("node_modules")).expect("deps");
        std::fs::create_dir_all(dir.join("dist")).expect("build output");
        std::fs::write(dir.join("index.js"), "export default 1;\n").expect("source");

        let readiness = tauri::async_runtime::block_on(inspect_git_readiness(
            dir.to_string_lossy().to_string(),
        ))
        .expect("readiness");

        assert_eq!(readiness.refusal, None);
        assert_eq!(readiness.would_ignore, vec!["dist", "node_modules"]);
        assert!(!readiness.would_commit.contains(&"node_modules".to_string()));
        assert!(!readiness.would_commit.contains(&"dist".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_action_ignores_generated_directories_and_creates_the_first_commit() {
        let dir = temp_dir("prepare-generated");
        std::fs::create_dir_all(dir.join("node_modules")).expect("deps");
        std::fs::create_dir_all(dir.join("dist")).expect("build output");
        std::fs::write(dir.join("node_modules").join("dependency.js"), "generated\n").expect("dep");
        std::fs::write(dir.join("dist").join("bundle.js"), "generated\n").expect("bundle");
        std::fs::write(dir.join("index.js"), "export default 1;\n").expect("source");

        let result = tauri::async_runtime::block_on(initialize_git(
            dir.to_string_lossy().to_string(),
        ))
        .expect("one-click git setup");
        assert!(result.is_repo);
        let ignore = std::fs::read_to_string(dir.join(".gitignore")).expect("gitignore");
        assert!(ignore.contains("node_modules/"), "{ignore}");
        assert!(ignore.contains("dist/"), "{ignore}");
        let tracked = std::process::Command::new("git")
            .args(["ls-files"])
            .current_dir(&dir)
            .output()
            .expect("git ls-files");
        let tracked = String::from_utf8_lossy(&tracked.stdout);
        assert!(tracked.contains("index.js"), "{tracked}");
        assert!(tracked.contains(".gitignore"), "{tracked}");
        assert!(!tracked.contains("node_modules"), "{tracked}");
        assert!(!tracked.contains("dist/"), "{tracked}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_with_no_source_is_refused() {
        let dir = temp_dir("no-source");
        std::fs::write(dir.join("holiday.jpg"), "not source").expect("file");

        let readiness = tauri::async_runtime::block_on(inspect_git_readiness(
            dir.to_string_lossy().to_string(),
        ))
        .expect("readiness");

        let refusal = readiness.refusal.expect("a folder with no source is refused");
        assert!(refusal.contains("no source files"), "{refusal}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The check has to be able to say YES, or it is not a check.
    #[test]
    fn an_ordinary_untracked_project_is_offered() {
        let dir = temp_dir("ordinary");
        std::fs::write(dir.join("index.ts"), "export const x = 1;\n").expect("source");
        std::fs::write(dir.join("README.md"), "# a project\n").expect("readme");

        let readiness = tauri::async_runtime::block_on(inspect_git_readiness(
            dir.to_string_lossy().to_string(),
        ))
        .expect("readiness");

        assert!(!readiness.is_repo);
        assert_eq!(readiness.refusal, None);
        assert!(readiness.would_commit.contains(&"index.ts".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_holding_a_secret_is_refused_rather_than_committed() {
        // The whole point of refusing: a first commit cannot be un-made without
        // rewriting history, which is exactly what somebody who has never used
        // git cannot be asked to do.
        let dir = temp_dir("secret");
        std::fs::write(dir.join(".env"), "TOKEN=1
").expect("write");
        std::fs::write(dir.join("index.js"), "//
").expect("write");

        let readiness =
            tauri::async_runtime::block_on(inspect_git_readiness(dir.to_string_lossy().to_string()))
                .expect("readiness");
        assert!(!readiness.is_repo);
        let refusal = readiness.refusal.expect("a secret must produce a refusal");
        assert!(refusal.contains(".env"), "the refusal must name the file: {refusal}");

        // And the action refuses too, re-checked rather than trusting the
        // earlier answer -- a file can appear between the two round trips.
        let attempted =
            tauri::async_runtime::block_on(initialize_git(dir.to_string_lossy().to_string()));
        assert!(attempted.is_err(), "initialize_git proceeded past a refusal");
        assert!(!dir.join(".git").exists(), "a repository was created anyway");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_ordinary_folder_is_offered_with_the_files_it_would_commit_named() {
        let dir = temp_dir("ordinary");
        std::fs::write(dir.join("index.js"), "//
").expect("write");
        std::fs::write(dir.join("README.md"), "# x
").expect("write");

        let readiness =
            tauri::async_runtime::block_on(inspect_git_readiness(dir.to_string_lossy().to_string()))
                .expect("readiness");
        assert!(!readiness.is_repo);
        assert!(readiness.refusal.is_none());
        // Named, so the offer can say what it is about to take.
        assert!(readiness.would_commit.contains(&"index.js".to_string()));
        assert!(readiness.would_commit.contains(&"README.md".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_repository_is_left_alone() {
        let dir = temp_dir("existing");
        std::fs::create_dir_all(dir.join(".git")).expect("git dir");
        let readiness =
            tauri::async_runtime::block_on(inspect_git_readiness(dir.to_string_lossy().to_string()))
                .expect("readiness");
        assert!(readiness.is_repo);
        assert!(readiness.would_commit.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── The idleness proof, against a crash and against a live run ──────────────
//
// This proof gates two irreversible-feeling acts: restarting the daemon after
// an update, and installing a new build over the running one. It has to be
// right in BOTH directions, and the two failures are not symmetric.
//
// Recovering too eagerly restarts into a running job, which is the exact thing
// the detached daemon exists to prevent. Recovering too reluctantly is quieter
// and just as bad in practice: a crash leaves `active` reservations behind
// forever, and a project that can never prove itself idle is one where the
// build bar and the daemon restart are permanently disabled with no way back.
#[cfg(test)]
mod idleness_tests {
    use super::tests::terminate_fixture_process;
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn project_with_reservation(label: &str, status: &str) -> PathBuf {
        project_with_reservation_session(label, status, "run-1")
    }

    fn project_with_reservation_session(label: &str, status: &str, session_id: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let project = std::env::temp_dir().join(format!(
            "hivemind-idle-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(project.join(".hivemind").join("resource")).unwrap();
        fs::write(
            project.join(".hivemind").join("resource").join("ledger.json"),
            format!(
                r#"{{"version":1,"providers":{{}},"reservations":[{{"reservation_id":"r1","status":"{status}","session_id":"{session_id}"}}]}}"#
            ),
        )
        .unwrap();
        project
    }

    fn record_daemon(project: &Path, pid: u32) {
        fs::write(
            project.join(".hivemind").join("daemon.json"),
            format!(
                r#"{{"version":1,"pid":{pid},"url":"http://127.0.0.1:7777","repo_root":"{}","started_at":"now"}}"#,
                project.to_string_lossy().replace(char::from(92), "/")
            ),
        )
        .unwrap();
    }

    fn spawn_sleeper() -> std::process::Child {
        if cfg!(windows) {
            let mut command = hidden_command("powershell");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            command.spawn().unwrap()
        } else {
            Command::new("sleep").arg("30").spawn().unwrap()
        }
    }

    /* THE DANGEROUS DIRECTION. A daemon that is genuinely running holds
       reservations that are genuinely live, and nothing may read that as safe
       to restart into. */
    #[test]
    fn a_live_daemons_reservations_still_read_as_busy() {
        let project = project_with_reservation("live", "active");
        let child = spawn_sleeper();
        record_daemon(&project, child.id());

        let standing = daemon_work(&project);
        assert_eq!(
            standing.work,
            DaemonWork::Busy,
            "a live daemon with an active reservation must never read as idle: {}",
            standing.detail
        );

        terminate_fixture_process(child.id());
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn a_live_provider_probe_is_named_as_a_retryable_check() {
        let project = project_with_reservation_session("probe", "active", "probe-worker-grok");
        let child = spawn_sleeper();
        record_daemon(&project, child.id());

        let standing = daemon_work(&project);
        assert_eq!(standing.work, DaemonWork::Busy);
        assert!(
            standing.detail.contains("provider check is still finishing"),
            "the updater must name the transient provider check: {}",
            standing.detail
        );
        assert!(standing.detail.contains("Try again"));

        terminate_fixture_process(child.id());
        let _ = fs::remove_dir_all(&project);
    }

    /* THE RECOVERY DIRECTION. A daemon that died mid-call leaves its
       reservation `active` forever -- nothing settles it, because the thing
       that would settle it is gone. Reading that as busy means the project can
       never prove itself idle again. */
    #[test]
    fn a_dead_daemons_reservations_do_not_block_forever() {
        let project = project_with_reservation("dead", "active");
        let child = spawn_sleeper();
        let pid = child.id();
        record_daemon(&project, pid);
        // Killed mid-reservation, exactly as a crash would leave it.
        terminate_fixture_process(pid);
        for _ in 0..50 {
            if process_liveness(Some(pid)) == ProcessLiveness::Dead {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(process_liveness(Some(pid)), ProcessLiveness::Dead);

        let standing = daemon_work(&project);
        assert_eq!(
            standing.work,
            DaemonWork::Idle,
            "a dead daemon's leftover reservation must not block forever: {}",
            standing.detail
        );

        let _ = fs::remove_dir_all(&project);
    }

    /* A settled reservation is not work, whoever wrote it. */
    #[test]
    fn settled_reservations_are_not_work() {
        let project = project_with_reservation("settled", "settled");
        assert_eq!(daemon_work(&project).work, DaemonWork::Idle);
        let _ = fs::remove_dir_all(&project);
    }

    /* No daemon record at all: nothing is registered as running this project,
       so a leftover reservation is an orphan rather than live work. The shell
       finds daemons through this record, so one it cannot see is one it would
       start a replacement for anyway. */
    #[test]
    fn reservations_with_no_daemon_record_are_orphans() {
        let project = project_with_reservation("orphan", "active");
        assert_eq!(daemon_work(&project).work, DaemonWork::Idle);
        let _ = fs::remove_dir_all(&project);
    }

    /* Uncertain liveness is NOT idleness. Permission-denied and ambiguous
       probes have to keep the guard closed, or the fail-safe is decorative. */
    #[test]
    fn unknown_liveness_keeps_the_guard_closed() {
        let project = project_with_reservation("unknown", "active");
        // Pid 0 is never a real process and `process_liveness` reports Unknown.
        record_daemon(&project, 0);
        let standing = daemon_work(&project);
        assert_ne!(
            standing.work,
            DaemonWork::Idle,
            "uncertain liveness must not be read as idle: {}",
            standing.detail
        );
        let _ = fs::remove_dir_all(&project);
    }
}

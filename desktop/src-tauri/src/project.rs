use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
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
pub async fn select_project(project_path: String) -> Result<ProjectConnection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        connect_project_with(
            &project_path,
            &mut start_daemon,
            &query_daemon_health,
            &query_cli_build_identity,
            &query_cli_shell_build_identity,
            EMBEDDED_SHELL_BUILD_ID,
            &process_liveness,
            STARTUP_TIMEOUT,
        )
    })
    .await
    .map_err(|error| format!("project selection task failed: {error}"))?
}

#[tauri::command]
pub async fn workspace_action(
    project_path: String,
    action: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = canonical_git_root(&project_path)?;
        let state = read_daemon_state(&project_root)?
            .ok_or_else(|| "selected project's daemon is not running".to_string())?;
        validate_state_project(&project_root, &state)?;
        let expected_shell_build_id = query_cli_shell_build_identity(&project_root)?;
        validate_shell_build(EMBEDDED_SHELL_BUILD_ID, &expected_shell_build_id)?;
        let expected_build_id = query_cli_build_identity(&project_root)?;
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
) -> Result<ProjectConnection, String>
where
    L: FnMut(&Path) -> Result<Option<Child>, String>,
    H: Fn(&str) -> Result<DaemonHealth, String>,
    B: Fn(&Path) -> Result<String, String>,
    S: Fn(&Path) -> Result<String, String>,
    P: Fn(Option<u32>) -> ProcessLiveness,
{
    let project_root = canonical_git_root(project_path)?;
    let expected_shell_build_id = expected_shell_build(&project_root)?;
    validate_shell_build(embedded_shell_build_id, &expected_shell_build_id)?;
    let expected_build_id = expected_build(&project_root)?;
    let config_path = project_root.join(".hivemind").join("config.json");
    if !config_path.is_file() {
        return Err("selected repository is not initialized for Hivemind".to_string());
    }

    if let Some(state) = read_daemon_state(&project_root)? {
        validate_state_project(&project_root, &state)?;
        match health(&state.url) {
            Ok(health_state) => {
                validate_health_project(&project_root, &health_state.repo_root)?;
                validate_daemon_build(&state, &health_state, &expected_build_id)?;
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
                    return Err(format!(
                        "selected project's daemon is live or liveness is uncertain, but health failed ({reason}); refusing to start a second writer"
                    ));
                }
            },
        }
    }

    let mut child = launch(&project_root)?;
    let deadline = Instant::now() + startup_timeout;
    loop {
        if let Some(process) = child.as_mut() {
            if let Some(status) = process
                .try_wait()
                .map_err(|error| format!("could not inspect started daemon: {error}"))?
            {
                return Err(format!(
                    "started daemon exited before becoming healthy: {status}"
                ));
            }
        }

        if let Some(state) = read_daemon_state(&project_root)? {
            validate_state_project(&project_root, &state)?;
            if let Ok(health_state) = health(&state.url) {
                validate_health_project(&project_root, &health_state.repo_root)?;
                validate_daemon_build(&state, &health_state, &expected_build_id)?;
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
            return Err(
                "started daemon did not become healthy before the startup timeout".to_string(),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn canonical_git_root(project_path: &str) -> Result<PathBuf, String> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("select a project directory".to_string());
    }
    let output = hidden_command("git")
        .args(["-C", trimmed, "rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| format!("could not inspect selected project: {error}"))?;
    if !output.status.success() {
        return Err("selected directory is not inside a git repository".to_string());
    }
    let root = String::from_utf8(output.stdout)
        .map_err(|_| "git returned a non-UTF-8 repository root".to_string())?;
    fs::canonicalize(root.trim())
        .map_err(|error| format!("could not canonicalize selected repository: {error}"))
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

fn start_daemon(project_root: &Path) -> Result<Option<Child>, String> {
    let mut command = daemon_command()?;
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

fn daemon_command() -> Result<Command, String> {
    if let Ok(configured) = std::env::var("HIVEMIND_CLI_PATH") {
        let configured = PathBuf::from(configured);
        if !configured.is_file() {
            return Err("HIVEMIND_CLI_PATH does not point to a file".to_string());
        }
        return Ok(command_for_cli_path(configured));
    }

    let development_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dist")
        .join("src")
        .join("cli.js");
    if development_cli.is_file() {
        return Ok(command_for_cli_path(development_cli));
    }
    Ok(hidden_command("hivemind"))
}

fn query_cli_build_identity(project_root: &Path) -> Result<String, String> {
    query_cli_identity(project_root, "build-id", "Core build")
}

fn query_cli_shell_build_identity(project_root: &Path) -> Result<String, String> {
    query_cli_identity(project_root, "shell-build-id", "desktop shell build")
}

fn query_cli_identity(project_root: &Path, command: &str, label: &str) -> Result<String, String> {
    let output = daemon_command()?
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
        command.arg(cli_path);
        command
    } else {
        hidden_command(cli_path)
    }
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
        let reason = parsed
            .get("reason")
            .and_then(|value| value.as_str())
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

        assert!(result.unwrap_err().contains("desktop shell build mismatch"));
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

        assert!(result.unwrap_err().contains("different project"));
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

            assert!(result.unwrap_err().contains("daemon build mismatch"));
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
            assert!(result
                .unwrap_err()
                .contains("refusing to start a second writer"));
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

    fn cleanup_fixture(project: &Path) {
        fs::remove_dir_all(project).unwrap();
    }

    #[cfg(windows)]
    fn terminate_fixture_process(pid: u32) {
        let _ = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }

    #[cfg(unix)]
    fn terminate_fixture_process(pid: u32) {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ProjectConnection {
    project_root: String,
    daemon_url: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DaemonState {
    version: u8,
    pid: u32,
    url: String,
    repo_root: String,
    started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DaemonHealth {
    ok: bool,
    repo_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessLiveness {
    Alive,
    Dead,
    Unknown,
}

#[tauri::command]
pub async fn select_project(project_path: String) -> Result<ProjectConnection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        connect_project_with(
            &project_path,
            &mut start_daemon,
            &query_daemon_health,
            &process_liveness,
            STARTUP_TIMEOUT,
        )
    })
    .await
    .map_err(|error| format!("project selection task failed: {error}"))?
}

fn connect_project_with<L, H, P>(
    project_path: &str,
    launch: &mut L,
    health: &H,
    liveness: &P,
    startup_timeout: Duration,
) -> Result<ProjectConnection, String>
where
    L: FnMut(&Path) -> Result<Option<Child>, String>,
    H: Fn(&str) -> Result<String, String>,
    P: Fn(u32) -> ProcessLiveness,
{
    let project_root = canonical_git_root(project_path)?;
    let config_path = project_root.join(".hivemind").join("config.json");
    if !config_path.is_file() {
        return Err("selected repository is not initialized for Hivemind".to_string());
    }

    if let Some(state) = read_daemon_state(&project_root)? {
        validate_state_project(&project_root, &state)?;
        match health(&state.url) {
            Ok(health_root) => {
                validate_health_project(&project_root, &health_root)?;
                return Ok(connection(&project_root, &state.url, "attached"));
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
            if let Ok(health_root) = health(&state.url) {
                validate_health_project(&project_root, &health_root)?;
                // Dropping Child detaches the daemon. Tauri intentionally owns no
                // shutdown hook so closing or switching the app cannot kill it.
                drop(child);
                return Ok(connection(&project_root, &state.url, "started"));
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
    if state.version != 1 || state.pid == 0 || state.started_at.trim().is_empty() {
        return Err("invalid .hivemind/daemon.json fields".to_string());
    }
    validate_loopback_url(&state.url)?;
    Ok(Some(state))
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

fn query_daemon_health(url: &str) -> Result<String, String> {
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
    Ok(health.repo_root)
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

fn connection(project_root: &Path, daemon_url: &str, status: &str) -> ProjectConnection {
    ProjectConnection {
        project_root: project_root.to_string_lossy().into_owned(),
        daemon_url: daemon_url.trim_end_matches('/').to_string(),
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
fn process_liveness(pid: u32) -> ProcessLiveness {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return match std::io::Error::last_os_error()
                .raw_os_error()
                .map(|value| value as u32)
            {
                Some(ERROR_INVALID_PARAMETER) => ProcessLiveness::Dead,
                Some(ERROR_ACCESS_DENIED) | None => ProcessLiveness::Unknown,
                Some(_) => ProcessLiveness::Unknown,
            };
        }
        let mut exit_code = 0_u32;
        let read = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if read == 0 {
            ProcessLiveness::Unknown
        } else if exit_code == 259 {
            ProcessLiveness::Alive
        } else {
            ProcessLiveness::Dead
        }
    }
}

#[cfg(unix)]
fn process_liveness(pid: u32) -> ProcessLiveness {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return ProcessLiveness::Alive;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessLiveness::Dead,
        Some(libc::EPERM) | None => ProcessLiveness::Unknown,
        Some(_) => ProcessLiveness::Unknown,
    }
}

#[cfg(not(any(windows, unix)))]
fn process_liveness(_pid: u32) -> ProcessLiveness {
    ProcessLiveness::Unknown
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
            &|_| Ok(project.to_string_lossy().into_owned()),
            &|_| ProcessLiveness::Alive,
            Duration::from_millis(20),
        )
        .unwrap();

        assert_eq!(result.status, "attached");
        assert_eq!(launch_count.load(Ordering::SeqCst), 0);
        cleanup_fixture(&project);
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
            &|_| Ok(project.to_string_lossy().into_owned()),
            &|_| ProcessLiveness::Dead,
            Duration::from_millis(20),
        )
        .unwrap();

        assert_eq!(result.status, "started");
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
            &|_| Ok(other.to_string_lossy().into_owned()),
            &|_| ProcessLiveness::Alive,
            Duration::from_millis(20),
        );

        assert!(result.unwrap_err().contains("different project"));
        assert_eq!(launch_count.load(Ordering::SeqCst), 0);
        cleanup_fixture(&project);
        cleanup_fixture(&other);
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
        assert_eq!(process_liveness(pid), ProcessLiveness::Alive);
        drop(child);
        assert_eq!(process_liveness(pid), ProcessLiveness::Alive);
        terminate_fixture_process(pid);
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
                "started_at": "2026-07-30T00:00:00.000Z"
            })
            .to_string(),
        )
        .unwrap();
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

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub(crate) const UPDATE_COORDINATOR_PROTOCOL: u32 = 1;
const ADMISSION_WAIT: Duration = Duration::from_secs(5);
const ADMISSION_POLL: Duration = Duration::from_millis(25);
const PROCESS_START_TOLERANCE_MS: u128 = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct UpdateLease {
    version: u32,
    nonce: String,
    owner_pid: u32,
    owner_started_at_ms: u128,
    acquired_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ArtifactIdentity {
    version: String,
    core_build_id: String,
    shell_build_id: String,
    runtime_version: String,
    runtime_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PendingRelaunch {
    version: u32,
    nonce: String,
    lease_nonce: String,
    requested_by_pid: u32,
    requested_by_started_at_ms: u128,
    expected: ArtifactIdentity,
}

#[derive(Debug, Serialize, Deserialize)]
struct AdmissionOwner {
    version: u32,
    pid: u32,
    process_started_at_ms: u128,
}

pub(crate) struct AdmissionGuard {
    directory: PathBuf,
    coordinator: PathBuf,
}

impl AdmissionGuard {
    pub(crate) fn coordinator_file(&self) -> &Path {
        &self.coordinator
    }
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

pub(crate) fn coordinator_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the machine-wide update directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the machine-wide update directory: {error}"))?;
    Ok(directory.join("update-lease.json"))
}

pub(crate) fn register_project(
    app: &tauri::AppHandle,
    admission: &AdmissionGuard,
    project_root: &Path,
) -> Result<(), String> {
    if !same_path(admission.coordinator_file(), &coordinator_file(app)?) {
        return Err("project registration does not own this update admission boundary".to_string());
    }
    let file = daemon_registry_file(app)?;
    let canonical = fs::canonicalize(project_root)
        .map_err(|error| format!("could not register the project daemon: {error}"))?;
    let mut projects = read_registered_projects(&file)?;
    if !projects.iter().any(|known| same_path(known, &canonical)) {
        projects.push(canonical);
        projects.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
        replace_json_atomically(&file, &projects)?;
    }
    Ok(())
}

#[allow(dead_code)] // The R2 admitted installer is the sole future consumer of this R1 boundary.
pub(crate) fn registered_projects(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    read_registered_projects(&daemon_registry_file(app)?)
}

pub(crate) fn begin_mutation(app: &tauri::AppHandle) -> Result<AdmissionGuard, String> {
    let file = coordinator_file(app)?;
    let guard = acquire_admission(&file)?;
    match read_live_lease(&file)? {
        Some(_) => {
            Err("Hivemind is being updated; new work is paused until the app restarts".to_string())
        }
        None => Ok(guard),
    }
}

pub(crate) fn reconcile_on_start(app: &tauri::AppHandle) -> Result<(), String> {
    let file = coordinator_file(app)?;
    reconcile_pending_relaunch(app, &file)?;
    let _ = read_live_lease(&file)?;
    reconcile_abandoned_admission(&file)
}

#[tauri::command]
pub(crate) fn pending_update_relaunch(app: tauri::AppHandle) -> Result<bool, String> {
    let coordinator = coordinator_file(&app)?;
    let Some(pending) = read_pending_relaunch(&pending_relaunch_file(&coordinator))? else {
        return Ok(false);
    };
    if process_identity_matches(pending.requested_by_pid, pending.requested_by_started_at_ms)
        != ProcessIdentity::Same
    {
        return Err(
            "the process that admitted this update is no longer the running app".to_string(),
        );
    }
    let lease = read_live_lease(&coordinator)?
        .ok_or_else(|| "the admitted update no longer owns its machine-wide lease".to_string())?;
    if lease.nonce != pending.lease_nonce || lease.owner_pid != std::process::id() {
        return Err("the admitted update does not own this machine-wide lease".to_string());
    }
    Ok(true)
}

#[tauri::command]
pub(crate) fn restart_after_update(app: tauri::AppHandle) -> Result<(), String> {
    let coordinator = coordinator_file(&app)?;
    let pending = read_pending_relaunch(&pending_relaunch_file(&coordinator))?
        .ok_or_else(|| "no admitted update is waiting to restart".to_string())?;
    if process_identity_matches(pending.requested_by_pid, pending.requested_by_started_at_ms)
        != ProcessIdentity::Same
    {
        return Err(
            "the process that admitted this update is no longer the running app".to_string(),
        );
    }
    let projects = registered_projects(&app)?;
    recheck_before_handoff(&coordinator, &pending.lease_nonce, &projects, |project| {
        crate::project::prove_daemon_idle_for_update(project)
    })?;
    app.restart()
}

#[allow(dead_code)] // R2 calls this only after its immutable artifact verifier admits an installer.
pub(crate) fn stage_verified_relaunch(
    app: &tauri::AppHandle,
    lease: &UpdateLease,
    expected: ArtifactIdentity,
) -> Result<(), String> {
    validate_artifact_identity(&expected)?;
    let file = coordinator_file(app)?;
    let pending = PendingRelaunch {
        version: UPDATE_COORDINATOR_PROTOCOL,
        nonce: format!("relaunch-{}-{}", std::process::id(), now_ms()?),
        lease_nonce: lease.nonce.clone(),
        requested_by_pid: std::process::id(),
        requested_by_started_at_ms: current_process_started_at_ms()?,
        expected,
    };
    write_new_json(&pending_relaunch_file(&file), &pending)
}

#[allow(dead_code)] // R2 supplies the admitted identity; this function never selects an artifact.
pub(crate) fn installed_artifact_identity(
    app: &tauri::AppHandle,
) -> Result<ArtifactIdentity, String> {
    use sha2::{Digest, Sha256};
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve installed resources: {error}"))?;
    let read = |relative: &str| -> Result<String, String> {
        fs::read_to_string(resources.join(relative))
            .map(|value| value.trim().to_string())
            .map_err(|error| format!("installed artifact identity is missing {relative}: {error}"))
    };
    let runtime_manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(resources.join("runtime/node-runtime.json"))
            .map_err(|error| format!("installed runtime manifest is missing: {error}"))?,
    )
    .map_err(|_| "installed runtime manifest is malformed".to_string())?;
    let runtime_version = runtime_manifest
        .get("version")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "installed runtime manifest has no version".to_string())?
        .to_string();
    let runtime = fs::read(resources.join("runtime/node.exe"))
        .map_err(|error| format!("installed runtime is missing: {error}"))?;
    let runtime_sha256 = format!("{:x}", Sha256::digest(runtime));
    let identity = ArtifactIdentity {
        version: app.package_info().version.to_string(),
        core_build_id: read("core/core-build-id.txt")?,
        shell_build_id: read("core/shell-build-id.txt")?,
        runtime_version,
        runtime_sha256,
    };
    validate_artifact_identity(&identity)?;
    Ok(identity)
}

#[cfg(test)]
fn acquire_update_lease<F>(
    file: &Path,
    project_roots: &[PathBuf],
    prove_idle: F,
) -> Result<UpdateLease, String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    let _guard = acquire_admission(file)?;
    acquire_update_lease_under_guard(file, project_roots, prove_idle)
}

fn acquire_update_lease_under_guard<F>(
    file: &Path,
    project_roots: &[PathBuf],
    prove_idle: F,
) -> Result<UpdateLease, String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    if read_live_lease(file)?.is_some() {
        return Err("another Hivemind update already holds the machine-wide lease".to_string());
    }
    for project_root in project_roots {
        prove_idle(project_root)?;
    }
    let now = now_ms()?;
    let lease = UpdateLease {
        version: UPDATE_COORDINATOR_PROTOCOL,
        nonce: format!("{}-{now}", std::process::id()),
        owner_pid: std::process::id(),
        owner_started_at_ms: current_process_started_at_ms()?,
        acquired_at_ms: now,
    };
    write_new_json(file, &lease)?;
    Ok(lease)
}

#[allow(dead_code)] // R2 calls this before any installer bytes can be handed off.
pub(crate) fn acquire_registered_update_lease<F>(
    app: &tauri::AppHandle,
    prove_idle: F,
) -> Result<UpdateLease, String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    let file = coordinator_file(app)?;
    let _guard = acquire_admission(&file)?;
    let projects = registered_projects(app)?;
    acquire_update_lease_under_guard(&file, &projects, prove_idle)
}

#[allow(dead_code)] // R2 calls this at the final installer handoff, under the same lease.
pub(crate) fn recheck_registered_before_handoff<F>(
    app: &tauri::AppHandle,
    nonce: &str,
    prove_idle: F,
) -> Result<(), String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    let file = coordinator_file(app)?;
    let projects = registered_projects(app)?;
    recheck_before_handoff(&file, nonce, &projects, prove_idle)
}

pub(crate) fn recheck_before_handoff<F>(
    file: &Path,
    nonce: &str,
    project_roots: &[PathBuf],
    prove_idle: F,
) -> Result<(), String>
where
    F: Fn(&Path) -> Result<(), String>,
{
    let _guard = acquire_admission(file)?;
    let lease = read_live_lease(file)?.ok_or_else(|| {
        "the machine-wide update lease disappeared before install handoff".to_string()
    })?;
    if lease.nonce != nonce || lease.owner_pid != std::process::id() {
        return Err("the machine-wide update lease belongs to another process".to_string());
    }
    for project_root in project_roots {
        prove_idle(project_root)?;
    }
    Ok(())
}

#[allow(dead_code)] // R2 uses this on every admitted-update terminal failure before handoff.
pub(crate) fn release_update_lease(file: &Path, nonce: &str) -> Result<(), String> {
    let Some(lease) = read_live_lease(file)? else {
        return Ok(());
    };
    if lease.nonce != nonce || lease.owner_pid != std::process::id() {
        return Err("the machine-wide update lease belongs to another process".to_string());
    }
    fs::remove_file(file)
        .map_err(|error| format!("could not release the machine-wide update lease: {error}"))
}

fn read_live_lease(file: &Path) -> Result<Option<UpdateLease>, String> {
    let raw = match fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not read the machine-wide update lease: {error}"
            ))
        }
    };
    let lease: UpdateLease = serde_json::from_str(&raw)
        .map_err(|_| "the machine-wide update lease is malformed; refusing new work".to_string())?;
    if lease.version != UPDATE_COORDINATOR_PROTOCOL || lease.nonce.trim().is_empty() {
        return Err("the machine-wide update lease is malformed; refusing new work".to_string());
    }
    match process_identity_matches(lease.owner_pid, lease.owner_started_at_ms) {
        ProcessIdentity::Same | ProcessIdentity::Unknown => Ok(Some(lease)),
        ProcessIdentity::DeadOrReused => {
            fs::remove_file(file).map_err(|error| {
                format!("could not reconcile the abandoned machine-wide update lease: {error}")
            })?;
            Ok(None)
        }
    }
}

fn reconcile_pending_relaunch(app: &tauri::AppHandle, lease_file: &Path) -> Result<(), String> {
    let file = pending_relaunch_file(lease_file);
    let Some(pending) = read_pending_relaunch(&file)? else {
        return Ok(());
    };
    if pending_belongs_to_current_process(&pending) {
        // The process that staged the handoff has not exited. Download or
        // installer completion is not a relaunch, so it cannot clear success.
        return Ok(());
    }
    let actual = installed_artifact_identity(app)?;
    if actual != pending.expected {
        return Err(
            "the relaunched app does not match the complete admitted artifact identity".to_string(),
        );
    }
    if let Some(lease) = read_live_lease(lease_file)? {
        if lease.nonce != pending.lease_nonce {
            return Err(
                "the relaunched app does not own the update lease it is completing".to_string(),
            );
        }
        fs::remove_file(lease_file)
            .map_err(|error| format!("could not release the completed update lease: {error}"))?;
    }
    replace_json_value_atomically(
        &completed_relaunch_file(lease_file),
        &serde_json::json!({
            "version": UPDATE_COORDINATOR_PROTOCOL,
            "nonce": pending.nonce,
            "identity": actual,
            "verified_at_ms": now_ms()?
        }),
    )?;
    // Keep the pending marker until the durable completion record exists. If
    // this process exits between those writes, the next launch repeats the
    // full identity check instead of losing the handoff forever.
    fs::remove_file(&file)
        .map_err(|error| format!("could not clear completed relaunch state: {error}"))
}

fn pending_belongs_to_current_process(pending: &PendingRelaunch) -> bool {
    pending.requested_by_pid == std::process::id()
        && process_identity_matches(pending.requested_by_pid, pending.requested_by_started_at_ms)
            == ProcessIdentity::Same
}

fn read_pending_relaunch(file: &Path) -> Result<Option<PendingRelaunch>, String> {
    let raw = match fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not read pending update relaunch state: {error}"
            ))
        }
    };
    let pending: PendingRelaunch = serde_json::from_str(&raw)
        .map_err(|_| "pending update relaunch state is malformed".to_string())?;
    if pending.version != UPDATE_COORDINATOR_PROTOCOL
        || pending.nonce.trim().is_empty()
        || pending.lease_nonce.trim().is_empty()
        || pending.requested_by_pid == 0
        || pending.requested_by_started_at_ms == 0
    {
        return Err("pending update relaunch state is malformed".to_string());
    }
    validate_artifact_identity(&pending.expected)?;
    Ok(Some(pending))
}

fn validate_artifact_identity(identity: &ArtifactIdentity) -> Result<(), String> {
    let hash = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    if identity.version.trim().is_empty()
        || !hash(&identity.core_build_id)
        || !hash(&identity.shell_build_id)
        || identity.runtime_version.trim().is_empty()
        || !hash(&identity.runtime_sha256)
    {
        return Err("installed artifact identity is incomplete or malformed".to_string());
    }
    Ok(())
}

fn acquire_admission(file: &Path) -> Result<AdmissionGuard, String> {
    let directory = admission_directory(file);
    let owner = AdmissionOwner {
        version: UPDATE_COORDINATOR_PROTOCOL,
        pid: std::process::id(),
        process_started_at_ms: current_process_started_at_ms()?,
    };
    let candidate = PathBuf::from(format!(
        "{}.candidate-{}-{}",
        directory.to_string_lossy(),
        std::process::id(),
        now_nanos()?
    ));
    fs::create_dir(&candidate)
        .map_err(|error| format!("could not prepare the update admission owner: {error}"))?;
    if let Err(error) = write_new_json(&candidate.join("owner.json"), &owner) {
        let _ = fs::remove_dir_all(&candidate);
        return Err(error);
    }
    let deadline = Instant::now() + ADMISSION_WAIT;
    loop {
        match fs::rename(&candidate, &directory) {
            Ok(()) => {
                return Ok(AdmissionGuard {
                    directory,
                    coordinator: file.to_path_buf(),
                });
            }
            Err(_) if directory.exists() => {
                if reconcile_abandoned_admission(file).is_ok() && !directory.exists() {
                    continue;
                }
                if Instant::now() >= deadline {
                    let _ = fs::remove_dir_all(&candidate);
                    return Err(
                        "project work is still crossing the machine-wide update admission boundary"
                            .to_string(),
                    );
                }
                thread::sleep(ADMISSION_POLL);
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&candidate);
                return Err(format!(
                    "could not acquire the machine-wide update admission lock: {error}"
                ));
            }
        }
    }
}

fn reconcile_abandoned_admission(file: &Path) -> Result<(), String> {
    let directory = admission_directory(file);
    if !directory.exists() {
        return Ok(());
    }
    let owner_raw = match fs::read_to_string(directory.join("owner.json")) {
        Ok(value) => value,
        // A writer may have created the directory but not its identity yet.
        // Never clear that live race; the bounded caller will retry.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "could not inspect the update admission owner: {error}"
            ))
        }
    };
    let owner: AdmissionOwner = serde_json::from_str(&owner_raw)
        .map_err(|_| "the update admission owner is malformed; refusing to clear it".to_string())?;
    if owner.version != UPDATE_COORDINATOR_PROTOCOL {
        return Err("the update admission owner uses an unknown protocol".to_string());
    }
    if process_identity_matches(owner.pid, owner.process_started_at_ms)
        == ProcessIdentity::DeadOrReused
    {
        fs::remove_dir_all(&directory).map_err(|error| {
            format!("could not reconcile an abandoned update admission lock: {error}")
        })?;
    }
    Ok(())
}

fn admission_directory(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.admission", file.to_string_lossy()))
}

fn daemon_registry_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    coordinator_file(app).map(|file| file.with_file_name("project-daemons.json"))
}

fn pending_relaunch_file(lease_file: &Path) -> PathBuf {
    lease_file.with_file_name("pending-update-relaunch.json")
}

fn completed_relaunch_file(lease_file: &Path) -> PathBuf {
    lease_file.with_file_name("last-verified-update.json")
}

fn read_registered_projects(file: &Path) -> Result<Vec<PathBuf>, String> {
    let raw = match fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "could not read the machine-wide project registry: {error}"
            ))
        }
    };
    let encoded: Vec<String> = serde_json::from_str(&raw)
        .map_err(|_| "the machine-wide project registry is malformed".to_string())?;
    let mut projects: Vec<PathBuf> = Vec::with_capacity(encoded.len());
    for value in encoded {
        let path = PathBuf::from(&value);
        if !path.is_absolute() {
            return Err("the machine-wide project registry contains a relative path".to_string());
        }
        if path.exists() {
            let canonical = fs::canonicalize(&path)
                .map_err(|error| format!("could not resolve a registered project: {error}"))?;
            if !projects.iter().any(|known| same_path(known, &canonical)) {
                projects.push(canonical);
            }
        }
    }
    Ok(projects)
}

fn replace_json_atomically(path: &Path, value: &[PathBuf]) -> Result<(), String> {
    let encoded: Vec<String> = value
        .iter()
        .map(|entry| entry.to_string_lossy().into_owned())
        .collect();
    let bytes = serde_json::to_vec_pretty(&encoded)
        .map_err(|error| format!("could not encode the project registry: {error}"))?;
    crate::project::replace_file_atomically(path, &[&bytes[..], b"\n"].concat())
}

fn replace_json_value_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("could not encode update state: {error}"))?;
    crate::project::replace_file_atomically(path, &[&bytes[..], b"\n"].concat())
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn write_new_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create update state directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("could not encode update state: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("could not create update state atomically: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not commit update state: {error}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessIdentity {
    Same,
    DeadOrReused,
    Unknown,
}

fn process_identity_matches(pid: u32, expected_started_at_ms: u128) -> ProcessIdentity {
    let Some(actual) = process_started_at_ms(pid) else {
        return if process_is_definitively_dead(pid) {
            ProcessIdentity::DeadOrReused
        } else {
            ProcessIdentity::Unknown
        };
    };
    if actual.abs_diff(expected_started_at_ms) <= PROCESS_START_TOLERANCE_MS {
        ProcessIdentity::Same
    } else {
        ProcessIdentity::DeadOrReused
    }
}

fn current_process_started_at_ms() -> Result<u128, String> {
    process_started_at_ms(std::process::id())
        .ok_or_else(|| "could not establish this update process identity".to_string())
}

fn now_ms() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|_| "system clock predates the Unix epoch".to_string())
}

fn now_nanos() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| "system clock predates the Unix epoch".to_string())
}

#[cfg(windows)]
fn process_started_at_ms(pid: u32) -> Option<u128> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let empty = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut creation = empty;
        let mut exit = empty;
        let mut kernel = empty;
        let mut user = empty;
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        Some(u128::from(ticks.saturating_sub(116_444_736_000_000_000)) / 10_000)
    }
}

#[cfg(unix)]
fn process_started_at_ms(pid: u32) -> Option<u128> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(") ")?.1;
    let start_ticks: u64 = after_name.split_whitespace().nth(19)?.parse().ok()?;
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks_per_second <= 0 {
        return None;
    }
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let boot_seconds: u64 = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    Some(
        u128::from(boot_seconds) * 1_000
            + u128::from(start_ticks) * 1_000 / u128::try_from(ticks_per_second).ok()?,
    )
}

#[cfg(not(any(windows, unix)))]
fn process_started_at_ms(_pid: u32) -> Option<u128> {
    None
}

#[cfg(windows)]
fn process_is_definitively_dead(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !handle.is_null() {
            CloseHandle(handle);
            return false;
        }
        std::io::Error::last_os_error()
            .raw_os_error()
            .map(|code| code as u32)
            == Some(ERROR_INVALID_PARAMETER)
    }
}

#[cfg(unix)]
fn process_is_definitively_dead(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(any(windows, unix)))]
fn process_is_definitively_dead(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hivemind-update-lifecycle-{label}-{}-{}",
            std::process::id(),
            now_ms().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn lease_proves_every_project_idle_and_rechecks_before_handoff() {
        let root = fixture("all-projects");
        let file = root.join("lease.json");
        let projects = vec![root.join("one"), root.join("two")];
        let observed = std::sync::Mutex::new(Vec::new());
        let lease = acquire_update_lease(&file, &projects, |project| {
            observed.lock().unwrap().push(project.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(*observed.lock().unwrap(), projects);
        observed.lock().unwrap().clear();
        recheck_before_handoff(&file, &lease.nonce, &projects, |project| {
            observed.lock().unwrap().push(project.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(*observed.lock().unwrap(), projects);
        release_update_lease(&file, &lease.nonce).unwrap();
        assert!(!file.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_busy_project_refuses_the_machine_wide_lease() {
        let root = fixture("busy-project");
        let file = root.join("lease.json");
        let projects = vec![root.join("idle"), root.join("busy")];
        let result = acquire_update_lease(&file, &projects, |project| {
            if project.ends_with("busy") {
                Err("project owns work".to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(result.unwrap_err(), "project owns work");
        assert!(!file.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn admission_owner_is_complete_before_the_lock_becomes_visible() {
        let root = fixture("complete-admission-owner");
        let file = root.join("lease.json");
        {
            let guard = acquire_admission(&file).unwrap();
            let owner: AdmissionOwner = serde_json::from_str(
                &fs::read_to_string(admission_directory(&file).join("owner.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(owner.version, UPDATE_COORDINATOR_PROTOCOL);
            assert_eq!(owner.pid, std::process::id());
            assert_eq!(guard.coordinator_file(), file);
            let candidates: Vec<_> = fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".candidate-"))
                .collect();
            assert!(
                candidates.is_empty(),
                "admission candidate remained visible"
            );
        }
        assert!(!admission_directory(&file).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reused_pid_identity_is_reconciled_without_terminating_that_process() {
        let root = fixture("reused-pid");
        let file = root.join("lease.json");
        let record = UpdateLease {
            version: UPDATE_COORDINATOR_PROTOCOL,
            nonce: "stale".to_string(),
            owner_pid: std::process::id(),
            owner_started_at_ms: 1,
            acquired_at_ms: 1,
        };
        write_new_json(&file, &record).unwrap();
        assert!(read_live_lease(&file).unwrap().is_none());
        assert!(!file.exists());
        assert!(process_started_at_ms(std::process::id()).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abandoned_admission_is_reconciled_without_terminating_the_reused_pid() {
        let root = fixture("abandoned-admission");
        let file = root.join("lease.json");
        let directory = admission_directory(&file);
        fs::create_dir(&directory).unwrap();
        write_new_json(
            &directory.join("owner.json"),
            &AdmissionOwner {
                version: UPDATE_COORDINATOR_PROTOCOL,
                pid: std::process::id(),
                process_started_at_ms: 1,
            },
        )
        .unwrap();
        reconcile_abandoned_admission(&file).unwrap();
        assert!(!directory.exists());
        assert!(process_started_at_ms(std::process::id()).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_the_process_that_staged_the_handoff_defers_relaunch_reconciliation() {
        let mut pending = PendingRelaunch {
            version: UPDATE_COORDINATOR_PROTOCOL,
            nonce: "relaunch".to_string(),
            lease_nonce: "lease".to_string(),
            requested_by_pid: std::process::id(),
            requested_by_started_at_ms: current_process_started_at_ms().unwrap(),
            expected: ArtifactIdentity {
                version: "26.829.9999".to_string(),
                core_build_id: "a".repeat(64),
                shell_build_id: "b".repeat(64),
                runtime_version: "22.23.2".to_string(),
                runtime_sha256: "c".repeat(64),
            },
        };
        assert!(pending_belongs_to_current_process(&pending));
        pending.requested_by_pid = pending.requested_by_pid.saturating_add(1);
        assert!(!pending_belongs_to_current_process(&pending));
    }

    #[test]
    fn complete_identity_rejects_a_mixed_artifact() {
        let identity = ArtifactIdentity {
            version: "26.829.9999".to_string(),
            core_build_id: "a".repeat(64),
            shell_build_id: "b".repeat(64),
            runtime_version: "22.23.2".to_string(),
            runtime_sha256: "c".repeat(64),
        };
        assert!(validate_artifact_identity(&identity).is_ok());
        let mut mixed = identity.clone();
        mixed.core_build_id = "old-core".to_string();
        assert!(validate_artifact_identity(&mixed).is_err());
        assert_ne!(identity, mixed);
    }
}

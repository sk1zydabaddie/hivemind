/*!
 * Updating the app, without ever restarting into a new build while work is in
 * flight.
 *
 * ## Why this is Rust rather than the plugin's JavaScript API
 *
 * The JS API would put `check()`, `download()` and `install()` in the client,
 * and the install decision is a gate: it stops the app replacing itself while
 * agents are mid-run. A gate evaluated in React is a gate that can be reached
 * around by anything that can call the plugin, and the standing rule here is
 * that the client holds no authoritative state and no gate logic. So the three
 * steps are commands, the refusal is computed here, and the surface renders
 * what it is told.
 *
 * The build bar gates the same way in the client only, which is weaker. That is
 * tolerable there because it guards a convenience -- a developer rebuilding
 * their own checkout -- and this guards every installed copy.
 *
 * ## Never silently do nothing
 *
 * The failure that motivated this was running a four-hour-old build without
 * knowing. Silence read as up to date. So every outcome below is a named state
 * with a sentence, including the ones that are nobody's fault: the endpoint
 * being unreachable is a REPORTED state, not an absence of news.
 *
 * ## What check and download may do freely
 *
 * `check` and `download` touch nothing that is running. They are safe at any
 * time and are deliberately not gated -- gating them would mean a busy project
 * could not even discover that an update exists, which is the silence this
 * exists to remove. Only `install` replaces the running binary, and only
 * `install` asks whether the project is idle.
 */

use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

use crate::project::{daemon_work, canonical_git_root, DaemonWork};

/// What happened, as a state a surface can render without interpreting prose.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStanding {
    /// Checked, and this is the newest build.
    UpToDate { running: String },
    /// Checked, and there is a newer one.
    Available {
        running: String,
        offered: String,
        notes: Option<String>,
    },
    /// The endpoint could not be reached or did not answer usefully. NOT the
    /// same as up to date, and the whole point of naming it separately.
    Unreachable { running: String, detail: String },
}

/// Why an install was refused, or that it proceeded.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum InstallStanding {
    /// The app is about to be replaced and restarted.
    Installing { version: String },
    /// Work is in flight. Refused, with what was found.
    WorkInFlight { detail: String },
    /// Nothing to install.
    NothingOffered,
    /// It failed, and this is why.
    Failed { detail: String },
}

fn running_version(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/**
 * Ask the endpoint. Safe at any time.
 *
 * An unreachable endpoint returns `Unreachable` rather than an `Err`, because
 * an error would be rendered by the surface as a failure of the button rather
 * than as a fact about the update channel. They are different sentences and the
 * person needs the second one.
 */
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStanding, String> {
    let running = running_version(&app);
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return Ok(UpdateStanding::Unreachable {
                running,
                detail: format!("the updater is not configured in this build: {error}"),
            })
        }
    };
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStanding::Available {
            running,
            offered: update.version.clone(),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateStanding::UpToDate { running }),
        Err(error) => Ok(UpdateStanding::Unreachable {
            running,
            detail: format!("could not reach the update endpoint: {error}"),
        }),
    }
}

/**
 * Download and install, gated on the on-disk idleness proof.
 *
 * The gate is the same one the daemon restart and the build bar use, and it is
 * read from disk rather than asked of the daemon -- a daemon that has crashed
 * cannot answer, and "cannot answer" must not read as "nothing is running".
 * `Unknown` is treated as busy for that reason: the asymmetry the whole project
 * uses, where being wrong in one direction is unbounded.
 *
 * Download and install are one command on purpose. A downloaded-but-uninstalled
 * update is a third state to explain, and the thing a person asked for is a new
 * version rather than a file on disk.
 */
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<InstallStanding, String> {
    /* Idleness is a property of a PROJECT -- its reservations, its worktrees,
       its daemon. With no project open there is nothing that could be
       abandoned, so the gate has nothing to refuse. */
    if !project_path.is_empty() {
        let standing = match canonical_git_root(&project_path) {
            Ok(root) => daemon_work(&root),
            Err(fault) => {
                /* Could not even resolve the project. Refuse: this is the
                   `Unknown` case arriving one step earlier. */
                return Ok(InstallStanding::WorkInFlight {
                    detail: format!(
                        "could not check whether work is running ({}), so the update was not installed",
                        fault.message
                    ),
                });
            }
        };
        if !matches!(standing.work, DaemonWork::Idle) {
            return Ok(InstallStanding::WorkInFlight {
                detail: standing.detail,
            });
        }
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return Ok(InstallStanding::Failed {
                detail: format!("the updater is not configured in this build: {error}"),
            })
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return Ok(InstallStanding::NothingOffered),
        Err(error) => {
            return Ok(InstallStanding::Failed {
                detail: format!("could not reach the update endpoint: {error}"),
            })
        }
    };

    let version = update.version.clone();
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => Ok(InstallStanding::Installing { version }),
        Err(error) => Ok(InstallStanding::Failed {
            detail: format!("the update could not be installed: {error}"),
        }),
    }
}

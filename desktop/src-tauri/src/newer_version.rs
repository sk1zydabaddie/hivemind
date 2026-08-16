/*!
 * One question: is a newer version available, and can it be running instead?
 *
 * ## Why this file replaces three mechanisms
 *
 * The build bar, the daemon-restart button and the updater were each built to
 * patch the gap the previous one left. Each was verified in isolation and the
 * composed path had never once worked on a shipping build: opening the real
 * artifact showed an update error, a connection error and a box about a
 * "background process from the previous version" — three surfaces, two buttons,
 * and no route to a newer version at all.
 *
 * A person does not have a build bar problem or an updater problem. They have
 * one question, and it has one answer. So there is one command that answers it
 * and one that acts on it, and the difference between *a release exists* and
 * *your source is ahead* is an implementation detail of where the newer version
 * comes from.
 *
 * ## Two sources, one answer, best first
 *
 * 1. **A published release**, if the endpoint is reachable and offers a newer
 *    version. Works for anybody.
 * 2. **This machine's own source**, if the open project is Hivemind's checkout
 *    and it is ahead of the running binary. Only possible for somebody building
 *    from source, which today is everybody who has one.
 *
 * A failed remote check is not the headline when the local route can answer —
 * it becomes a detail. It is the headline only when nothing else can answer,
 * because a permanent unactionable error trains people to ignore the one
 * channel that matters.
 *
 * ## The daemon restart is not a third thing
 *
 * It is a consequence of having updated, never a decision. If a project's
 * daemon is from the old build and the project is provably idle, it is
 * restarted without asking. It surfaces only when it cannot be done silently —
 * work in flight, or the restart failed — and then it says what is running
 * rather than naming a background process.
 */

use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

use crate::project::{canonical_git_root, daemon_work, DaemonWork};
use crate::selfbuild::{build_and_install, source_standing, swap_log_path, swap_marker_path};

/// Where a newer version would come from, or why there is none.
#[derive(Debug, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum NewerVersion {
    /// An update was attempted and the running version is not the one it was
    /// for. The single most important thing this can say, because the previous
    /// behaviour was to reopen on the old build in silence.
    DidNotTake {
        running: String,
        attempted: String,
        detail: String,
    },
    /// Nothing newer anywhere that could be reached.
    None { running: String, checked: String },
    /// A published release is newer.
    Release { running: String, offered: String },
    /// The open project is Hivemind's source and is ahead of this binary.
    Source { running: String, detail: String },
    /// Nothing could be determined at all. Never rendered as up to date.
    Unknown { running: String, detail: String },
}

/// What happened when the update was taken.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateOutcome {
    /// Replaced and restarting. The app is about to go.
    Restarting { version: String },
    /// Refused: work would be abandoned.
    WorkInFlight { detail: String },
    /// Tried and failed, with the reason.
    Failed { detail: String },
}

fn running(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/**
 * Ask both sources and return the best answer.
 *
 * Never gated. A busy project must still be able to DISCOVER that a newer
 * version exists — refusing to look is the silence this replaced.
 */
#[tauri::command]
pub async fn newer_version(app: tauri::AppHandle, project_path: String) -> NewerVersion {
    let running = running(&app);

    /* First, before anything else: did the last attempt actually land? */
    if let Ok(attempted) = std::fs::read_to_string(swap_marker_path()) {
        let attempted = attempted.trim().to_string();
        if !attempted.is_empty() && attempted != running {
            let tail = std::fs::read_to_string(swap_log_path())
                .map(|log| {
                    log.lines()
                        .filter(|line| !line.trim().is_empty())
                        .rev()
                        .take(4)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_else(|_| "no installer log was written".to_string());
            return NewerVersion::DidNotTake {
                running,
                attempted,
                detail: tail,
            };
        }
        /* It landed. Clear the marker so it is reported once. */
        let _ = std::fs::remove_file(swap_marker_path());
    }

    /* The release, first, because it is the route that works for anybody. */
    let mut remote_detail = String::new();
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                return NewerVersion::Release {
                    running,
                    offered: update.version.clone(),
                }
            }
            Ok(None) => remote_detail = "no newer release is published".to_string(),
            Err(error) => remote_detail = format!("the release endpoint could not be reached ({error})"),
        },
        Err(error) => remote_detail = format!("this build has no updater configured ({error})"),
    }

    /* Then this machine's own source. */
    if !project_path.is_empty() {
        match source_standing(&app, &project_path).await {
            Ok(standing) if standing.is_own_source && standing.stale => {
                return NewerVersion::Source {
                    running,
                    detail: standing.detail,
                }
            }
            Ok(_) => {}
            Err(error) => {
                return NewerVersion::Unknown {
                    running,
                    detail: format!("{remote_detail}, and the source could not be read ({error})"),
                }
            }
        }
    }

    /* Nothing newer. If the remote could not be REACHED that is not the same
       as being current, and the distinction is kept rather than flattened. */
    if remote_detail.starts_with("no newer release") {
        NewerVersion::None {
            running,
            checked: remote_detail,
        }
    } else {
        NewerVersion::Unknown {
            running,
            detail: remote_detail,
        }
    }
}

/**
 * Take it, whichever route it came from.
 *
 * Gated on the on-disk idleness proof for both routes, because both end by
 * replacing the running binary. `Unknown` counts as busy: a daemon that cannot
 * answer must never read as one with nothing running.
 */
#[tauri::command]
pub async fn take_newer_version(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<UpdateOutcome, String> {
    if !project_path.is_empty() {
        match canonical_git_root(&project_path) {
            Ok(root) => {
                let standing = daemon_work(&root);
                if !matches!(standing.work, DaemonWork::Idle) {
                    return Ok(UpdateOutcome::WorkInFlight {
                        detail: standing.detail,
                    });
                }
            }
            Err(fault) => {
                return Ok(UpdateOutcome::WorkInFlight {
                    detail: format!(
                        "could not check whether work is running ({}), so nothing was replaced",
                        fault.message
                    ),
                })
            }
        }
    }

    /* A release, if one is offered. */
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            let version = update.version.clone();
            return match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => Ok(UpdateOutcome::Restarting { version }),
                Err(error) => Ok(UpdateOutcome::Failed {
                    detail: format!("the release could not be installed: {error}"),
                }),
            };
        }
    }

    /* Otherwise this machine's source. Long — a full build — and the surface
       says so before it starts. */
    if project_path.is_empty() {
        return Ok(UpdateOutcome::Failed {
            detail: "There is no newer version to take: no release is published and no project is open to build from.".to_string(),
        });
    }
    match build_and_install(app.clone(), project_path).await {
        Ok(version) => Ok(UpdateOutcome::Restarting { version }),
        Err(detail) => Ok(UpdateOutcome::Failed { detail }),
    }
}

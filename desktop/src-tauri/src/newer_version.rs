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
use tauri::ipc::Channel;
use tauri_plugin_updater::UpdaterExt;

use crate::project::{canonical_git_root, daemon_work, DaemonWork};
use crate::selfbuild::{
    build_and_install, install_built_and_restart, source_standing, swap_log_path, swap_marker_path,
};

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
    /// Nothing newer. `caveat` is set when one of the two sources could not be
    /// consulted but the other answered "current" -- the honest middle, which
    /// is neither news nor a fault and must not be dressed as either.
    None {
        running: String,
        caveat: Option<String>,
    },
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

/// Observable work, never an estimate.
///
/// A release exposes byte counts, so it may report a percentage when the
/// server supplies a total. A source build exposes ordered tool output but no
/// defensible total, so it reports only the stage named by that output. React
/// displays this stream; it does not infer or gate any of it.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateProgress {
    Stage { label: String },
    Download {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
}

pub(crate) fn report_progress(progress: &Channel<UpdateProgress>, update: UpdateProgress) {
    /* The app may close while the final message is in flight. Losing a display
       update must not turn a completed, verified install into a failed one. */
    let _ = progress.send(update);
}

fn running(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Calendar versions as comparable numbers: `26.817.944` -> `(26, 817, 944)`.
///
/// A missing or malformed part sorts lowest rather than erroring, because a
/// version this cannot parse must not be able to claim it is newer than one it
/// can.
fn version_parts(version: &str) -> (u32, u32, u32) {
    let mut parts = version.split('.').map(|part| {
        part.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Did the attempt land? True when the running version is the attempted one **or
/// newer**.
///
/// The first version of this asked `attempted != running`, which reports a
/// SUCCESS as a failure in one real case: a build installed by hand, or a later
/// version arriving by another route, leaves an older marker behind and the app
/// then insists an update did not take while running something newer than the
/// one it is complaining about. The marker records what was attempted, not a
/// version the app must be pinned to.
fn attempt_landed(attempted: &str, running: &str) -> bool {
    version_parts(running) >= version_parts(attempted)
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
        if !attempted.is_empty() && !attempt_landed(&attempted, &running) {
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
    let remote_detail = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                return NewerVersion::Release {
                    running,
                    offered: update.version.clone(),
                }
            }
            Ok(None) => "no newer release is published".to_string(),
            Err(error) => format!("the release endpoint could not be reached ({error})"),
        },
        Err(error) => format!("this build has no updater configured ({error})"),
    };

    /* Then this machine's own source. `answered` records that a source was
       actually consulted and said "not newer" -- distinct from never having
       been able to look, which is the whole point below. */
    let mut source_answered = false;
    if !project_path.is_empty() {
        match source_standing(&app, &project_path).await {
            Ok(standing) if standing.is_own_source && standing.stale => {
                return NewerVersion::Source {
                    running,
                    detail: standing.detail,
                }
            }
            Ok(standing) => source_answered = standing.is_own_source,
            Err(_) => source_answered = false,
        }
    }

    /* THREE STATES, THREE TREATMENTS, and the middle one is the common case.

       A machine with no release published sat permanently on a clay-toned
       "could not check for updates" -- a standing alarm about a non-problem,
       and a standing alarm is ignored within a week. But flattening it into
       "up to date" would be the opposite lie, because the remote genuinely was
       not reached.

       So the middle is its own answer: nothing newer, with the caveat attached
       rather than announced. Only when NEITHER source could answer is this
       actually broken. */
    let remote_answered = remote_detail.starts_with("no newer release");
    match (remote_answered, source_answered) {
        (true, _) => NewerVersion::None {
            running,
            caveat: Option::None,
        },
        (false, true) => NewerVersion::None {
            running,
            caveat: Some(remote_detail),
        },
        (false, false) => NewerVersion::Unknown {
            running,
            detail: remote_detail,
        },
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
    on_progress: Channel<UpdateProgress>,
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

    /* A RETRY, before either route.
     *
     * An attempt that did not take leaves a marker and, for the source route, an
     * installer that is still on disk. What failed was the swap -- the helper --
     * not the build, so rebuilding would spend minutes redoing the one part that
     * worked. This re-runs just the swap.
     *
     * This is the half that was missing: the surface reported the failure
     * honestly and then offered nothing, which is a dead end wearing a good
     * error message. A report a person cannot act on is only marginally better
     * than the silence it replaced. */
    if !project_path.is_empty() {
        if let Ok(attempted) = std::fs::read_to_string(swap_marker_path()) {
            let attempted = attempted.trim().to_string();
            if !attempted.is_empty() && !attempt_landed(&attempted, &running(&app)) {
                report_progress(
                    &on_progress,
                    UpdateProgress::Stage {
                        label: "Installing the finished build".to_string(),
                    },
                );
                return match install_built_and_restart(app.clone(), project_path.clone()).await {
                    Ok(()) => Ok(UpdateOutcome::Restarting { version: attempted }),
                    Err(detail) => Ok(UpdateOutcome::Failed {
                        detail: format!("the update could not be retried: {detail}"),
                    }),
                };
            }
        }
    }

    /* A release, if one is offered. */
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            let version = update.version.clone();
            report_progress(
                &on_progress,
                UpdateProgress::Stage {
                    label: "Downloading the release".to_string(),
                },
            );
            let download_progress = on_progress.clone();
            let install_progress = on_progress.clone();
            let mut downloaded_bytes = 0_u64;
            return match update
                .download_and_install(
                    move |chunk_bytes, total_bytes| {
                        downloaded_bytes = downloaded_bytes.saturating_add(chunk_bytes as u64);
                        report_progress(
                            &download_progress,
                            UpdateProgress::Download {
                                downloaded_bytes,
                                total_bytes,
                            },
                        );
                    },
                    move || {
                        report_progress(
                            &install_progress,
                            UpdateProgress::Stage {
                                label: "Installing the release".to_string(),
                            },
                        );
                    },
                )
                .await
            {
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
    match build_and_install(app.clone(), project_path, on_progress).await {
        Ok(version) => Ok(UpdateOutcome::Restarting { version }),
        Err(detail) => Ok(UpdateOutcome::Failed { detail }),
    }
}

#[cfg(test)]
mod tests {
    use super::{attempt_landed, version_parts};

    /* The marker records what was ATTEMPTED. Asking whether it equals the
       running version turns two successes into reported failures, and this app
       hits both: a build installed by hand while an older marker is still on
       disk, and a version arriving by the release route while a source attempt
       is outstanding. */
    #[test]
    fn an_attempt_landed_when_the_running_version_is_the_one_attempted() {
        assert!(attempt_landed("26.817.944", "26.817.944"));
    }

    #[test]
    fn an_attempt_landed_when_the_running_version_is_newer_still() {
        assert!(attempt_landed("26.817.944", "26.817.1013"));
        assert!(attempt_landed("26.817.944", "26.818.100"));
        assert!(attempt_landed("26.817.944", "27.101.1"));
    }

    #[test]
    fn an_attempt_did_not_land_when_the_running_version_is_older() {
        assert!(!attempt_landed("26.817.944", "26.816.1540"));
        assert!(!attempt_landed("26.817.944", "26.817.943"));
        assert!(!attempt_landed("27.101.1", "26.818.100"));
    }

    /* Numeric, not lexicographic. `944` vs `1013` is the case a string compare
       gets backwards, and the build number is minutes-since-midnight so it
       crosses that boundary every day after 16:53. */
    #[test]
    fn the_comparison_is_numeric_rather_than_lexicographic() {
        assert!(version_parts("26.817.1013") > version_parts("26.817.944"));
        assert!("26.817.1013" < "26.817.944", "a string compare disagrees, which is the point");
    }

    /* A version this cannot read must not be able to claim it is newer -- the
       safe direction is to report a failure that did not happen rather than to
       hide one that did. */
    #[test]
    fn an_unreadable_version_sorts_lowest() {
        assert_eq!(version_parts("nonsense"), (0, 0, 0));
        assert_eq!(version_parts(""), (0, 0, 0));
        assert!(!attempt_landed("26.817.944", "nonsense"));
    }

    /* Suffixes are tolerated: the replay harness reports `-replay`, and a
       pre-release tag on a real build must not read as version zero. */
    #[test]
    fn a_suffix_does_not_destroy_the_number() {
        assert_eq!(version_parts("26.816.1540-replay"), (26, 816, 1540));
        assert!(attempt_landed("26.816.1540", "26.816.1540-replay"));
    }
}

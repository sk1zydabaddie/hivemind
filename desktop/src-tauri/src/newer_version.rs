/*!
 * Read-only update discovery.
 *
 * The consumer previously exposed two installation authorities: a published
 * updater and a source checkout selected by substring. Neither shared a
 * machine-wide lease or a provenance verifier, and the source route could
 * execute an unrelated repository. Phase 0 deliberately removes both
 * installation routes. This command may report what the signed endpoint says;
 * it cannot download, install, build, restart, or publish anything.
 */

use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum NewerVersion {
    /// The configured endpoint answered and offered nothing newer.
    None { running: String },
    /// A published release is newer. This is information, not install authority.
    Release { running: String, offered: String },
    /// The endpoint could not answer. Never represented as "up to date".
    Unknown { running: String, detail: String },
}

fn running(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn newer_version(app: tauri::AppHandle) -> NewerVersion {
    let running = running(&app);
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => NewerVersion::Release {
                running,
                offered: update.version.clone(),
            },
            Ok(None) => NewerVersion::None { running },
            Err(error) => NewerVersion::Unknown {
                running,
                detail: format!("the release endpoint could not be reached ({error})"),
            },
        },
        Err(error) => NewerVersion::Unknown {
            running,
            detail: format!("this build has no updater configured ({error})"),
        },
    }
}

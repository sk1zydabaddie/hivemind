#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod newer_version;

use newer_version::newer_version;
use project::{
    choose_project_attachment_folder, choose_project_files, choose_project_folder, dismiss_hint,
    dismissed_hints, initialize_git, initialize_project, inspect_daemon_work,
    forget_project, inspect_git_readiness, last_project, recent_projects, remember_project,
    restart_daemon, select_project,
    workspace_action,
};

fn main() {
    tauri::Builder::default()
        /* Notifications exist for one reason: a run is minutes to hours, so a supervisor who has to
           keep the window open is not being supervised by the tool.

           A plugin, unlike the custom commands above, needs an ACL permission
           granted in `capabilities/`. That file is compiled in by
           `generate_context!` at build time -- which is exactly the shape that
           went wrong with `bundle.icon`: configured, and never reaching the
           artifact. `packaging.test.ts` asserts the capability exists and names
           the permission, so the wiring fails a test rather than failing
           silently on somebody's machine. */
        .plugin(tauri_plugin_notification::init())
        /* The webview cannot call the dialog plugin directly. One narrow custom
           command below opens a native folder picker and returns only the path
           the person chose; project validation and switching still go through
           `select_project`. This keeps browsing in the OS and authority in the
           existing shell boundary. */
        .plugin(tauri_plugin_dialog::init())
        /* The updater plugin is used for read-only discovery. Every webview
           updater command remains denied, and the custom command reports only
           whether the endpoint offers a newer version. Installation returns in
           a later phase after one global lease and one provenance verifier
           exist. */
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            newer_version,
            choose_project_attachment_folder,
            choose_project_files,
            choose_project_folder,
            dismiss_hint,
            dismissed_hints,
            initialize_git,
            initialize_project,
            inspect_daemon_work,
            inspect_git_readiness,
            restart_daemon,
            recent_projects,
            remember_project,
            last_project,
            forget_project,
            select_project,
            workspace_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

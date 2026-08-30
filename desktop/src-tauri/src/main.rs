#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod update_lifecycle;

use project::{
    choose_project_attachment_folder, choose_project_files, choose_project_folder, dismiss_hint,
    dismissed_hints, initialize_git, initialize_project, inspect_daemon_work,
    forget_project, inspect_git_readiness, last_project, recent_projects, remember_project,
    restart_daemon, select_project,
    workspace_action,
};
use update_lifecycle::{pending_update_relaunch, restart_after_update};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            update_lifecycle::reconcile_on_start(&app.handle().clone())?;
            Ok(())
        })
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
        .invoke_handler(tauri::generate_handler![
            choose_project_attachment_folder,
            choose_project_files,
            choose_project_folder,
            dismiss_hint,
            dismissed_hints,
            initialize_git,
            initialize_project,
            pending_update_relaunch,
            inspect_daemon_work,
            inspect_git_readiness,
            restart_daemon,
            restart_after_update,
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

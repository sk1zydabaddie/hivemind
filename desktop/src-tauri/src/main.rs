#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod selfbuild;
mod updater;

use selfbuild::{inspect_build_staleness, install_built_and_restart, rebuild_app};
use updater::{check_for_update, install_update};
use project::{
    dismiss_hint, dismissed_hints, initialize_git, initialize_project, inspect_daemon_work,
    inspect_git_readiness, recent_projects, remember_project, restart_daemon, select_project,
    workspace_action,
};

fn main() {
    tauri::Builder::default()
        /* Notifications are the one plugin this app takes, and it takes it for
           one reason: a run is minutes to hours, so a supervisor who has to
           keep the window open is not being supervised by the tool.

           A plugin, unlike the custom commands above, needs an ACL permission
           granted in `capabilities/`. That file is compiled in by
           `generate_context!` at build time -- which is exactly the shape that
           went wrong with `bundle.icon`: configured, and never reaching the
           artifact. `packaging.test.ts` asserts the capability exists and names
           the permission, so the wiring fails a test rather than failing
           silently on somebody's machine. */
        .plugin(tauri_plugin_notification::init())
        /* The updater. Its JS API is deliberately NOT used: install is a gate
           -- it refuses to replace the running binary while agents are mid-run
           -- and a gate evaluated in React is a gate anything calling the
           plugin can walk around. `updater.rs` holds the decision; the surface
           renders what it is told. */
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            check_for_update,
            install_update,
            inspect_build_staleness,
            install_built_and_restart,
            rebuild_app,
            dismiss_hint,
            dismissed_hints,
            initialize_git,
            initialize_project,
            inspect_daemon_work,
            inspect_git_readiness,
            restart_daemon,
            recent_projects,
            remember_project,
            select_project,
            workspace_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod selfbuild;

use selfbuild::{inspect_build_staleness, install_built_and_restart, rebuild_app};
use project::{
    dismiss_hint, dismissed_hints, initialize_git, initialize_project, inspect_git_readiness,
    recent_projects, remember_project, select_project, workspace_action,
};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            inspect_build_staleness,
            install_built_and_restart,
            rebuild_app,
            dismiss_hint,
            dismissed_hints,
            initialize_git,
            initialize_project,
            inspect_git_readiness,
            recent_projects,
            remember_project,
            select_project,
            workspace_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

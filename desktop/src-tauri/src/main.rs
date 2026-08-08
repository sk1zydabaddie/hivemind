#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;

use project::{initialize_project, select_project, workspace_action};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![initialize_project, select_project, workspace_action])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

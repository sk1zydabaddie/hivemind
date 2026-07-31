mod project;

use project::{select_project, workspace_action};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![select_project, workspace_action])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

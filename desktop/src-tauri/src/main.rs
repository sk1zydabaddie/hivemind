mod project;

use project::select_project;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![select_project])
        .run(tauri::generate_context!())
        .expect("failed to run Hivemind desktop monitor");
}

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"));
    let shell_build_id = query_shell_build_identity(&manifest_dir);
    println!("cargo:rustc-env=HIVEMIND_SHELL_BUILD_ID={shell_build_id}");
    for input in [
        "../src",
        "../index.html",
        "../package.json",
        "../package-lock.json",
        "../tsconfig.json",
        "../tsconfig.app.json",
        "../tsconfig.node.json",
        "../vite.config.ts",
        "src",
        "capabilities",
        "Cargo.toml",
        "Cargo.lock",
        "tauri.conf.json",
        "build.rs",
        "../../dist/src/build-identity.js",
        "../../dist/src/cli.js",
        "gen/shell-build-id.txt",
    ] {
        println!("cargo:rerun-if-changed={input}");
    }
    tauri_build::build()
}

fn query_shell_build_identity(manifest_dir: &Path) -> String {
    let configured_cli = std::env::var("HIVEMIND_CLI_PATH").ok().map(PathBuf::from);
    let cli = configured_cli.unwrap_or_else(|| {
        manifest_dir
            .join("..")
            .join("..")
            .join("dist")
            .join("src")
            .join("cli.js")
    });
    if !cli.is_file() {
        panic!("Hivemind Core CLI is required before building the desktop shell: run the root build first");
    }
    let output = if cli.extension().and_then(|value| value.to_str()) == Some("js") {
        Command::new(std::env::var("HIVEMIND_NODE_PATH").unwrap_or_else(|_| "node".to_string()))
            .arg(&cli)
            .arg("shell-build-id")
            .current_dir(manifest_dir)
            .output()
    } else {
        Command::new(&cli)
            .arg("shell-build-id")
            .current_dir(manifest_dir)
            .output()
    }
    .unwrap_or_else(|error| panic!("could not query Hivemind shell build identity: {error}"));
    if !output.status.success() {
        panic!(
            "Hivemind shell build identity command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let value = String::from_utf8(output.stdout)
        .expect("Hivemind shell build identity must be UTF-8")
        .trim()
        .to_string();
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        panic!("Hivemind Core returned an invalid shell build identity");
    }
    value
}

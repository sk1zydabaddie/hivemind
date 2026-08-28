import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const projectSource = path.resolve(
  import.meta.dirname,
  "..",
  "src-tauri",
  "src",
  "project.rs"
);

describe("release executable provenance", () => {
  test("release daemon startup resolves only the packaged Core entrypoint", async () => {
    const source = await readFile(projectSource, "utf8");
    const release = between(
      source,
      "#[cfg(not(debug_assertions))]\nfn daemon_command",
      "#[cfg(debug_assertions)]\nfn daemon_command"
    );

    expect(release).toContain("bundled_cli_path(resource_dir)");
    expect(release).toContain("command_for_bundled_cli_path");
    expect(release).not.toMatch(/std::env|HIVEMIND_|hidden_command\("hivemind"\)/u);
  });

  test("release shell identity comes from the packaged manifest", async () => {
    const source = await readFile(projectSource, "utf8");
    const release = between(
      source,
      "#[cfg(not(debug_assertions))]\nfn query_expected_shell_build_identity_for_runtime",
      "#[cfg(debug_assertions)]\nfn query_expected_shell_build_identity_for_runtime"
    );

    expect(release).toContain("packaged_shell_build_identity(resource_dir)");
    expect(release).not.toMatch(/query_cli|std::env|HIVEMIND_/u);
  });

  test("executable overrides exist only in debug-compiled functions", async () => {
    const source = await readFile(projectSource, "utf8");
    const debugDaemon = between(
      source,
      "#[cfg(debug_assertions)]\nfn daemon_command",
      "fn query_cli_build_identity"
    );
    const debugIdentity = between(
      source,
      "#[cfg(debug_assertions)]\nfn query_expected_shell_build_identity_for_runtime",
      "fn query_cli_identity"
    );
    const debugCommand = between(
      source,
      "#[cfg(debug_assertions)]\nfn command_for_development_cli_path",
      "#[cfg(windows)]\nfn node_compatible_path"
    );

    expect(debugDaemon).toContain('std::env::var("HIVEMIND_CLI_PATH")');
    expect(debugIdentity).toContain('std::env::var_os("HIVEMIND_CLI_PATH")');
    expect(debugCommand).toContain('std::env::var("HIVEMIND_NODE_PATH")');
    expect(source.match(/HIVEMIND_CLI_PATH/gu)).toHaveLength(3);
    expect(source.match(/HIVEMIND_NODE_PATH/gu)).toHaveLength(1);
  });
});

function between(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

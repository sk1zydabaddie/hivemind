import { describe, expect, test } from "vitest";

import {
  actionErrorAfterDurableProgress,
  createProjectSession,
  createProjectStreamGuard,
  displayProjectPath,
  projectNameFromPath,
  validateProjectConnection
} from "../src/lib/project-session";

describe("project-bound desktop session", () => {
  const buildId = "a".repeat(64);
  const shellBuildId = "b".repeat(64);
  test("a later selection wins and stale project state is never reconnected", async () => {
    const pending = new Map<
      string,
      (connection: Record<string, unknown>) => void
    >();
    const resets: string[] = [];
    const connections: string[] = [];
    const errors: string[] = [];
    const session = createProjectSession({
      initializeProject: (projectPath) => Promise.reject(new Error(`unexpected initialize ${projectPath}`)),
      selectProject: (projectPath) =>
        new Promise((resolve) => pending.set(projectPath, resolve)),
      onSwitchStart: () => resets.push("reset"),
      onConnected: (connection) => connections.push(connection.project_root),
      onError: (error) => errors.push(error.message)
    });

    const projectA = session.switchProject("A");
    const projectB = session.switchProject("B");
    pending.get("B")?.({
      project_root: "B",
      daemon_url: "http://127.0.0.1:41002",
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "attached"
    });
    expect((await projectB).ok).toBe(true);
    pending.get("A")?.({
      project_root: "A",
      daemon_url: "http://127.0.0.1:41001",
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "attached"
    });
    expect(await projectA).toEqual({ ok: false, stale: true });
    expect(resets).toHaveLength(2);
    expect(connections).toEqual(["B"]);
    expect(errors).toEqual([]);
  });

  test("connection validation accepts complete loopback project results only", () => {
    expect(
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "http://127.0.0.1:8765/",
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "started"
      })
    ).toEqual({
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765",
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "started"
    });
    expect(() =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "https://example.com",
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "attached"
      })
    ).toThrow(/non-loopback/u);
    expect(() =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "http://127.0.0.1:8765",
        build_id: "stale",
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "attached"
      })
    ).toThrow(/incomplete project connection/u);
    expect(() =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "http://127.0.0.1:8765",
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: "c".repeat(64),
        status: "attached"
      })
    ).toThrow(/Desktop update required/u);
  });

  test("queued callbacks from a prior project become invalid immediately", () => {
    const guard = createProjectStreamGuard();
    const projectA = guard.capture();
    expect(projectA()).toBe(true);
    guard.advance();
    const projectB = guard.capture();
    expect(projectA()).toBe(false);
    expect(projectB()).toBe(true);
  });

  test("project labels never expose Windows device prefixes", () => {
    expect(displayProjectPath("\\\\?\\C:\\Users\\ethan\\Projects\\Hivemind AI")).toBe(
      "C:\\Users\\ethan\\Projects\\Hivemind AI"
    );
    expect(displayProjectPath("\\\\?\\UNC\\server\\share\\Project")).toBe(
      "\\\\server\\share\\Project"
    );
    expect(projectNameFromPath("\\\\?\\C:\\Users\\ethan\\Projects\\Hivemind AI\\")).toBe(
      "Hivemind AI"
    );
  });

  test("durable progress clears recovered transport failures without hiding deterministic refusals", () => {
    expect(actionErrorAfterDurableProgress("daemon action response failed: A connection attempt failed")).toBe("");
    expect(actionErrorAfterDurableProgress("failed to fetch the daemon action response")).toBe("");
    expect(actionErrorAfterDurableProgress("integration refused: changed line 42 is not covered")).toBe(
      "integration refused: changed line 42 is not covered"
    );
  });
});

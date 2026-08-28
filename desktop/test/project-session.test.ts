import { describe, expect, test } from "vitest";

import {
  actionErrorAfterDurableProgress,
  createProjectSession,
  createProjectStreamGuard,
  displayProjectPath,
  projectNameFromPath,
  projectSelectionAccepted,
  projectStreamUrl,
  validateProjectConnection
} from "../src/lib/project-session";

describe("project-bound desktop session", () => {
  const buildId = "a".repeat(64);
  const shellBuildId = "b".repeat(64);
  const daemonToken = "d".repeat(43);
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
      daemon_token: daemonToken,
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "attached"
    });
    expect((await projectB).ok).toBe(true);
    pending.get("A")?.({
      project_root: "A",
      daemon_url: "http://127.0.0.1:41001",
      daemon_token: daemonToken,
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
        daemon_token: daemonToken,
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "started"
      })
    ).toEqual({
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765",
      daemon_token: daemonToken,
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "started"
    });
    expect(() =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "https://example.com",
        daemon_token: daemonToken,
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
        daemon_token: daemonToken,
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
        daemon_token: daemonToken,
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

  test("a completed Git preparation cannot reopen an older project after a newer selection", async () => {
    let finishPreparation!: () => void;
    const connected: string[] = [];
    const session = createProjectSession({
      initializeProject: async (projectPath) => ({
        project_root: projectPath,
        daemon_url: "http://127.0.0.1:41001",
        daemon_token: daemonToken,
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "attached"
      }),
      selectProject: async (projectPath) => ({
        project_root: projectPath,
        daemon_url: "http://127.0.0.1:41002",
        daemon_token: daemonToken,
        build_id: buildId,
        shell_build_id: shellBuildId,
        expected_shell_build_id: shellBuildId,
        status: "attached"
      }),
      onSwitchStart: () => undefined,
      onConnected: (connection) => connected.push(connection.project_root),
      onError: () => undefined
    });
    const preparing = session.prepareProject("A", () => new Promise<void>((resolve) => { finishPreparation = resolve; }));
    expect((await session.switchProject("B")).ok).toBe(true);
    finishPreparation();
    expect(await preparing).toEqual({ ok: false, stale: true });
    expect(connected).toEqual(["B"]);
  });

  test("a usable setup folder closes the chooser while a missing path remains editable", () => {
    expect(projectSelectionAccepted("not_a_git_repository", {
      exists: true,
      is_directory: true,
      is_repo: false,
      content: "source",
      saw: ["src/index.js"],
      starts_empty: false,
      would_commit: ["src/index.js"],
      would_ignore: [],
      refusal: null
    })).toBe(true);
    expect(projectSelectionAccepted("not_a_git_repository", {
      exists: false,
      is_directory: false,
      is_repo: false,
      starts_empty: false,
      would_commit: [],
      would_ignore: [],
      refusal: "The folder does not exist."
    })).toBe(false);
    expect(projectSelectionAccepted("not_initialized_for_hivemind", null)).toBe(true);
    expect(projectSelectionAccepted("unknown", null)).toBe(false);
  });

  test("stream credentials stay confined to the daemon's read-only stream routes", () => {
    const connection = validateProjectConnection({
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765",
      daemon_token: daemonToken,
      build_id: buildId,
      shell_build_id: shellBuildId,
      expected_shell_build_id: shellBuildId,
      status: "attached"
    });
    expect(projectStreamUrl(connection, "/events/stream")).toBe(
      `http://127.0.0.1:8765/events/stream?access_token=${daemonToken}`
    );
    expect(projectStreamUrl(connection, "/tasks/T-001/output/stream")).toBe(
      `http://127.0.0.1:8765/tasks/T-001/output/stream?access_token=${daemonToken}`
    );
    expect(() => projectStreamUrl(connection, "https://attacker.example/events/stream"))
      .toThrow(/invalid daemon stream path/u);
    expect(() => projectStreamUrl(connection, "/workspace/action"))
      .toThrow(/invalid daemon stream path/u);
    expect(() => projectStreamUrl(connection, "/events/stream?forward=true"))
      .toThrow(/invalid daemon stream path/u);
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

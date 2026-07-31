import { describe, expect, test } from "vitest";

import {
  createProjectSession,
  createProjectStreamGuard,
  validateProjectConnection
} from "../src/lib/project-session";

describe("project-bound desktop session", () => {
  test("a later selection wins and stale project state is never reconnected", async () => {
    const pending = new Map<
      string,
      (connection: Record<string, unknown>) => void
    >();
    const resets: string[] = [];
    const connections: string[] = [];
    const errors: string[] = [];
    const session = createProjectSession({
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
      status: "attached"
    });
    expect((await projectB).ok).toBe(true);
    pending.get("A")?.({
      project_root: "A",
      daemon_url: "http://127.0.0.1:41001",
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
        status: "started"
      })
    ).toEqual({
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765",
      status: "started"
    });
    expect(() =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "https://example.com",
        status: "attached"
      })
    ).toThrow(/non-loopback/u);
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
});

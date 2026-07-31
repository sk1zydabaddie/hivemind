import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createProjectSession,
  createProjectStreamGuard,
  validateProjectConnection
} from "../app/project-session.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");

test("a later project selection wins and stale project state is never reconnected", async () => {
  const pending = new Map();
  const resets = [];
  const connections = [];
  const errors = [];
  const session = createProjectSession({
    selectProject: (projectPath) => new Promise((resolve) => pending.set(projectPath, resolve)),
    onSwitchStart: () => resets.push("reset"),
    onConnected: (connection) => connections.push(connection),
    onError: (error) => errors.push(error.message)
  });

  const projectA = session.switchProject("A");
  const projectB = session.switchProject("B");
  pending.get("B")({
    project_root: "B",
    daemon_url: "http://127.0.0.1:41002",
    status: "attached"
  });
  assert.equal((await projectB).ok, true);
  pending.get("A")({
    project_root: "A",
    daemon_url: "http://127.0.0.1:41001",
    status: "attached"
  });
  assert.deepEqual(await projectA, { ok: false, stale: true });

  assert.equal(resets.length, 2);
  assert.deepEqual(connections.map((connection) => connection.project_root), ["B"]);
  assert.deepEqual(errors, []);
});

test("project connection validation accepts only complete loopback project-bound results", () => {
  assert.deepEqual(
    validateProjectConnection({
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765/",
      status: "started"
    }),
    {
      project_root: "D:\\Projects\\A",
      daemon_url: "http://127.0.0.1:8765",
      status: "started"
    }
  );
  assert.throws(
    () =>
      validateProjectConnection({
        project_root: "D:\\Projects\\A",
        daemon_url: "https://example.com",
        status: "attached"
      }),
    /non-loopback/u
  );
});

test("queued stream callbacks from a previous project become invalid immediately on switch", () => {
  const guard = createProjectStreamGuard();
  const projectA = guard.capture();
  assert.equal(projectA(), true);

  guard.advance();
  const projectB = guard.capture();
  assert.equal(projectA(), false);
  assert.equal(projectB(), true);
});

test("the renderer has no persisted or caller-supplied daemon URL and no daemon shutdown path", async () => {
  const source = await readFile(path.join(desktopRoot, "app", "main.mjs"), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|daemon-url|[?&]daemon=/u);
  assert.match(source, /invoke\("select_project", \{ projectPath \}\)/u);
  assert.doesNotMatch(source, /stop_daemon|kill_daemon|shutdown_daemon/u);
  assert.match(source, /beforeunload", closeStreams/u);
  assert.match(source, /streamGuard\.advance\(\)/u);
  assert.equal((source.match(/streamGuard\.capture\(\)/gu) ?? []).length, 2);
});

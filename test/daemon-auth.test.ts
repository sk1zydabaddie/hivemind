import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createDaemonServer, daemonCommand } from "../src/daemon.js";
import { createDaemonAuthToken } from "../src/daemon-auth.js";
import { callDaemonIfConfigured } from "../src/daemon-client.js";
import { readDaemonState } from "../src/daemon-state.js";
import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);
const fixtureToken = "A".repeat(43);

test("a credential-free workspace request is rejected before dispatcher execution", async () => {
  await withRepo(async (repo) => {
    const server = (createDaemonServer as unknown as (
      repoRoot: string,
      buildId: string,
      authToken: string
    ) => Server)(repo, "a".repeat(64), fixtureToken);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address !== "object") return;

    const marker = path.join(repo, "phase1-unauthenticated-action.txt");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/workspace/action`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://untrusted.example"
        },
        body: JSON.stringify({
          type: "checks.try",
          payload: {
            command: `node -e \"require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\"`
          }
        })
      });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        ok: false,
        reason: "daemon authentication required"
      });
      await assert.rejects(access(marker));
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

test("the credential and transport boundary cover health, streams, routes, origin, host, and content type", async () => {
  await withRepo(async (repo) => {
    const server = createDaemonServer(repo, "b".repeat(64), fixtureToken);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address !== "object") return;
    const base = `http://127.0.0.1:${address.port}`;
    const bearer = { authorization: `Bearer ${fixtureToken}` };

    try {
      const missingHealth = await fetch(`${base}/health`);
      assert.equal(missingHealth.status, 401);

      const wrongHealth = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${"W".repeat(43)}` }
      });
      assert.equal(wrongHealth.status, 401);
      assert.deepEqual(await wrongHealth.json(), {
        ok: false,
        reason: "daemon authentication required"
      });

      const malformedHealth = await fetch(`${base}/health`, {
        headers: { authorization: "Bearer short" }
      });
      assert.equal(malformedHealth.status, 401);

      const queryOnNonStream = await fetch(
        `${base}/health?access_token=${encodeURIComponent(fixtureToken)}`
      );
      assert.equal(queryOnNonStream.status, 401);

      const badHost = await rawHealth(base, "untrusted.example", bearer.authorization);
      assert.equal(badHost.status, 403);
      assert.match(badHost.body, /Host header/u);

      const badOrigin = await fetch(`${base}/health`, {
        headers: { ...bearer, origin: "https://untrusted.example" }
      });
      assert.equal(badOrigin.status, 403);
      assert.match(JSON.stringify(await badOrigin.json()), /Origin/u);

      const badContent = await fetch(`${base}/workspace/action`, {
        method: "POST",
        headers: { ...bearer, "content-type": "text/plain" },
        body: JSON.stringify({ type: "status.inspect", payload: {} })
      });
      assert.equal(badContent.status, 415);

      const allowed = await fetch(`${base}/workspace/action`, {
        method: "POST",
        headers: {
          ...bearer,
          "content-type": "application/json; charset=utf-8",
          origin: "http://tauri.localhost"
        },
        body: JSON.stringify({ type: "status.inspect", payload: {} })
      });
      assert.equal(allowed.status, 200);
      assert.equal((await allowed.json() as { ok?: unknown }).ok, true);

      const unknown = await fetch(`${base}/not-a-route`, { headers: bearer });
      assert.equal(unknown.status, 404);

      const missingStream = await fetch(`${base}/events/stream`);
      assert.equal(missingStream.status, 401);

      const duplicateStreamToken = await fetch(
        `${base}/events/stream?access_token=${fixtureToken}&access_token=${fixtureToken}`
      );
      assert.equal(duplicateStreamToken.status, 401);

      const controller = new AbortController();
      const stream = await fetch(
        `${base}/events/stream?access_token=${encodeURIComponent(fixtureToken)}`,
        {
          headers: { origin: "http://tauri.localhost" },
          signal: controller.signal
        }
      );
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/u);
      controller.abort();
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

test("a restarted daemon rejects the previous session credential", async () => {
  await withRepo(async (repo) => {
    const oldToken = "O".repeat(43);
    const currentToken = "N".repeat(43);
    const first = createDaemonServer(repo, "c".repeat(64), oldToken);
    first.listen(0, "127.0.0.1");
    await once(first, "listening");
    const address = first.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address !== "object") return;
    const port = address.port;
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${oldToken}` }
    })).status, 200);
    first.close();
    await once(first, "close");

    const second = createDaemonServer(repo, "d".repeat(64), currentToken);
    second.listen(port, "127.0.0.1");
    await once(second, "listening");
    try {
      assert.equal((await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${oldToken}` }
      })).status, 401);
      assert.equal((await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${currentToken}` }
      })).status, 200);
    } finally {
      second.close();
      await once(second, "close");
    }
  });
});

test("generated daemon credentials are fresh 256-bit base64url values", () => {
  const first = createDaemonAuthToken();
  const second = createDaemonAuthToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first, second);
});

test("Core refuses remote configured and discovered daemon addresses before transport", async () => {
  await withRepo(async (repo) => {
    const previousUrl = process.env.HIVEMIND_DAEMON_URL;
    const previousToken = process.env.HIVEMIND_DAEMON_TOKEN;
    process.env.HIVEMIND_DAEMON_URL = "http://example.com:4444";
    process.env.HIVEMIND_DAEMON_TOKEN = fixtureToken;
    try {
      const configured = await callDaemonIfConfigured(repo, "/workspace/action", {
        type: "status.inspect",
        payload: {}
      });
      assert.equal(configured.routed, true);
      assert.equal(configured.ok, false);
      if (!configured.routed || configured.ok) return;
      assert.match(configured.reason, /HTTP loopback address/u);
    } finally {
      if (previousUrl === undefined) delete process.env.HIVEMIND_DAEMON_URL;
      else process.env.HIVEMIND_DAEMON_URL = previousUrl;
      if (previousToken === undefined) delete process.env.HIVEMIND_DAEMON_TOKEN;
      else process.env.HIVEMIND_DAEMON_TOKEN = previousToken;
    }

    await writeFile(
      path.join(repo, ".hivemind", "daemon.json"),
      `${JSON.stringify({
        version: 2,
        pid: process.pid,
        url: "http://example.com:4444",
        repo_root: repo,
        auth_token: fixtureToken,
        started_at: new Date().toISOString()
      })}\n`
    );
    const discovered = await readDaemonState(repo);
    assert.equal(discovered.ok, false);
    if (discovered.ok) return;
    assert.match(discovered.reason, /HTTP loopback address/u);
  });
});

test("the daemon CLI refuses non-loopback binding before startup", async () => {
  await withRepo(async (repo) => {
    assert.equal(await daemonCommand(repo, ["--host", "0.0.0.0"]), 1);
  });
});

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-daemon-auth-"));
  try {
    await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
      windowsHide: true
    });
    await execFileAsync("git", ["config", "user.name", "Hivemind Test"], {
      cwd: repo,
      windowsHide: true
    });
    await writeFile(path.join(repo, "README.md"), "# Daemon authentication fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo, windowsHide: true });
    assert.equal(await initProject(repo), 0);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function rawHealth(
  base: string,
  host: string,
  authorization: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/health`, {
      headers: { authorization, host }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

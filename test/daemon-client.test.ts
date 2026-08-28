import assert from "node:assert/strict";
import test from "node:test";
import { currentBuildIdentity } from "../src/build-identity.js";
import { callDaemonIfConfigured } from "../src/daemon-client.js";

test("daemon client preserves nested fetch causes instead of collapsing them to fetch failed", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HIVEMIND_DAEMON_URL;
  const originalToken = process.env.HIVEMIND_DAEMON_TOKEN;
  const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  const failure = new TypeError("fetch failed") as TypeError & { cause?: unknown };
  failure.cause = cause;
  globalThis.fetch = (async () => {
    throw failure;
  }) as typeof fetch;
  process.env.HIVEMIND_DAEMON_URL = "http://127.0.0.1:65535";
  process.env.HIVEMIND_DAEMON_TOKEN = "T".repeat(43);

  try {
    const result = await callDaemonIfConfigured(process.cwd(), "/status", {});
    assert.equal(result.routed, true);
    assert.equal(result.ok, false);
    if (!result.routed || result.ok) {
      return;
    }
    assert.match(result.reason, /daemon request failed: fetch failed/u);
    assert.match(result.reason, /Headers Timeout Error/u);
    assert.match(result.reason, /UND_ERR_HEADERS_TIMEOUT/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.HIVEMIND_DAEMON_URL;
    } else {
      process.env.HIVEMIND_DAEMON_URL = originalUrl;
    }
    if (originalToken === undefined) delete process.env.HIVEMIND_DAEMON_TOKEN;
    else process.env.HIVEMIND_DAEMON_TOKEN = originalToken;
  }
});

test("daemon client refuses a live daemon from a different Core build before mutation", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HIVEMIND_DAEMON_URL;
  const originalToken = process.env.HIVEMIND_DAEMON_TOKEN;
  const calls: string[] = [];
  process.env.HIVEMIND_DAEMON_URL = "http://127.0.0.1:65535";
  process.env.HIVEMIND_DAEMON_TOKEN = "T".repeat(43);
  globalThis.fetch = (async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"T".repeat(43)}`);
    return new Response(JSON.stringify({
      ok: true,
      repo_root: process.cwd(),
      build_id: "0".repeat(64)
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    assert.notEqual(await currentBuildIdentity(), "0".repeat(64));
    const result = await callDaemonIfConfigured(process.cwd(), "/lease/request-contract", { task_id: "T-001" });
    assert.equal(result.routed, true);
    assert.equal(result.ok, false);
    if (result.routed && !result.ok) assert.match(result.reason, /daemon build mismatch/u);
    assert.deepEqual(calls, ["http://127.0.0.1:65535/health"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.HIVEMIND_DAEMON_URL;
    else process.env.HIVEMIND_DAEMON_URL = originalUrl;
    if (originalToken === undefined) delete process.env.HIVEMIND_DAEMON_TOKEN;
    else process.env.HIVEMIND_DAEMON_TOKEN = originalToken;
  }
});

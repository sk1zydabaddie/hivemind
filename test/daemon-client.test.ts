import assert from "node:assert/strict";
import test from "node:test";
import { callDaemonIfConfigured } from "../src/daemon-client.js";

test("daemon client preserves nested fetch causes instead of collapsing them to fetch failed", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HIVEMIND_DAEMON_URL;
  const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  const failure = new TypeError("fetch failed") as TypeError & { cause?: unknown };
  failure.cause = cause;
  globalThis.fetch = (async () => {
    throw failure;
  }) as typeof fetch;
  process.env.HIVEMIND_DAEMON_URL = "http://127.0.0.1:65535";

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
  }
});

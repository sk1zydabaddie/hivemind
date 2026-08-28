import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectProviderAuthentication,
  parseAuthenticationStatus
} from "../src/provider-auth-status.js";

test("provider login-status parsers keep malformed output distinct from sign-out", () => {
  assert.equal(parseAuthenticationStatus("codex-cli", "login-text", "Logged in using ChatGPT\n").status, "signed_in");
  assert.equal(parseAuthenticationStatus("codex-cli", "login-text", "Not logged in\n").status, "signed_out");
  assert.equal(parseAuthenticationStatus("claude", "logged-in-json", '{"loggedIn":true,"email":"private@example.test"}').status, "signed_in");
  assert.equal(parseAuthenticationStatus("claude", "logged-in-json", '{"loggedIn":false}').status, "signed_out");
  assert.equal(parseAuthenticationStatus("opencode", "credential-count", "— 2 credentials\n").status, "signed_in");
  assert.equal(parseAuthenticationStatus("opencode", "credential-count", "— 0 credentials\n").status, "signed_out");
  assert.equal(parseAuthenticationStatus("codex-cli", "login-text", "something changed upstream").status, "malformed");
  assert.equal(parseAuthenticationStatus("claude", "logged-in-json", "not json").status, "malformed");
});

test("authentication inspection never returns raw provider account output", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-provider-auth-test-"));
  try {
    const view = await inspectProviderAuthentication(repo, {
      availability: async () => true,
      runner: async (spec) => {
        if (spec.kind === "logged-in-json") {
          return {
            ok: true,
            stdout: '{"loggedIn":true,"email":"private@example.test","orgName":"Private Org"}',
            stderr: "",
            reason: null
          };
        }
        if (spec.kind === "login-text") {
          return { ok: true, stdout: "", stderr: "Logged in using ChatGPT", reason: null };
        }
        return { ok: true, stdout: "— 0 credentials", stderr: "", reason: null };
      }
    });
    assert.equal(view.providers.find((entry) => entry.provider_id === "codex-cli")?.status, "signed_in");
    assert.equal(view.providers.find((entry) => entry.provider_id === "claude")?.status, "signed_in");
    assert.equal(view.providers.find((entry) => entry.provider_id === "opencode")?.status, "signed_out");
    assert.equal(view.providers.find((entry) => entry.provider_id === "grok")?.status, "unverifiable");
    assert.equal(view.providers.find((entry) => entry.provider_id === "kimi")?.status, "unverifiable");
    assert.equal(JSON.stringify(view).includes("private@example.test"), false);
    assert.equal(JSON.stringify(view).includes("Private Org"), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("missing provider executables are detected before the wrapper status command", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-provider-auth-test-"));
  try {
    let statusCalls = 0;
    const view = await inspectProviderAuthentication(repo, {
      availability: async (command) => command !== (process.platform === "win32" ? "codex.cmd" : "codex"),
      runner: async () => {
        statusCalls += 1;
        return { ok: true, stdout: "Logged in", stderr: "", reason: null };
      }
    });
    const codex = view.providers.find((entry) => entry.provider_id === "codex-cli");
    assert.equal(codex?.status, "missing");
    assert.equal(codex?.installed, false);
    assert.equal(statusCalls, 2, "the missing provider reached the cmd.exe wrapper status process");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectProviderAuthentication,
  parseAuthenticationStatus,
  providerCommandAvailable
} from "../src/provider-auth-status.js";
import {
  PROVIDER_AUTHENTICATION_STATUS_SPECS,
  providerAuthentication
} from "../src/agent-catalogue.js";

test("provider login-status parsers keep malformed output distinct from sign-out", () => {
  assert.equal(parseAuthenticationStatus("codex-cli", "login-text", "Logged in using ChatGPT\n").status, "signed_in");
  assert.equal(parseAuthenticationStatus("codex-cli", "login-text", "Not logged in\n").status, "signed_out");
  assert.equal(parseAuthenticationStatus("claude", "logged-in-json", '{"loggedIn":true,"email":"private@example.test"}').status, "signed_in");
  assert.equal(parseAuthenticationStatus("claude", "logged-in-json", '{"loggedIn":false}').status, "signed_out");
  assert.equal(parseAuthenticationStatus("opencode", "credential-count", "— 2 credentials\n").status, "signed_in");
  assert.equal(parseAuthenticationStatus("opencode", "credential-count", "— 0 credentials\n").status, "signed_out");
  assert.equal(
    parseAuthenticationStatus(
      "grok",
      "headed-model-list",
      "You are not authenticated.\nDefault model: grok-4.6\nAvailable models:\n  grok-4.6\n"
    ).status,
    "signed_out",
    "the explicit signed-out marker wins over the cached model catalogue"
  );
  assert.equal(
    parseAuthenticationStatus("grok", "headed-model-list", "Default model: grok-4.6\nAvailable models:\n  grok-4.6\n").status,
    "signed_in"
  );
  assert.equal(parseAuthenticationStatus("grok", "headed-model-list", "grok-4.6\n").status, "malformed");
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
        if (spec.kind === "credential-count") {
          return { ok: true, stdout: "— 0 credentials", stderr: "", reason: null };
        }
        return { ok: true, stdout: "You are not authenticated.\nDefault model: grok-4.6\nAvailable models:\n  grok-4.6", stderr: "", reason: null };
      }
    });
    assert.equal(view.providers.find((entry) => entry.provider_id === "codex-cli")?.status, "signed_in");
    assert.equal(view.providers.find((entry) => entry.provider_id === "claude")?.status, "signed_in");
    assert.equal(view.providers.find((entry) => entry.provider_id === "opencode")?.status, "signed_out");
    assert.equal(view.providers.find((entry) => entry.provider_id === "grok")?.status, "signed_out");
    assert.equal(view.providers.some((entry) => entry.provider_id === "kimi"), false);
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
      availability: async (command) => command !== "codex",
      runner: async () => {
        statusCalls += 1;
        return { ok: true, stdout: "Logged in", stderr: "", reason: null };
      }
    });
    const codex = view.providers.find((entry) => entry.provider_id === "codex-cli");
    assert.equal(codex?.status, "missing");
    assert.equal(codex?.installed, false);
    assert.equal(statusCalls, 3, "only the missing provider skips its status process");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("Windows provider commands accept either vendor executables or package-manager shims", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows PATHEXT behaviour");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-provider-command-test-"));
  const bin = path.join(root, "bin");
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, "codex.exe"), "fixture", "utf8");
    assert.equal(await providerCommandAvailable("codex", { env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" } }), true);
    assert.equal(await providerCommandAvailable("codex.cmd", { env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" } }), false);
    assert.equal(providerAuthentication("codex-cli")?.command[0], "codex");
    assert.equal(PROVIDER_AUTHENTICATION_STATUS_SPECS["codex-cli"]?.invocation.includes("codex"), true);
    assert.equal(PROVIDER_AUTHENTICATION_STATUS_SPECS["codex-cli"]?.invocation.includes("codex.cmd"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

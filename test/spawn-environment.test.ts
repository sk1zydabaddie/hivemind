import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REFUSED_ENVIRONMENT,
  keepsAuthentication,
  refusedEnvironmentNames,
  spawnEnvironment,
  withProviderExecutablePath
} from "../src/spawn-environment.js";

/* The variable that made this necessary. `CLAUDE_CONFIG_DIR` relocates Claude
   Code's whole configuration directory -- settings, hooks and credentials
   together. Measured: pointed at an empty directory the CLI answers "Not logged
   in", so it really does move everything. Left in a shell, it would send a
   worker to a configuration that was never probed and never hashed. */
test("a config-relocating variable does not reach the worker", () => {
  const built = spawnEnvironment({
    PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "/somewhere/else",
    CODEX_HOME: "/elsewhere",
    XDG_CONFIG_HOME: "/nope"
  });
  assert.equal(built.PATH, "/usr/bin");
  assert.equal(built.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(built.CODEX_HOME, undefined);
  assert.equal(built.XDG_CONFIG_HOME, undefined);
});

/* Observed, not imagined: this exact set was present in a shell that happened
   to be inside a Claude Code session, and starting an app from a terminal is
   ordinary. `CLAUDE_EFFORT` is the sharp one -- it changes the reasoning effort
   of a worker whose profile never asked for any. */
test("a parent harness session does not configure the worker it starts", () => {
  const inherited = {
    CLAUDECODE: "1",
    CLAUDE_EFFORT: "high",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_EXECPATH: "C:/claude.exe",
    CLAUDE_PID: "23600"
  };
  const built = spawnEnvironment(inherited);
  assert.deepEqual(Object.keys(built), []);
  assert.deepEqual(refusedEnvironmentNames(inherited).length, 6);
});

/* The line this must not cross. Hivemind holds no provider credential, and the
   promise is that whatever authentication a harness uses stays with the
   harness. Stripping a secret would break somebody's agent with an error that
   points nowhere -- so the refusal removes CONTROL and never removes auth. */
test("nothing that looks like a credential is ever stripped", () => {
  const built = spawnEnvironment({
    ANTHROPIC_API_KEY: "sk-test",
    OPENAI_API_KEY: "sk-test",
    CODEX_HOME_TOKEN: "keep-me",
    GH_TOKEN: "keep-me"
  });
  assert.equal(built.ANTHROPIC_API_KEY, "sk-test");
  assert.equal(built.OPENAI_API_KEY, "sk-test");
  assert.equal(built.GH_TOKEN, "keep-me");
  for (const name of ["API_KEY", "AUTH_TOKEN", "MY_SECRET", "DB_PASSWORD", "X_CREDENTIAL"]) {
    assert.ok(keepsAuthentication(name), `${name} must read as authentication`);
  }
});

/* Hivemind's own choice is the reason the home variables are refused at all:
   an account is a decision recorded in the project, and it has to beat a
   leftover in somebody's shell rather than lose to it. */
test("the account Hivemind chose wins over the one that was inherited", () => {
  const built = spawnEnvironment(
    { CLAUDE_CONFIG_DIR: "/from/the/shell", PATH: "/usr/bin" },
    { CLAUDE_CONFIG_DIR: "/chosen/by/hivemind" }
  );
  assert.equal(built.CLAUDE_CONFIG_DIR, "/chosen/by/hivemind");
  assert.equal(built.PATH, "/usr/bin");
});

/* A process needs far more environment than is comfortable to enumerate, and
   getting an allowlist wrong fails as `spawn ENOENT` on somebody else's
   machine rather than loudly here. So this removes a known few and keeps the
   rest -- and that choice is asserted, so it cannot drift into an allowlist by
   accident. */
test("everything not named is kept", () => {
  const inherited = {
    PATH: "/usr/bin",
    SystemRoot: "C:/Windows",
    TEMP: "/tmp",
    APPDATA: "C:/Users/x/AppData/Roaming",
    LANG: "en_US.UTF-8",
    HOME: "/home/x"
  };
  assert.deepEqual(spawnEnvironment(inherited), inherited);
  assert.deepEqual(refusedEnvironmentNames(inherited), []);
});

/* Changing somebody's environment silently is the same surprise as writing a
   file into their repository silently. */
test("what was dropped can be reported", () => {
  const names = refusedEnvironmentNames({ CLAUDE_EFFORT: "high", PATH: "/usr/bin" });
  assert.deepEqual(names, ["CLAUDE_EFFORT"]);
  assert.ok(REFUSED_ENVIRONMENT.includes("CLAUDE_CONFIG_DIR"));
});

test("a Windows desktop launch discovers documented provider bins and Codex Desktop", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows install layout");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-provider-path-test-"));
  const appData = path.join(root, "AppData", "Roaming");
  const localAppData = path.join(root, "AppData", "Local");
  const grokBin = path.join(root, ".grok", "bin");
  const kimiBin = path.join(root, ".kimi-code", "bin");
  const nvmLink = path.join(root, "nvm", "nodejs");
  const codexBin = path.join(localAppData, "OpenAI", "Codex", "bin", "release-hash");
  try {
    for (const directory of [path.join(appData, "npm"), grokBin, kimiBin, nvmLink, codexBin]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(path.join(codexBin, "codex.exe"), "fixture", "utf8");
    const built = withProviderExecutablePath({
      PATH: "C:\\Windows\\System32",
      USERPROFILE: root,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      NVM_SYMLINK: nvmLink
    });
    const directories = built.PATH?.split(";") ?? [];
    assert.equal(directories[0], "C:\\Windows\\System32", "the person's existing command wins");
    assert.ok(directories.includes(path.join(appData, "npm")));
    assert.ok(directories.includes(grokBin));
    assert.ok(directories.includes(kimiBin));
    assert.ok(directories.includes(nvmLink));
    assert.ok(directories.includes(codexBin));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

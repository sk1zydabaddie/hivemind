import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { ACCOUNT_HOME_VARIABLES, agentCatalogue } from "../src/agent-catalogue.js";
import {
  accountEnvironment,
  accountEnvironmentForTool,
  accountHomeVariable,
  addAccount,
  isCredentialVariable,
  readAccounts,
  selectAccount,
  selectedAccount
} from "../src/provider-accounts.js";
import { parseProviderQuota } from "../src/adapter.js";
import { connectAdapter } from "../src/config-actions.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/* Switching which account a provider runs as.
 *
 * The promise that has to hold under test is narrow and absolute: **Hivemind
 * never carries a credential.** An account is a directory the harness itself
 * owns, and selecting one sets exactly one allowlisted variable pointing at it.
 * Most of what follows asserts what CANNOT happen.
 */

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "provider-accounts",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
      await initProject(repo);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-provider-accounts-test-"
  );
}

/** A directory standing in for one of a harness's own homes. */
async function fakeHome(repo: string, name: string): Promise<string> {
  const dir = path.join(repo, "..", `home-${name}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("an account is a directory the harness owns, and selecting one points at it", async () => {
  await withRepo(async (repo) => {
    const work = await fakeHome(repo, "work");
    const added = await addAccount(repo, { label: "work", harness: "codex-cli", home_dir: work });
    assert.equal(added.ok, true);

    const file = await readAccounts(repo);
    assert.equal(file.accounts.length, 1);
    assert.equal(selectedAccount(file, "codex-cli"), null, "an account was selected without anyone choosing");

    if (!added.ok) return;
    const selected = await selectAccount(repo, added.value.id);
    assert.equal(selected.ok, true);

    /* Resolved by HARNESS here, directly, because no role is connected in this
       fixture. The role path -- which is what production uses -- has its own
       test below. */
    assert.deepEqual(accountEnvironment(selectedAccount(await readAccounts(repo), "codex-cli")), {
      CODEX_HOME: path.resolve(work)
    });
  });
});

test("the first connection probe runs under the selected account before a record exists", async () => {
  await withRepo(async (repo) => {
    const home = await fakeHome(repo, "first-connect");
    const added = await addAccount(repo, { label: "first connect", harness: "codex-cli", home_dir: home });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal((await selectAccount(repo, added.value.id)).ok, true);

    let observed: Record<string, string> | undefined;
    const connected = await connectAdapter(repo, "worker", "codex-terra", {
      runner: async ({ accountEnv }) => {
        observed = accountEnv;
        return {
          ok: true,
          reason: null,
          stdout: '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
          stderr: "",
          exitCode: 0,
          timedOut: false,
          wallTimeMs: 10,
          effectiveTokens: 12,
          wroteNonceFile: true
        };
      },
      readback: async () => ({
        source: "fixture",
        model: "gpt-5.6-terra",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        workspaceRoots: [repo],
        subagents: "none"
      })
    });
    assert.equal(connected.ok, true);
    assert.deepEqual(observed, { CODEX_HOME: path.resolve(home) });
  });
});

test("the environment carries one directory variable and nothing else, ever", async () => {
  /* The whole promise, asserted at the function that produces what a process
     will run with. A second variable here is a credential channel. */
  const env = accountEnvironment({
    id: "A-1",
    label: "work",
    harness: "codex-cli",
    home_dir: "/tmp/home",
    added_at: "2026-08-13T00:00:00.000Z"
  });
  assert.deepEqual(Object.keys(env), ["CODEX_HOME"]);

  /* A harness Hivemind cannot point anywhere contributes nothing rather than
     guessing a variable name. */
  assert.deepEqual(
    accountEnvironment({
      id: "A-2",
      label: "x",
      harness: "some-other-agent",
      home_dir: "/tmp/home",
      added_at: "2026-08-13T00:00:00.000Z"
    }),
    {}
  );
});

test("no credential-shaped variable can be reached, by allowlist or by name", async () => {
  /* Both halves of the guard, because either alone is one careless edit from
     gone. These names sit in the same binaries as the ones on the allowlist. */
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "OPENCODE_AUTH_CONTENT",
    "GITHUB_TOKEN",
    "SOME_SERVICE_SECRET",
    "DB_PASSWORD",
    "AWS_CREDENTIALS"
  ]) {
    assert.equal(isCredentialVariable(name), true, `${name} was not recognised as a credential`);
  }
  for (const name of Object.values(ACCOUNT_HOME_VARIABLES)) {
    assert.equal(isCredentialVariable(name), false, `${name} was mistaken for a credential`);
  }

  /* And the allowlist is exactly the three measured variables -- not a shape
     that a config file could widen. */
  assert.deepEqual(Object.keys(ACCOUNT_HOME_VARIABLES).sort(), ["claude", "codex-cli", "grok", "kimi", "opencode"]);
  assert.equal(accountHomeVariable("codex-cli"), "CODEX_HOME");
  assert.equal(accountHomeVariable("claude"), "CLAUDE_CONFIG_DIR");
  assert.equal(accountHomeVariable("opencode"), "OPENCODE_CONFIG_DIR");
  assert.equal(accountHomeVariable("grok"), "GROK_HOME");
  assert.equal(accountHomeVariable("kimi"), "KIMI_CODE_HOME");
});

test("the spawn re-checks the environment rather than trusting its caller", async () => {
  /* `safeAccountEnvironment` is the last point before a variable reaches a
     provider process. Asserted at the source because the alternative is
     spawning a real provider to prove a negative. */
  const source = await readFile(path.resolve("src/adapter.ts"), "utf8");
  assert.match(source, /function safeAccountEnvironment/u);
  assert.match(source, /allowed\.has\(key\)\s*\|\|\s*isCredentialVariable\(key\)/u);
  /* Resolved once inside runAdapterProcess, so no call site can forget it. */
  assert.match(source, /accountEnvironmentForTool\(repoRoot, profile\.tool\)/u);
});

test("what is registered is validated as a directory, and nothing is read inside it", async () => {
  await withRepo(async (repo) => {
    const missing = await addAccount(repo, {
      label: "gone",
      harness: "codex-cli",
      home_dir: path.join(repo, "does-not-exist")
    });
    assert.equal(missing.ok, false);

    const file = path.join(repo, "README.md");
    const notDirectory = await addAccount(repo, { label: "file", harness: "codex-cli", home_dir: file });
    assert.equal(notDirectory.ok, false);

    const unknown = await addAccount(repo, {
      label: "x",
      harness: "some-other-agent",
      home_dir: await fakeHome(repo, "other")
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.reason, /does not know how to select an account/u);

    /* An EMPTY directory is accepted. Hivemind does not look inside to check
       for a login, because looking inside is the thing it promised not to do;
       a home with no credential fails at the harness's own auth step, with the
       harness's own message, which is where that failure belongs. */
    const empty = await addAccount(repo, {
      label: "empty",
      harness: "codex-cli",
      home_dir: await fakeHome(repo, "empty")
    });
    assert.equal(empty.ok, true);
  });
});

test("switching accounts invalidates the capability verification for that harness", async () => {
  await withRepo(async (repo) => {
    /* A connected role, recorded the way `adapter.connect` records one. */
    const dir = path.join(repo, ".hivemind", "adapters");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "worker.profile.json"),
      /* tool IS the role, as every real profile is written. */
      JSON.stringify({
        tool: "worker",
        invoke: ["codex", "exec"],
        prompt_arg: "stdin",
        verified_on: "2026-08-13",
        context_window: 200000
      })
    );
    await writeFile(
      path.join(dir, "worker.connection.json"),
      JSON.stringify({
        agent_id: "codex-terra",
        connected_at: "2026-08-13T00:00:00.000Z",
        effective_tokens: 1000,
        readback_source: "stream",
        provider_version: "0.147.0",
        capabilities: [{ id: "reports_usage", status: "verified" }],
        capabilities_stale: null
      })
    );

    const work = await addAccount(repo, {
      label: "work",
      harness: "codex-cli",
      home_dir: await fakeHome(repo, "sw-work")
    });
    const personal = await addAccount(repo, {
      label: "personal",
      harness: "codex-cli",
      home_dir: await fakeHome(repo, "sw-personal")
    });
    assert.equal(work.ok && personal.ok, true);
    if (!work.ok || !personal.ok) return;

    await executeWorkspaceAction(repo, {
      type: "accounts.select",
      payload: { account_id: work.value.id }
    });
    const afterFirst = JSON.parse(
      await readFile(path.join(dir, "worker.connection.json"), "utf8")
    ) as { capabilities_stale: string | null };
    assert.equal(afterFirst.capabilities_stale, "account_changed");

    /* The reason it is invalidated at all: the probe measured the tool, the
       profile AND the account. A different plan can change which models can be
       pinned and whether usage is reported, so the recorded verification no
       longer describes what would run. */
    const switched = await executeWorkspaceAction(repo, {
      type: "accounts.select",
      payload: { account_id: personal.value.id }
    });
    assert.equal(switched.ok, true);
    if (switched.ok) {
      const value = switched.value as { roles: { account: { label: string } | null }[] };
      assert.equal(value.roles.find((entry) => entry.account !== null)?.account?.label, "personal");
    }

    /* And the capabilities are kept, not deleted: the previous measurement is
       still the best description of the TOOL, it just no longer refers to the
       account in use. "Measured, but not for what is running now." */
    const record = JSON.parse(await readFile(path.join(dir, "worker.connection.json"), "utf8")) as {
      capabilities: unknown[];
    };
    assert.equal(record.capabilities.length, 1);
  });
});

test("the account actions are shaped, and carry no authority", async () => {
  await withRepo(async (repo) => {
    const extra = await executeWorkspaceAction(repo, {
      type: "accounts.inspect",
      payload: { harness: "codex-cli" }
    });
    assert.equal(extra.ok, false);

    for (const field of ["approved", "human", "force", "authorized"]) {
      const crafted = await executeWorkspaceAction(repo, {
        type: "accounts.select",
        [field]: true,
        payload: { account_id: "A-1" }
      });
      assert.equal(crafted.ok, false);
      if (!crafted.ok) assert.match(crafted.reason, /cannot supply authority field/u);
    }

    const unknown = await executeWorkspaceAction(repo, {
      type: "accounts.select",
      payload: { account_id: "A-nope" }
    });
    assert.equal(unknown.ok, false);

    /* Not vacuous: the read really does work. */
    const inspected = await executeWorkspaceAction(repo, { type: "accounts.inspect", payload: {} });
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      const value = inspected.value as { switchable: Record<string, string> };
      assert.equal(value.switchable["codex-cli"], "CODEX_HOME");
    }
  });
});

/* ── What a provider says is left ──────────────────────────────────────────
 *
 * Field names read out of the shipped codex.exe on 2026-08-13: a
 * `RateLimitWindow` of used_percent / window_minutes / resets_at, under a
 * `rate_limits` key on its token-count event.
 */
test("a provider's own quota snapshot is read where it reports one", () => {
  const line = JSON.stringify({
    type: "token_count",
    info: { total_token_usage: { total_tokens: 1234 } },
    rate_limits: {
      planType: "pro",
      primary: { used_percent: 82.5, window_minutes: 300, resets_at: "2026-08-13T18:00:00Z" },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: "2026-08-19T00:00:00Z" }
    }
  });
  const quota = parseProviderQuota("codex-jsonl", `{"type":"other"}\n${line}\n`);
  assert.notEqual(quota, null);
  assert.equal(quota?.plan, "pro");
  assert.equal(quota?.windows.length, 2);
  assert.equal(quota?.windows[0]?.used_percent, 82.5);
  assert.equal(quota?.windows[0]?.resets_at, "2026-08-13T18:00:00Z");
});

test("the newest snapshot wins, because an earlier one describes a state that has passed", () => {
  const older = JSON.stringify({ rate_limits: { primary: { used_percent: 10 } } });
  const newer = JSON.stringify({ rate_limits: { primary: { used_percent: 91 } } });
  const quota = parseProviderQuota("codex-jsonl", `${older}\n${newer}\n`);
  assert.equal(quota?.windows[0]?.used_percent, 91);
});

test("a provider that reports no quota returns nothing, rather than a confident zero", () => {
  /* The measured negative: the shipped claude.exe carries no rate-limit field
     at all -- its only RATE_LIMITED strings belong to the QUIC stack. Null and
     "0% used" are different facts and must not collapse. */
  assert.equal(parseProviderQuota("claude-json", '{"type":"result","usage":{}}\n'), null);
  assert.equal(parseProviderQuota("codex-jsonl", "not json at all\n"), null);
  assert.equal(parseProviderQuota("codex-jsonl", '{"rate_limits":{}}\n'), null);
});

/* The bug the fixtures hid.
 *
 * A profile's `tool` is the ROLE -- `worker.profile.json` carries
 * `tool: "worker"` -- because Core resolves adapters by the name callers send
 * and callers send the role. Every earlier test here wrote `tool: "codex"`, a
 * shape no real profile has, so the role-to-harness lookup was never exercised
 * and the account was silently never applied. `adapter-probe.test.ts` caught it
 * only because it builds its profile the way the product does.
 */
test("an account resolves through the ROLE, the way a real profile is shaped", async () => {
  await withRepo(async (repo) => {
    const dir = path.join(repo, ".hivemind", "adapters");
    await mkdir(dir, { recursive: true });

    /* Exactly what `buildProfileForAgent` writes: tool IS the role. */
    await writeFile(
      path.join(dir, "worker.profile.json"),
      JSON.stringify({
        tool: "worker",
        invoke: ["codex", "exec"],
        prompt_arg: "stdin",
        verified_on: "2026-08-14",
        context_window: 200000
      })
    );
    /* And the connection names the catalogue agent, which is the only thing
       that knows the harness. */
    await writeFile(
      path.join(dir, "worker.connection.json"),
      JSON.stringify({
        agent_id: "codex-terra",
        connected_at: "2026-08-14T00:00:00.000Z",
        capabilities: [{ id: "reports_usage", status: "verified" }],
        capabilities_stale: null
      })
    );

    const home = await fakeHome(repo, "role-resolved");
    const added = await addAccount(repo, { label: "work", harness: "codex-cli", home_dir: home });
    assert.equal(added.ok, true, "codex-cli is the catalogue harness name");
    if (!added.ok) return;
    await selectAccount(repo, added.value.id);

    /* Resolved from the ROLE, as `runAdapterProcess` does. Before the fix this
       returned {} and no account was ever applied in production. */
    const env = await accountEnvironmentForTool(repo, "worker");
    assert.deepEqual(env, { CODEX_HOME: path.resolve(home) });
  });
});

test("the account variables are keyed by the names the catalogue actually uses", () => {
  /* The other half of the same bug: the map was keyed `codex`, and no catalogue
     agent has that harness. A key nothing can match is a feature that silently
     does nothing. */
  const harnesses = new Set(agentCatalogue.map((agent) => agent.harness));
  for (const key of Object.keys(ACCOUNT_HOME_VARIABLES)) {
    assert.ok(
      harnesses.has(key),
      `${key} is not a harness any catalogue agent declares, so nothing can ever match it`
    );
  }
});

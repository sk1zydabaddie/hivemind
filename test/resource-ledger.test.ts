import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import {
  checkTokenBudgetPreflight,
  readQuotaLedger,
  recordQuotaUsage,
  type QuotaLedger
} from "../src/resource-ledger.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

test("quota ledger reads empty when missing and records self-metered usage atomically", async () => {
  await withTempRepo(async ({ repo }) => {
    const empty = await readQuotaLedger(repo);
    assert.equal(empty.ok, true);
    if (!empty.ok) {
      return;
    }
    assert.deepEqual(empty.value, {});

    const first = await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "12345678",
      model_output_text: "1234",
      wall_time_ms: 25,
      throttled: false
    });
    assert.equal(first.ok, true);
    const second = await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "1234",
      model_output_text: "",
      wall_time_ms: 75,
      throttled: false
    });
    assert.equal(second.ok, true);

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.source, "dual-channel");
    assert.deepEqual(ledger.value.fake.self_measured, {
      requests: 2,
      input_tokens_estimated: 3,
      output_tokens_estimated: 1,
      wall_time_ms: 100
    });
    assert.equal(ledger.value.fake.provider_reported, null);
    assert.deepEqual(ledger.value.fake.reconciliation, {
      self_measured_tokens_for_reported_requests: 0,
      provider_reported_total_tokens: null,
      absolute_divergence_tokens: null,
      provider_to_self_ratio: null,
      accounting_source: "self_measured",
      routing_source: "profile_policy"
    });
    assert.equal(ledger.value.fake.observed_limit, null);
    assert.equal(await exists(path.join(repo, ".hivemind", "resource", "ledger.json")), true);
  });
});

test("quota ledger records provider usage and visible estimate reconciliation without requiring it", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await recordQuotaUsage(repo, {
      provider: "codex",
      input_text: "12345678",
      model_output_text: "1234",
      wall_time_ms: 25,
      throttled: false,
      provider_reported: {
        input_tokens: 8,
        cached_input_tokens: 2,
        output_tokens: 10,
        reasoning_tokens: 7,
        total_tokens: 18
      }
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.value.provider_reported, {
      reports: 1,
      input_tokens: 8,
      cached_input_tokens: 2,
      output_tokens: 10,
      reasoning_tokens: 7,
      total_tokens: 18,
      self_measured_tokens_for_reported_requests: 3
    });
    assert.deepEqual(result.value.reconciliation, {
      self_measured_tokens_for_reported_requests: 3,
      provider_reported_total_tokens: 18,
      absolute_divergence_tokens: 15,
      provider_to_self_ratio: 6,
      accounting_source: "provider_reported",
      routing_source: "profile_policy"
    });
  });
});

test("run token ceiling records usage then stops on provider-reported effective tokens", async () => {
  await withTempRepo(async ({ repo }) => {
    await setResourcePolicy(repo, { run_ceiling: { tokens: 10 } });

    const result = await recordQuotaUsage(repo, {
      provider: "codex",
      input_text: "small prompt",
      model_output_text: "small output",
      wall_time_ms: 25,
      throttled: false,
      provider_usage: {
        status: "captured",
        parser: "codex-jsonl",
        usage: {
          input_tokens: 8,
          cached_input_tokens: 0,
          output_tokens: 12,
          reasoning_tokens: 7,
          total_tokens: 20
        }
      }
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.budget_exceeded, true);
    assert.match(result.reason, /used 20 effective tokens against run ceiling 10/);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.codex.last_request?.effective_tokens, 20);
    assert.equal(ledger.value.codex.last_request?.accounting_source, "provider_reported");
  });
});

test("run token ceiling falls back to self-measured tokens when provider usage is unavailable", async () => {
  await withTempRepo(async ({ repo }) => {
    await setResourcePolicy(repo, { run_ceiling: { tokens: 2 } });

    const result = await recordQuotaUsage(repo, {
      provider: "opaque-provider",
      input_text: "12345678",
      model_output_text: "1234",
      wall_time_ms: 1,
      throttled: false,
      provider_usage: {
        status: "not_available",
        parser: null,
        reason: "provider exposes no usage record"
      }
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.budget_exceeded, true);
    assert.match(result.reason, /used 3 effective tokens against run ceiling 2/);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value["opaque-provider"].last_request?.effective_tokens, 3);
    assert.equal(ledger.value["opaque-provider"].last_request?.accounting_source, "self_measured");
  });
});

test("manager session token ceiling aggregates providers and refuses the next call after exhaustion", async () => {
  await withTempRepo(async ({ repo }) => {
    await setResourcePolicy(repo, { session_ceiling: { tokens: 10 } });
    const sessionId = "session-budget-test";

    const first = await recordQuotaUsage(repo, {
      provider: "codex",
      input_text: "one",
      model_output_text: "two",
      wall_time_ms: 1,
      throttled: false,
      session_id: sessionId,
      provider_usage: {
        status: "captured",
        parser: "codex-jsonl",
        usage: {
          input_tokens: 2,
          cached_input_tokens: 0,
          output_tokens: 4,
          reasoning_tokens: 2,
          total_tokens: 6
        }
      }
    });
    assert.equal(first.ok, true);

    const second = await recordQuotaUsage(repo, {
      provider: "claude",
      input_text: "three",
      model_output_text: "four",
      wall_time_ms: 1,
      throttled: false,
      session_id: sessionId,
      provider_usage: {
        status: "captured",
        parser: "claude-json",
        usage: {
          input_tokens: 2,
          cached_input_tokens: 0,
          output_tokens: 4,
          reasoning_tokens: null,
          total_tokens: 6
        }
      }
    });
    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.equal(second.budget_exceeded, true);
    assert.match(second.reason, /used 12 effective tokens against ceiling 10/);

    const preflight = await checkTokenBudgetPreflight(repo, "codex", sessionId);
    assert.equal(preflight.ok, false);
    if (preflight.ok) {
      return;
    }
    assert.match(preflight.reason, /used 12 effective tokens with 0 estimated input tokens against ceiling 10/);
  });
});

test("provider usage capture state distinguishes not available from expected but unparseable", async () => {
  await withTempRepo(async ({ repo }) => {
    const unavailable = await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "",
      model_output_text: "",
      wall_time_ms: 1,
      throttled: false,
      provider_usage: {
        status: "not_available",
        parser: null,
        reason: "no supported usage channel"
      }
    });
    assert.equal(unavailable.ok, true);

    const unparseable = await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "",
      model_output_text: "",
      wall_time_ms: 1,
      throttled: false,
      provider_usage: {
        status: "expected_but_unparseable",
        parser: "codex-jsonl",
        reason: "missing usage object"
      }
    });
    assert.equal(unparseable.ok, false);
    if (unparseable.ok) {
      return;
    }
    assert.match(unparseable.reason, /expected but unparseable/);

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.provider_usage_capture.not_available_requests, 1);
    assert.equal(ledger.value.fake.provider_usage_capture.expected_but_unparseable_requests, 1);
    assert.equal(ledger.value.fake.provider_usage_capture.last_status, "expected_but_unparseable");
  });
});

test("quota ledger reads legacy self-metered entries through the dual-channel fallback", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, ".hivemind", "resource"), { recursive: true });
    await writeFile(
      path.join(repo, ".hivemind", "resource", "ledger.json"),
      `${JSON.stringify({
        fake: {
          used: {
            requests: 1,
            input_tokens_estimated: 4,
            output_tokens_estimated: 2,
            wall_time_ms: 10
          },
          observed_limit: null,
          resets_at: null,
          source: "self-metered",
          updated_at: "2026-07-27T00:00:00.000Z",
          unmetered: false
        }
      })}\n`
    );

    const ledger = await readQuotaLedger(repo);

    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.deepEqual(ledger.value.fake.self_measured, {
      requests: 1,
      input_tokens_estimated: 4,
      output_tokens_estimated: 2,
      wall_time_ms: 10
    });
    assert.equal(ledger.value.fake.provider_reported, null);
    assert.equal(ledger.value.fake.source, "dual-channel");
    assert.equal(ledger.value.fake.reconciliation.accounting_source, "self_measured");
  });
});

test("quota ledger serializes concurrent self-metered usage records", async () => {
  await withTempRepo(async ({ repo }) => {
    const attempts = 20;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        recordQuotaUsage(repo, {
          provider: "fake",
          input_text: `input ${index}`,
          model_output_text: `output ${index}`,
          wall_time_ms: 1,
          throttled: false
        })
      )
    );

    assert.equal(results.every((result) => result.ok), true);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.self_measured.requests, attempts);
    assert.equal(ledger.value.fake.self_measured.wall_time_ms, attempts);
  });
});

test("quota ledger serializes writers forced to contend behind one lock", async () => {
  await withTempRepo(async ({ repo }) => {
    const lockPath = path.join(repo, ".hivemind", "resource", "ledger.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    const heldLock = await open(lockPath, "wx");
    await heldLock.writeFile("test-held-lock\n", "utf8");

    try {
      const attempts = 20;
      let settled = 0;
      const resultsPromise = Promise.all(
        Array.from({ length: attempts }, (_, index) =>
          recordQuotaUsage(repo, {
            provider: "fake",
            input_text: `barrier input ${index}`,
            model_output_text: `barrier output ${index}`,
            wall_time_ms: 1,
            throttled: false
          }).finally(() => {
            settled += 1;
          })
        )
      );

      await sleep(100);
      assert.equal(settled, 0);

      await heldLock.close();
      await rm(lockPath, { force: true });

      const results = await resultsPromise;
      assert.equal(results.every((result) => result.ok), true);
      const ledger = await readQuotaLedger(repo);
      assert.equal(ledger.ok, true);
      if (!ledger.ok) {
        return;
      }
      assert.equal(ledger.value.fake.self_measured.requests, attempts);
      assert.equal(ledger.value.fake.self_measured.wall_time_ms, attempts);
    } finally {
      await heldLock.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  });
});

test("quota ledger lock timeout fails loudly without recording usage", async () => {
  await withTempRepo(async ({ repo }) => {
    const lockPath = path.join(repo, ".hivemind", "resource", "ledger.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    const heldLock = await open(lockPath, "wx");
    await heldLock.writeFile("test-held-lock\n", "utf8");

    try {
      const result = await recordQuotaUsage(repo, {
        provider: "fake",
        input_text: "blocked input",
        model_output_text: "blocked output",
        wall_time_ms: 1,
        throttled: false
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.match(result.reason, /could not acquire quota ledger lock/);

      const ledger = await readQuotaLedger(repo);
      assert.equal(ledger.ok, true);
      if (!ledger.ok) {
        return;
      }
      assert.deepEqual(ledger.value, {});
    } finally {
      await heldLock.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  });
});

test("quota ledger fails closed for malformed state and marks local providers unmetered", async () => {
  await withTempRepo(async ({ repo }) => {
    const local = await recordQuotaUsage(repo, {
      provider: "local",
      input_text: "local prompt",
      model_output_text: "local output",
      wall_time_ms: 1,
      throttled: false
    });
    assert.equal(local.ok, true);
    if (!local.ok) {
      return;
    }
    assert.equal(local.value.unmetered, true);

    await writeFile(path.join(repo, ".hivemind", "resource", "ledger.json"), "{\"fake\":{\"used\":1}}\n");
    const result = await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "prompt",
      model_output_text: "output",
      wall_time_ms: 1,
      throttled: false
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /must be a JSON object|must be self-metered|must be an ISO timestamp/);
  });
});

test("quota CLI and daemon route return the current ledger", async () => {
  await withTempRepo(async ({ repo }) => {
    await recordQuotaUsage(repo, {
      provider: "fake",
      input_text: "prompt",
      model_output_text: "output",
      wall_time_ms: 10,
      throttled: false
    });

    const direct = await execFileAsync(process.execPath, [cliPath, "quota", "status"], { cwd: repo, windowsHide: true });
    const directLedger = JSON.parse(direct.stdout) as QuotaLedger;
    assert.equal(direct.stderr, "");
    assert.equal(directLedger.fake.self_measured.requests, 1);

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "quota", "status"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: daemon.url },
        windowsHide: true
      });
      assert.deepEqual(JSON.parse(routed.stdout), directLedger);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("quota CLI rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "quota"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /usage: hivemind quota status/);
        return true;
      }
    );
  });
});

async function withTempRepo(run: (context: { repo: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-resource-ledger-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function setResourcePolicy(repo: string, resourcePolicy: Record<string, unknown>): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({ ...config, resource_policy: resourcePolicy }, null, 2)}\n`);
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url };
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    daemon.child.once("exit", () => resolve());
    daemon.child.kill();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(stdout.slice(0, newline).trim());
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before ready with code ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { callDaemonIfConfigured } from "../src/daemon-client.js";
import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { checkWriteIntent } from "../src/intent.js";
import { readActiveLeases, requestLeaseForContract } from "../src/lease.js";
import { appendTaskOutput, readTaskOutput } from "../src/output-stream.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";
import { ratifyPlanForExistingTask } from "./support/ratified-plan.js";
import { withTemplateRepo } from "./support/fixture-repo.js";
import { stopChildProcess } from "./support/child-process.js";
import { setProjectConfig } from "../src/config-actions.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
  repoRoot: string;
  authToken: string;
}

test("failed startup stops its daemon before releasing the fixture", async () => {
  await withTempRepo(async ({ repo }) => {
    let failedChild: ChildProcessWithoutNullStreams | undefined;
    try {
      await assert.rejects(startDaemon(repo, undefined, async (child) => {
        failedChild = child;
        await readLine(child);
        throw new Error("injected startup failure");
      }), /injected startup failure/);
      assert.ok(failedChild?.pid);
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${failedChild.pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
        assert.equal(stdout.split(/\r?\n/u).some((line) => new RegExp(`^\"[^\"]*\",\"${failedChild!.pid}\"(?:,|$)`, "u").test(line)), false);
      } else {
        assert.throws(() => process.kill(failedChild!.pid!, 0), { code: "ESRCH" });
      }
    } finally {
      if (failedChild) await stopChildProcess(failedChild);
    }
  });
});

test("a coded daemon failure survives the HTTP round trip", async () => {
  await withTempRepo(async ({ repo }) => {
    const daemon = await startDaemon(repo);
    const originalUrl = process.env.HIVEMIND_DAEMON_URL;
    process.env.HIVEMIND_DAEMON_URL = daemon.url;
    try {
      const result = await callDaemonIfConfigured(repo, "/integrate/shadow", {});

      assert.equal(result.routed, true);
      assert.equal(result.ok, false);
      if (!result.routed || result.ok) return;
      assert.equal(result.code, "integration_queue_not_found");
    } finally {
      if (originalUrl === undefined) delete process.env.HIVEMIND_DAEMON_URL;
      else process.env.HIVEMIND_DAEMON_URL = originalUrl;
      await stopDaemon(daemon);
    }
  });
});

test("daemon serializes idempotent concurrent lease requests and re-reads committed state after restart", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    let daemon = await startDaemon(repo);
    try {
      const [first, second] = await Promise.allSettled([
        execCli(repo, daemon.url, ["lease", "T-001"]),
        execCli(repo, daemon.url, ["lease", "T-001"])
      ]);
      const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
      assert.equal(fulfilled.length, 2);

      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (!store.ok) {
        return;
      }
      assert.equal(Object.keys(store.store).length, 1);
      assert.equal(store.store["README.md"], "T-001");
    } finally {
      await stopDaemon(daemon);
    }

    daemon = await startDaemon(repo);
    try {
      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (!store.ok) {
        return;
      }
      assert.equal(store.store["README.md"], "T-001");
      await execCli(repo, daemon.url, ["lease", "T-001", "--release"]);
      const granted = await execCli(repo, daemon.url, ["lease", "T-001"]);
      const parsed = JSON.parse(granted.stdout) as { task_id: string; granted: string[] };
      assert.equal(parsed.task_id, "T-001");
      assert.deepEqual(parsed.granted, ["README.md"]);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("lease command falls back to direct single-writer mode without a daemon URL", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    const result = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });

    const parsed = JSON.parse(result.stdout) as { task_id: string; granted: string[] };
    assert.equal(parsed.task_id, "T-001");
    assert.deepEqual(parsed.granted, ["README.md"]);
  });
});

test("lease command discovers a live daemon without HIVEMIND_DAEMON_URL before falling back to direct mode", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { task_id: string; granted: string[] };
      assert.equal(parsed.task_id, "T-001");
      assert.deepEqual(parsed.granted, ["README.md"]);
    } finally {
      await stopDaemon(daemon);
    }

    await writeFile(path.join(repo, ".hivemind", "daemon.json"), JSON.stringify({
      version: 2,
      pid: 99999999,
      url: "http://127.0.0.1:1",
      repo_root: repo,
      auth_token: "D".repeat(43),
      started_at: new Date().toISOString()
    }));
    const released = await execFileAsync(process.execPath, [cliPath, "lease", "T-001", "--release"], {
      cwd: repo,
      env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
      windowsHide: true
    });
    assert.equal(JSON.parse(released.stdout).task_id, "T-001");

    const direct = await execFileAsync(process.execPath, [cliPath, "lease", "T-001"], {
      cwd: repo,
      env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
      windowsHide: true
    });
    assert.equal(JSON.parse(direct.stdout).task_id, "T-001");
  });
});

test("lease command rejects a daemon for a different repo before mutating", async () => {
  await withTempRepo(async ({ repo: daemonRepo }) => {
    await withTempRepo(async ({ repo: commandRepo, baseCommit }) => {
      await writeContract(commandRepo, "T-001", baseCommit, ["README.md"]);
      const daemon = await startDaemon(daemonRepo);
      try {
        await assert.rejects(
          execCli(commandRepo, daemon.url, ["lease", "T-001"], daemon.authToken),
          (error: unknown) => {
            assert.equal((error as { code?: number }).code, 1);
            assert.match(String((error as { stderr?: string }).stderr), /daemon repo_root does not match/);
            return true;
          }
        );

        const commandStore = await readActiveLeases(commandRepo);
        const daemonStore = await readActiveLeases(daemonRepo);
        assert.equal(commandStore.ok, true);
        assert.equal(daemonStore.ok, true);
        if (!commandStore.ok || !daemonStore.ok) {
          return;
        }
        assert.deepEqual(commandStore.store, {});
        assert.deepEqual(daemonStore.store, {});
      } finally {
        await stopDaemon(daemon);
      }
    });
  });
});

test("plan thrash discovers a live daemon and routes the re-plan write", async () => {
  await withTempRepo(async ({ repo }) => {
    const planPath = await writePlan(repo, {
      tasks: [planTask("T-WRITE")],
      execution_groups: [{ group_id: "G-1", mode: "parallel", task_ids: ["T-WRITE"] }]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await appendPatchRejected(repo, "T-WRITE", "outside allowed_files: src/feature.ts");
    await appendPatchRejected(repo, "T-WRITE", "outside allowed_files again: src/feature.ts");

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--thrash", "T-WRITE"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { status: string; replan_path: string };
      assert.equal(parsed.status, "replan_required");
      const record = JSON.parse(await readFile(path.join(repo, parsed.replan_path), "utf8")) as { task_id: string; attempts: unknown[] };
      assert.equal(record.task_id, "T-WRITE");
      assert.equal(record.attempts.length, 1);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("daemon streams compact authoritative events separately from per-task worker output", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeStreamingProfile(repo, "fake-stream");
    const unrelatedOutput = await appendTaskOutput(repo, {
      task_id: "T-999",
      tool: "other",
      stream: "stdout",
      text: "other task chatter\n"
    });
    assert.equal(unrelatedOutput.ok, true);
    const lease = await requestLeaseForContract(repo, "T-001");
    assert.equal(lease.ok, true);
    const intent = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["README.md"],
      intended_symbols: [],
      possible_risks: [],
      will_not_change: []
    });
    assert.equal(intent.ok, true);

    const daemon = await startDaemon(repo);
    try {
      const accepted = await execCli(repo, daemon.url, ["run", "T-001", "--tool", "fake-stream"]);
      const acceptedParsed = JSON.parse(accepted.stdout) as { status: string; task_id: string };
      assert.equal(acceptedParsed.status, "started");
      assert.equal(acceptedParsed.task_id, "T-001");

      const completed = await waitForEvent(repo, (event) => event.type === "task.completed" && event.task_id === "T-001");
      assert.equal(completed.data.status, "completed");
      assert.equal(completed.data.changed_files, 1);
    } finally {
      await stopDaemon(daemon);
    }

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => String(event.type) === "task.output"), false);
    assert.equal(events.value.every((event) => String(event.type) !== "task.output" && !JSON.stringify(event).includes("live-start")), true);
    assert.equal(events.value.some((event) => event.type === "task.started" && event.task_id === "T-001"), true);
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-001"), true);

    const output = await readTaskOutput(repo, "T-001");
    assert.equal(output.ok, true);
    if (!output.ok) {
      return;
    }
    assert.equal(output.value.some((record) => record.text.includes("live-start")), true);
    assert.equal(output.value.some((record) => record.text.includes("live-end")), true);
    assert.equal(output.value.some((record) => record.text.includes("other task chatter")), false);

    const busSourceText = await readFile(path.join(process.cwd(), "src", "event-bus.ts"), "utf8");
    assert.doesNotMatch(busSourceText, /claude|codex/i);
    for (const sourcePath of ["src/integrate.ts", "src/status.ts", "src/replan.ts", "src/cache.ts"]) {
      assert.doesNotMatch(await readFile(path.join(process.cwd(), sourcePath), "utf8"), /output-stream|readTaskOutput|TaskOutput/u);
    }
    assert.match(await readFile(path.join(process.cwd(), "src", "plan.ts"), "utf8"), /createLiveOutputWriter/u);
  });
});

test("two project daemons share one update lease and both refuse new work", async () => {
  await withTempRepo(async ({ repo: firstRepo }) => {
    await withTempRepo(async ({ repo: secondRepo }) => {
      const coordinatorRoot = await mkdtemp(path.join(tmpdir(), "hivemind-machine-update-"));
      const coordinator = path.join(coordinatorRoot, "update-lease.json");
      const first = await startDaemon(firstRepo, coordinator);
      const second = await startDaemon(secondRepo, coordinator);
      try {
        for (const daemon of [first, second]) {
          const health = await fetch(`${daemon.url}/health`, {
            headers: { authorization: `Bearer ${daemon.authToken}` }
          });
          assert.equal((await health.json() as { update_coordinator_protocol?: number }).update_coordinator_protocol, 1);
        }
        await writeFile(coordinator, `${JSON.stringify({ version: 1, nonce: "installed-update" })}\n`);
        for (const daemon of [first, second]) {
          const refused = await postDaemon(daemon, "/workspace/action", {
            type: "conversation.submit",
            payload: { prompt: "must not start", tool: "planner", request_id: "00000000-0000-4000-8000-000000000001" }
          });
          assert.equal(refused.ok, false);
          assert.equal(refused.reason, "Hivemind is being updated; new work is paused until the app restarts");
          const observation = await postDaemon(daemon, "/workspace/action", {
            type: "files.list",
            payload: {}
          });
          assert.equal(observation.ok, true, "read-only project observation should remain available during handoff");
        }
      } finally {
        await Promise.all([stopDaemon(first), stopDaemon(second)]);
        await rm(coordinatorRoot, { recursive: true, force: true });
      }
    });
  });
});

test("read-only inspection remains live while a conversation provider is running", async () => {
  await withTempRepo(async ({ repo }) => {
    const configured = await setProjectConfig(repo, { no_tests_declared: true });
    assert.equal(configured.ok, true, configured.ok ? undefined : configured.reason);
    await writeDelayedPlanner(repo);
    const daemon = await startDaemon(repo);
    try {
      const conversation = postDaemon(daemon, "/workspace/action", {
        type: "conversation.submit",
        payload: {
          prompt: "What does this project do?",
          tool: "planner",
          request_id: "123e4567-e89b-42d3-a456-426614174010",
          attachments: []
        }
      });
      await waitForEvent(repo, (event) =>
        event.type === "conversation.message_recorded" && event.data.request_id === "123e4567-e89b-42d3-a456-426614174010"
      );
      const started = Date.now();
      const inspection = await postDaemon(daemon, "/workspace/action", {
        type: "status.inspect",
        payload: {}
      });
      assert.equal(inspection.ok, true);
      assert.ok(Date.now() - started < 1_000, `inspection waited ${Date.now() - started}ms`);
      assert.equal((await conversation).ok, true);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("daemon startup does not reclaim a live unfinished worker", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-LIVE", baseCommit, ["README.md"]);
    const lease = await requestLeaseForContract(repo, "T-LIVE");
    assert.equal(lease.ok, true, lease.ok ? undefined : lease.reason);
    const worktree = await createTaskWorktree(repo, "T-LIVE");
    assert.equal(worktree.ok, true, worktree.ok ? undefined : worktree.reason);
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    assert.notEqual(worker.pid, undefined);
    await appendEvent(repo, { type: "task.started", task_id: "T-LIVE", data: { run_id: "R-LIVE", tool: "fake-stream" } });
    await appendEvent(repo, {
      type: "task.worker_process_started",
      task_id: "T-LIVE",
      data: { run_id: "R-LIVE", pid: worker.pid, process_group_id: process.platform === "win32" ? null : worker.pid, process_instance_id: "live-worker" }
    });

    const daemon = await startDaemon(repo);
    try {
      const events = await readEvents(repo);
      assert.equal(events.ok, true);
      if (events.ok) assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-LIVE"), false);
      const held = await readActiveLeases(repo);
      assert.equal(held.ok, true);
      if (held.ok) assert.equal(held.store["README.md"], "T-LIVE");
      if (worktree.ok) assert.equal((await stat(worktree.value.worktree)).isDirectory(), true);
    } finally {
      await stopDaemon(daemon);
      worker.kill();
    }
  });
});

test("daemon startup preserves quota-paused runs instead of marking them failed", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await appendEvent(repo, {
      type: "task.started",
      task_id: "T-PAUSE",
      data: { tool: "fake-stream", worktree: path.join(repo, ".hivemind", "worktrees", "T-PAUSE") }
    });
    assert.equal(started.ok, true);
    const paused = await appendEvent(repo, {
      type: "task.paused",
      task_id: "T-PAUSE",
      data: {
        reason: "quota_exhausted",
        source: "quota-wall-recovery",
        snapshot_path: ".hivemind/resource/checkpoints/T-PAUSE.snapshot.json",
        awaiting: "quota_reset_or_provider_available"
      }
    });
    assert.equal(paused.ok, true);

    const daemon = await startDaemon(repo);
    try {
      const events = await readEvents(repo);
      assert.equal(events.ok, true);
      if (!events.ok) {
        return;
      }
      assert.equal(events.value.some((event) => event.type === "task.paused" && event.task_id === "T-PAUSE"), true);
      assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-PAUSE"), false);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "daemon",
    async (repo) => {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.name", "Hivemind Test"]);
      await git(repo, ["config", "user.email", "hivemind@example.test"]);
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await initProject(repo);
      await createRatifiedSpec(repo);
    },
    async (repo) => {
      await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
    },
    "hivemind-daemon-test-",
    async (repo) => { await cleanupTempRepo(repo); }
  );
}

async function startDaemon(repo: string, updateCoordinator?: string, readReadyLine = readLine): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: {
      ...process.env,
      HIVEMIND_DAEMON_URL: "",
      ...(updateCoordinator === undefined ? {} : { HIVEMIND_UPDATE_COORDINATOR: updateCoordinator })
    },
    windowsHide: true
  });
  try {
    const line = await readReadyLine(child);
    const parsed = JSON.parse(line) as Record<string, unknown> & {
      event: string;
      url: string;
      repo_root: string;
    };
    assert.equal(parsed.event, "daemon.ready");
    assert.equal("auth_token" in parsed, false, "daemon.ready exposed its session credential");
    const state = JSON.parse(
      await readFile(path.join(repo, ".hivemind", "daemon.json"), "utf8")
    ) as { auth_token?: unknown };
    assert.match(String(state.auth_token ?? ""), /^[A-Za-z0-9_-]{43}$/u);
    return {
      child,
      url: parsed.url,
      repoRoot: parsed.repo_root,
      authToken: String(state.auth_token)
    };
  } catch (error) {
    // Startup has not transferred ownership to the caller's finally block yet.
    await stopChildProcess(child, "daemon whose startup failed");
    throw error;
  }
}

interface EventStreamMessage {
  kind: "event";
  source: "history" | "live";
  seq?: number;
  event: {
    ts: string;
    type: string;
    task_id: string | null;
    data: Record<string, unknown>;
  };
}

interface OutputStreamMessage {
  kind: "output";
  source: "history" | "live";
  seq?: number;
  record: {
    ts: string;
    task_id: string;
    tool: string;
    stream: "stdout" | "stderr";
    text: string;
  };
}

interface ErrorStreamMessage {
  kind: "error";
  reason: string;
}

type StreamMessage = EventStreamMessage | OutputStreamMessage | ErrorStreamMessage;

async function waitForEvent(
  repo: string,
  predicate: (event: { type: string; task_id: string | null; data: Record<string, unknown> }) => boolean,
  timeoutMs = 10000
): Promise<{ type: string; task_id: string | null; data: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const found = events.value.find((event) => predicate(event as { type: string; task_id: string | null; data: Record<string, unknown> }));
      if (found !== undefined) {
        return found as { type: string; task_id: string | null; data: Record<string, unknown> };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for durable event");
}

class EventStreamClient {
  private readonly decoder = new TextDecoder();
  private readonly messages: StreamMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: StreamMessage) => boolean;
    resolve: (message: StreamMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  private buffer = "";
  private readLoop: Promise<void>;

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController
  ) {
    this.readLoop = this.read();
  }

  static async connect(daemonUrl: string, route: string): Promise<EventStreamClient> {
    const controller = new AbortController();
    const response = await fetch(`${daemonUrl}${route}`, { signal: controller.signal });
    assert.equal(response.ok, true);
    assert.ok(response.body, "event stream response must have a body");
    return new EventStreamClient(response.body.getReader(), controller);
  }

  nextEvent(predicate: (message: EventStreamMessage) => boolean, timeoutMs = 5000): Promise<EventStreamMessage> {
    return this.nextMessage((message): message is EventStreamMessage => message.kind === "event" && predicate(message), timeoutMs);
  }

  nextOutput(predicate: (message: OutputStreamMessage) => boolean, timeoutMs = 5000): Promise<OutputStreamMessage> {
    return this.nextMessage((message): message is OutputStreamMessage => message.kind === "output" && predicate(message), timeoutMs);
  }

  seenMessages(): StreamMessage[] {
    return this.messages;
  }

  async close(): Promise<void> {
    this.controller.abort();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("event stream closed"));
    }
    await this.readLoop.catch(() => undefined);
  }

  private async read(): Promise<void> {
    try {
      while (true) {
        const chunk = await this.reader.read();
        if (chunk.done) {
          return;
        }
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        this.drainBuffer();
      }
    } catch {
      return;
    }
  }

  private drainBuffer(): void {
    let boundary = findFrameBoundary(this.buffer);
    while (boundary !== null) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + boundaryLength(this.buffer, boundary));
      this.handleFrame(frame);
      boundary = findFrameBoundary(this.buffer);
    }
  }

  private nextMessage<T extends StreamMessage>(predicate: (message: StreamMessage) => message is T, timeoutMs: number): Promise<T> {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex !== -1) {
      const [message] = this.messages.splice(existingIndex, 1);
      return Promise.resolve(message as T);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.reject === reject);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for event stream message; seen=${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: resolve as (message: StreamMessage) => void, reject, timeout });
    });
  }

  private handleFrame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    if (data === "") {
      return;
    }
    const parsed = JSON.parse(data) as StreamMessage;
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(parsed);
      return;
    }
    this.messages.push(parsed);
  }
}

function findFrameBoundary(buffer: string): number | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) {
    return crlf === -1 ? null : crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function boundaryLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

/**
 * Stop the daemon, and never wait forever for it to agree.
 *
 * This awaited `once("exit")` with no ceiling. Measured on 2026-08-15: a run of
 * this file sat for **233 minutes** in exactly that await, holding a live
 * daemon, until it was killed by hand. Two things made it worse than a failure:
 *
 * - **A hang looks like progress.** `node --test` printed nothing, so the
 *   suite was indistinguishable from a slow one. Silence read as success --
 *   the instrument family this project keeps recording, this time in the test
 *   runner rather than in an assertion.
 * - **It leaves the hazard behind.** The daemon it could not stop stays alive,
 *   and a surviving daemon from a superseded run is already on record as a rig
 *   failure that breaks the NEXT run.
 *
 * So the wait is bounded and it escalates. `SIGTERM` first, because a daemon
 * that shuts down cleanly should be allowed to; `SIGKILL` after, because a test
 * helper's job is to end the process rather than to negotiate with it; and a
 * thrown error last, because a daemon that survives both is a real finding and
 * must not be swallowed by the cleanup that noticed it.
 *
 * The sibling `once("exit")` in `readLine` was checked and left alone -- it has
 * carried a 5s timeout since it was written.
 */
async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  await stopChildProcess(daemon.child, "the daemon");
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

async function execCli(repo: string, daemonUrl: string, args: string[], authToken?: string) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HIVEMIND_DAEMON_URL: daemonUrl,
      ...(authToken === undefined ? {} : { HIVEMIND_DAEMON_TOKEN: authToken })
    },
    windowsHide: true
  });
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Daemon lease test",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Daemon fixture completes one lease operation.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
  await ratifyPlanForExistingTask(repo, taskId);
}

async function writeStreamingProfile(repo: string, tool: string): Promise<void> {
  const agentPath = path.join(repo, "streaming-agent.mjs");
  await writeFile(
    agentPath,
    [
      "const { writeFile } = await import('node:fs/promises');",
      "console.log('live-start');",
      "await new Promise((resolve) => setTimeout(resolve, 750));",
      "await writeFile('README.md', '# Fixture\\nchanged by streaming agent\\n');",
      "console.log('live-end');"
    ].join("\n"),
    "utf8"
  );
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: [process.execPath, agentPath],
        prompt_arg: "stdin",
        verified_on: "test",
        context_window: 100000,
        timeout_ms: 5000,
        routing_tier: "strong"
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writePlan(repo: string, body: unknown): Promise<string> {
  const filePath = path.join(repo, "plan.json");
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
  return filePath;
}

function planTask(taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "Daemon thrash fixture",
    task_type: "deterministic",
    routing_task_type: "other",
    mode: "write",
    agent_role: "builder",
    draft_scope: {
      allowed_files: ["README.md"],
      read_only_files: [],
      forbidden_files: [],
      must_not_change: []
    },
    depends_on: [],
    parallel_safe: true,
    acceptance_criterion: "One binary acceptance check passes.",
    required_tests: ["npm run typecheck"],
    patch_requirements: ["submit diff only"]
  };
}

async function appendPatchRejected(repo: string, taskId: string, reason: string): Promise<void> {
  const result = await appendEvent(repo, {
    type: "patch.rejected",
    task_id: taskId,
    data: { verdict: "reject", reason }
  });
  assert.equal(result.ok, true);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function cleanupTempRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function writeDelayedPlanner(repo: string): Promise<void> {
  const agentPath = path.join(repo, "delayed-planner.mjs");
  await writeFile(
    agentPath,
    [
      "process.stdin.resume();",
      "await new Promise((resolve) => setTimeout(resolve, 1500));",
      "process.stdout.write(JSON.stringify({ kind: 'reply', reply: 'A daemon fixture.' }));"
    ].join("\n"),
    "utf8"
  );
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, "planner.profile.json"),
    `${JSON.stringify({
      tool: "planner",
      invoke: [process.execPath, agentPath],
      prompt_arg: "stdin",
      verified_on: "test",
      context_window: 100000,
      timeout_ms: 5000,
      routing_tier: "cheap",
      roles: ["orchestrator"]
    }, null, 2)}\n`,
    "utf8"
  );
}

async function postDaemon(
  daemon: DaemonProcess,
  route: string,
  payload: unknown
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const response = await fetch(`${daemon.url}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return await response.json() as { ok: boolean; [key: string]: unknown };
}

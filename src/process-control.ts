import { spawn } from "node:child_process";
import {
  getProcessGroupLiveness,
  getProcessLiveness,
  type ProcessLiveness
} from "./process-liveness.js";

/**
 * Killing a worker, and proving it.
 *
 * INVARIANT: proving a worker dead means proving its entire process TREE is
 * dead. The same code path that releases a lease and resets a worktree depends
 * on that proof, and a tree that outlives its parent is exactly the condition
 * the lease was protecting against. Anything short of proof is "unknown",
 * which per PL-1 is treated as alive, and nothing is reclaimed.
 *
 * What was wrong: Windows ran `taskkill /t` and killed the tree, but POSIX
 * sent SIGTERM then SIGKILL to a single pid. The adapter spawned its child
 * with no `detached` and no process group, so there was no group to signal and
 * the agent CLI's own subprocesses -- a shell, a node, a git -- survived.
 * Verification then confirmed the NAMED pid was absent, returned "dead", and
 * the caller reset the worktree and released the lease while orphaned
 * grandchildren were still writing into it.
 *
 * There is one entry point. Platform differences live inside it, the way PL-1
 * keeps liveness in one place, so the two cannot drift into a pair that
 * disagrees about what "dead" means.
 */

const gracefulStopMs = 750;
const forcedStopMs = 2_500;
const pollMs = 50;

export interface DurableProcessIdentity {
  pid: number;
  process_instance_id: string;
  /**
   * The POSIX process group the worker leads, recorded when it is spawned.
   *
   * Null on Windows, which has no equivalent and uses `taskkill /t` instead,
   * and null for any worker recorded before this field existed. On POSIX a
   * null group means the tree cannot be proven dead -- so it is not proven,
   * and nothing is reclaimed. That is the fail-closed cost of not knowing,
   * and it is the correct one.
   */
  process_group_id?: number | null;
}

export interface ProcessTerminationResult {
  status: "dead" | "not_proven_dead";
  liveness: ProcessLiveness;
  reason: string;
}

export interface ProcessTerminationOptions {
  probeLiveness?: (pid: number) => ProcessLiveness;
  probeGroupLiveness?: (pgid: number) => ProcessLiveness;
  platform?: NodeJS.Platform;
  runWindowsTaskkill?: (pid: number) => Promise<{ ok: boolean; reason: string }>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => { ok: boolean; reason: string };
  gracefulMs?: number;
  forcedMs?: number;
}

export async function terminateProcessTreeAndVerify(
  identity: DurableProcessIdentity,
  options: ProcessTerminationOptions = {}
): Promise<ProcessTerminationResult> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.process_instance_id.trim() === "") {
    return { status: "not_proven_dead", liveness: "unknown", reason: "worker process identity is invalid" };
  }
  const platform = options.platform ?? process.platform;
  return platform === "win32"
    ? terminateWindowsTree(identity, options)
    : terminatePosixTree(identity, options);
}

/**
 * `taskkill /t /f` terminates the tree and its exit code is the platform's own
 * statement that it did. This path is unchanged; it was already correct.
 */
async function terminateWindowsTree(
  identity: DurableProcessIdentity,
  options: ProcessTerminationOptions
): Promise<ProcessTerminationResult> {
  const probe = options.probeLiveness ?? getProcessLiveness;
  const initial = probe(identity.pid);
  if (initial === "dead") {
    return { status: "dead", liveness: "dead", reason: "worker process was already definitively absent" };
  }

  const killed = await (options.runWindowsTaskkill ?? runWindowsTaskkill)(identity.pid);
  if (!killed.ok) {
    const liveness = probe(identity.pid);
    return liveness === "dead"
      ? { status: "dead", liveness, reason: `taskkill raced another terminator; worker pid ${identity.pid} is definitively absent` }
      : { status: "not_proven_dead", liveness, reason: killed.reason };
  }
  return waitForDefinitiveDeath(
    identity.pid,
    options.forcedMs ?? forcedStopMs,
    probe,
    "taskkill completed but worker death was not proven"
  );
}

/**
 * Signals the worker's process GROUP, and proves the group empty.
 *
 * `kill(-pgid, sig)` reaches every process in the group, so the agent CLI's
 * own children die with it. Verification asks whether any member of the group
 * remains, which is the only question that can prove a tree gone -- the root
 * pid being absent says nothing about its orphans.
 */
async function terminatePosixTree(
  identity: DurableProcessIdentity,
  options: ProcessTerminationOptions
): Promise<ProcessTerminationResult> {
  const probeGroup = options.probeGroupLiveness ?? getProcessGroupLiveness;
  const probePid = options.probeLiveness ?? getProcessLiveness;
  const groupId = identity.process_group_id ?? null;

  if (groupId === null) {
    // No group was recorded, so the tree cannot be proven gone. Killing the
    // named pid would leave its children running and report success, which is
    // the exact failure this exists to prevent.
    const liveness = probePid(identity.pid);
    if (liveness === "dead") {
      // The root is definitively absent, but that is not the claim being made
      // here. Its children may still hold the worktree.
      return {
        status: "not_proven_dead",
        liveness: "unknown",
        reason: `worker pid ${identity.pid} has no recorded process group, so its tree cannot be proven dead even though the root process is absent`
      };
    }
    return {
      status: "not_proven_dead",
      liveness,
      reason: `worker pid ${identity.pid} has no recorded process group; refusing to report a single-process kill as a tree termination`
    };
  }

  if (probeGroup(groupId) === "dead") {
    return { status: "dead", liveness: "dead", reason: `worker process group ${groupId} was already definitively absent` };
  }

  const send = options.sendSignal ?? sendProcessSignal;
  // The negative pid is the group. This is the whole fix.
  const term = send(-groupId, "SIGTERM");
  if (!term.ok && probeGroup(groupId) !== "dead") {
    return { status: "not_proven_dead", liveness: probeGroup(groupId), reason: term.reason };
  }
  const graceful = await waitForDefinitiveGroupDeath(
    groupId,
    options.gracefulMs ?? gracefulStopMs,
    probeGroup,
    "worker process group ignored SIGTERM"
  );
  if (graceful.status === "dead") return graceful;

  const kill = send(-groupId, "SIGKILL");
  if (!kill.ok && probeGroup(groupId) !== "dead") {
    return { status: "not_proven_dead", liveness: probeGroup(groupId), reason: kill.reason };
  }
  return waitForDefinitiveGroupDeath(
    groupId,
    options.forcedMs ?? forcedStopMs,
    probeGroup,
    "worker process group death was not proven after SIGKILL"
  );
}

async function runWindowsTaskkill(pid: number): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    let stderr = "";
    const timeout = setTimeout(() => {
      killer.kill();
      resolve({ ok: false, reason: `taskkill timed out for worker pid ${pid}` });
    }, forcedStopMs);
    killer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    killer.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: `taskkill failed for worker pid ${pid}: ${error.message}` });
    });
    killer.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0
        ? { ok: true, reason: `taskkill verified command success for worker pid ${pid}` }
        : { ok: false, reason: `taskkill exited ${code ?? "unknown"} for worker pid ${pid}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}` });
    });
  });
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals): { ok: boolean; reason: string } {
  try {
    process.kill(pid, signal);
    return { ok: true, reason: `${signal} sent` };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { ok: false, reason: `${signal} failed for worker ${pid < 0 ? `process group ${-pid}` : `pid ${pid}`}: ${code}` };
  }
}

async function waitForDefinitiveDeath(
  pid: number,
  timeoutMs: number,
  probe: (pid: number) => ProcessLiveness,
  timeoutReason: string
): Promise<ProcessTerminationResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const liveness = probe(pid);
    if (liveness === "dead") {
      return { status: "dead", liveness, reason: `worker pid ${pid} is definitively absent` };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const liveness = probe(pid);
  return { status: "not_proven_dead", liveness, reason: `${timeoutReason}; liveness is ${liveness}` };
}

async function waitForDefinitiveGroupDeath(
  groupId: number,
  timeoutMs: number,
  probe: (pgid: number) => ProcessLiveness,
  timeoutReason: string
): Promise<ProcessTerminationResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const liveness = probe(groupId);
    if (liveness === "dead") {
      return {
        status: "dead",
        liveness,
        reason: `worker process group ${groupId} is definitively absent, so no descendant survives`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const liveness = probe(groupId);
  return { status: "not_proven_dead", liveness, reason: `${timeoutReason}; group liveness is ${liveness}` };
}

import { spawn } from "node:child_process";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";

const gracefulStopMs = 750;
const forcedStopMs = 2_500;
const pollMs = 50;

export interface DurableProcessIdentity {
  pid: number;
  process_instance_id: string;
}

export interface ProcessTerminationResult {
  status: "dead" | "not_proven_dead";
  liveness: ProcessLiveness;
  reason: string;
}

export interface ProcessTerminationOptions {
  probeLiveness?: (pid: number) => ProcessLiveness;
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
  const probe = options.probeLiveness ?? getProcessLiveness;
  const initial = probe(identity.pid);
  if (initial === "dead") {
    return { status: "dead", liveness: "dead", reason: "worker process was already definitively absent" };
  }

  if ((options.platform ?? process.platform) === "win32") {
    const killed = await (options.runWindowsTaskkill ?? runWindowsTaskkill)(identity.pid);
    if (!killed.ok) {
      const liveness = probe(identity.pid);
      return liveness === "dead"
        ? { status: "dead", liveness, reason: `taskkill raced another terminator; worker pid ${identity.pid} is definitively absent` }
        : { status: "not_proven_dead", liveness, reason: killed.reason };
    }
    return waitForDefinitiveDeath(identity.pid, options.forcedMs ?? forcedStopMs, probe, "taskkill completed but worker death was not proven");
  }

  const send = options.sendSignal ?? sendProcessSignal;
  const term = send(identity.pid, "SIGTERM");
  if (!term.ok && probe(identity.pid) !== "dead") {
    return { status: "not_proven_dead", liveness: probe(identity.pid), reason: term.reason };
  }
  const graceful = await waitForDefinitiveDeath(identity.pid, options.gracefulMs ?? gracefulStopMs, probe, "worker ignored SIGTERM");
  if (graceful.status === "dead") return graceful;

  const kill = send(identity.pid, "SIGKILL");
  if (!kill.ok && probe(identity.pid) !== "dead") {
    return { status: "not_proven_dead", liveness: probe(identity.pid), reason: kill.reason };
  }
  return waitForDefinitiveDeath(identity.pid, options.forcedMs ?? forcedStopMs, probe, "worker death was not proven after SIGKILL");
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
    return { ok: false, reason: `${signal} failed for worker pid ${pid}: ${code}` };
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

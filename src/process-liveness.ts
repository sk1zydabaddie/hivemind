import { isNodeError } from "./error-detail.js";
export type ProcessLiveness = "alive" | "dead" | "unknown";

export function createCachedProcessLivenessProbe(
  probeLiveness: (pid: number) => ProcessLiveness = getProcessLiveness
): (pid: number) => ProcessLiveness {
  const observations = new Map<number, ProcessLiveness>();
  return (pid) => {
    const existing = observations.get(pid);
    if (existing !== undefined) return existing;
    const observed = probeLiveness(pid);
    observations.set(pid, observed);
    return observed;
  };
}

export type ProcessSignalProbe = (pid: number) => void;

// Implements PL-1 from Hivemind_AI_Overview.md. The Tauri shell carries a
// deliberate Rust port because it must decide liveness before a daemon exists.
export function getProcessLiveness(
  pid: number | null | undefined,
  probe: ProcessSignalProbe = (candidatePid) => {
    process.kill(candidatePid, 0);
  }
): ProcessLiveness {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }

  try {
    probe(pid);
    return "alive";
  } catch (error: unknown) {
    return isNodeError(error, "ESRCH") ? "dead" : "unknown";
  }
}

export function processIsLiveOrUnknown(pid: number): boolean {
  return getProcessLiveness(pid) !== "dead";
}

/**
 * PL-1 applied to a whole process group.
 *
 * `kill(-pgid, 0)` asks the kernel whether ANY process in the group exists,
 * which is the only question worth asking when the thing being proven dead is
 * a tree. Signalling a single pid can only ever prove one process absent, and
 * an agent CLI's own children -- a shell, a node, a git -- outlive it.
 *
 * Deliberately built on `kill` rather than /proc, because macOS and the BSDs
 * have no /proc and are port targets. The three outcomes:
 *
 * - ESRCH  -> no process in the group exists. Dead, and only this proves it.
 * - EPERM  -> at least one process exists but is not ours to signal. Alive.
 * - success -> the group exists. Alive.
 *
 * Anything else is "unknown", which per PL-1 is treated as alive: nothing is
 * reclaimed on a maybe.
 */
export function getProcessGroupLiveness(
  processGroupId: number | null | undefined,
  probe: ProcessSignalProbe = (candidatePgid) => {
    process.kill(-candidatePgid, 0);
  }
): ProcessLiveness {
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return "unknown";
  }
  if (process.platform === "win32") {
    // Windows has no process groups in this sense. Callers must use the
    // platform's own tree primitive rather than pretend this answered.
    return "unknown";
  }

  try {
    probe(processGroupId);
    return "alive";
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) return "dead";
    if (isNodeError(error, "EPERM")) return "alive";
    return "unknown";
  }
}

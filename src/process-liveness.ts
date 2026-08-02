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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

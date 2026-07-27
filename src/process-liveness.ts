export type ProcessLiveness = "alive" | "dead" | "unknown";

export type ProcessSignalProbe = (pid: number) => void;

export function getProcessLiveness(
  pid: number,
  probe: ProcessSignalProbe = (candidatePid) => {
    process.kill(candidatePid, 0);
  }
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) {
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

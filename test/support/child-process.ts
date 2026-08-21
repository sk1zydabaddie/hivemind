import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const GRACEFUL_STOP_MS = 5_000;
const FORCED_STOP_MS = 5_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function goneWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return child.exitCode !== null;
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processExists(pid)) return true;
    await sleep(50);
  } while (Date.now() < deadline);
  return !processExists(pid);
}

function closePipes(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function forceWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: FORCED_STOP_MS },
      () => resolve()
    );
  });
}

/**
 * Ends a test-owned child without allowing cleanup to become a third,
 * never-answering test outcome. A graceful stop gets a bounded opportunity;
 * a surviving process is then force-stopped, and survival after both signals
 * is reported as the test rig failure it is.
 */
export async function stopChildProcess(
  child: ChildProcessWithoutNullStreams,
  label = "test child process"
): Promise<void> {
  if (child.pid !== undefined && !processExists(child.pid)) {
    closePipes(child);
    return;
  }

  /* On Windows, Node implements signal delivery for a single pid. The root can
     disappear before its console/process descendants release their cwd, which
     makes the liveness probe look settled while a later rm still receives
     EBUSY. taskkill /T is the platform's process-tree primitive, so use it
     while the known test-owned root identity still exists instead of waiting
     until that identity is gone and its descendants are orphaned. */
  if (process.platform === "win32" && child.pid !== undefined) {
    await forceWindowsProcessTree(child.pid);
    if (await goneWithin(child, FORCED_STOP_MS)) {
      closePipes(child);
      return;
    }
    throw new Error(
      `${label} (pid ${String(child.pid)}) survived Windows process-tree termination; it is still running and would invalidate the next test run`
    );
  }

  child.kill("SIGTERM");
  if (await goneWithin(child, GRACEFUL_STOP_MS)) {
    closePipes(child);
    return;
  }

  child.kill("SIGKILL");
  if (await goneWithin(child, FORCED_STOP_MS)) {
    closePipes(child);
    return;
  }

  throw new Error(
    `${label} (pid ${String(child.pid)}) survived SIGTERM and SIGKILL; it is still running and would invalidate the next test run`
  );
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";

const GRACEFUL_STOP_MS = 5_000;
const FORCED_STOP_MS = 5_000;

async function exitedWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return await new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
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
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  if (await exitedWithin(child, GRACEFUL_STOP_MS)) return;

  child.kill("SIGKILL");
  if (await exitedWithin(child, FORCED_STOP_MS)) return;

  throw new Error(
    `${label} (pid ${String(child.pid)}) survived SIGTERM and SIGKILL; it is still running and would invalidate the next test run`
  );
}

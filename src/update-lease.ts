import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const UPDATE_COORDINATOR_ENV = "HIVEMIND_UPDATE_COORDINATOR";
export const UPDATE_COORDINATOR_PROTOCOL = 1;

const admissionWaitMs = 2_000;
const admissionPollMs = 25;

export type UpdateAdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const readOnlyWorkspaceActions = new Set([
  "status.inspect",
  "trail.inspect",
  "change.inspect",
  "config.inspect",
  "provider.auth.inspect",
  "models.discover",
  "files.list",
  "files.read",
  "checks.inspect",
  "accounts.inspect",
  "sharing.inspect",
  "plan.review",
  "spec.review",
  "adoption.review"
]);

export function daemonRequestStartsWork(
  method: string | undefined,
  route: string,
  payload: Record<string, unknown>
): boolean {
  if (method !== "POST") return false;
  if (route === "/status" || route === "/resource/quota") return false;
  if (route !== "/workspace/action") return true;
  return typeof payload.type !== "string" || !readOnlyWorkspaceActions.has(payload.type);
}

/**
 * Serializes every state-changing daemon request against update admission.
 *
 * The update lease path is supplied only by the installed shell that launched
 * the daemon. Standalone Core use has no desktop artifact to replace and does
 * not participate. While the admission directory is held, an update cannot
 * pass its final idle proof; once the durable lease exists, no new mutation can
 * enter. Holding the directory for the whole request is deliberately
 * conservative: a provider call may be long, but replacing the running Core
 * during that call is the unsafe direction.
 */
export async function withUpdateAdmission<T>(
  operation: () => Promise<UpdateAdmissionResult<T>>,
  coordinatorFile = process.env[UPDATE_COORDINATOR_ENV]
): Promise<UpdateAdmissionResult<T>> {
  if (coordinatorFile === undefined || coordinatorFile.trim() === "") {
    return operation();
  }
  const leaseFile = path.resolve(coordinatorFile);
  const admissionDirectory = `${leaseFile}.admission`;
  const candidateDirectory = `${admissionDirectory}.candidate-${process.pid}-${process.hrtime.bigint().toString()}`;
  try {
    await mkdir(candidateDirectory);
    const owner = await open(path.join(candidateDirectory, "owner.json"), "wx");
    try {
      await owner.writeFile(
        `${JSON.stringify({
          version: UPDATE_COORDINATOR_PROTOCOL,
          pid: process.pid,
          process_started_at_ms: Math.round(Date.now() - process.uptime() * 1_000)
        })}\n`,
        "utf8"
      );
      await owner.sync();
    } finally {
      await owner.close();
    }
  } catch {
    await rm(candidateDirectory, { recursive: true, force: true });
    return { ok: false, reason: "the machine-wide update admission owner could not be prepared" };
  }

  const deadline = Date.now() + admissionWaitMs;
  while (true) {
    try {
      await rename(candidateDirectory, admissionDirectory);
      break;
    } catch (error: unknown) {
      let occupied: boolean;
      try {
        occupied = await directoryExists(admissionDirectory);
      } catch {
        await rm(candidateDirectory, { recursive: true, force: true });
        return { ok: false, reason: "the machine-wide update admission lock could not be inspected" };
      }
      if (!occupied) {
        await rm(candidateDirectory, { recursive: true, force: true });
        return { ok: false, reason: "the machine-wide update admission lock could not be acquired" };
      }
      if (Date.now() >= deadline) {
        await rm(candidateDirectory, { recursive: true, force: true });
        return { ok: false, reason: "Hivemind is preparing an update; try this action again after it finishes" };
      }
      await delay(admissionPollMs);
    }
  }

  try {
    const lease = await readLease(leaseFile);
    if (!lease.ok) return lease;
    if (lease.value) {
      return { ok: false, reason: "Hivemind is being updated; new work is paused until the app restarts" };
    }
    return await operation();
  } finally {
    await rm(admissionDirectory, { recursive: true, force: true });
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function readLease(file: string): Promise<UpdateAdmissionResult<boolean>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !("version" in parsed) || parsed.version !== UPDATE_COORDINATOR_PROTOCOL ||
      !("nonce" in parsed) || typeof parsed.nonce !== "string" || parsed.nonce.trim() === ""
    ) {
      return { ok: false, reason: "the machine-wide update lease is malformed; refusing new work" };
    }
    return { ok: true, value: true };
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { ok: true, value: false }
      : { ok: false, reason: "the machine-wide update lease could not be read; refusing new work" };
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

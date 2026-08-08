import { readEvents, repairEventTrail } from "./events.js";
import { readTaskOutput, repairTaskOutput } from "./output-stream.js";
import { findGitRoot } from "./repo.js";
import { validateRequestedTaskId } from "./task-id.js";

/**
 * The way out of a damaged trail.
 *
 * A damaged event trail is otherwise terminal: readEvents refuses, and 69 call
 * sites across 15 modules depend on it, so the system fails closed with no
 * path forward. This is that path -- deliberately a separate command a person
 * runs, never something an append does on its own, because the only damage it
 * can address is an interrupted append and everything else is a decision.
 */
export async function eventsCommand(cwd: string, args: string[]): Promise<number> {
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }

  if (args[0] === "check") {
    return checkTrail(repoRoot, args.slice(1));
  }
  if (args[0] === "repair") {
    return repairTrailCommand(repoRoot, args.slice(1));
  }
  console.error(`error: ${usage()}`);
  return 1;
}

async function checkTrail(repoRoot: string, args: string[]): Promise<number> {
  const target = parseTarget(args);
  if (!target.ok) {
    console.error(`error: ${target.reason}`);
    return 1;
  }

  const read = target.taskId === null
    ? await readEvents(repoRoot)
    : await readTaskOutput(repoRoot, target.taskId);
  if (read.ok) {
    console.log(JSON.stringify({ status: "intact", records: read.value.length }, null, 2));
    return 0;
  }
  console.error(`error: ${read.reason}`);
  console.log(JSON.stringify({ status: "damaged", damage: read.damage ?? null }, null, 2));
  return 1;
}

async function repairTrailCommand(repoRoot: string, args: string[]): Promise<number> {
  const target = parseTarget(args);
  if (!target.ok) {
    console.error(`error: ${target.reason}`);
    return 1;
  }

  const repaired = target.taskId === null
    ? await repairEventTrail(repoRoot)
    : await repairTaskOutput(repoRoot, target.taskId);
  if (!repaired.ok) {
    console.error(`error: ${repaired.reason}`);
    return 1;
  }
  if (repaired.value === null) {
    console.log(JSON.stringify({ status: "intact", repaired: false }, null, 2));
    return 0;
  }
  console.log(JSON.stringify({ status: "repaired", repaired: true, ...repaired.value }, null, 2));
  return 0;
}

function parseTarget(args: string[]): { ok: true; taskId: string | null } | { ok: false; reason: string } {
  if (args.length === 0) {
    return { ok: true, taskId: null };
  }
  if (args.length !== 2 || args[0] !== "--task") {
    return { ok: false, reason: usage() };
  }
  const validated = validateRequestedTaskId(args[1]);
  return validated.ok ? { ok: true, taskId: args[1] } : { ok: false, reason: validated.reason };
}

function usage(): string {
  return "usage: hivemind events check|repair [--task <task-id>]";
}

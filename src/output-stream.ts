import { AgentStreamDecoder, activityLines, type AgentVisibleOutput } from "./agent-activity.js";
import type { AdapterStreamChunk } from "./adapter.js";
import path from "node:path";
import {
  appendTrailLine,
  readTrail,
  repairTrail,
  type TrailDamage,
  type TrailRepair
} from "./jsonl-trail.js";
import { validateRequestedTaskId } from "./task-id.js";

export type TaskOutputStream = "stdout" | "stderr";

/**
 * The channel for "what is happening right now" in this project.
 *
 * Not a task id: a fixed key a surface can subscribe to before it knows what is
 * about to run. Its records carry timestamps, so a reader shows only the ones
 * that belong to the wait it is in.
 */
export const ACTIVITY_STREAM_ID = "activity";

/**
 * Who to tell when a line is written.
 *
 * The publisher used to be threaded through one action: the daemon handed
 * `onOutput` to the RUN path, which called it after appending. So worker output
 * reached subscribers and everything else -- drafting, and anything added later
 * -- wrote to disk and told nobody. The records were there on the next
 * subscribe, as history, which is why the file looked right and the surface
 * stayed empty.
 *
 * The same shape this project keeps recording: a mitigation attached to the
 * path where it was needed leaves every other path without it. So it is
 * attached to the WRITE. One registration, and every writer publishes.
 */
type TaskOutputPublisher = (record: TaskOutputRecord) => void;

let publisher: TaskOutputPublisher | null = null;

/** Registered once by whatever owns the subscribers. */
export function setTaskOutputPublisher(next: TaskOutputPublisher | null): void {
  publisher = next;
}

export interface TaskOutputRecord {
  ts: string;
  task_id: string;
  tool: string;
  stream: TaskOutputStream;
  text: string;
  /**
   * What this line means, for a surface that shows an agent working.
   *
   * Computed here because it is knowledge of a harness's output shapes, and a
   * client deciding what raw JSONL means would make it the authority on a
   * provider's format. Absent when the line says nothing worth showing, which
   * is most of them.
   */
  activity?: string;
  /** User-visible answer text decoded by Core, never a raw provider envelope. */
  answer?: string;
  answer_mode?: "complete" | "delta";
}

export interface TaskOutputInput {
  task_id: string;
  tool: string;
  stream: TaskOutputStream;
  text: string;
  /** Present when a stateful per-process decoder already framed this chunk. */
  visible?: AgentVisibleOutput;
}

export interface LiveOutputWriter {
  onChunk: (chunk: AdapterStreamChunk) => void;
  drain: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * One ordered, stateful output writer for one provider process.
 *
 * Every orchestration caller uses this instead of inventing its own callback.
 * JSON records split across operating-system chunks therefore share one carry
 * buffer, and a failed durable write fails the provider operation rather than
 * being converted into successful silence.
 */
export function createLiveOutputWriter(
  repoRoot: string,
  taskId: string,
  tool: string,
  onRecord?: (record: TaskOutputRecord) => void,
  options: { structuredAnswers?: boolean } = {}
): LiveOutputWriter {
  const decoders = {
    stdout: new AgentStreamDecoder(options),
    stderr: new AgentStreamDecoder(options)
  };
  let tail: Promise<{ ok: true } | { ok: false; reason: string }> = Promise.resolve({ ok: true });
  let flushed = false;

  const append = (chunk: AdapterStreamChunk, visible: AgentVisibleOutput): void => {
    tail = tail.then((previous) =>
      previous.ok
        ? appendTaskOutput(repoRoot, {
            task_id: taskId,
            tool,
            stream: chunk.stream,
            text: chunk.text,
            visible
          }).then((result) => {
            if (!result.ok) return result;
            onRecord?.(result.value);
            return { ok: true as const };
          })
        : previous
    );
  };

  return {
    onChunk: (chunk) => {
      const decoded = decoders[chunk.stream].push(chunk.text);
      if (decoded.length === 0) {
        append(chunk, {});
        return;
      }
      const activities = decoded.flatMap((entry) => entry.activity === undefined ? [] : [entry.activity]);
      const answers = decoded.flatMap((entry) => entry.answer === undefined ? [] : [entry.answer]);
      append(chunk, {
        ...(activities.length === 0 ? {} : { activity: activities.join(" · ") }),
        ...(answers.length === 0
          ? {}
          : {
              answer: answers.join(""),
              answer_mode: decoded.some((entry) => entry.answer_mode === "delta") ? "delta" : "complete"
            })
      });
    },
    drain: () => {
      if (!flushed) {
        flushed = true;
        for (const stream of ["stdout", "stderr"] as const) {
          for (const visible of decoders[stream].flush()) {
            append({ stream, text: "" }, visible);
          }
        }
      }
      return tail;
    }
  };
}

export async function appendTaskOutput(
  repoRoot: string,
  input: TaskOutputInput
): Promise<{ ok: true; value: TaskOutputRecord } | { ok: false; reason: string }> {
  const validation = validateTaskOutputInput(input);
  if (!validation.ok) {
    return validation;
  }

  /* One chunk can carry several JSONL lines, so the readable account is the
     lines it contains, joined. Absent when it contains nothing worth showing. */
  const activity = input.visible?.activity ?? (input.visible === undefined ? activityLines([input.text]).join(" · ") : "");
  const record: TaskOutputRecord = {
    ts: new Date().toISOString(),
    task_id: input.task_id,
    tool: input.tool,
    stream: input.stream,
    text: input.text,
    ...(activity === "" ? {} : { activity }),
    ...(input.visible?.answer === undefined ? {} : { answer: input.visible.answer }),
    ...(input.visible?.answer_mode === undefined ? {} : { answer_mode: input.visible.answer_mode })
  };

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    return { ok: false, reason: "task output data must be JSON serializable" };
  }

  // Worker stdout is the largest thing written anywhere in the system -- lines
  // of 23,408 bytes are in this repository's own captured trail -- and this
  // path previously had no serialisation at all, not even in-process.
  const appended = await appendTrailLine(taskOutputLogPath(repoRoot, input.task_id), line);
  if (!appended.ok) {
    return appended;
  }
  /* Told once, here. A writer that appends without publishing is invisible to
     every subscriber until the next reconnect, which is the bug this closes. */
  publisher?.(record);
  return { ok: true, value: record };
}

export async function readTaskOutput(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: TaskOutputRecord[] } | { ok: false; reason: string; damage?: TrailDamage }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return { ok: false, reason: taskIdResult.reason };
  }

  return readTrail<TaskOutputRecord>(
    repoRoot,
    taskOutputLogPath(repoRoot, taskId),
    taskOutputRelativePath(taskId),
    (value) => validateTaskOutputShape(value, taskId),
    taskOutputRepairCommand(taskId)
  );
}

export function taskOutputRepairCommand(taskId: string): string {
  return `hivemind events repair --task ${taskId}`;
}

/**
 * Removes an interrupted trailing append from a task's output stream.
 *
 * Unlike the event trail this does not record itself, because the output
 * stream is a record of what a provider printed rather than a record anything
 * derives a guarantee from -- and appending a repair notice into a worker's
 * stdout would put a Hivemind sentence in the provider's mouth. The event
 * trail is where the repair is recorded.
 */
export async function repairTaskOutput(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: TrailRepair | null } | { ok: false; reason: string }> {
  const read = await readTaskOutput(repoRoot, taskId);
  if (read.ok) {
    return { ok: true, value: null };
  }
  if (read.damage === undefined) {
    return { ok: false, reason: read.reason };
  }
  return repairTrail(
    taskOutputLogPath(repoRoot, taskId),
    taskOutputRelativePath(taskId),
    read.damage,
    new Date().toISOString().replaceAll(":", "-")
  );
}

export function taskOutputRelativePath(taskId: string): string {
  return `.hivemind/log/tasks/${taskId}.output.jsonl`;
}

function taskOutputLogPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".hivemind", "log", "tasks", `${taskId}.output.jsonl`);
}

function validateTaskOutputInput(input: TaskOutputInput): { ok: true } | { ok: false; reason: string } {
  const taskIdResult = validateRequestedTaskId(input.task_id);
  if (!taskIdResult.ok) {
    return { ok: false, reason: `task output task_id is invalid: ${taskIdResult.reason}` };
  }
  if (typeof input.tool !== "string" || input.tool.trim() === "") {
    return { ok: false, reason: "task output tool must be a non-empty string" };
  }
  if (input.stream !== "stdout" && input.stream !== "stderr") {
    return { ok: false, reason: "task output stream must be stdout or stderr" };
  }
  if (typeof input.text !== "string") {
    return { ok: false, reason: "task output text must be a string" };
  }
  if (input.visible !== undefined) {
    if (input.visible.activity !== undefined && typeof input.visible.activity !== "string") {
      return { ok: false, reason: "task output visible activity must be a string" };
    }
    if (input.visible.answer !== undefined && typeof input.visible.answer !== "string") {
      return { ok: false, reason: "task output visible answer must be a string" };
    }
    if (input.visible.answer_mode !== undefined && input.visible.answer_mode !== "complete" && input.visible.answer_mode !== "delta") {
      return { ok: false, reason: "task output visible answer_mode must be complete or delta" };
    }
  }
  return { ok: true };
}

function validateTaskOutputShape(value: unknown, expectedTaskId: string): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "task output record must be a JSON object" };
  }
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) {
    return { ok: false, reason: "task output ts must be an ISO timestamp string" };
  }
  if (value.task_id !== expectedTaskId) {
    return { ok: false, reason: "task output task_id must match the stream task" };
  }
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    return { ok: false, reason: "task output tool must be a non-empty string" };
  }
  if (value.stream !== "stdout" && value.stream !== "stderr") {
    return { ok: false, reason: "task output stream must be stdout or stderr" };
  }
  if (typeof value.text !== "string") {
    return { ok: false, reason: "task output text must be a string" };
  }
  if (value.activity !== undefined && typeof value.activity !== "string") {
    return { ok: false, reason: "task output activity must be a string when present" };
  }
  if (value.answer !== undefined && typeof value.answer !== "string") {
    return { ok: false, reason: "task output answer must be a string when present" };
  }
  if (value.answer_mode !== undefined && value.answer_mode !== "complete" && value.answer_mode !== "delta") {
    return { ok: false, reason: "task output answer_mode must be complete or delta when present" };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

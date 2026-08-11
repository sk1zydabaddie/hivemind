import type { HivemindEvent, OutputRecord } from "./projection";

export interface ActivityGroup {
  event: HivemindEvent;
  count: number;
}

/* Core composes queue titles as "T-001 needs a revision" while the row beside
 * them reads "Initialize CLI package metadata and usage docs". Leading with the
 * identifier is the one rule every other surface follows in reverse.
 *
 * This removes the identifier only when the title literally begins with the
 * exact `task_id` the item already carries -- an exact token this client was
 * handed, not a guess at what Core meant. Anything else is passed through
 * untouched. The durable fix is `taskAttentionTitle` leading with the title
 * Core already has in the contract it just loaded; until then this keeps the
 * two halves of one row from disagreeing.
 */
export interface AttentionHeadline {
  /** What the item is about: the task's title where one is known. */
  headline: string;
  /** What happened to it, with the identifier stripped where it led. */
  predicate: string | null;
  /** Shown as secondary detail, never as the headline. */
  taskId: string | null;
}

export function attentionHeadline(
  item: { title: string; task_id: string | null },
  taskTitles: Record<string, string>
): AttentionHeadline {
  const taskId = item.task_id;
  if (taskId === null) {
    return { headline: item.title, predicate: null, taskId: null };
  }
  const title = taskTitles[taskId];
  const named = title !== undefined && title.trim() !== "" && title !== taskId;
  if (!named) {
    return { headline: item.title, predicate: null, taskId };
  }
  const prefix = `${taskId} `;
  const predicate = item.title.startsWith(prefix)
    ? item.title.slice(prefix.length)
    : item.title;
  return { headline: title, predicate, taskId };
}

export function groupConsecutiveActivity(eventsNewestFirst: HivemindEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const event of [...eventsNewestFirst].reverse()) {
    const previous = groups.at(-1);
    if (previous?.event.type === event.type && previous.event.task_id === event.task_id) {
      previous.event = event;
      previous.count += 1;
    } else {
      groups.push({ event, count: 1 });
    }
  }
  return groups;
}

export function summarizeWorkerOutput(records: OutputRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    for (const rawLine of stripAnsi(record.text).split(/\r?\n/u)) {
      const line = extractReadableLine(rawLine.trim());
      if (line === null || line === lines.at(-1)) continue;
      lines.push(line);
    }
  }
  if (lines.length === 0) {
    return "No readable worker message yet. Full output contains the provider details.";
  }
  return lines.slice(-12).join("\n");
}

function extractReadableLine(line: string): string | null {
  if (line === "") return null;
  if (!line.startsWith("{")) return line;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const item = asRecord(record.item);
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text.trim();
    if (record.type === "message" && typeof record.text === "string") return record.text.trim();
    if (typeof record.message === "string") return record.message.trim();
    return null;
  } catch {
    return line;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

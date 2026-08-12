import { ANONYMOUS_TASK, stripIdentifiers, taskTitleOrNull } from "./identifiers";
import type { HivemindEvent, OutputRecord } from "./projection";

export interface ActivityGroup {
  event: HivemindEvent;
  count: number;
}

/* Core composes queue titles two ways, and both used to leak.
 *
 * "T-209 stopped" leads with the identifier. "Initialize CLI package metadata
 * and usage docs needs a revision" leads with the title — and the old rule only
 * stripped a literal `${task_id} ` prefix, so the second shape fell through to
 * the predicate untouched and the bar rendered the title, then the whole title
 * again with "T-001" after it. That is the sentence this pass was asked to
 * delete for the fifth time.
 *
 * The rule now: the headline is the task's title; the predicate is whatever the
 * queue title says MINUS the title it just repeated and MINUS every identifier.
 * A task with no known title gets an honest anonymous headline rather than its
 * identifier — trails that predate `task.created` carrying titles cannot name
 * their tasks, and the identifier is not a name.
 */
export interface AttentionHeadline {
  /** What the item is about: the task's title where one is known. */
  headline: string;
  /** What happened to it. Never repeats the headline, never carries an id. */
  predicate: string | null;
}

export function attentionHeadline(
  item: { title: string; task_id: string | null },
  taskTitles: Record<string, string>
): AttentionHeadline {
  const cleanTitle = stripIdentifiers(item.title);
  const taskTitle = taskTitleOrNull(item.task_id, taskTitles);

  if (taskTitle === null) {
    /* No title to lead with. Core's own sentence, scrubbed, is the best thing
       available — and when scrubbing leaves nothing but a predicate ("stopped"),
       the item is named for what it is instead of for a task nobody can name. */
    return cleanTitle === ""
      ? { headline: ANONYMOUS_TASK, predicate: null }
      : item.task_id === null
        ? { headline: cleanTitle, predicate: null }
        : { headline: ANONYMOUS_TASK, predicate: cleanTitle };
  }

  /* Core's title often already contains the task title, because Core composes
     it the same way. Saying it twice in two type sizes reads as a rendering
     bug, which is exactly how it was reported. */
  const predicate = cleanTitle.startsWith(taskTitle)
    ? cleanTitle.slice(taskTitle.length).trim()
    : cleanTitle;
  return {
    headline: taskTitle,
    predicate: predicate === "" || predicate === taskTitle ? null : predicate
  };
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

import type { HivemindEvent, OutputRecord } from "./projection";

export interface ActivityGroup {
  event: HivemindEvent;
  count: number;
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

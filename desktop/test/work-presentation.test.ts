import { describe, expect, test } from "vitest";

import type { HivemindEvent, OutputRecord } from "../src/lib/projection";
import { groupConsecutiveActivity, summarizeWorkerOutput } from "../src/lib/work-presentation";

describe("Work presentation", () => {
  test("collapses only consecutive updates of the same kind and task", () => {
    const groups = groupConsecutiveActivity([
      event("2026-08-01T00:00:03.000Z", "patch.submitted", "T-001"),
      event("2026-08-01T00:00:02.000Z", "task.started", "T-002"),
      event("2026-08-01T00:00:01.000Z", "task.started", "T-001"),
      event("2026-08-01T00:00:00.000Z", "task.started", "T-001")
    ]);

    expect(groups.map((group) => [group.event.type, group.event.task_id, group.count])).toEqual([
      ["task.started", "T-001", 2],
      ["task.started", "T-002", 1],
      ["patch.submitted", "T-001", 1]
    ]);
  });

  test("shows model messages by default while leaving telemetry for full output", () => {
    const records: OutputRecord[] = [
      output('{"type":"thread.started","thread_id":"abc"}'),
      output('{"type":"item.completed","item":{"type":"agent_message","text":"Implemented the parser."}}'),
      output('{"type":"item.completed","item":{"type":"agent_message","text":"Implemented the parser."}}'),
      output("\u001b[32m7 tests passed\u001b[0m")
    ];

    expect(summarizeWorkerOutput(records)).toBe("Implemented the parser.\n7 tests passed");
  });
});

function event(ts: string, type: string, taskId: string): HivemindEvent {
  return { ts, type, task_id: taskId, data: {} };
}

function output(text: string): OutputRecord {
  return { ts: "2026-08-01T00:00:00.000Z", task_id: "T-001", tool: "fixture", stream: "stdout", text };
}

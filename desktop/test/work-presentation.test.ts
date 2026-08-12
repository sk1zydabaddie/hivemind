import { describe, expect, test } from "vitest";

import type { HivemindEvent, OutputRecord } from "../src/lib/projection";
import {
  attentionHeadline,
  groupConsecutiveActivity,
  summarizeWorkerOutput
} from "../src/lib/work-presentation";

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

/* These are the exact titles Core wrote on the captured trails in
   docs/evidence, which is why they read the way they do. */
describe("what a needs-you item is called", () => {
  const titles = { "T-001": "Initialize CLI package metadata and usage docs" };

  test("leads with the task's title and drops the identifier entirely", () => {
    expect(attentionHeadline({ title: "T-001 needs a revision", task_id: "T-001" }, titles)).toEqual({
      headline: "Initialize CLI package metadata and usage docs",
      predicate: "needs a revision"
    });
  });

  /* The shape the brief quoted. Core composes the title from the task title,
     so the bar used to render it, then render the whole of it again as the
     predicate, then append "T-001" to that. */
  test("does not say the task's name twice when Core already said it", () => {
    expect(
      attentionHeadline(
        {
          title: "Initialize CLI package metadata and usage docs needs a revision",
          task_id: "T-001"
        },
        titles
      )
    ).toEqual({
      headline: "Initialize CLI package metadata and usage docs",
      predicate: "needs a revision"
    });
  });

  test("passes a title through untouched when it does not lead with the identifier", () => {
    expect(
      attentionHeadline({ title: "Something else entirely", task_id: "T-001" }, titles).predicate
    ).toBe("Something else entirely");
  });

  test("names an unnameable task rather than numbering it", () => {
    /* A trail with no `task.created` cannot name its tasks. The identifier is
       not a name and is never the answer; "one of the tasks" plus Core's own
       predicate is what is actually known. */
    expect(attentionHeadline({ title: "T-209 stopped", task_id: "T-209" }, titles)).toEqual({
      headline: "One of the tasks",
      predicate: "stopped"
    });
  });

  test("leaves run-level items alone, because they are about no one task", () => {
    const item = { title: "This change needs fresh checks before it can merge", task_id: null };
    expect(attentionHeadline(item, titles)).toEqual({
      headline: item.title,
      predicate: null
    });
  });

  test("does not mistake a title that merely starts with the same characters", () => {
    // "T-1" must not be stripped from a task whose id is "T-10".
    expect(
      attentionHeadline({ title: "T-10 needs a revision", task_id: "T-10" }, { "T-10": "Real title" })
        .predicate
    ).toBe("needs a revision");
  });
});

function event(ts: string, type: string, taskId: string): HivemindEvent {
  return { ts, type, task_id: taskId, data: {} };
}

function output(text: string): OutputRecord {
  return { ts: "2026-08-01T00:00:00.000Z", task_id: "T-001", tool: "fixture", stream: "stdout", text };
}

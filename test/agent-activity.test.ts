import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamDecoder, activityLine, activityLines } from "../src/agent-activity.js";

/* ── What is actually available ────────────────────────────────────────────
 *
 * `codex exec --json` emits COMPLETED items, never token deltas: a captured
 * drafting call shows thread.started at t+1.0s, turn.started at t+1.1s, then
 * ONE item.completed carrying the whole message at t+5.1s. There is no delta
 * event and no flag that adds one. So progressive TEXT is not something wiring
 * can deliver, and a surface that promised it would be lying.
 *
 * What is progressive is the items. A worker doing real work produces many, and
 * this is what turns them into an account a person can read.
 */
test("the steps of a working agent read as an account of the work", () => {
  const lines = activityLines([
    '{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}\n',
    '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}\n',
    '{"type":"item.completed","item":{"type":"file_change","path":"src/index.js"}}\n',
    '{"type":"item.completed","item":{"type":"agent_message","text":"All done."}}\n',
    '{"type":"turn.completed","usage":{"input_tokens":100}}\n'
  ]);
  assert.deepEqual(lines, ["Starting", "Thinking", "Running npm test", "Editing src/index.js"]);
});

/* The reply is shown as the reply. Repeating it as an activity line would print
   the same sentence twice on one surface. */
test("the answer itself is not also an activity line", () => {
  assert.equal(
    activityLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}'),
    null
  );
});

/* The raw stream is provider JSONL and a person should never see it. */
test("nothing unrecognised leaks through as text", () => {
  for (const raw of [
    '{"type":"turn.completed","usage":{"input_tokens":21652}}',
    '2026-08-25T23:47:00Z ERROR codex_models_manager: failed to load models cache',
    "{",
    "{",
    ""
  ]) {
    const line = activityLine(raw);
    assert.ok(line === null || !line.includes("{"), `leaked: ${line}`);
  }
});

test("a JSONL record split across operating-system chunks is retained", () => {
  const decoder = new AgentStreamDecoder();
  assert.deepEqual(decoder.push('{"type":"turn.'), []);
  assert.deepEqual(decoder.push('started"}\n'), [{ activity: "Thinking" }]);
});

test("safe plain-text progress remains visible", () => {
  const decoder = new AgentStreamDecoder();
  assert.deepEqual(decoder.push("Inspecting project files"), [{ activity: "Inspecting project files" }]);
});

test("Claude, Grok-compatible, and OpenCode shapes normalize without leaking envelopes", () => {
  const decoder = new AgentStreamDecoder();
  const visible = [
    ...decoder.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n'),
    ...decoder.push('{"type":"content_block_delta","delta":{"text":"Hello "}}\n'),
    ...decoder.push('{"type":"text_delta","text":"from Grok"}\n'),
    ...decoder.push('{"type":"step-start"}\n'),
    ...decoder.push('{"type":"message.part.updated","part":{"type":"tool","tool":"search"}}\n')
  ];
  assert.deepEqual(visible, [
    { activity: "Using Read" },
    { answer: "Hello ", answer_mode: "delta" },
    { answer: "from Grok", answer_mode: "delta" },
    { activity: "Thinking" },
    { activity: "Using search" }
  ]);
});

test("structured provider replies expose reply text but never their JSON envelope", () => {
  const decoder = new AgentStreamDecoder({ structuredAnswers: true });
  assert.deepEqual(
    decoder.push('{"kind":"reply","reply":"Direct answer."}'),
    [{ answer: "Direct answer.", answer_mode: "complete" }]
  );
  assert.deepEqual(
    decoder.push('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"kind\\":\\"reply\\",\\"reply\\":\\"Visible answer.\\"}"}}\n'),
    [{ answer: "Visible answer.", answer_mode: "complete" }]
  );
  assert.deepEqual(
    decoder.push('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"kind\\":\\"draft\\",\\"title\\":\\"Hidden schema\\"}"}}\n'),
    []
  );
});

test("structured JSON split across provider deltas is buffered until it is safe", () => {
  const decoder = new AgentStreamDecoder({ structuredAnswers: true });
  assert.deepEqual(decoder.push('{"type":"content_block_delta","delta":{"text":"{\\"kind\\":\\"reply\\","}}\n'), []);
  assert.deepEqual(
    decoder.push('{"type":"content_block_delta","delta":{"text":"\\"reply\\":\\"Across chunks.\\"}"}}\n'),
    [{ answer: "Across chunks.", answer_mode: "complete" }]
  );
});

/* "Thinking / Thinking / Thinking" is a stutter, not progress. */
test("a repeated state is said once", () => {
  const lines = activityLines([
    '{"type":"item.completed","item":{"type":"reasoning"}}\n{"type":"item.completed","item":{"type":"reasoning"}}\n'
  ]);
  assert.deepEqual(lines, ["Thinking"]);
});

test("a tool call and an error both say what happened", () => {
  assert.match(
    activityLine('{"type":"item.completed","item":{"type":"mcp_tool_call","name":"search"}}') ?? "",
    /Using search/u
  );
  assert.match(
    activityLine('{"type":"item.completed","item":{"type":"error","message":"disk full"}}') ?? "",
    /Hit an error: disk full/u
  );
});

/* A long command is shortened rather than allowed to run off the surface. */
test("a long command is shortened", () => {
  const long = "npm run something ".repeat(20);
  const line = activityLine(
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: long } })
  );
  assert.ok((line ?? "").length < 80, line ?? "");
  assert.match(line ?? "", /…$/u);
});

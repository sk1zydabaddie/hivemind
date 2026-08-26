/**
 * What an agent is doing, in a line a person can read.
 *
 * ## What is actually available
 *
 * `codex exec --json` does not stream text as it is generated. It emits
 * COMPLETED items: `thread.started`, `turn.started`, then one
 * `item.completed` carrying the whole message, then `turn.completed`. There is
 * no delta event and no flag that adds one -- checked against the CLI's own
 * help. So "watch the words appear" is not something wiring can deliver here,
 * and saying otherwise would be the interface lying about what it is.
 *
 * What IS progressive is the ITEMS. A planner answering a question produces one,
 * so its reply arrives at once and only the indicator can be honest about the
 * wait. A worker doing real work produces many -- a command run, a file read, a
 * patch applied, a reasoning step -- each landing the moment it finishes, over
 * the minutes the work takes. That is a real account of what an agent is doing,
 * and it is what this turns the raw stream into.
 *
 * ## Why this lives in Core
 *
 * It is knowledge of a harness's output shapes, which is the same knowledge the
 * usage parser already holds. A surface reading raw JSONL and deciding what it
 * means would be the client becoming the authority on a provider's format --
 * the coupling the thin-client boundary exists to prevent.
 */

/** One readable thing an agent did, or null when the line carries nothing to say. */
export function activityLine(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;

  /* Not JSON: the harness's own stderr chatter. Kept only when it looks like a
     sentence rather than a stack trace, because a person watching an agent work
     does not need its logging framework. */
  if (!text.startsWith("{")) {
    return /^\s*(?:\d{4}-\d\d-\d\dT|\s*at )/u.test(text) ? null : null;
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof record.type === "string" ? record.type : "";
  if (type === "thread.started") return "Starting";
  if (type === "turn.started") return "Thinking";
  if (type === "turn.completed") return null;
  if (type !== "item.completed" && type !== "item.started") return null;

  const item = isRecord(record.item) ? record.item : {};
  const itemType = typeof item.type === "string" ? item.type : "";

  if (itemType === "reasoning") return "Thinking";
  if (itemType === "agent_message") {
    /* The message itself is the answer, not an activity line. The surface shows
       it as the reply; repeating it here would print it twice. */
    return null;
  }
  if (itemType === "command_execution" || itemType === "local_shell_call") {
    const command = firstString(item.command, item.parsed_cmd);
    return command === null ? "Running a command" : `Running ${shorten(command)}`;
  }
  if (itemType === "file_change" || itemType === "patch_apply") {
    const path = firstString(item.path, item.file);
    return path === null ? "Editing files" : `Editing ${shorten(path)}`;
  }
  if (itemType === "mcp_tool_call" || itemType === "function_call" || itemType === "custom_tool_call") {
    const name = firstString(item.name, item.tool);
    return name === null ? "Using a tool" : `Using ${shorten(name)}`;
  }
  if (itemType === "todo_list") return "Planning its steps";
  if (itemType === "web_search") return "Searching";
  if (itemType === "error") {
    const message = firstString(item.message);
    return message === null ? "Hit an error" : `Hit an error: ${shorten(message, 90)}`;
  }
  return null;
}

/**
 * The activity lines from a run of raw output, in order, without repeating
 * whatever it was already doing.
 *
 * Consecutive duplicates are collapsed because "Thinking / Thinking / Thinking"
 * says the same thing three times and reads as a stutter rather than as
 * progress.
 */
export function activityLines(chunks: readonly string[]): string[] {
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const raw of chunk.split("\n")) {
      const line = activityLine(raw);
      if (line === null || line === lines.at(-1)) continue;
      lines.push(line);
    }
  }
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (Array.isArray(value)) {
      const joined = value.filter((entry): entry is string => typeof entry === "string").join(" ");
      if (joined.trim() !== "") return joined.trim();
    }
  }
  return null;
}

function shorten(value: string, limit = 60): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

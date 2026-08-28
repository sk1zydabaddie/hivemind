/**
 * Provider-neutral user-visible output.
 *
 * Raw process chunks are transport fragments, not records. This decoder owns
 * the carry buffer for one provider process and emits only complete JSONL
 * records (or bounded readable plain text). Hidden reasoning and raw provider
 * envelopes never cross into the client.
 */

export interface AgentVisibleOutput {
  activity?: string;
  /** User-visible answer text. Complete messages and true deltas are distinct. */
  answer?: string;
  answer_mode?: "complete" | "delta";
}

export class AgentStreamDecoder {
  private carry = "";
  private lastActivity = "";
  private structuredAnswer = "";

  constructor(private readonly options: { structuredAnswers?: boolean } = {}) {}

  push(chunk: string): AgentVisibleOutput[] {
    if (chunk === "") return [];
    this.carry += chunk;
    const output: AgentVisibleOutput[] = [];
    while (true) {
      const newline = this.carry.indexOf("\n");
      if (newline === -1) break;
      const record = this.carry.slice(0, newline).replace(/\r$/u, "");
      this.carry = this.carry.slice(newline + 1);
      this.decodeRecord(record, output);
    }

    /* Some CLIs emit one JSON object without a trailing newline. Decode it as
       soon as it is complete, while retaining a genuinely split record. */
    const pending = this.carry.trim();
    if (pending.startsWith("{") && parsesAsRecord(pending)) {
      this.carry = "";
      this.decodeRecord(pending, output);
    } else if (pending !== "" && !pending.startsWith("{")) {
      /* Plain progress has no framing contract. A process chunk is therefore
         the only honest liveness boundary available; retain it immediately. */
      this.carry = "";
      this.decodeRecord(pending, output);
    }
    return output;
  }

  flush(): AgentVisibleOutput[] {
    const output: AgentVisibleOutput[] = [];
    const pending = this.carry;
    this.carry = "";
    this.decodeRecord(pending, output);
    return output;
  }

  private decodeRecord(raw: string, output: AgentVisibleOutput[]): void {
    const decoded = decodeAgentRecord(raw);
    if (decoded === null) return;
    if (decoded.activity !== undefined) {
      if (decoded.activity === this.lastActivity) {
        delete decoded.activity;
      } else {
        this.lastActivity = decoded.activity;
      }
    }
    if (this.options.structuredAnswers === true && decoded.answer !== undefined) {
      const normalized = this.normalizeStructuredAnswer(decoded);
      if (normalized.activity !== undefined || normalized.answer !== undefined) output.push(normalized);
      return;
    }
    if (decoded.activity !== undefined || decoded.answer !== undefined) output.push(decoded);
  }

  private normalizeStructuredAnswer(decoded: AgentVisibleOutput): AgentVisibleOutput {
    const answer = decoded.answer ?? "";
    if (decoded.answer_mode === "delta" && (this.structuredAnswer !== "" || answer.trimStart().startsWith("{"))) {
      this.structuredAnswer += answer;
      const visible = structuredVisibleAnswer(this.structuredAnswer);
      if (visible.state === "incomplete") return withoutAnswer(decoded);
      this.structuredAnswer = "";
      return visible.state === "reply"
        ? { ...withoutAnswer(decoded), answer: visible.text, answer_mode: "complete" }
        : withoutAnswer(decoded);
    }
    const visible = structuredVisibleAnswer(answer);
    if (visible.state === "reply") {
      return { ...withoutAnswer(decoded), answer: visible.text, answer_mode: "complete" };
    }
    return visible.state === "not_json" ? decoded : withoutAnswer(decoded);
  }
}

/** One complete provider record, retained for focused tests and legacy callers. */
export function decodeAgentRecord(raw: string): AgentVisibleOutput | null {
  const text = raw.trim();
  if (text === "") return null;
  if (!text.startsWith("{")) {
    const activity = safePlainProgress(text);
    return activity === null ? null : { activity };
  }

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    record = parsed;
  } catch {
    return null;
  }

  const type = string(record.type) ?? string(record.event) ?? "";

  /* Some adapters expose the requested schema directly instead of wrapping it
     in a provider event. Only the conversational reply field is visible; all
     other schema objects remain internal orchestration output. */
  if (record.kind === "reply" && typeof record.reply === "string" && record.reply.trim() !== "") {
    return { answer: record.reply, answer_mode: "complete" };
  }

  /* Codex JSONL. */
  if (type === "thread.started") return { activity: "Starting" };
  if (type === "turn.started") return { activity: "Thinking" };
  if (type === "turn.completed" || type === "result") return null;
  if (type === "item.completed" || type === "item.started") {
    const item = isRecord(record.item) ? record.item : {};
    return decodeItem(item, type === "item.completed");
  }

  /* Anthropic Messages events (Grok Build and compatible Kimi/OpenCode
     adapters may expose this wire shape) plus Claude Code stream-json. */
  if (type === "message_start" || type === "message_delta") return { activity: "Thinking" };
  if (type === "content_block_start") {
    const block = isRecord(record.content_block) ? record.content_block : {};
    if (block.type === "tool_use") {
      const name = string(block.name);
      return { activity: name === null ? "Using a tool" : `Using ${shorten(name)}` };
    }
    const initial = string(block.text);
    return initial === null ? null : { answer: initial, answer_mode: "delta" };
  }
  if (type === "content_block_delta") {
    const delta = isRecord(record.delta) ? record.delta : {};
    const answer = string(delta.text);
    return answer === null ? null : { answer, answer_mode: "delta" };
  }
  if (type === "assistant") {
    const message = isRecord(record.message) ? record.message : record;
    const content = Array.isArray(message.content) ? message.content : [];
    const tool = content.find((entry) => isRecord(entry) && entry.type === "tool_use");
    if (isRecord(tool)) {
      const name = string(tool.name);
      return { activity: name === null ? "Using a tool" : `Using ${shorten(name)}` };
    }
    const answer = content
      .filter(isRecord)
      .filter((entry) => entry.type === "text")
      .map((entry) => string(entry.text) ?? "")
      .join("");
    return answer === "" ? { activity: "Thinking" } : { answer, answer_mode: "complete" };
  }

  /* OpenCode/Kimi event variants. Their versions have used both a top-level
     part and a nested part payload. Unknown records remain hidden. */
  if (type === "step_start" || type === "step-start" || type === "session.start") {
    return { activity: "Thinking" };
  }
  const part = isRecord(record.part)
    ? record.part
    : isRecord(record.data) && isRecord(record.data.part)
      ? record.data.part
      : null;
  if (part !== null) {
    if (part.type === "tool" || part.type === "tool_use") {
      const name = string(part.tool) ?? string(part.name);
      return { activity: name === null ? "Using a tool" : `Using ${shorten(name)}` };
    }
    if (part.type === "text") {
      const answer = string(part.text);
      return answer === null ? null : { answer, answer_mode: "delta" };
    }
  }
  if (type === "text" || type === "text-delta" || type === "text_delta") {
    const answer = string(record.text) ?? (isRecord(record.delta) ? string(record.delta.text) : null);
    return answer === null ? null : { answer, answer_mode: type === "text" ? "complete" : "delta" };
  }
  return null;
}

/** Backwards-compatible activity-only helpers. */
export function activityLine(raw: string): string | null {
  return decodeAgentRecord(raw)?.activity ?? null;
}

export function activityLines(chunks: readonly string[]): string[] {
  const decoder = new AgentStreamDecoder();
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const decoded of decoder.push(chunk)) {
      if (decoded.activity !== undefined) lines.push(decoded.activity);
    }
  }
  for (const decoded of decoder.flush()) {
    if (decoded.activity !== undefined) lines.push(decoded.activity);
  }
  return lines;
}

function decodeItem(item: Record<string, unknown>, completed: boolean): AgentVisibleOutput | null {
  const type = string(item.type) ?? "";
  if (type === "reasoning") return { activity: "Thinking" };
  if (type === "agent_message") {
    const answer = string(item.text);
    return !completed || answer === null ? null : { answer, answer_mode: "complete" };
  }
  if (type === "command_execution" || type === "local_shell_call") {
    const command = firstString(item.command, item.parsed_cmd);
    return { activity: command === null ? "Running a command" : `Running ${shorten(command)}` };
  }
  if (type === "file_change" || type === "patch_apply") {
    const file = firstString(item.path, item.file);
    return { activity: file === null ? "Editing files" : `Editing ${shorten(file)}` };
  }
  if (type === "mcp_tool_call" || type === "function_call" || type === "custom_tool_call") {
    const name = firstString(item.name, item.tool);
    return { activity: name === null ? "Using a tool" : `Using ${shorten(name)}` };
  }
  if (type === "todo_list") return { activity: "Planning its steps" };
  if (type === "web_search") return { activity: "Searching" };
  if (type === "error") {
    const message = string(item.message);
    return { activity: message === null ? "Hit an error" : `Hit an error: ${shorten(message, 90)}` };
  }
  return null;
}

function withoutAnswer(decoded: AgentVisibleOutput): AgentVisibleOutput {
  return decoded.activity === undefined ? {} : { activity: decoded.activity };
}

function structuredVisibleAnswer(value: string):
  | { state: "reply"; text: string }
  | { state: "hidden" | "incomplete" | "not_json" } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return { state: "not_json" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return { state: "hidden" };
    return parsed.kind === "reply" && typeof parsed.reply === "string" && parsed.reply.trim() !== ""
      ? { state: "reply", text: parsed.reply }
      : { state: "hidden" };
  } catch {
    return { state: "incomplete" };
  }
}

function safePlainProgress(value: string): string | null {
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat === "" || flat.length > 240) return null;
  if (/^(?:\d{4}-\d\d-\d\dT|at\s|Error:|node:|\[stack\])/iu.test(flat)) return null;
  if (/[{}\[\]]/u.test(flat)) return null;
  return shorten(flat, 120);
}

function parsesAsRecord(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const direct = string(value);
    if (direct !== null) return direct;
    if (Array.isArray(value)) {
      const joined = value.filter((entry): entry is string => typeof entry === "string").join(" ").trim();
      if (joined !== "") return joined;
    }
  }
  return null;
}

function shorten(value: string, limit = 60): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { currentConversationBoundary } from "./conversation-control.js";
import { isNodeError } from "./error-detail.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { isRecord } from "./json.js";
import { withPathLock } from "./lease-lock.js";
import { parseConversationAttachments, type ConversationAttachment } from "./spec-draft-action.js";

/** Advisory, unsent user input only. No event, task, plan or approval is written. */
export interface ConversationDraft {
  content_id: string;
  text: string;
  attachments: ConversationAttachment[];
  submission: { request_id: string; content_id: string } | null;
}

export interface ConversationDraftView {
  conversation_id: string;
  revision: string | null;
  draft: ConversationDraft;
  receipt: { request_id: string; accepted: boolean; finished: boolean } | null;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
const MAX_RECORD_BYTES = 256 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseDraft(value: unknown): Result<ConversationDraft> {
  if (!isRecord(value) || Object.keys(value).length !== 4 ||
      typeof value.content_id !== "string" || !uuid.test(value.content_id) ||
      typeof value.text !== "string" || !Array.isArray(value.attachments) ||
      Object.keys(value).some(key => !["content_id", "text", "attachments", "submission"].includes(key))) {
    return { ok: false, reason: "The saved draft must contain only its text, attachments, content identity and submission identity." };
  }
  const attachments = parseConversationAttachments(value.attachments);
  if (!attachments.ok) return attachments;
  const submission = value.submission;
  if (submission !== null && (!isRecord(submission) || Object.keys(submission).length !== 2 ||
      typeof submission.request_id !== "string" || !uuid.test(submission.request_id) ||
      typeof submission.content_id !== "string" || !uuid.test(submission.content_id))) {
    return { ok: false, reason: "The saved draft has an invalid submission identity." };
  }
  const draft = { content_id: value.content_id, text: value.text, attachments: attachments.value,
    submission: submission as ConversationDraft["submission"] };
  // Reserve space for the record envelope. Refuse, never silently truncate input.
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > MAX_RECORD_BYTES - 1024) {
    return { ok: false, reason: "This draft is too large to save (256 KiB including attachments). Shorten it or keep a copy before leaving." };
  }
  return { ok: true, value: draft };
}

/** Fixed, hash-named private storage: caller input is never a filesystem path. */
async function draftPath(repoRoot: string, conversationId: string, create: boolean): Promise<string> {
  const root = await realpath(repoRoot);
  const name = `${createHash("sha256").update(conversationId).digest("hex")}.json`;
  let directory = root;
  for (const segment of [".hivemind", "ui", "conversation-drafts"]) {
    directory = path.join(directory, segment);
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Draft storage must be an ordinary project-local directory.");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      // .hivemind must already be an initialized project's directory.
      if (segment === ".hivemind") throw new Error("Initialize the project before saving drafts.");
      if (!create) return path.join(root, ".hivemind", "ui", "conversation-drafts", name);
      await mkdir(directory).catch(error => { if (!isNodeError(error, "EEXIST")) throw error; });
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Draft storage changed while opening it.");
    }
  }
  return path.join(directory, name);
}

async function readDraft(filePath: string, conversationId: string): Promise<Result<ConversationDraftView>> {
  try {
    const before = await lstat(filePath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error("Draft storage cannot use links or non-file entries.");
    const handle = await open(filePath, "r");
    let text: string;
    try {
      const info = await handle.stat();
      if (info.dev !== before.dev || info.ino !== before.ino || !info.isFile() || info.nlink !== 1 || info.size > MAX_RECORD_BYTES) {
        throw new Error("The saved draft changed or exceeds its 256 KiB limit.");
      }
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) {
        throw new Error("The saved draft changed while reading it. Retry loading it.");
      }
      text = buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
    let record: unknown;
    try { record = JSON.parse(text); }
    catch { return { ok: false, reason: "The saved draft is not valid JSON. It was not overwritten." }; }
    if (!isRecord(record) || record.version !== 1 || record.conversation_id !== conversationId ||
        typeof record.revision !== "string" || !uuid.test(record.revision) ||
        Object.keys(record).some(key => !["version", "conversation_id", "revision", "draft"].includes(key))) {
      return { ok: false, reason: "The saved draft has an invalid identity or format. It was not overwritten." };
    }
    const parsed = parseDraft(record.draft);
    return parsed.ok ? { ok: true, value: { conversation_id: conversationId, revision: record.revision, draft: parsed.value, receipt: null } } : parsed;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: { conversation_id: conversationId, revision: null,
        draft: { content_id: randomUUID(), text: "", attachments: [], submission: null }, receipt: null } };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function withReceipt(view: ConversationDraftView, events: HivemindEvent[]): ConversationDraftView {
  const submission = view.draft.submission;
  if (submission === null) return view;
  const accepted = events.some(event => event.type === "conversation.message_recorded" &&
    event.data.request_id === submission.request_id &&
    (event.data.conversation_id ?? "legacy") === view.conversation_id);
  const finished = events.some(event => event.type === "conversation.operation_finished" && event.data.request_id === submission.request_id);
  return { ...view, receipt: { request_id: submission.request_id, accepted, finished },
    draft: accepted && view.draft.content_id === submission.content_id
      ? { ...view.draft, text: "", attachments: [] } : view.draft };
}

export async function inspectConversationDraft(repoRoot: string, payload: Record<string, unknown>): Promise<Result<ConversationDraftView>> {
  if (Object.keys(payload).length !== 1 || typeof payload.conversation_id !== "string") {
    return { ok: false, reason: "draft.inspect requires only the conversation identity." };
  }
  return accessDraft(repoRoot, payload.conversation_id, null);
}

export async function saveConversationDraft(repoRoot: string, payload: Record<string, unknown>): Promise<Result<ConversationDraftView>> {
  if (Object.keys(payload).length !== 3 || typeof payload.conversation_id !== "string" ||
      !(payload.expected_revision === null || typeof payload.expected_revision === "string" && uuid.test(payload.expected_revision))) {
    return { ok: false, reason: "draft.save requires the conversation identity, expected revision and draft." };
  }
  const parsed = parseDraft(payload.draft);
  if (!parsed.ok) return parsed;
  return accessDraft(repoRoot, payload.conversation_id, { revision: payload.expected_revision, draft: parsed.value });
}

async function accessDraft(repoRoot: string, conversationId: string,
  save: { revision: string | null; draft: ConversationDraft } | null): Promise<Result<ConversationDraftView>> {
  try {
    const events = await readEvents(repoRoot);
    if (!events.ok) return events;
    const boundary = currentConversationBoundary(events.value);
    if (!boundary.ok) return boundary;
    if (conversationId !== boundary.value.conversation_id) {
      return { ok: false, reason: "This draft belongs to a different conversation. Its saved copy has been retained." };
    }
    const filePath = await draftPath(repoRoot, conversationId, save !== null);
    if (save === null) {
      const current = await readDraft(filePath, conversationId);
      return current.ok ? { ok: true, value: withReceipt(current.value, events.value) } : current;
    }
    return await withPathLock(`${filePath}.lock`, async () => {
      const current = await readDraft(filePath, conversationId);
      if (!current.ok) return current;
      if (current.value.revision !== save.revision) {
        return { ok: false, reason: "This draft changed in another window. Your current text is still here; copy it before reloading the saved draft." };
      }
      const view = withReceipt({ conversation_id: conversationId, revision: randomUUID(), draft: save.draft, receipt: null }, events.value);
      const record = { version: 1, conversation_id: conversationId, revision: view.revision, draft: view.draft };
      if (Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8") > MAX_RECORD_BYTES) {
        return { ok: false, reason: "This draft is too large to save (256 KiB including attachments). Shorten it or keep a copy before leaving." };
      }
      await writeJsonAtomic(filePath, record);
      return { ok: true, value: view };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

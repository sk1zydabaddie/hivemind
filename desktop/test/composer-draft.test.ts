import { describe, expect, test, vi } from "vitest";
import { ComposerDraftSession, type ConversationDraftView } from "../src/lib/composer-draft";
import type { WorkspaceAction } from "../src/lib/workspace-actions";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function storage(conversationId = "legacy") {
  let saved: ConversationDraftView = { conversation_id: conversationId, revision: null,
    draft: { content_id: crypto.randomUUID(), text: "", attachments: [], submission: null }, receipt: null };
  let delaySave: Promise<void> | null = null;
  let failure: string | null = null;
  const requests: WorkspaceAction[] = [];
  const action = async <T,>(request: WorkspaceAction): Promise<T> => {
    requests.push(structuredClone(request));
    if (failure !== null) throw new Error(failure);
    if (request.type === "draft.inspect") return structuredClone(saved) as T;
    if (request.type !== "draft.save") throw new Error(`Unexpected action: ${request.type}`);
    const waiting = delaySave;
    delaySave = null;
    if (waiting !== null) await waiting;
    expect(request.payload.conversation_id).toBe(conversationId);
    if (request.payload.expected_revision !== saved.revision) throw new Error("Another window changed this draft");
    saved = { ...saved, revision: crypto.randomUUID(), draft: structuredClone(request.payload.draft) as ConversationDraftView["draft"] };
    return structuredClone(saved) as T;
  };
  return {
    action, requests,
    read: () => structuredClone(saved),
    delay: (promise: Promise<void>) => { delaySave = promise; },
    fail: (message: string | null) => { failure = message; },
    receipt: (accepted: boolean, finished: boolean) => {
      const submission = saved.draft.submission!;
      saved.receipt = { request_id: submission.request_id, accepted, finished };
      if (accepted && saved.draft.content_id === submission.content_id) saved.draft = { ...saved.draft, text: "", attachments: [] };
    }
  };
}

describe("project-owned unsent composer draft", () => {
  test("tab consumers share text and attachments, and a new session reloads the saved record", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    const notify = vi.fn();
    const leaveWork = session.subscribe(notify);
    session.update(draft => ({ ...draft, text: "Keep both paragraphs\n\nwhile I inspect Agents", attachments: [{ kind: "folder", path: "src" }] }));
    leaveWork();
    const agentsConsumer = session.getSnapshot();
    expect(agentsConsumer.view?.draft.text).toContain("both paragraphs");
    expect(agentsConsumer.view?.draft.attachments).toEqual([{ kind: "folder", path: "src" }]);
    await session.flush();
    expect(notify).toHaveBeenCalled();
    const reloaded = new ComposerDraftSession("legacy", disk.action);
    await reloaded.refresh();
    expect(reloaded.getSnapshot().view?.draft).toEqual(session.getSnapshot().view?.draft);
    expect(disk.requests.every(request => ["draft.inspect", "draft.save"].includes(request.type))).toBe(true);
  });

  test("edits during a delayed save use the returned revision and persist the latest content", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    const gate = deferred();
    disk.delay(gate.promise);
    session.update(draft => ({ ...draft, text: "first" }));
    const save = session.flush();
    session.update(draft => ({ ...draft, text: "second" }));
    session.update(draft => ({ ...draft, text: "third", attachments: [{ kind: "file", path: "README.md" }] }));
    expect(session.getSnapshot().view?.draft.text).toBe("third");
    expect(session.unsaved).toBe(true);
    gate.resolve();
    await save;
    expect(disk.read().draft.text).toBe("third");
    expect(disk.read().draft.attachments).toEqual([{ kind: "file", path: "README.md" }]);
    expect(session.unsaved).toBe(false);
    expect(disk.requests.filter(request => request.type === "draft.save")).toHaveLength(2);
  });

  test("late selection completion stays with its originating project and never reaches the selected project's draft", async () => {
    const a = storage();
    const b = storage();
    const oldOwner = new ComposerDraftSession("legacy", a.action);
    const selectedOwner = new ComposerDraftSession("legacy", b.action);
    await Promise.all([oldOwner.refresh(), selectedOwner.refresh()]);
    expect(oldOwner.beginAttachmentSelection()).toBe(true);
    expect(oldOwner.beginAttachmentSelection()).toBe(false);
    expect(oldOwner.canRelease).toBe(false);
    oldOwner.update(draft => ({ ...draft, text: "Do not send until my selection returns" }));
    expect(await oldOwner.beginSubmission()).toBeNull();
    selectedOwner.update(draft => ({ ...draft, text: "project B" }));
    // This is the callback captured when A's native picker opened.
    oldOwner.update(draft => ({ ...draft, attachments: [{ kind: "file", path: "only-in-A.txt" }] }));
    oldOwner.finishAttachmentSelection();
    expect(oldOwner.canRelease).toBe(false);
    await Promise.all([oldOwner.flush(), selectedOwner.flush()]);
    expect(a.read().draft.attachments).toHaveLength(1);
    expect(b.read().draft.attachments).toEqual([]);
    expect(b.read().draft.text).toBe("project B");
    expect(oldOwner.canRelease).toBe(true);
  });

  test("saving a request identity precedes dispatch, blocks a second tab's submit and survives reload", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    session.update(draft => ({ ...draft, text: "  Send once  " }));
    const gate = deferred();
    disk.delay(gate.promise);
    const sending = session.beginSubmission();
    expect(session.getSnapshot().sending).toBe(true);
    expect(await session.beginSubmission()).toBeNull();
    gate.resolve();
    const submitted = await sending;
    expect(submitted?.prompt).toBe("Send once");
    expect(submitted?.request_id).toBe(disk.read().draft.submission?.request_id);
    const reloaded = new ComposerDraftSession("legacy", disk.action);
    await reloaded.refresh();
    const retry = await reloaded.beginSubmission();
    expect(retry?.request_id).toBe(submitted?.request_id);
    expect(retry?.prompt).toBe(submitted?.prompt);
  });

  test("durable receipt clears only the submitted content and a terminal response preserves the next draft", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    session.update(draft => ({ ...draft, text: "first", attachments: [{ kind: "file", path: "first.txt" }] }));
    const first = await session.beginSubmission();
    disk.receipt(true, false);
    await session.refresh();
    expect(session.getSnapshot().view?.draft.text).toBe("");
    expect(session.getSnapshot().view?.draft.attachments).toEqual([]);
    session.update(draft => ({ ...draft, text: "next", attachments: [{ kind: "file", path: "next.txt" }] }));
    await session.flush();
    disk.receipt(true, true);
    await session.finishSubmission();
    expect(session.getSnapshot().sending).toBe(false);
    expect(session.getSnapshot().view?.draft.text).toBe("next");
    expect(session.getSnapshot().view?.draft.attachments).toEqual([{ kind: "file", path: "next.txt" }]);
    const next = await session.beginSubmission();
    expect(next?.request_id).not.toBe(first?.request_id);
    expect(next?.prompt).toBe("next");
  });

  test("save failure leaves unsent input visible, refuses dispatch, and supports retry", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    disk.fail("Disk is full");
    session.update(draft => ({ ...draft, text: "do not lose me" }));
    await expect(session.beginSubmission()).rejects.toThrow("Disk is full");
    expect(session.getSnapshot().view?.draft.text).toBe("do not lose me");
    expect(session.getSnapshot().error).toBe("Disk is full");
    expect(session.getSnapshot().sending).toBe(false);
    expect(session.unsaved).toBe(true);
    disk.fail(null);
    session.update(draft => ({ ...draft, text: "edited after the save failed" }));
    await session.flush();
    expect(session.unsaved).toBe(false);
    expect(session.getSnapshot().error).toBe("");
    expect(disk.read().draft.text).toBe("edited after the save failed");
    const retried = await session.beginSubmission();
    expect(retried?.prompt).toBe("edited after the save failed");
  });

  test("an uncertain older send never consumes changed text as an idempotent duplicate", async () => {
    const disk = storage();
    const session = new ComposerDraftSession("legacy", disk.action);
    await session.refresh();
    session.update(draft => ({ ...draft, text: "uncertain" }));
    await session.beginSubmission();
    await session.finishSubmission();
    session.update(draft => ({ ...draft, text: "new draft" }));
    await expect(session.beginSubmission()).rejects.toThrow("previous send is not confirmed");
    await session.flush();
    expect(disk.read().draft.text).toBe("new draft");
  });

  test("a durable receipt arriving during a slow refresh schedules a fresh read instead of being lost", async () => {
    const disk = storage();
    const gate = deferred();
    const entered = deferred();
    let delayNextRead = false;
    const session = new ComposerDraftSession("legacy", async <T,>(action: WorkspaceAction): Promise<T> => {
      const result = await disk.action<T>(action);
      if (action.type === "draft.inspect" && delayNextRead) {
        delayNextRead = false;
        entered.resolve();
        await gate.promise;
      }
      return result;
    });
    await session.refresh();
    session.update(draft => ({ ...draft, text: "pending receipt" }));
    await session.beginSubmission();
    delayNextRead = true;
    const refresh = session.refresh();
    await entered.promise;
    disk.receipt(true, true);
    const laterEvent = session.refresh();
    gate.resolve();
    await Promise.all([refresh, laterEvent]);
    expect(session.getSnapshot().view?.draft.text).toBe("");
    expect(session.getSnapshot().view?.receipt?.finished).toBe(true);
    expect(disk.requests.filter(action => action.type === "draft.inspect")).toHaveLength(3);
  });
});

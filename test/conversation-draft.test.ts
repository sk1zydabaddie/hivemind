import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { inspectConversationDraft, saveConversationDraft, type ConversationDraft, type ConversationDraftView } from "../src/conversation-draft.js";
import { buildConversationHistory } from "../src/spec-draft-action.js";
import { currentConversationBoundary } from "../src/conversation-control.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo("conversation-draft", async repo => {
    await promisify(execFile)("git", ["init"], { cwd: repo, windowsHide: true });
    const initialized = await initProject(repo);
    assert.equal(initialized, 0);
  }, run);
}

function draft(text = "Unsent request"): ConversationDraft {
  return { content_id: randomUUID(), text, attachments: [{ kind: "file", path: "src/index.ts" }], submission: null };
}

function value<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

test("drafts round-trip text and attachments through the audited action without changing authoritative state", async () => {
  await withRepo(async repo => {
    const before = value(await readEvents(repo));
    const initial = value(await inspectConversationDraft(repo, { conversation_id: "legacy" }));
    assert.equal(initial.revision, null);
    await assert.rejects(lstat(path.join(repo, ".hivemind", "ui")), { code: "ENOENT" }, "inspection must not create storage");
    const proposed = draft("First paragraph\n\nUnicode: 🛰é€");
    const saved = value(await executeWorkspaceAction(repo, { type: "draft.save", payload: {
      conversation_id: "legacy", expected_revision: null, draft: proposed
    } })) as ConversationDraftView;
    assert.notEqual(saved.revision, null);
    const reopened = value(await executeWorkspaceAction(repo, { type: "draft.inspect", payload: { conversation_id: "legacy" } }));
    assert.deepEqual(reopened, saved);
    assert.deepEqual(saved.draft, proposed);
    assert.deepEqual(value(await readEvents(repo)), before, "saving must not create a conversation, provider call or approval");
  });
});

test("CLI draft actions use the same saved record and new draft files are ignored by Git", async () => {
  await withRepo(async repo => {
    const actionPath = path.join(repo, "draft-action.json");
    const proposed = draft("Saved by the CLI");
    await writeFile(actionPath, JSON.stringify({ type: "draft.save", payload: {
      conversation_id: "legacy", expected_revision: null, draft: proposed
    } }));
    const cli = await promisify(execFile)(process.execPath, [path.resolve("dist/src/cli.js"), "workspace", actionPath], { cwd: repo, windowsHide: true });
    assert.deepEqual(JSON.parse(cli.stdout).draft, proposed);
    assert.deepEqual(value(await inspectConversationDraft(repo, { conversation_id: "legacy" })).draft, proposed);
    const directory = path.join(repo, ".hivemind", "ui", "conversation-drafts");
    const file = (await readdir(directory))[0]!;
    const ignored = await promisify(execFile)("git", ["check-ignore", `ui/conversation-drafts/${file}`], { cwd: path.join(repo, ".hivemind"), windowsHide: true });
    assert.match(ignored.stdout, /conversation-drafts/u);
  });
});

test("draft saves are compare-and-swap: concurrent and stale writers cannot overwrite another window", async () => {
  await withRepo(async repo => {
    const results = await Promise.all(["one", "two"].map(text => saveConversationDraft(repo, {
      conversation_id: "legacy", expected_revision: null, draft: draft(text)
    })));
    assert.equal(results.filter(result => result.ok).length, 1);
    const winner = results.find(result => result.ok)!;
    assert.deepEqual(value(await inspectConversationDraft(repo, { conversation_id: "legacy" })), value(winner));
    const stale = await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: draft("stale") });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.reason, /another window/u);
  });
});

test("project and durable conversation boundaries keep saved drafts separate", async () => {
  await withRepo(async repo => {
    const initial = value(await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: draft("original") }));
    const directory = path.join(repo, ".hivemind", "ui", "conversation-drafts");
    const savedPath = path.join(directory, (await readdir(directory))[0]!);
    const original = await readFile(savedPath, "utf8");
    value(await appendEvent(repo, { type: "conversation.started", task_id: null, data: { conversation_id: "C-next" } }));
    assert.equal((await inspectConversationDraft(repo, { conversation_id: "legacy" })).ok, false);
    assert.equal((await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: initial.revision, draft: draft("late") })).ok, false);
    const next = value(await inspectConversationDraft(repo, { conversation_id: "C-next" }));
    assert.equal(next.draft.text, "");
    assert.deepEqual(next.draft.attachments, []);
    assert.equal(await readFile(savedPath, "utf8"), original, "archived draft must be retained");
    await withRepo(async other => {
      const separate = value(await inspectConversationDraft(other, { conversation_id: "legacy" }));
      assert.equal(separate.draft.text, "");
      assert.equal(separate.revision, null);
    });
  });
});

test("reload reconciles an accepted submission even beyond the UI event page, retaining a newer draft", async () => {
  await withRepo(async repo => {
    const submitted = draft();
    submitted.submission = { request_id: randomUUID(), content_id: submitted.content_id };
    let saved = value(await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: submitted }));
    assert.equal(saved.receipt?.accepted, false);
    value(await appendEvent(repo, { type: "conversation.message_recorded", task_id: null,
      data: { request_id: submitted.submission.request_id, conversation_id: "legacy", message: submitted.text } }));
    for (let index = 0; index < 330; index += 1) {
      value(await appendEvent(repo, { type: "human.guidance_recorded", task_id: null, data: { index } }));
    }
    const accepted = value(await inspectConversationDraft(repo, { conversation_id: "legacy" }));
    assert.equal(accepted.draft.text, "");
    assert.deepEqual(accepted.draft.attachments, []);
    assert.equal(accepted.receipt?.accepted, true);
    const next = { ...draft("next draft while responding"), submission: submitted.submission };
    saved = value(await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: saved.revision, draft: next }));
    assert.deepEqual(saved.draft, next);
    value(await appendEvent(repo, { type: "conversation.operation_finished", task_id: null, data: { request_id: submitted.submission.request_id, status: "stopped" } }));
    const finished = value(await inspectConversationDraft(repo, { conversation_id: "legacy" }));
    assert.deepEqual(finished.draft, next);
    assert.equal(finished.receipt?.finished, true);
  });
});

test("failed unaccepted submission retains text and attachments; wrong-conversation acceptance cannot clear it", async () => {
  await withRepo(async repo => {
    const pending = draft();
    pending.submission = { request_id: randomUUID(), content_id: pending.content_id };
    value(await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: pending }));
    value(await appendEvent(repo, { type: "conversation.operation_finished", task_id: null, data: { request_id: pending.submission.request_id, status: "failed" } }));
    value(await appendEvent(repo, { type: "conversation.message_recorded", task_id: null, data: { request_id: pending.submission.request_id, conversation_id: "another" } }));
    const retained = value(await inspectConversationDraft(repo, { conversation_id: "legacy" }));
    assert.deepEqual(retained.draft, pending);
    assert.equal(retained.receipt?.accepted, false);
    assert.equal(retained.receipt?.finished, true);
  });
});

test("malformed, oversized and authority-bearing draft payloads fail without overwriting the last saved draft", async () => {
  await withRepo(async repo => {
    const saved = value(await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: draft() }));
    for (const invalid of [
      { ...draft(), text: "x".repeat(256 * 1024) },
      { ...draft(), approved: true },
      { ...draft(), submission: { request_id: "not-a-uuid", content_id: randomUUID() } },
      { ...draft(), attachments: [{ kind: "file", path: "a", approved: true }] },
      { ...draft(), attachments: Array.from({ length: 21 }, () => ({ kind: "file", path: "a" })) }
    ]) {
      const result = await executeWorkspaceAction(repo, { type: "draft.save", payload: { conversation_id: "legacy", expected_revision: saved.revision, draft: invalid } });
      assert.equal(result.ok, false);
    }
    assert.deepEqual(value(await inspectConversationDraft(repo, { conversation_id: "legacy" })), saved);
    const directory = path.join(repo, ".hivemind", "ui", "conversation-drafts");
    const savedPath = path.join(directory, (await readdir(directory))[0]!);
    await writeFile(savedPath, "x".repeat(256 * 1024 + 1));
    assert.equal((await inspectConversationDraft(repo, { conversation_id: "legacy" })).ok, false);
    assert.equal((await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: saved.revision, draft: draft() })).ok, false);
  });
});

test("draft storage rejects directory links and malformed current conversation identities", async () => {
  await withRepo(async repo => {
    const outside = path.join(repo, "ordinary-source");
    await mkdir(outside);
    await symlink(outside, path.join(repo, ".hivemind", "ui"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await saveConversationDraft(repo, { conversation_id: "legacy", expected_revision: null, draft: draft() })).ok, false);
    assert.deepEqual(await readdir(outside), []);
    value(await appendEvent(repo, { type: "conversation.started", task_id: null, data: { conversation_id: "" } }));
    const events = value(await readEvents(repo));
    assert.equal(currentConversationBoundary(events).ok, false);
    assert.equal(buildConversationHistory(events).ok, false);
    assert.equal((await inspectConversationDraft(repo, { conversation_id: "legacy" })).ok, false);
  });
});

test("the bound includes the actual formatted record and escaped conversation identity, not just draft text", async () => {
  await withRepo(async repo => {
    const conversationId = "\0".repeat(128);
    value(await appendEvent(repo, { type: "conversation.started", task_id: null, data: { conversation_id: conversationId } }));
    const large = draft("");
    large.attachments = Array.from({ length: 20 }, (_, index) => ({ kind: "file", path: `src/file-${index}.ts` }));
    large.submission = { request_id: randomUUID(), content_id: large.content_id };
    large.text = "x".repeat(256 * 1024 - 1024 - Buffer.byteLength(JSON.stringify(large)));
    assert.equal(Buffer.byteLength(JSON.stringify(large)), 256 * 1024 - 1024);
    const result = await saveConversationDraft(repo, { conversation_id: conversationId, expected_revision: null, draft: large });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /too large/u);
    assert.deepEqual(await readdir(path.join(repo, ".hivemind", "ui", "conversation-drafts")), []);
  });
});

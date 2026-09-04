import { isNodeError } from "./error-detail.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  runAdapterProcess,
  type AdapterProfile
} from "./adapter.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { plainReason } from "./plain-reason.js";
import { ACTIVITY_STREAM_ID, createLiveOutputWriter } from "./output-stream.js";
import { appendEvent, readEvents } from "./events.js";
import { recordIdeationRound, startIdeationSession } from "./ideation.js";
import {
  buildSpecDraftingPrompt,
  draftedSpecJsonSchema,
  parseDraftedAnswer,
  type ConversationProjectContext,
  type DraftedAnswer
} from "./spec-drafting.js";
import {
  activeSpecPath,
  buildDraftedSpec,
  specFilePath,
  type SpecResult
} from "./spec-format.js";

/**
 * The action that closes the front door.
 *
 * One adapter call turns what somebody typed into a short-form spec, opens its
 * ideation session, and records the drafter's own alternatives and self-critique
 * as the orchestrator's round. What comes out is a drafted, orchestrator-signed
 * spec that `plan.prepare` can plan from â€” and nothing more. The person's
 * signature is not here and cannot be: `convergence.user` is reachable only
 * through the challenge-bound human act in src/spec-convergence.ts, and this
 * module never touches it.
 *
 * The round is the drafter's real material rather than a stub assembled to pass
 * the gate. If a prompt is too thin for two honest alternatives, the drafter is
 * told to say so in an open question â€” which blocks ratification â€” instead of
 * inventing a second one.
 */

/**
 * What `spec.draft` answers with.
 *
 * `status` is the discriminator the client switches on. A "replied" answer
 * means the drafter judged the message not to be a build request and said
 * something back instead: no spec exists, no ideation round was opened, and
 * nothing was authorised. The client must not continue to `plan.prepare` on it.
 */
export type DraftSpecOutcome =
  | ({ status: "draft" } & DraftSpecResult)
  | { status: "replied"; reply: string };

export interface DraftSpecResult {
  spec_id: string;
  title: string;
  status: "draft";
  open_questions: string[];
  non_goals: string[];
  assumptions: string[];
  alternatives: number;
}

/**
 * Conversation context is intentionally small. The drafter receives the files
 * most likely to identify the project plus files named in the question, never
 * the whole repository. On a larger project the remaining files stay names;
 * naming one in a later question promotes it into the next bounded snapshot.
 */
export const CONVERSATION_CONTEXT_MAX_FILES = 8;
export const CONVERSATION_CONTEXT_MAX_FILE_BYTES = 12 * 1024;
export const CONVERSATION_CONTEXT_MAX_TOTAL_BYTES = 48 * 1024;
const CONVERSATION_CONTEXT_MAX_READ_ATTEMPTS = 16;
const CONVERSATION_PROJECT_FILE_LIMIT = 10_000;

export interface ConversationAttachment {
  kind: "file" | "folder";
  path: string;
}

type ProjectFileReadAction = (
  filePath: string
) => Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;

/**
 * Begin a new conversation in this project.
 *
 * What it does to durable state, stated because the answer is not obvious:
 *
 *  - The TRAIL is untouched. Every earlier message, plan, run and check stays
 *    exactly where it was; this appends one event and removes nothing. The
 *    Project tab still shows the whole history, and a reconstruction still
 *    rebuilds every earlier state.
 *  - The prior active-request POINTER is moved into an archive. Its spec and
 *    plan artifacts remain in history, but neither can control the new thread.
 *  - A new conversation id is recorded and every later message carries it.
 *
 * This is therefore a durable semantic boundary, not only a display filter.
 */
export async function startNewConversation(repoRoot: string): Promise<SpecResult<{ started_at: string }>> {
  const startedAt = new Date().toISOString();
  const conversationId = `C-${randomUUID()}`;
  const activePath = activeSpecPath(repoRoot);
  const archivePath = path.join(repoRoot, ".hivemind", "spec", "archive", `${conversationId}.active.json`);
  let archived = false;
  try {
    await mkdir(path.dirname(archivePath), { recursive: true });
    await rename(activePath, archivePath);
    archived = true;
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `new conversation could not archive the active project request: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const recorded = await appendEvent(repoRoot, {
    type: "conversation.started",
    task_id: null,
    data: {
      version: 1,
      conversation_id: conversationId,
      active_request_archived: archived,
      /* Advisory and authority-free, in the same shape as guidance: moving
         where a thread begins is a view decision and must never read as one
         that permits anything. */
      advisory_only: true,
      authorization_effect: "none"
    }
  });
  if (!recorded.ok && archived) {
    try {
      await rename(archivePath, activePath);
    } catch {
      return { ok: false, reason: `${recorded.reason}; the prior active request also could not be restored` };
    }
  }
  return recorded.ok ? { ok: true, value: { started_at: startedAt } } : recorded;
}

export async function draftSpecFromPrompt(
  repoRoot: string,
  prompt: string,
  tool: string,
  /* `answerOnly` means a plan is already prepared and waiting. A question is not
     an approval, so the conversation continues -- but drafting a second spec
     behind a plan nobody has looked at would replace their work by surprise. So
     the drafter answers and never drafts, and says what is waiting. */
  options: {
    answerOnly?: boolean;
    readProjectFile: ProjectFileReadAction;
    requestId?: string;
    attachments?: ConversationAttachment[];
  }
): Promise<SpecResult<DraftSpecOutcome>> {
  if (prompt.trim() === "") {
    return { ok: false, reason: "describe what you want built before drafting a spec" };
  }

  const profile = await loadAdapterProfile(repoRoot, tool);
  if (!profile.ok) return profile;
  const dangerous = findDangerousAdapterArgs(profile.profile.invoke);
  if (dangerous.length > 0) {
    return {
      ok: false,
      reason: `drafting adapter profile "${tool}" contains dangerous invocation flags (${dangerous.join(", ")})`
    };
  }

  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;
  /* A-03's money gate, at the FIRST paid call rather than the last check.
     Integration refuses an undeclared empty test_command -- but by the time
     integration runs, planning and worker calls are already spent. Setup no
     longer reads complete in this state; this refusal covers the side door
     (Work stays reachable by design), and it costs nothing because it fires
     before any provider process starts. */
  if (config.config.test_command.trim() === "" && config.config.no_tests_declared !== true) {
    return {
      ok: false,
      reason:
        "this project has no verification command and has not declared that it has no tests; finish setup first -- set the command there, or state the absence explicitly"
    };
  }
  const projectFiles = await currentProjectFiles(repoRoot);
  if (!projectFiles.ok) return projectFiles;
  const visibleProjectFiles = projectFiles.value.files.filter((filePath) => !isPrivateProjectRoot(filePath));
  const projectContext = await buildConversationProjectContext(
    prompt,
    visibleProjectFiles,
    options.readProjectFile,
    options.attachments ?? [],
    projectFiles.value.truncated
  );

  const specId = await nextSpecId(repoRoot);
  if (!specId.ok) return specId;

  /* Every turn gets its own id, and it is NOT the spec id.
   *
   * The spec id was used for both, which was fine while every message became a
   * spec. Once a message could be answered instead, no spec document got
   * written, `nextSpecId` returned the same name next time, and every
   * conversational turn in a project shared one id -- so the second exchange
   * never rendered: the surface keys a turn on that id and had already seen it.
   * A turn is a turn whether or not it becomes a spec. */
  const turnId = `M-${randomUUID()}`;

  const recorded = await appendEvent(repoRoot, {
    type: "conversation.message_recorded",
    task_id: null,
    data: {
      message_id: turnId,
      conversation_id: await currentConversationId(repoRoot),
      ...(options.requestId === undefined ? {} : { request_id: options.requestId }),
      text: prompt.trim(),
      attachments: options.attachments ?? []
    }
  });
  if (!recorded.ok) return recorded;

  const started = await appendEvent(repoRoot, {
    type: "spec.draft_started",
    task_id: null,
    /* Whose round this is. Recorded so a reader can ask whether anything is
       still doing it: without a pid, an abandoned round is indistinguishable
       from a slow one until a timeout expires. See src/open-rounds.ts. */
    data: {
      spec_id: specId.value,
      tool,
      message_id: turnId,
      process_identity: { pid: process.pid, process_instance_id: turnId }
    }
  });
  if (!started.ok) return started;

  const drafting = buildSpecDraftingPrompt({
    prompt,
    trackedFiles: visibleProjectFiles,
    testCommand: config.config.test_command ?? null,
    projectContext,
    answerOnly: options.answerOnly === true
  });
  const drafted = await draftOnce(repoRoot, profile.profile, tool, turnId, drafting);
  if (!drafted.ok) {
    return failDraft(repoRoot, specId.value, drafted.reason);
  }

  /* Not a build request. The drafter said so in the same call that would have
     drafted, so this costs nothing extra, and the branch happens BEFORE any
     spec file is written or any ideation round is opened.

     What a reply may do is bounded by what happens here: one event, marked
     advisory and carrying no authorisation, exactly as human guidance is. It
     cannot ratify, approve, plan or start anything -- the composer looking like
     a chat is fixed by letting it hold a conversation, never by letting a
     conversation become a way to authorise work. */
  if (drafted.value.kind === "reply") {
    const answered = await appendEvent(repoRoot, {
      type: "conversation.reply_recorded",
      task_id: null,
      data: {
        version: 1,
        message_id: turnId,
        text: drafted.value.reply,
        tool,
        advisory_only: true,
        authorization_effect: "none"
      }
    });
    if (!answered.ok) return answered;
    /* The round that opened has to be closed, or the record leaves a draft
       running forever. `outcome` is a typed code so a surface can tell
       "answered" from "went wrong" -- a call was made and the record keeps
       that, but nothing failed. No spec id is consumed: the document was never
       written, so the next real spec still gets this name. */
    const closed = await appendEvent(repoRoot, {
      type: "spec.draft_failed",
      task_id: null,
      data: {
        spec_id: specId.value,
        outcome: "answered",
        reason: "the message was answered rather than drafted from; it did not ask for anything to be built"
      }
    });
    if (!closed.ok) return closed;
    return { ok: true, value: { status: "replied", reply: drafted.value.reply } };
  }

  if (options.answerOnly === true) {
    /* The drafter was told to answer; if it drafted anyway, the answer is still
       an answer and no spec is written. A model that ignores an instruction
       must not be able to replace a prepared plan. */
    const answered = await appendEvent(repoRoot, {
      type: "conversation.reply_recorded",
      task_id: null,
      data: {
        version: 1,
        message_id: turnId,
        text: "There is already a plan prepared and waiting for you. I have not changed it. Look at it when you are ready, or start over if you want a different one.",
        tool,
        advisory_only: true,
        authorization_effect: "none"
      }
    });
    if (!answered.ok) return answered;
    const closed = await appendEvent(repoRoot, {
      type: "spec.draft_failed",
      task_id: null,
      data: {
        spec_id: specId.value,
        outcome: "answered",
        reason: "a plan is already prepared, so the message was answered rather than drafted from"
      }
    });
    if (!closed.ok) return closed;
    return {
      ok: true,
      value: {
        status: "replied",
        reply:
          "There is already a plan prepared and waiting for you. I have not changed it. Look at it when you are ready, or start over if you want a different one."
      }
    };
  }

  const proposal = { ok: true as const, value: drafted.value };

  /* Written before the ideation session opens, because the session reads the
     document it is about. */
  try {
    await writeFileAtomic(
      specFilePath(repoRoot, specId.value),
      buildDraftedSpec({
        title: proposal.value.title,
        prompt,
        goal: proposal.value.goal,
        nonGoals: proposal.value.non_goals,
        acceptance: proposal.value.acceptance,
        openQuestions: proposal.value.open_questions,
        assumptions: proposal.value.assumptions
      })
    );
    await writeJsonAtomic(activeSpecPath(repoRoot), { version: 1, spec_id: specId.value });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return failDraft(repoRoot, specId.value, `the drafted spec could not be saved: ${detail}`);
  }

  const session = await startIdeationSession(
    repoRoot,
    specId.value,
    proposal.value.title,
    proposal.value.goal
  );
  if (!session.ok) return failDraft(repoRoot, specId.value, session.reason);

  /* The drafter's own alternatives and self-critique, recorded as the
     orchestrator's round. `orchestrator_calls_convergence` signs the half a
     model is allowed to sign. The other half stays unsigned. */
  const round = await recordIdeationRound(repoRoot, specId.value, {
    alternatives: proposal.value.alternatives,
    self_critique: proposal.value.self_critique,
    substantive_change: true,
    orchestrator_calls_convergence: true
  });
  if (!round.ok) return failDraft(repoRoot, specId.value, round.reason);

  const completed = await appendEvent(repoRoot, {
    type: "spec.draft_completed",
    task_id: null,
    data: {
      spec_id: specId.value,
      title: proposal.value.title,
      goal: proposal.value.goal,
      open_questions: proposal.value.open_questions
    }
  });
  if (!completed.ok) return completed;

  return {
    ok: true,
    value: {
      spec_id: specId.value,
      title: proposal.value.title,
      status: "draft",
      open_questions: proposal.value.open_questions,
      non_goals: proposal.value.non_goals,
      assumptions: proposal.value.assumptions,
      alternatives: proposal.value.alternatives.length
    }
  };
}

const PROJECT_DESCRIPTOR_NAMES = new Set([
  "readme",
  "readme.md",
  "readme.txt",
  "package.json",
  "cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc"
]);

const PROJECT_ENTRYPOINT = /(^|\/)(src\/)?(index|main|lib|app|server|cli)\.[a-z0-9]+$/iu;
const PROJECT_SOURCE = /\.(?:[cm]?[jt]sx?|rs|py|go|java|kt|kts|cs|cpp|cc|c|h|hpp|rb|php|swift|ex|exs|vue|svelte)$/iu;

/** Assemble one deterministic, bounded context pack through the supplied action. */
async function buildConversationProjectContext(
  prompt: string,
  projectFiles: string[],
  readProjectFileAction: ProjectFileReadAction,
  attachments: ConversationAttachment[],
  inventoryTruncated: boolean
): Promise<ConversationProjectContext> {
  const promptFolded = prompt.toLocaleLowerCase("en-US").replaceAll("\\", "/");
  const candidates = projectFiles
    .filter((filePath) => !isPrivateProjectRoot(filePath))
    .map((filePath, index) => ({
      path: filePath,
      index,
      score: conversationFileScore(filePath, promptFolded, attachments)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index || left.path.localeCompare(right.path));

  const files: ConversationProjectContext["files"] = [];
  let remaining = CONVERSATION_CONTEXT_MAX_TOTAL_BYTES;
  for (const candidate of candidates.slice(0, CONVERSATION_CONTEXT_MAX_READ_ATTEMPTS)) {
    if (remaining <= 0 || files.length >= CONVERSATION_CONTEXT_MAX_FILES) break;
    const read = await readProjectFileAction(candidate.path);
    if (!read.ok || !isProjectFileContent(read.value)) continue;
    const allowed = Math.min(CONVERSATION_CONTEXT_MAX_FILE_BYTES, remaining);
    const complete = Buffer.from(read.value.text, "utf8");
    const text = utf8Prefix(complete, allowed);
    const includedBytes = Buffer.byteLength(text, "utf8");
    if (includedBytes === 0 && read.value.bytes > 0) continue;
    files.push({
      path: read.value.path,
      text,
      bytes: read.value.bytes,
      included_bytes: includedBytes,
      truncated: read.value.truncated || complete.length > includedBytes
    });
    remaining -= includedBytes;
  }

  return {
    files,
    tracked_files: projectFiles.length,
    candidate_files: candidates.length,
    max_files: CONVERSATION_CONTEXT_MAX_FILES,
    max_total_bytes: CONVERSATION_CONTEXT_MAX_TOTAL_BYTES,
    inventory_truncated: inventoryTruncated
  };
}

/** Return the longest complete UTF-8 prefix within `maxBytes`. */
function utf8Prefix(value: Buffer, maxBytes: number): string {
  if (value.length <= maxBytes) return value.toString("utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return decoder.decode(value.subarray(0, end));
    } catch {
      /* A UTF-8 code point occupies at most four bytes, so this retries no more
         than three times for a buffer that originated from a JS string. */
      end -= 1;
    }
  }
  return "";
}

function conversationFileScore(
  filePath: string,
  promptFolded: string,
  attachments: ConversationAttachment[]
): number {
  const normalized = filePath.replaceAll("\\", "/");
  const folded = normalized.toLocaleLowerCase("en-US");
  const basename = folded.split("/").at(-1) ?? folded;
  const depth = folded.split("/").length - 1;
  const attachment = attachments.find((entry) => {
    const attached = entry.path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "").toLocaleLowerCase("en-US");
    return entry.kind === "file" ? folded === attached : folded.startsWith(`${attached}/`);
  });
  if (attachment?.kind === "file") return 30_000 - depth;
  if (attachment?.kind === "folder") return 25_000 - depth;
  const explicitlyNamed = promptFolded.includes(folded) ||
    (basename.length >= 4 && promptFolded.includes(basename));
  if (explicitlyNamed) return 20_000 - depth;
  if (depth === 0 && PROJECT_DESCRIPTOR_NAMES.has(basename)) return 15_000;
  if (PROJECT_ENTRYPOINT.test(folded)) return 12_000 - depth;
  if (PROJECT_SOURCE.test(folded)) return 1_000 - Math.min(depth, 100);
  return 0;
}

async function currentProjectFiles(
  repoRoot: string
): Promise<SpecResult<{ files: string[]; truncated: boolean }>> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const files: string[] = [];
    let carry = "";
    let truncated = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      carry += chunk;
      const names = carry.split("\0");
      carry = names.pop() ?? "";
      for (const name of names) {
        if (name === "") continue;
        if (files.length < CONVERSATION_PROJECT_FILE_LIMIT) files.push(name);
        else truncated = true;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16 * 1024) stderr += chunk.slice(0, 16 * 1024 - stderr.length);
    });
    child.once("error", (error) => {
      resolve({ ok: false, reason: `current project files could not be listed: ${error.message}` });
    });
    child.once("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, reason: `current project files could not be listed: ${stderr.trim() || `git exited ${code ?? "without a status"}`}` });
        return;
      }
      if (carry !== "") {
        if (files.length < CONVERSATION_PROJECT_FILE_LIMIT) files.push(carry);
        else truncated = true;
      }
      resolve({ ok: true, value: { files, truncated } });
    });
  });
}

async function currentConversationId(repoRoot: string): Promise<string> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return "legacy";
  const boundary = [...events.value].reverse().find((event) => event.type === "conversation.started");
  return typeof boundary?.data.conversation_id === "string" ? boundary.data.conversation_id : "legacy";
}

function isPrivateProjectRoot(filePath: string): boolean {
  const first = filePath.replaceAll("\\", "/").split("/")[0]?.toLocaleLowerCase("en-US");
  return first === ".git" || first === ".hivemind";
}

function isProjectFileContent(value: unknown): value is {
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const content = value as Record<string, unknown>;
  return typeof content.path === "string" &&
    typeof content.text === "string" &&
    typeof content.bytes === "number" &&
    typeof content.truncated === "boolean";
}

async function failDraft(
  repoRoot: string,
  specId: string,
  reason: string
): Promise<SpecResult<never>> {
  const failed = await appendEvent(repoRoot, {
    type: "spec.draft_failed",
    task_id: null,
    data: {
      spec_id: specId,
      /* The sentence comes from the reason, not from a constant. This used to
         be fixed text paired with whatever detail happened to be underneath --
         "I couldn't finish preparing a plan. No project source files were
         changed." next to "first ideation round must include at least two
         alternatives", which is two unrelated statements about one event, the
         second reassuring about a risk drafting never runs. When nothing maps,
         the detail stands alone rather than being introduced by a claim that
         may not describe it. */
      message: plainReason(reason),
      detail: reason
    }
  });
  return failed.ok ? { ok: false, reason } : failed;
}

/**
 * Ask the drafter once and either accept that reply or report its failure.
 *
 * A malformed reply used to trigger two more paid calls. That hid the adapter
 * normalization defect which discarded valid Claude stream output and charged
 * the user three times for one request. Retry is now an explicit user action:
 * one press means one provider call, while a blocking question remains a
 * successful parsed answer rather than a failure to reroll.
 */
async function draftOnce(
  repoRoot: string,
  profile: AdapterProfile,
  tool: string,
  /* The TURN, not the spec. It was called `specId` and then handed `turnId`
     when the two were separated, so the stream was written under one id and
     read under the other and no text ever arrived. A parameter named for what
     it is cannot drift that way twice. */
  turnId: string,
  drafting: string
): Promise<SpecResult<DraftedAnswer>> {
  /* Stream it. The harness emits text as it thinks, and this threw it away:
     thirteen seconds of a spinner and then a finished answer. The chunks go to
     the same durable channel worker output already uses, keyed on the spec id,
     so the surface reads them through the endpoint it already has rather than
     through a second mechanism.

     Writes are chained rather than fired in parallel: the records are a
     transcript, and a transcript out of order is worse than no transcript. */
  const liveOutput = createLiveOutputWriter(repoRoot, ACTIVITY_STREAM_ID, tool, undefined, {
    structuredAnswers: true
  });
  const process = await runAdapterProcess(repoRoot, profile, repoRoot, drafting, {
    outputLogPath: adapterRunLogPath(repoRoot, `drafting-${turnId}-1`),
    usageSessionId: turnId,
    usageRunId: turnId,
    /* A fixed channel is subscribable before the turn id exists. The writer is
       per process, so framing state never bleeds between concurrent calls. */
    onStreamChunk: liveOutput.onChunk,
    ...(profile.usage_parser === "claude-json" ? { structuredOutputSchema: draftedSpecJsonSchema } : {})
  });
  const output = await liveOutput.drain();
  if (!output.ok) return output;
  if (!process.ok) return process;
  if (process.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, process.value, "spec drafter") };
  }
  const parsed = parseDraftedAnswer(process.value.modelOutput);
  return parsed.ok
    ? parsed
    : {
        ok: false,
        reason: `I couldn't read the planner's reply (${parsed.reason}). No project source files were changed. You can send the request again.`
      };
}

/** S-001, then S-002, and so on. Never reuses an id a document already has. */
async function nextSpecId(repoRoot: string): Promise<SpecResult<string>> {
  let entries: string[] = [];
  try {
    entries = await readdir(path.join(repoRoot, ".hivemind", "spec"));
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const used = new Set(
    entries
      .map((name) => /^S-(\d{3,})\.md$/u.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number.parseInt(value, 10))
  );
  for (let index = 1; index < 1000; index += 1) {
    if (!used.has(index)) return { ok: true, value: `S-${String(index).padStart(3, "0")}` };
  }
  return { ok: false, reason: "this project already has 999 specs" };
}

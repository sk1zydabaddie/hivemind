import { setTimeout as delay } from "node:timers/promises";
import { runAdapterProcess, type AdapterProfile, type AdapterProcessOptions } from "./adapter.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { terminateProcessTreeAndVerify, type DurableProcessIdentity } from "./process-control.js";
import { getProcessGroupLiveness, getProcessLiveness } from "./process-liveness.js";
import { isRecord } from "./json.js";

export interface ConversationOperation {
  request_id: string;
  started_at: string;
  phase: "reading" | "planning" | "stopping" | "interrupted";
}

/** Identity comes from the complete durable trail, never a UI event page. */
export function currentConversationBoundary(events: HivemindEvent[]):
  { ok: true; value: { conversation_id: string; start: number } } | { ok: false; reason: string } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "conversation.started") continue;
    const id = event.data.conversation_id;
    if (typeof id !== "string" || id.trim() === "" || id.length > 128) {
      return { ok: false, reason: "the current conversation boundary has no valid identity; history cannot be reconstructed" };
    }
    return { ok: true, value: { conversation_id: id, start: index + 1 } };
  }
  return { ok: true, value: { conversation_id: "legacy", start: 0 } };
}

export function currentConversationOperation(events: HivemindEvent[]): ConversationOperation | null {
  const finished = new Set(events.filter((event) => event.type === "conversation.operation_finished").map((event) => event.data.request_id));
  const start = events.find((event) => event.type === "conversation.operation_started" && !finished.has(event.data.request_id));
  if (start === undefined || typeof start.data.request_id !== "string") return null;
  const own = events.filter((event) => event.data.request_id === start.data.request_id);
  const owner = start.data.process_identity;
  return {
    request_id: start.data.request_id, started_at: start.ts,
    phase: isRecord(owner) && typeof owner.pid === "number" && getProcessLiveness(owner.pid) === "dead" ? "interrupted"
      : own.some((event) => event.type === "conversation.cancel_requested") ? "stopping"
      : own.some((event) => event.type === "conversation.phase_changed" && event.data.phase === "planning") ? "planning" : "reading"
  };
}

// The operation spans both provider calls. Cancellation is durable, not an
// AbortController owned by a window that may disconnect or switch projects.
export async function conversationCancelled(repoRoot: string, requestId: string): Promise<boolean> {
  const events = await readEvents(repoRoot);
  if (!events.ok) throw new Error(events.reason);
  return events.value.some((event) => event.type === "conversation.cancel_requested" && event.data.request_id === requestId);
}

export async function stopConversation(repoRoot: string, requestId: string) {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const own = events.value.filter((event) => event.data.request_id === requestId);
  if (!own.some((event) => event.type === "conversation.operation_started")) {
    return { ok: false as const, reason: "The request has not been admitted yet. Try Stop again in a moment." };
  }
  const finished = own.find((event) => event.type === "conversation.operation_finished");
  if (finished) return { ok: true as const, value: { request_id: requestId, status: finished.data.status } };
  if (!own.some((event) => event.type === "conversation.cancel_requested")) {
    const recorded = await appendEvent(repoRoot, {
      type: "conversation.cancel_requested", task_id: null,
      data: { request_id: requestId, requested_by: "human" }
    });
    if (!recorded.ok) return recorded;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await readEvents(repoRoot);
    if (!current.ok) return current;
    const terminal = current.value.find((event) => event.type === "conversation.operation_finished" && event.data.request_id === requestId);
    if (terminal) return { ok: true as const, value: { request_id: requestId, status: terminal.data.status } };
    // A restarted daemon cannot hold the old producer's callback. Reconcile
    // only proven absence; never signal a historical PID that may be reused.
    const owner = own.find(event => event.type === "conversation.operation_started")?.data.process_identity;
    if (isRecord(owner) && typeof owner.pid === "number" && getProcessLiveness(owner.pid) === "dead") {
      const processes = current.value.filter(event => event.type === "conversation.process_started" && event.data.request_id === requestId);
      const ended = new Set(current.value.filter(event => event.type === "conversation.process_finished" && event.data.request_id === requestId).map(event => event.data.process_id));
      const dead = processes.every(event => {
        if (ended.has(event.data.process_id)) return true;
        const identity = event.data.process_identity;
        // Windows has no recorded process group here. An absent root PID
        // cannot establish that an orphaned descendant is absent as well.
        return isRecord(identity) && typeof identity.pid === "number" && getProcessLiveness(identity.pid) === "dead" &&
          process.platform !== "win32" && typeof identity.process_group_id === "number" && getProcessGroupLiveness(identity.process_group_id) === "dead";
      });
      if (dead) {
        for (const started of processes) {
          if (ended.has(started.data.process_id)) continue;
          const closed = await appendEvent(repoRoot, { type: "conversation.process_finished", task_id: null,
            data: { ...started.data, reconciled_after_producer_exit: true } });
          if (!closed.ok) return closed;
        }
        const recorded = await appendEvent(repoRoot, { type: "conversation.operation_finished", task_id: null,
          data: { request_id: requestId, status: "stopped", reconciled_after_producer_exit: true } });
        return recorded.ok ? { ok: true as const, value: { request_id: requestId, status: "stopped" } } : recorded;
      }
    }
    await delay(100);
  }
  return { ok: false as const, reason: "Stop was requested, but termination has not been confirmed. The request remains stopping; retry to check it. No later stage may start." };
}

export async function runConversationAdapter(
  repoRoot: string, profile: AdapterProfile, prompt: string,
  options: AdapterProcessOptions, requestId?: string
): ReturnType<typeof runAdapterProcess> {
  if (requestId === undefined) return runAdapterProcess(repoRoot, profile, repoRoot, prompt, options);
  if (await conversationCancelled(repoRoot, requestId)) return { ok: false, reason: "Response stopped." };
  let identity: DurableProcessIdentity | null = null;
  const result = await runAdapterProcess(repoRoot, profile, repoRoot, prompt, {
    ...options,
    cancelBeforeSpawn: true,
    shouldCancel: () => conversationCancelled(repoRoot, requestId).catch(() => true),
    onProcessStart: async (started) => {
      identity = started;
      const recorded = await appendEvent(repoRoot, {
        type: "conversation.process_started", task_id: null,
        data: { request_id: requestId, process_id: started.process_instance_id, process_identity: started }
      });
      if (!recorded.ok) return recorded;
      // Stdin profiles receive no input until this callback succeeds. Other
      // profiles are cancelled through the same process-ownership callback.
      return await conversationCancelled(repoRoot, requestId).catch(() => true)
        ? { ok: false, reason: "Response stopped before provider input." }
        : { ok: true };
    }
  });
  if (identity !== null) {
    if (await conversationCancelled(repoRoot, requestId)) {
      const terminated = await terminateProcessTreeAndVerify(identity);
      if (terminated.status !== "dead") return { ok: false, reason: `Stop could not prove termination: ${terminated.reason}` };
    }
    const recorded = await appendEvent(repoRoot, {
      type: "conversation.process_finished", task_id: null,
      data: { request_id: requestId, process_id: (identity as DurableProcessIdentity).process_instance_id, process_identity: identity }
    });
    if (!recorded.ok) return recorded;
  }
  return result;
}

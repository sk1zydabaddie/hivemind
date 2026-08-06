import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileCode2,
  Layers3,
  MessageSquareText,
  Plus,
  Send,
  SlidersHorizontal,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { plainActionError } from "@/lib/plain-language";
import {
  type BoardProjection,
  type HivemindEvent,
  type TaskProjection,
  type TaskState
} from "@/lib/projection";
import {
  groupConsecutiveActivity,
  summarizeWorkerOutput
} from "@/lib/work-presentation";
import type {
  AutonomyLevel,
  WorkspaceAction,
  WorkspaceInspection,
  WorkspacePlanReview,
  WorkspacePlanTask,
  WorkspaceQueueItem
} from "@/lib/workspace-actions";

interface WorkTabProps {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  actionError: string;
  connectionState: string;
  connectionDetail: string;
  onReconnect: () => Promise<void>;
  onSelectTask: (taskId: string) => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}

type Tone = "neutral" | "live" | "good" | "warning" | "danger";

interface AmendmentDraft {
  taskId: string;
  title: string;
  files: string;
  readOnlyFiles: string;
  dependencies: string;
  acceptance: string;
  validityCheck: string;
  checks: string;
  groupId: string;
  groupMode: "parallel" | "sequence";
}

const stateLanguage: Record<TaskState, { label: string; tone: Tone }> = {
  planned: { label: "Waiting to start", tone: "neutral" },
  running: { label: "Working", tone: "live" },
  paused: { label: "Paused for capacity", tone: "warning" },
  submitted: { label: "Change ready", tone: "live" },
  accepted: { label: "Checks passed", tone: "good" },
  rejected: { label: "Needs revision", tone: "danger" },
  blocked: { label: "Project checks blocked", tone: "danger" },
  failed: { label: "Worker stopped", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  verified: { label: "Ready to ship", tone: "good" },
  merged: { label: "Merged", tone: "good" }
};

/* Tasks are grouped by what the person watching would do about them, not by the
   machinery that produced them. Urgent first, finished last. */
const LANES: Array<{ key: string; label: string; states: TaskState[] }> = [
  { key: "working", label: "Working now", states: ["running", "submitted", "accepted"] },
  { key: "attention", label: "Needs attention", states: ["rejected", "blocked", "failed"] },
  { key: "waiting", label: "Waiting", states: ["planned", "paused"] },
  { key: "finished", label: "Finished", states: ["verified", "merged", "cancelled"] }
];

const EXAMPLE_ASKS = [
  "Add a dark mode toggle to the settings page",
  "Validate the sign-up form before it submits",
  "Make the dashboard load faster on first paint"
];

const toneText: Record<Tone, string> = {
  neutral: "text-muted",
  live: "text-navy",
  good: "text-navy",
  warning: "text-amber",
  danger: "text-clay"
};

const toneEdge: Record<Tone, string> = {
  neutral: "bg-rule",
  live: "bg-navy",
  good: "bg-navy",
  warning: "bg-amber",
  danger: "bg-clay"
};

export function WorkTab({
  projection,
  inspection,
  actionError,
  connectionState,
  connectionDetail,
  onReconnect,
  onSelectTask,
  onAction
}: WorkTabProps): React.JSX.Element {
  const tasks = inspection?.tasks ?? [];
  const selected = projection.selectedTaskId
    ? tasks.find((task) => task.task_id === projection.selectedTaskId) ?? null
    : null;
  const [dismissedAttention, setDismissedAttention] = useState<string[]>([]);
  const [dismissedPlanHash, setDismissedPlanHash] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [amendment, setAmendment] = useState<{
    kind: "add_task" | "edit_task";
    draft: AmendmentDraft;
  } | null>(null);
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [redirectText, setRedirectText] = useState("");
  const [patchOpen, setPatchOpen] = useState(false);
  const [changeSetPatch, setChangeSetPatch] = useState<{
    verificationId: string;
    text: string;
  } | null>(null);
  const [changeSetPatchError, setChangeSetPatchError] = useState("");
  const [changeSetPatchLoading, setChangeSetPatchLoading] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const activityEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [projection.eventCount]);

  const connectionAttention: WorkspaceQueueItem | null =
    connectionState === "connection interrupted" || connectionState === "connection error"
      ? {
          id: "connection-interrupted",
          kind: "run_stalled",
          title: "Project updates stopped",
          detail: `${connectionDetail || "The desktop lost its connection to this project."} Reconnect before trusting what you see here.`,
          created_at: new Date().toISOString(),
          task_id: null,
          action: null
        }
      : null;
  const queue = inspection?.needs_you ?? [];
  const openQueue = queue.filter((item) => !dismissedAttention.includes(item.id));
  const attention = connectionAttention ?? openQueue[0] ?? null;
  /* The daemon decides what matters most; shipping only takes the bar when it is
     already at the front of the queue. */
  const shipItem = attention?.kind === "adoption_ready" ? attention : null;
  const plan = inspection?.plan_review ?? null;
  const currentPlan = inspection?.current_plan ?? null;
  const displayedPlan = plan ?? currentPlan;
  const planWaiting = plan !== null && dismissedPlanHash !== plan.plan_hash;
  const managerSession = inspection?.manager_session;
  const runActive =
    managerSession !== null &&
    managerSession !== undefined &&
    managerSession.status !== "complete" &&
    managerSession.status !== "stopped";
  const continuationAvailable = managerSession?.continuation_available === true;
  const managerStartAvailable =
    inspection?.current_plan !== null &&
    inspection?.current_plan !== undefined &&
    plan === null &&
    (managerSession === null || managerSession === undefined);

  const startManager = async (
    message = "Execute the exact ratified plan through the normal checks."
  ): Promise<{ session_id: string }> =>
    onAction<{ session_id: string }>({
      type: "manager.start",
      payload: { message, tool: "manager" }
    });

  const continueSession = async (sessionId: string): Promise<void> => {
    await onAction({
      type: "manager.continue",
      payload: { session_id: sessionId, tool: "manager", max_steps: 25 }
    });
  };

  const submitPrompt = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    const message = composer.trim();
    if (message === "") return;
    setBusy(true);
    setFeedback("");
    try {
      if (runActive) {
        await onAction({
          type: "guidance.record",
          payload: { target: "orchestrator", message }
        });
        setFeedback("Saved for the next step. Work already in progress was not changed.");
      } else if (plan !== null) {
        setFeedback("Review the prepared plan first. Typed notes cannot approve it.");
        setReviewOpen(true);
        return;
      } else if (inspection?.current_plan === null || inspection?.current_plan === undefined) {
        const prepared = await onAction<{
          status: "awaiting_ratification" | "ratified_by_policy";
          autonomy_level: AutonomyLevel;
          task_count: number;
        }>({
          type: "plan.prepare",
          payload: { prompt: message, tool: "planner" }
        });
        if (prepared.status === "ratified_by_policy") {
          const started = await startManager(message);
          await continueSession(started.session_id);
          setFeedback(
            `${prepared.task_count} ${prepared.task_count === 1 ? "task" : "tasks"}, working. You can stop at any time.`
          );
        } else {
          setFeedback("A plan is ready for you to look at. Nothing has started.");
        }
      } else {
        const started = await startManager(message);
        if (inspection?.autonomy.configured_level === "review_everything") {
          setFeedback("The first step is prepared. Continue when you are ready.");
        } else {
          await continueSession(started.session_id);
          setFeedback("Working until it finishes or something needs you.");
        }
      }
      setComposer("");
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
    }
  };

  const continueRun = async (): Promise<void> => {
    if (!managerSession || !continuationAvailable) return;
    setBusy(true);
    setFeedback("");
    try {
      await onAction({
        type: "manager.continue",
        payload: {
          session_id: managerSession.session_id,
          tool: managerSession.tool,
          max_steps: 25
        }
      });
      setFeedback("Working until it finishes or something needs you.");
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async (): Promise<void> => {
    if (!managerSession) {
      setFeedback("Nothing is running to stop.");
      return;
    }
    setStopBusy(true);
    try {
      await onAction({
        type: "run.stop",
        payload: { session_id: managerSession.session_id, reason: "Stopped from the Work tab" }
      });
      setFeedback("Stopped. Every active task was cleaned up on the way out.");
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setStopBusy(false);
    }
  };

  const openPlanReview = async (): Promise<void> => {
    if (!displayedPlan) return;
    setReviewOpen(true);
    setFeedback("");
    if (!plan) return;
    try {
      await onAction({ type: "plan.review", payload: { spec_id: plan.spec_id } });
    } catch (error) {
      setFeedback(plainActionError(error));
    }
  };

  const approveQueueItem = async (item: WorkspaceQueueItem): Promise<void> => {
    if (!item.action) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await onAction<{ task_ids?: string[]; session_id?: string }>(item.action);
      if (item.action.type === "manager.start" && result.session_id) {
        await continueSession(result.session_id);
        setFeedback("Picked up again from the approved plan.");
      } else if (item.action.type === "manager.retry_blocked" && managerSession) {
        await onAction({
          type: "manager.continue",
          payload: {
            session_id: managerSession.session_id,
            tool: managerSession.tool,
            max_steps: 25
          }
        });
        setFeedback("The project check is ready for your approval with the refreshed project state.");
      } else if (item.action.type === "adoption.review") {
        setFeedback("The exact set of changes is ready for you to authorize.");
      } else if (item.action.type === "adoption.execute") {
        const taskCount = result.task_ids?.length ?? item.change_set?.task_ids.length ?? 0;
        const branch = item.change_set?.base_branch ?? "your branch";
        setFeedback(
          `Shipped ${taskCount} ${taskCount === 1 ? "task" : "tasks"} to ${branch}.`
        );
      } else {
        setFeedback(actionSuccessMessage(item.action.type));
      }
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
    }
  };

  const loadChangeSetPatch = async (item: WorkspaceQueueItem): Promise<void> => {
    const changeSet = item.change_set;
    if (!changeSet) return;
    setPatchOpen(true);
    if (changeSetPatch?.verificationId === changeSet.verification_id) return;
    setChangeSetPatchLoading(true);
    setChangeSetPatchError("");
    try {
      const sections: string[] = [];
      for (const taskId of changeSet.task_ids) {
        const result = await onAction<{ task_id: string; diff: string }>({
          type: "change.inspect",
          payload: { task_id: taskId }
        });
        sections.push(`# ${result.task_id}\n${result.diff.trimEnd()}`);
      }
      setChangeSetPatch({
        verificationId: changeSet.verification_id,
        text: sections.join("\n\n")
      });
    } catch (error) {
      setChangeSetPatchError(plainActionError(error));
    } finally {
      setChangeSetPatchLoading(false);
    }
  };

  const openAttentionTarget = (item: WorkspaceQueueItem): void => {
    if (item.id === "connection-interrupted") {
      void onReconnect();
    } else if (item.kind === "plan_review") {
      void openPlanReview();
    } else if (item.task_id) {
      onSelectTask(item.task_id);
    }
  };

  const idle =
    tasks.length === 0 && displayedPlan === null && !runActive && attention === null;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden px-4 pb-4">
      {/* Row 1 is always present so the panels below can never lose their row; it
          only has height when a human is genuinely required. */}
      <div className="min-w-0">
        {shipItem ? (
          <ShipBar
            busy={busy}
            item={shipItem}
            onInspect={() => void loadChangeSetPatch(shipItem)}
            onShip={() => void approveQueueItem(shipItem)}
          />
        ) : attention ? (
          <AttentionBar
            busy={busy}
            item={attention}
            moreCount={Math.max(0, openQueue.length - 1)}
            planWaiting={planWaiting}
            onApprove={() => void approveQueueItem(attention)}
            onDismiss={() => setDismissedAttention((items) => [...items, attention.id])}
            onOpen={() => openAttentionTarget(attention)}
          />
        ) : planWaiting && plan ? (
          <PlanWaitingBar
            plan={plan}
            onDismiss={() => setDismissedPlanHash(plan.plan_hash)}
            onReview={() => void openPlanReview()}
          />
        ) : null}
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-4 overflow-hidden">
        {/* The work panel owns the composer as its own last row, so no amount of
            content above can ever push it out of reach. */}
        <div className="grid min-h-0 overflow-hidden">
          <Panel className="grid-rows-[auto_minmax(0,1fr)_auto]">
            <RunHeader
              configuredLevel={inspection?.autonomy.configured_level ?? "auto"}
              busy={busy}
              integrationStatus={projection.integration.status}
              planAvailable={displayedPlan !== null}
              runActive={runActive}
              stopBusy={stopBusy}
              tasks={tasks}
              onLevelChange={async (level) => {
                setBusy(true);
                setFeedback("");
                try {
                  await onAction({ type: "autonomy.set", payload: { level } });
                  setFeedback(`You will be interrupted at: ${autonomyLabel(level)}.`);
                } catch (error) {
                  setFeedback(plainActionError(error));
                } finally {
                  setBusy(false);
                }
              }}
              onOpenPlan={() => void openPlanReview()}
              onStop={() => void stopRun()}
            />
            {idle ? (
              <IdleBoard onPick={setComposer} />
            ) : (
              <TaskBoard
                groups={inspection?.execution_groups ?? []}
                integrationFailure={inspection?.integration_failure ?? null}
                selectedTaskId={projection.selectedTaskId}
                taskTitles={inspection?.task_titles ?? {}}
                tasks={tasks}
                onSelectTask={onSelectTask}
              />
            )}

            <PromptDock
              busy={busy}
              continuationAvailable={continuationAvailable}
              feedback={feedback || plainActionError(actionError)}
              idle={idle}
              managerStartAvailable={managerStartAvailable}
              runActive={runActive}
              spend={inspection?.spend ?? null}
              value={composer}
              onChange={setComposer}
              onContinue={continueRun}
              onStartManager={async () => {
                setBusy(true);
                setFeedback("");
                try {
                  const started = await startManager();
                  if (inspection?.autonomy.configured_level === "review_everything") {
                    setFeedback("The first step is prepared. Continue when you are ready.");
                  } else {
                    await continueSession(started.session_id);
                    setFeedback("Working until it finishes or something needs you.");
                  }
                } catch (error) {
                  setFeedback(plainActionError(error));
                } finally {
                  setBusy(false);
                }
              }}
              onSubmit={submitPrompt}
            />
          </Panel>
        </div>

        <aside
          className={`grid min-h-0 gap-4 ${
            selected ? "grid-rows-[minmax(0,1.15fr)_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]"
          }`}
        >
          {selected ? (
            <Panel>
              <InspectorPane
                output={projection.selectedOutput}
                task={selected}
                onGuide={() => setRedirectOpen(true)}
              />
            </Panel>
          ) : null}
          <Panel>
            <ActivityStream
              endRef={activityEndRef}
              events={projection.recentEvents}
              taskTitles={inspection?.task_titles ?? {}}
            />
          </Panel>
        </aside>
      </div>

      {displayedPlan ? (
        <PlanTakeover
          busy={busy}
          open={reviewOpen}
          plan={displayedPlan}
          ratificationPending={plan !== null}
          onAdd={() => setAmendment({ kind: "add_task", draft: emptyAmendment() })}
          onEdit={(task) =>
            setAmendment({
              kind: "edit_task",
              draft: amendmentFromTask(task, displayedPlan)
            })
          }
          onOpenChange={setReviewOpen}
          onRatify={async () => {
            if (plan === null) return;
            setBusy(true);
            setFeedback("");
            try {
              await onAction({
                type: "plan.ratify",
                payload: { spec_id: plan.spec_id, expected_plan_hash: plan.plan_hash }
              });
              const started = await startManager();
              setReviewOpen(false);
              if (inspection?.autonomy.configured_level === "review_everything") {
                setFeedback("Approved. The first step is prepared; continue when you are ready.");
              } else {
                await continueSession(started.session_id);
                setFeedback("Approved. Working until it finishes or something needs you.");
              }
            } catch (error) {
              setFeedback(plainActionError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {amendment && inspection?.current_plan ? (
        <AmendmentDialog
          busy={busy}
          plan={inspection.current_plan}
          value={amendment}
          onChange={setAmendment}
          onClose={() => setAmendment(null)}
          onSubmit={async () => {
            setBusy(true);
            setFeedback("");
            try {
              await onAction({
                type: "plan.amend",
                payload: {
                  spec_id: inspection.current_plan!.spec_id,
                  amendment: buildAmendment(amendment, inspection.current_plan!)
                }
              });
              setAmendment(null);
              setFeedback("Queued. It has to pass the normal checks and a fresh review before it counts.");
            } catch (error) {
              setFeedback(plainActionError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {selected ? (
        <TextActionDialog
          busy={busy}
          description="This reaches the agent at its next safe stopping point. Every file and project check still applies."
          open={redirectOpen}
          submitLabel="Send guidance"
          title={`Guide ${selected.title}`}
          value={redirectText}
          onChange={setRedirectText}
          onOpenChange={setRedirectOpen}
          onSubmit={async () => {
            setBusy(true);
            setFeedback("");
            try {
              await onAction({
                type: "task.redirect",
                payload: { task_id: selected.task_id, correction: redirectText }
              });
              setRedirectText("");
              setRedirectOpen(false);
              setFeedback("Guidance queued at the agent's existing safe boundary.");
            } catch (error) {
              setFeedback(plainActionError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <PatchDialog
        error={changeSetPatchError}
        loading={changeSetPatchLoading}
        open={patchOpen}
        patch={changeSetPatch?.text ?? null}
        onOpenChange={setPatchOpen}
      />
    </div>
  );
}

/* Every content surface is a panel lifted off the canvas. Grouping comes from
   the container and its padding, not from a grid of full-bleed rules. */
function Panel({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-rule bg-panel shadow-panel ${className ?? ""}`}
    >
      {children}
    </section>
  );
}

/* ── Decision 2 ───────────────────────────────────────────────────────────── */

function ShipBar({
  item,
  busy,
  onInspect,
  onShip
}: {
  item: WorkspaceQueueItem;
  busy: boolean;
  onInspect: () => void;
  onShip: () => void;
}): React.JSX.Element {
  const changeSet = item.change_set;
  const files = changeSet?.changed_files ?? [];
  return (
    <Collapsible asChild>
      <section
        aria-label="Ready to ship"
        className="mb-4 rounded-lg border border-navy/20 bg-navy-wash px-5 py-4 shadow-panel"
      >
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-md bg-navy text-panel"
          >
            <Check className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
              {item.title}
            </strong>
            {changeSet ? (
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-muted">
                <span>
                  {changeSet.task_ids.length}{" "}
                  {changeSet.task_ids.length === 1 ? "task" : "tasks"} ·
                </span>
                <CollapsibleTrigger asChild>
                  <button
                    className="font-medium text-navy underline decoration-navy/30 underline-offset-2 hover:decoration-navy"
                    type="button"
                  >
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </button>
                </CollapsibleTrigger>
                <span>
                  · into <span className="font-mono text-[12px] text-ink">{changeSet.base_branch}</span>
                </span>
              </span>
            ) : (
              <span className="mt-0.5 block text-[13px] break-words text-muted">
                {plainPrimaryDetail(item.detail, item.kind)}
              </span>
            )}
          </div>
          {changeSet ? (
            <Button
              className="bg-panel/70 text-navy"
              type="button"
              variant="outline"
              onClick={onInspect}
            >
              See every line
            </Button>
          ) : null}
          {item.action ? (
            <Button disabled={busy} type="button" onClick={onShip}>
              {queueActionLabel(item.action.type)}
              <ArrowRight aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <CollapsibleContent>
          <ul className="mt-3.5 mb-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 border-t border-navy/15 p-0 pt-3.5">
            {item.change_set?.changed_files.map((file) => (
              <li className="font-mono text-[12px] break-all text-muted" key={file}>
                {file}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/* ── The only interruption surface ────────────────────────────────────────── */

function AttentionBar({
  item,
  busy,
  moreCount,
  planWaiting,
  onApprove,
  onDismiss,
  onOpen
}: {
  item: WorkspaceQueueItem;
  busy: boolean;
  moreCount: number;
  planWaiting: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const failing = /failed|stopped|blocked|rejected/iu.test(`${item.kind} ${item.title}`);
  const skin = failing
    ? "border-clay/25 bg-clay-wash"
    : "border-amber/25 bg-amber-wash";
  const mark = failing ? "text-clay" : "text-amber";
  return (
    <section
      aria-label="Needs you"
      className={`mb-4 flex items-start gap-4 rounded-lg border px-5 py-4 shadow-panel ${skin}`}
    >
      <span
        aria-hidden="true"
        className={`grid size-8 shrink-0 place-items-center rounded-md bg-panel/70 ${mark}`}
      >
        <AlertTriangle className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className={`text-[12px] font-semibold ${mark}`}>Needs you</span>
          {moreCount > 0 ? (
            <span className="text-[12px] text-muted">{moreCount} more after this</span>
          ) : null}
          {planWaiting ? (
            <span className="text-[12px] text-muted">a plan is also waiting</span>
          ) : null}
        </div>
        <strong className="mt-1 block text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
          {item.title}
        </strong>
        <p className="mt-1.5 mb-0 max-w-[760px] text-[13px] leading-relaxed break-words text-muted">
          {plainPrimaryDetail(item.detail, item.kind)}
        </p>
      </div>
      {item.action ? (
        <Button disabled={busy} type="button" onClick={onApprove}>
          {queueActionLabel(item.action.type)}
        </Button>
      ) : (
        <Button className="bg-panel/70" type="button" variant="outline" onClick={onOpen}>
          Show me
        </Button>
      )}
      <Button
        aria-label="Set this aside"
        size="icon"
        title="Set this aside"
        type="button"
        variant="ghost"
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </section>
  );
}

function PlanWaitingBar({
  plan,
  onReview,
  onDismiss
}: {
  plan: WorkspacePlanReview;
  onReview: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-label="Plan ready for review"
      className="mb-4 flex items-center gap-4 rounded-lg border border-rule bg-panel px-5 py-4 shadow-panel"
    >
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-md bg-navy-wash text-navy"
      >
        <Layers3 className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
          A {plan.tasks.length}-step plan is ready
        </strong>
        <span className="mt-0.5 block text-[13px] text-muted">
          Nothing starts until you review and approve this exact plan.
        </span>
      </div>
      <Button type="button" onClick={onReview}>
        Review the plan
        <ChevronRight aria-hidden="true" />
      </Button>
      <Button
        aria-label="Set this aside"
        size="icon"
        type="button"
        variant="ghost"
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </section>
  );
}

/* ── Run header ───────────────────────────────────────────────────────────── */

function RunHeader({
  tasks,
  runActive,
  planAvailable,
  integrationStatus,
  configuredLevel,
  busy,
  stopBusy,
  onOpenPlan,
  onStop,
  onLevelChange
}: {
  tasks: TaskProjection[];
  runActive: boolean;
  planAvailable: boolean;
  integrationStatus: string;
  configuredLevel: AutonomyLevel;
  busy: boolean;
  stopBusy: boolean;
  onOpenPlan: () => void;
  onStop: () => void;
  onLevelChange: (level: AutonomyLevel) => Promise<void>;
}): React.JSX.Element {
  const working = tasks.filter((task) => task.state === "running").length;
  const done = tasks.filter((task) => shipped(task) || task.state === "verified").length;
  const files = tasks.reduce((count, task) => count + task.lease_files.length, 0);
  const verification = integrationLanguage(integrationStatus);
  const headline =
    tasks.length === 0
      ? runActive
        ? "Planning the work"
        : "Nothing running"
      : working > 0
        ? `${working} ${working === 1 ? "task" : "tasks"} running`
        : runActive
          ? "Waiting on the next task"
          : done === tasks.length
            ? "All tasks finished"
            : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} in this run`;
  const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);

  return (
    <div className="relative flex min-h-[60px] shrink-0 items-center gap-4 border-b border-rule-soft px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="m-0 text-[16px] leading-tight font-semibold tracking-[-0.015em] text-ink">
          {headline}
        </h2>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 text-[13px] text-muted">
          {files > 0 ? (
            <span>{files === 1 ? "1 file" : `${files} files`} being edited</span>
          ) : null}
          {tasks.length > 0 ? (
            <span className="font-mono text-[12px]">
              {done}/{tasks.length} done
            </span>
          ) : null}
          {integrationStatus !== "idle" && tasks.length > 0 ? (
            <span className={`font-medium ${toneText[verification.tone]}`}>
              {verification.label}
            </span>
          ) : null}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {planAvailable ? (
          <Button size="sm" type="button" variant="ghost" onClick={onOpenPlan}>
            <Layers3 aria-hidden="true" />
            View plan
          </Button>
        ) : null}
        {runActive ? (
          <Button
            className="text-clay hover:bg-clay-wash hover:text-clay"
            disabled={stopBusy}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onStop}
          >
            <CircleStop aria-hidden="true" />
            Stop
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="How often Hivemind interrupts you"
              className="text-muted"
              size="sm"
              type="button"
              variant="ghost"
            >
              <SlidersHorizontal aria-hidden="true" />
              {autonomyLabel(configuredLevel)}
              <ChevronDown aria-hidden="true" className="text-muted" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[260px]">
            <DropdownMenuLabel className="text-muted">Interrupt me for</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={configuredLevel}
              onValueChange={(value) => void onLevelChange(value as AutonomyLevel)}
            >
              <DropdownMenuRadioItem disabled={busy} value="auto">
                Only what needs me
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem disabled={busy} value="review_plan">
                The plan, then only what needs me
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem disabled={busy} value="review_everything">
                Every step
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The header's own edge doubles as run progress. It only moves when a task
          actually finishes. */}
      <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-[2px]">
        <span
          className="block h-[2px] rounded-r-full bg-navy transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </span>
    </div>
  );
}

/* ── Decision 1, before anything exists ───────────────────────────────────── */

function IdleBoard({ onPick }: { onPick: (value: string) => void }): React.JSX.Element {
  return (
    <div className="min-h-0 overflow-auto px-8 py-10">
      <div className="max-w-[620px]">
        <h2 className="m-0 text-[32px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink">
          Describe what you
          <br />
          want built.
        </h2>
        <p className="mt-4 mb-0 max-w-[520px] text-[15px] leading-[1.6] text-muted">
          Hivemind splits the work across agents, keeps each one inside its own
          files, and checks every change. You step in twice: now, and when it
          asks you to ship.
        </p>
        <p className="mt-10 mb-3 text-[12px] font-medium text-muted">Try one of these</p>
        <ul className="m-0 grid list-none gap-2 p-0">
          {EXAMPLE_ASKS.map((ask, index) => (
            <li key={ask}>
              <button
                className="group flex w-full items-center gap-3.5 rounded-md border border-rule bg-canvas px-4 py-3 text-left transition-colors hover:border-navy/30 hover:bg-navy-wash"
                type="button"
                onClick={() => onPick(ask)}
              >
                <span className="font-mono text-[12px] text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 text-[14px] break-words text-ink group-hover:text-navy">
                  {ask}
                </span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── The work itself ─────────────────────────────────────────────────────── */

function TaskBoard({
  tasks,
  groups,
  taskTitles,
  integrationFailure,
  selectedTaskId,
  onSelectTask
}: {
  tasks: TaskProjection[];
  groups: WorkspaceInspection["execution_groups"];
  taskTitles: Record<string, string>;
  integrationFailure: WorkspaceInspection["integration_failure"];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  /* The daemon owns the order tasks run in; the lanes below only decide what a
     person would do about each one. */
  const order = useMemo(() => {
    const index = new Map<string, number>();
    let position = 0;
    for (const group of groups) {
      for (const taskId of group.task_ids) {
        if (!index.has(taskId)) index.set(taskId, position++);
      }
    }
    return index;
  }, [groups]);

  const lanes = LANES.map((lane) => ({
    ...lane,
    tasks: tasks
      .filter((task) => lane.states.includes(task.state))
      .sort(
        (left, right) =>
          (order.get(left.task_id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.task_id) ?? Number.MAX_SAFE_INTEGER) ||
          left.task_id.localeCompare(right.task_id)
      )
  })).filter((lane) => lane.tasks.length > 0);

  return (
    <ScrollArea className="min-h-0">
      <div className="pb-4">
        {lanes.length === 0 ? (
          <p className="m-0 px-5 py-6 text-[14px] text-muted">
            The plan is being prepared. Nothing is running yet.
          </p>
        ) : null}
        {lanes.map((lane) => (
          <section key={lane.key}>
            <header className="sticky top-0 z-1 flex items-baseline justify-between gap-3 border-b border-rule-soft bg-canvas px-5 py-2">
              <span className="text-[12px] font-medium text-muted">{lane.label}</span>
              <span className="font-mono text-[12px] text-muted">{lane.tasks.length}</span>
            </header>
            {lane.tasks.map((task) => (
              <TaskRow
                key={task.task_id}
                integrationFailure={
                  integrationFailure?.task_ids.includes(task.task_id)
                    ? integrationFailure.reason
                    : null
                }
                selected={task.task_id === selectedTaskId}
                task={task}
                taskTitles={taskTitles}
                onSelect={() => onSelectTask(task.task_id)}
              />
            ))}
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

function TaskRow({
  task,
  taskTitles,
  integrationFailure,
  selected,
  onSelect
}: {
  task: TaskProjection;
  taskTitles: Record<string, string>;
  integrationFailure: string | null;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const language =
    integrationFailure === null
      ? stateLanguage[task.state]
      : { label: "Project checks blocked", tone: "danger" as const };
  const issue = integrationFailure ?? task.issue;
  const dependencies = task.depends_on
    .map((taskId) => taskTitles[taskId] ?? taskId)
    .join(", ");
  return (
    <button
      aria-pressed={selected}
      className={`relative flex w-full items-start gap-4 border-b border-rule-soft px-5 py-3.5 text-left transition-colors ${
        selected ? "bg-navy-wash" : "bg-transparent hover:bg-canvas"
      }`}
      type="button"
      onClick={onSelect}
    >
      <span
        aria-hidden="true"
        className={`mt-[7px] size-2 shrink-0 rounded-full ${toneEdge[language.tone]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-snug font-medium break-words text-ink">
          {task.title}
        </span>
        <span className="mt-1 block text-[13px] break-words text-muted">
          <span className="font-mono text-[12px]" title={task.task_id}>
            {task.task_id}
          </span>
          {task.lease_files.length > 0
            ? ` · editing ${task.lease_files.length} ${task.lease_files.length === 1 ? "file" : "files"}`
            : ""}
          {dependencies !== "" ? ` · after ${dependencies}` : ""}
        </span>
        {issue ? (
          <span className="mt-2 block rounded-md bg-clay-wash px-2.5 py-1.5 text-[13px] leading-snug break-words text-clay">
            {plainTaskIssue(issue)}
          </span>
        ) : null}
      </span>
      <span className={`shrink-0 text-[13px] font-medium ${toneText[language.tone]}`}>
        {language.label}
      </span>
    </button>
  );
}

/* ── Rail: what one agent is doing, then what just happened ──────────────── */

function InspectorPane({
  task,
  output,
  onGuide
}: {
  task: TaskProjection;
  output: BoardProjection["selectedOutput"];
  onGuide: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"summary" | "raw">("summary");
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => setMode("summary"), [task.task_id]);
  const files = task.lease_files;
  const text =
    mode === "summary"
      ? summarizeWorkerOutput(output)
      : output.map((record) => `[${formatClock(record.ts)}] ${record.text}`).join("\n");

  return (
    <>
      <header className="grid shrink-0 gap-3 border-b border-rule-soft px-4 py-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <strong className="block text-[14px] leading-snug font-semibold break-words text-ink">
              {task.title}
            </strong>
            <span className="mt-0.5 block text-[13px] break-words text-muted">
              <span className="font-mono text-[12px]">{task.task_id}</span>
              {task.agent ? ` · ${task.agent}` : " · no agent yet"}
            </span>
          </div>
          <Button
            aria-label="Guide this agent"
            size="icon-sm"
            title="Guide this agent"
            type="button"
            variant="outline"
            onClick={onGuide}
          >
            <MessageSquareText aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted">Live output</span>
          <span
            aria-label="How much output to show"
            className="ml-auto inline-flex gap-0.5 rounded-md bg-canvas p-0.5"
            role="group"
          >
            {(["summary", "raw"] as const).map((option) => (
              <button
                className={`rounded-sm px-2 py-1 text-[12px] font-medium transition-colors ${
                  mode === option
                    ? "bg-panel text-ink shadow-panel"
                    : "text-muted hover:text-ink"
                }`}
                key={option}
                type="button"
                onClick={() => setMode(option)}
              >
                {option === "summary" ? "Highlights" : "Everything"}
              </button>
            ))}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        <ScrollArea className="min-h-0">
          <pre className="m-0 px-4 py-3 font-mono text-[12px] leading-[1.7] break-words whitespace-pre-wrap text-ink">
            {output.length > 0 ? text : "Nothing from this agent yet."}
          </pre>
        </ScrollArea>

        <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full items-center gap-2 border-t border-rule-soft px-4 py-2.5 text-left hover:bg-canvas"
              type="button"
            >
              <FileCode2 aria-hidden="true" className="size-4 text-muted" />
              <span className="text-[13px] text-ink">Files being edited</span>
              <span className="ml-auto font-mono text-[12px] text-muted">{files.length}</span>
              <ChevronRight
                aria-hidden="true"
                className={`size-4 text-muted transition-transform ${filesOpen ? "rotate-90" : ""}`}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {files.length === 0 ? (
              <p className="m-0 px-4 pb-3 text-[13px] text-muted">
                This task is not editing any file yet.
              </p>
            ) : (
              <ul className="m-0 max-h-[140px] list-none overflow-auto p-0 pb-2">
                {files.map((file) => (
                  <li
                    className="px-4 py-1 font-mono text-[12px] break-all text-muted"
                    key={file}
                  >
                    {file}
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}

function ActivityStream({
  events,
  taskTitles,
  endRef
}: {
  events: BoardProjection["recentEvents"];
  taskTitles: Record<string, string>;
  endRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const groups = groupConsecutiveActivity(events);
  return (
    <>
      <header className="flex shrink-0 items-baseline justify-between gap-2 border-b border-rule-soft px-4 py-3">
        <h2 className="m-0 text-[14px] font-semibold text-ink" id="activity-title">
          Activity
        </h2>
        <span className="text-[12px] text-muted">newest at the bottom</span>
      </header>
      <ScrollArea aria-labelledby="activity-title" className="min-h-0">
        {groups.length === 0 ? (
          <p className="m-0 px-4 py-4 text-[13px] leading-relaxed text-muted">
            Quiet for now. Updates land here as they happen.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {groups.map(({ event, count }, index) => (
              <li
                className="flex items-baseline gap-2.5 px-4 py-2"
                key={`${event.ts}-${event.type}-${index}`}
              >
                <time className="shrink-0 font-mono text-[12px] text-muted">
                  {formatClock(event.ts)}
                </time>
                <span
                  aria-hidden="true"
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${eventDot(event.type)}`}
                />
                <span className="min-w-0 flex-1 text-[13px] leading-snug break-words text-ink">
                  {eventDescription(event, taskTitles)}
                  {count > 1 ? (
                    <span className="ml-1.5 font-mono text-[12px] text-muted">×{count}</span>
                  ) : null}
                </span>
              </li>
            ))}
            <div ref={endRef} />
          </ol>
        )}
      </ScrollArea>
    </>
  );
}

/* ── Decision 1, anchored forever at the bottom ──────────────────────────── */

function PromptDock({
  value,
  idle,
  runActive,
  continuationAvailable,
  managerStartAvailable,
  busy,
  feedback,
  spend,
  onChange,
  onSubmit,
  onContinue,
  onStartManager
}: {
  value: string;
  idle: boolean;
  runActive: boolean;
  continuationAvailable: boolean;
  managerStartAvailable: boolean;
  busy: boolean;
  feedback: string;
  spend: WorkspaceInspection["spend"] | null;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onContinue: () => Promise<void>;
  onStartManager: () => Promise<void>;
}): React.JSX.Element {
  return (
    <footer className="shrink-0 border-t border-rule-soft p-3">
      <form className="grid gap-2.5" onSubmit={(event) => void onSubmit(event)}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-md border border-rule bg-canvas p-2 transition-colors focus-within:border-navy/40 focus-within:bg-panel">
          <textarea
            className="max-h-[180px] min-h-[40px] w-full resize-y border-0 bg-transparent px-1.5 py-1.5 text-[15px] leading-[1.55] text-ink outline-none placeholder:text-muted"
            placeholder={
              runActive
                ? "Add guidance for the next step…"
                : idle
                  ? "Describe what you want built…"
                  : "Describe the next change you want…"
            }
            rows={idle ? 3 : 2}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            className={idle ? "h-11 px-5 text-[14px]" : "size-11"}
            disabled={busy || value.trim() === ""}
            size={idle ? "default" : "icon"}
            type="submit"
          >
            {idle ? (
              <>
                Start building
                <ArrowRight aria-hidden="true" />
              </>
            ) : (
              <Send aria-hidden="true" className="size-[18px]" />
            )}
          </Button>
        </div>
        {feedback ? (
          <p
            className="m-0 rounded-md bg-navy-wash px-3 py-2 text-[13px] leading-snug break-words text-navy"
            role="status"
          >
            {feedback}
          </p>
        ) : null}
        <div className="flex items-center gap-3 px-2">
          <span className="min-w-0 flex-1 text-[12px] leading-snug break-words text-muted">
            {runActive
              ? "Guidance is read on the next step and does not change work already in progress."
              : "Typing describes work. Nothing runs until Hivemind has a plan it can check."}
          </span>
          {managerStartAvailable ? (
            <Button disabled={busy} size="sm" type="button" variant="outline" onClick={() => void onStartManager()}>
              Start the approved plan
            </Button>
          ) : null}
          {continuationAvailable ? (
            <Button disabled={busy} size="sm" type="button" variant="outline" onClick={() => void onContinue()}>
              Keep going
            </Button>
          ) : null}
          <SpendMeter spend={spend} />
        </div>
      </form>
    </footer>
  );
}

function SpendMeter({
  spend
}: {
  spend: WorkspaceInspection["spend"] | null;
}): React.JSX.Element {
  if (!spend) {
    return <span className="shrink-0 text-[12px] text-muted">no spend yet</span>;
  }
  const ratio =
    spend.session_ceiling_tokens > 0
      ? Math.min(100, (spend.committed_tokens / spend.session_ceiling_tokens) * 100)
      : 0;
  return (
    <span
      className={`flex shrink-0 items-center gap-2.5 rounded-md px-2 py-1 font-mono text-[12px] ${
        spend.near_session_ceiling ? "bg-amber-wash text-amber" : "text-muted"
      }`}
      title={`${spend.run_ceiling_tokens.toLocaleString()} tokens maximum per call`}
    >
      <span>{spend.calls} calls</span>
      <span className="block h-1.5 w-[56px] overflow-hidden rounded-full bg-rule">
        <span
          className={`block h-1.5 rounded-full ${spend.near_session_ceiling ? "bg-amber" : "bg-navy"}`}
          style={{ width: `${ratio}%` }}
        />
      </span>
      <span>
        {formatCompact(spend.effective_tokens)} + {formatCompact(spend.reserved_tokens)} held /{" "}
        {formatCompact(spend.session_ceiling_tokens)}
      </span>
    </span>
  );
}

/* ── Plan review ─────────────────────────────────────────────────────────── */

function PlanTakeover({
  plan,
  open,
  busy,
  ratificationPending,
  onOpenChange,
  onRatify,
  onAdd,
  onEdit
}: {
  plan: WorkspacePlanReview;
  open: boolean;
  busy: boolean;
  ratificationPending: boolean;
  onOpenChange: (open: boolean) => void;
  onRatify: () => Promise<void>;
  onAdd: () => void;
  onEdit: (task: WorkspacePlanTask) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[min(780px,calc(100vh-48px))] w-[min(1140px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="border-b border-rule-soft px-8 py-6">
          <span className="text-[12px] font-medium text-navy">
            {ratificationPending ? "Before anything starts" : "The approved plan"}
          </span>
          <DialogTitle className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">
            {plan.tasks.length} {plan.tasks.length === 1 ? "step" : "steps"}, in{" "}
            {plan.execution_groups.length}{" "}
            {plan.execution_groups.length === 1 ? "stage" : "stages"}
          </DialogTitle>
          <DialogDescription className="max-w-[720px] text-[14px] leading-relaxed">
            {ratificationPending
              ? "Check the order, the files each step may touch, and how each result gets checked. Approving applies to this exact version only."
              : "Read-only record of the exact approved plan, including how each step's result is checked."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="px-8 py-6">
            {plan.execution_groups.map((group, groupIndex) => (
              <section
                className="grid grid-cols-[172px_minmax(0,1fr)] gap-6 pb-6"
                key={group.group_id}
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-ink font-mono text-[12px] text-panel">
                    {groupIndex + 1}
                  </span>
                  <div className="min-w-0">
                    <strong className="block text-[14px] font-semibold text-ink">
                      {group.mode === "parallel"
                        ? `${group.task_ids.length} at the same time`
                        : `${group.task_ids.length} in order`}
                    </strong>
                    <span className="mt-1 block font-mono text-[12px] break-words text-muted">
                      {group.group_id}
                    </span>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {group.task_ids.map((taskId) => {
                    const task = plan.tasks.find((candidate) => candidate.task_id === taskId);
                    return task ? (
                      <PlanTaskCard
                        key={taskId}
                        plan={plan}
                        task={task}
                        onEdit={() => onEdit(task)}
                      />
                    ) : null;
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter className="items-center justify-between border-t border-rule-soft bg-panel px-8 py-4 sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <code className="rounded-sm bg-canvas px-2 py-1 font-mono text-[12px] text-muted">
              {plan.plan_hash.slice(0, 12)}
            </code>
            <span className="text-[13px] text-muted">
              {ratificationPending
                ? "Any regenerated or edited plan needs a fresh approval."
                : "Read-only record of the exact approved plan."}
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <Button type="button" variant="outline" onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add a step
            </Button>
            {ratificationPending ? (
              <Button disabled={busy} size="lg" type="button" onClick={() => void onRatify()}>
                <Check aria-hidden="true" />
                Approve and start
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanTaskCard({
  task,
  plan,
  onEdit
}: {
  task: WorkspacePlanTask;
  plan: WorkspacePlanReview;
  onEdit: () => void;
}): React.JSX.Element {
  const after = task.depends_on
    .map((taskId) => plan.tasks.find((entry) => entry.task_id === taskId)?.title ?? taskId)
    .join(", ");
  return (
    <article className="min-w-0 rounded-lg border border-rule bg-panel p-5 shadow-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 text-[15px] leading-snug font-semibold break-words text-ink">
            {task.title}
          </h3>
          <span className="mt-1 block font-mono text-[12px] text-muted">{task.task_id}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {task.tier === "high" || task.tier === "critical" ? (
            <Badge tone={task.tier === "critical" ? "danger" : "warning"}>
              {capitalize(task.tier)} risk
            </Badge>
          ) : null}
          <Button
            aria-label={`Edit ${task.title}`}
            size="icon-sm"
            title="Edit this step"
            type="button"
            variant="ghost"
            onClick={onEdit}
          >
            <SlidersHorizontal aria-hidden="true" />
          </Button>
        </div>
      </div>
      <dl className="mt-4 mb-0 grid gap-3">
        <PlanFact label="Changes" value={task.scope.join(", ") || "No files"} mono />
        <PlanFact label="Reads" value={task.read_only_scope.join(", ") || "Nothing extra"} mono />
        <PlanFact label="After" value={after || "Can start immediately"} />
        <PlanFact label="Done when" value={task.acceptance_criterion} />
        <PlanFact
          label="How it is checked"
          value={task.deterministic_validity_check ?? "The named checks listed in this step"}
          mono
        />
      </dl>
    </article>
  );
}

function PlanFact({
  label,
  value,
  mono = false
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-4 border-t border-rule-soft pt-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd
        className={`m-0 break-words text-ink ${mono ? "font-mono text-[12px] leading-relaxed" : "text-[13px] leading-snug"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/* ── Plan editing, deliberately kept inside plan review ──────────────────── */

function AmendmentDialog({
  value,
  plan,
  busy,
  onChange,
  onClose,
  onSubmit
}: {
  value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft };
  plan: WorkspacePlanReview;
  busy: boolean;
  onChange: (value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft }) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}): React.JSX.Element {
  const update = (field: keyof AmendmentDraft, next: string): void =>
    onChange({ ...value, draft: { ...value.draft, [field]: next } });
  const field =
    "w-full rounded-md border border-rule bg-canvas px-2.5 py-2 font-mono text-[13px] font-normal text-ink";
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-[min(760px,calc(100vw-48px))] gap-0 p-0 sm:max-w-none">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader className="border-b border-rule-soft px-6 py-5">
            <DialogTitle className="text-[19px] font-semibold tracking-[-0.015em]">
              {value.kind === "add_task" ? "Add a step" : `Edit ${value.draft.taskId}`}
            </DialogTitle>
            <DialogDescription className="text-[14px] leading-relaxed">
              {value.kind === "edit_task"
                ? "If this step has already started, Hivemind will refuse the edit and tell you the safer next move."
                : "The step is queued for grounding and checks, then comes back to you as a new plan to review."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] grid-cols-2 gap-4 overflow-auto px-6 py-5">
            <label className="grid gap-2 text-[13px] font-medium text-ink">
              Step ID
              <input
                className={field}
                disabled={value.kind === "edit_task"}
                onChange={(event) => update("taskId", event.target.value)}
                value={value.draft.taskId}
              />
            </label>
            <label className="grid gap-2 text-[13px] font-medium text-ink">
              Title
              <input
                className={field}
                onChange={(event) => update("title", event.target.value)}
                value={value.draft.title}
              />
            </label>
            <label className="col-span-2 grid gap-2 text-[13px] font-medium text-ink">
              Files it may change
              <textarea
                className={field}
                onChange={(event) => update("files", event.target.value)}
                placeholder="src/example.ts"
                rows={2}
                value={value.draft.files}
              />
            </label>
            <label className="col-span-2 grid gap-2 text-[13px] font-medium text-ink">
              Files it may read
              <textarea
                className={field}
                onChange={(event) => update("readOnlyFiles", event.target.value)}
                rows={2}
                value={value.draft.readOnlyFiles}
              />
            </label>
            <label className="grid gap-2 text-[13px] font-medium text-ink">
              Runs after
              <input
                className={field}
                onChange={(event) => update("dependencies", event.target.value)}
                placeholder="T-001, T-002"
                value={value.draft.dependencies}
              />
            </label>
            <label className="grid gap-2 text-[13px] font-medium text-ink">
              Named check
              <input
                className={field}
                onChange={(event) => update("checks", event.target.value)}
                placeholder="npm test"
                value={value.draft.checks}
              />
            </label>
            <label className="col-span-2 grid gap-2 text-[13px] font-medium text-ink">
              Done when
              <textarea
                className={field}
                onChange={(event) => update("acceptance", event.target.value)}
                rows={2}
                value={value.draft.acceptance}
              />
            </label>
            <label className="col-span-2 grid gap-2 text-[13px] font-medium text-ink">
              Independent check
              <input
                className={field}
                onChange={(event) => update("validityCheck", event.target.value)}
                placeholder="Optional command that proves the result without the step's own tests"
                value={value.draft.validityCheck}
              />
            </label>
            {value.kind === "add_task" ? (
              <>
                <label className="grid gap-2 text-[13px] font-medium text-ink">
                  Stage
                  <input
                    className={field}
                    onChange={(event) => update("groupId", event.target.value)}
                    value={value.draft.groupId}
                  />
                </label>
                <label className="grid gap-2 text-[13px] font-medium text-ink">
                  Order
                  <select
                    className={field}
                    onChange={(event) => update("groupMode", event.target.value)}
                    value={value.draft.groupMode}
                  >
                    <option value="sequence">In order</option>
                    <option value="parallel">At the same time</option>
                  </select>
                </label>
              </>
            ) : null}
          </div>
          <DialogFooter className="items-center justify-between border-t border-rule-soft bg-canvas px-6 py-4 sm:justify-between">
            <span className="text-[13px] text-muted">
              Current plan: {plan.tasks.length} {plan.tasks.length === 1 ? "step" : "steps"}
            </span>
            <Button disabled={busy} type="submit">
              {value.kind === "add_task" ? "Queue the step" : "Queue the edit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TextActionDialog({
  title,
  description,
  value,
  open,
  busy,
  submitLabel,
  onChange,
  onOpenChange,
  onSubmit
}: {
  title: string;
  description: string;
  value: string;
  open: boolean;
  busy: boolean;
  submitLabel: string;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => Promise<void>;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-[19px] font-semibold tracking-[-0.015em] break-words">{title}</DialogTitle>
            <DialogDescription className="text-[14px] leading-relaxed">
              {description}
            </DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            className="min-h-[150px] w-full resize-y rounded-md border border-rule bg-canvas px-3 py-2.5 text-[14px] leading-relaxed text-ink"
            rows={6}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <DialogFooter className="items-center justify-between sm:justify-between">
            <span className="text-[13px] text-muted">
              Guidance cannot approve a change or ship anything.
            </span>
            <Button disabled={busy || value.trim() === ""} type="submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PatchDialog({
  open,
  patch,
  loading,
  error,
  onOpenChange
}: {
  open: boolean;
  patch: string | null;
  loading: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(720px,calc(100vh-48px))] w-[min(1000px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule-soft px-6 py-5">
          <DialogTitle className="text-[19px] font-semibold tracking-[-0.015em]">
            Every line that would land
          </DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed">
            Exactly what was checked. Nothing here has touched your branch yet.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 bg-canvas">
          {loading ? (
            <p className="m-0 px-6 py-5 text-[13px] text-muted">Loading the checked changes…</p>
          ) : null}
          {error ? (
            <p className="m-0 px-6 py-5 text-[13px] text-clay" role="status">
              {error}
            </p>
          ) : null}
          {patch ? (
            <pre className="m-0 px-6 py-5 font-mono text-[12px] leading-[1.7] break-words whitespace-pre-wrap text-ink">
              {patch}
            </pre>
          ) : null}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/* ── Language and formatting ─────────────────────────────────────────────── */

function queueActionLabel(actionType: string): string {
  if (actionType === "manager.start") return "Pick it back up";
  if (actionType === "manager.continue") return "Keep going";
  if (actionType === "manager.retry_blocked") return "Try again";
  if (actionType === "task.stop") return "Stop this task";
  if (actionType === "verification.rerun") return "Run the checks again";
  if (actionType === "adoption.review") return "Show me the changes";
  if (actionType === "adoption.execute") return "Ship it";
  return "Go ahead";
}

function actionSuccessMessage(actionType: string): string {
  if (actionType === "manager.approve_pending") return "The next step was approved.";
  if (actionType === "verification.rerun") return "Fresh project checks completed.";
  return "Done.";
}

function autonomyLabel(level: AutonomyLevel): string {
  return level === "auto"
    ? "Only what needs me"
    : level === "review_plan"
      ? "Plan, then what needs me"
      : "Every step";
}

function shipped(task: TaskProjection): boolean {
  return task.integration === "merged" || task.state === "merged";
}

/* Two vocabularies: things a task did (read after its title) and things the run
   did (read on their own). Mixing them is what made the old stream unreadable. */
const TASK_EVENT_LABELS: Record<string, string> = {
  "task.created": "was added to the plan",
  "task.started": "started working",
  "task.completed": "finished its work",
  "task.failed": "stopped unexpectedly",
  "task.paused": "paused for capacity",
  "task.resumed": "picked up where it left off",
  "task.blocked": "needs help before it can continue",
  "task.redirected": "received new guidance",
  "lease.approved": "started editing its files",
  "lease.released": "finished editing its files",
  "patch.submitted": "sent its change for checking",
  "patch.accepted": "passed its file checks",
  "patch.rejected": "has to revise its change",
  "routing.observed": "used a model",
  "quality.draft_started": "started a second attempt",
  "quality.draft_verified": "checked its second attempt"
};

const RUN_EVENT_LABELS: Record<string, string> = {
  "human.guidance_recorded": "Your guidance was saved for the next step",
  "plan.prepared": "A plan was prepared for you to review",
  "plan.ratified": "You approved the plan",
  "plan.amendment_queued": "A plan change was queued for review",
  "integration.blocked": "Project checks are blocked",
  "integration.low_confidence": "A change has thin test coverage",
  "integration.passed": "Changes passed the project checks and are ready to ship",
  "quality.selection_decided": "A candidate change was picked for review"
};

function eventDescription(
  event: HivemindEvent,
  taskTitles: Record<string, string>
): string {
  if (event.type === "adoption.completed") {
    const taskCount = Array.isArray(event.data.task_ids) ? event.data.task_ids.length : 0;
    return `Shipped ${taskCount} ${taskCount === 1 ? "task" : "tasks"} to your branch`;
  }
  const runLabel = RUN_EVENT_LABELS[event.type];
  if (runLabel) return runLabel;
  const taskLabel = TASK_EVENT_LABELS[event.type];
  if (taskLabel && event.task_id) {
    return `${taskTitles[event.task_id] ?? "A task"} ${taskLabel}`;
  }
  return taskLabel ?? "Project state was updated";
}

function eventDot(type: string): string {
  if (/failed|blocked|rejected|cancel_failed/u.test(type)) return "bg-clay";
  if (/passed|accepted|integrated|ratified/u.test(type)) return "bg-navy";
  if (/started|submitted|guidance|draft/u.test(type)) return "bg-navy/55";
  return "bg-rule";
}

function plainPrimaryDetail(detail: string, kind: WorkspaceQueueItem["kind"]): string {
  if (kind === "quality_cancel_failed") {
    return "A second attempt may still be running. Check it before starting another one.";
  }
  if (/oracle|tier-?2|write[-_ ]intent|lease|durable trail|provider evidence/iu.test(detail)) {
    return "Open the details to see what needs attention.";
  }
  return detail;
}

function plainTaskIssue(issue: string): string {
  if (/quota|429|capacity/iu.test(issue)) return "Paused until capacity is available.";
  if (/oracle|coverage/iu.test(issue)) return "Testing is too thin for this change.";
  if (/write[-_ ]intent|scope/iu.test(issue)) {
    return "The agent tried to change a file outside this task.";
  }
  return issue;
}

function integrationLanguage(status: string): { label: string; tone: Tone } {
  if (status === "merged") return { label: "Merged", tone: "good" };
  if (status === "blocked") return { label: "Project checks blocked", tone: "danger" };
  if (status === "low-confidence") return { label: "Thin test coverage", tone: "warning" };
  if (status === "failed") return { label: "Checks failed", tone: "danger" };
  if (status === "passed") return { label: "Ready to ship", tone: "good" };
  if (status === "running" || status === "queued") return { label: "Checking", tone: "live" };
  return { label: "Not checked yet", tone: "neutral" };
}

function emptyAmendment(): AmendmentDraft {
  return {
    taskId: "",
    title: "",
    files: "",
    readOnlyFiles: "",
    dependencies: "",
    acceptance: "",
    validityCheck: "",
    checks: "",
    groupId: "G-new",
    groupMode: "sequence"
  };
}

function amendmentFromTask(
  task: WorkspacePlanTask,
  plan: WorkspacePlanReview | null
): AmendmentDraft {
  const group = plan?.execution_groups.find((entry) => entry.task_ids.includes(task.task_id));
  return {
    taskId: task.task_id,
    title: task.title,
    files: task.scope.join("\n"),
    readOnlyFiles: task.read_only_scope.join("\n"),
    dependencies: task.depends_on.join(", "),
    acceptance: task.acceptance_criterion,
    validityCheck: task.deterministic_validity_check ?? "",
    checks: task.required_tests.join("\n"),
    groupId: group?.group_id ?? "G-edit",
    groupMode: group?.mode ?? "sequence"
  };
}

function buildAmendment(
  value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft },
  plan: WorkspacePlanReview
): Record<string, unknown> {
  const existing = plan.tasks.find((task) => task.task_id === value.draft.taskId);
  const allowedFiles = splitList(value.draft.files);
  const task = {
    task_id: value.draft.taskId.trim(),
    title: value.draft.title.trim(),
    task_type: existing?.task_type ?? "generative",
    routing_task_type: existing?.routing_task_type ?? "other",
    mode: existing?.mode ?? "write",
    agent_role: existing?.agent_role ?? "builder",
    draft_scope: {
      allowed_files: allowedFiles,
      allowed_file_intents: Object.fromEntries(
        allowedFiles.map((file) => [file, existing?.allowed_file_intents[file] ?? "modify"])
      ),
      read_only_files: splitList(value.draft.readOnlyFiles),
      forbidden_files: existing?.forbidden_scope ?? [],
      must_not_change: existing?.must_not_change ?? []
    },
    depends_on: splitList(value.draft.dependencies),
    parallel_safe: existing?.parallel_safe ?? false,
    acceptance_criterion: value.draft.acceptance.trim(),
    ...(value.draft.validityCheck.trim()
      ? { deterministic_validity_check: value.draft.validityCheck.trim() }
      : {}),
    required_tests: splitList(value.draft.checks),
    patch_requirements: existing?.patch_requirements ?? [
      "Submit only the requested scoped change."
    ],
    critical_path_approved: existing?.critical_path_approved ?? false
  };
  return value.kind === "add_task"
    ? {
        kind: value.kind,
        task,
        execution_group: {
          group_id: value.draft.groupId.trim(),
          mode: value.draft.groupMode
        }
      }
    : { kind: value.kind, task };
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

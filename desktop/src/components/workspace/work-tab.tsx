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
  ListTree,
  MessageSquareText,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  TextQuote,
  X
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

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
import {
  Panel,
  PanelCount,
  PanelHeader,
  PanelLabel
} from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PhaseSpine, RunMap, phaseRatio } from "@/components/workspace/agent-map";
import {
  SpecReviewPanel,
  initialNonGoals,
  NOTHING_TO_DECLINE,
  type NonGoalEntry
} from "@/components/workspace/spec-review";
import { plainActionError } from "@/lib/plain-language";
import {
  RECENT_EVENT_LIMIT,
  type BoardProjection,
  type TaskProjection,
  type TaskState
} from "@/lib/projection";
import { PHASES, filesInFlight, runStanding, taskPhase } from "@/lib/phases";
import {
  buildRunThread,
  runSpanMs,
  taskLabel,
  type ThreadEntry,
  type ThreadTone
} from "@/lib/work-thread";
import { attentionHeadline, summarizeWorkerOutput } from "@/lib/work-presentation";
import { containsInternalVocabulary } from "@/lib/vocabulary";
import type {
  AutonomyLevel,
  WorkspaceAction,
  WorkspaceInspection,
  WorkspacePlanReview,
  WorkspacePlanTask,
  WorkspaceQueueItem,
  SpecReview
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
  neutral: "text-muted-foreground",
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

const toneDot: Record<ThreadTone, string> = {
  neutral: "bg-rule",
  live: "bg-navy/55",
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
  /* The map is the same run drawn as shape. It is a way of looking, not a place
     to be, so it lives here rather than in the shell's navigation. */
  const [view, setView] = useState<"thread" | "map">("thread");
  const [reviewOpen, setReviewOpen] = useState(false);
  /* The spec half of the one review. Read through the audited dispatcher; the
     client decides nothing about it. */
  const [specReview, setSpecReview] = useState<SpecReview | null>(null);
  const [nonGoals, setNonGoals] = useState<NonGoalEntry[]>([]);
  const [composer, setComposer] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [amendment, setAmendment] = useState<{
    kind: "add_task" | "edit_task";
    draft: AmendmentDraft;
  } | null>(null);
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [redirectText, setRedirectText] = useState("");
  const [replanOpen, setReplanOpen] = useState(false);
  const [replanText, setReplanText] = useState("");
  const [patchOpen, setPatchOpen] = useState(false);
  const [changeSetPatch, setChangeSetPatch] = useState<{
    verificationId: string;
    text: string;
  } | null>(null);
  const [changeSetPatchError, setChangeSetPatchError] = useState("");
  const [changeSetPatchLoading, setChangeSetPatchLoading] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const activityEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const attentionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [projection.eventCount]);

  /* `/` reaches the composer from anywhere, Escape sets the current
     interruption aside. Both stay out of the way while you are typing. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        composerRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && !typing) {
        setDismissedAttention((items) =>
          attentionIdRef.current === null || items.includes(attentionIdRef.current)
            ? items
            : [...items, attentionIdRef.current]
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
  attentionIdRef.current = attention?.id ?? null;
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
  /* A plan that has nothing left to do must not capture the next request. A task
     the daemon has not projected yet has not finished either. */
  const planHasWorkLeft =
    currentPlan !== null &&
    currentPlan.tasks.some((planned) => {
      const task = tasks.find((entry) => entry.task_id === planned.task_id);
      return task === undefined || (task.state !== "merged" && task.state !== "cancelled");
    });

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

  /* One request, one plan. Used by the composer when nothing is left to do, and
     by "Start over" when a prepared plan is not what the person wanted. */
  const preparePlan = async (message: string): Promise<void> => {
    /* A project with no spec yet gets one drafted from what was typed. Core
       decides everything about it; this only notices, from the inspection, that
       there is nothing to plan against yet. The drafted spec carries the
       orchestrator's signature only -- the person's comes at the review. */
    if (inspection?.active_spec_id === null || inspection?.active_spec_id === undefined) {
      setFeedback("Working out what you asked for…");
      await onAction({ type: "spec.draft", payload: { prompt: message, tool: "planner" } });
    }
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
        /* A plan you do not want is not a dead end: the text becomes the start of
           a different plan instead of being thrown away. */
        setReplanText(message);
        setReplanOpen(true);
        setFeedback(
          "Review the prepared plan first. Typed guidance cannot approve it — start over below if you want a different plan."
        );
        return;
      } else if (!planHasWorkLeft) {
        await preparePlan(message);
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

  /* Stopping one task used to be reachable only from the separate tree tab. It
     belongs beside the agent it stops, in the one inspector this app now has. */
  const stopTask = async (taskId: string, reason: string): Promise<void> => {
    setBusy(true);
    setFeedback("");
    try {
      await onAction({ type: "task.stop", payload: { task_id: taskId, reason } });
      setFeedback("Stopped. Its files were released for other work.");
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
    const specId = plan?.spec_id ?? currentPlan?.spec_id ?? null;
    if (specId !== null) {
      try {
        const loaded = await onAction<SpecReview>({
          type: "spec.review",
          payload: { spec_id: specId }
        });
        setSpecReview(loaded);
        setNonGoals(initialNonGoals(loaded));
      } catch {
        /* A spec that cannot be read is not a reason to hide the plan. */
        setSpecReview(null);
      }
    }
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
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-3">
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
            planWaiting={planWaiting}
            rest={openQueue.filter((entry) => entry.id !== attention.id)}
            taskTitles={inspection?.task_titles ?? {}}
            onApprove={() => void approveQueueItem(attention)}
            onApproveOther={(other) => void approveQueueItem(other)}
            onDismiss={() => setDismissedAttention((items) => [...items, attention.id])}
            onDismissOther={(other) =>
              setDismissedAttention((items) => [...items, other.id])
            }
            onOpen={() => openAttentionTarget(attention)}
            onOpenOther={(other) => openAttentionTarget(other)}
          />
        ) : planWaiting && plan ? (
          <PlanWaitingBar
            plan={plan}
            onDismiss={() => setDismissedPlanHash(plan.plan_hash)}
            onReview={() => void openPlanReview()}
            onStartOver={() => {
              setReplanText("");
              setReplanOpen(true);
            }}
          />
        ) : null}
      </div>

      {/* A run with no tasks projected yet -- which a real trail does produce,
          with five things in the queue and nothing to show beside them -- must
          not hold 360px open for an empty panel. */}
      {/* The rail narrows below ~1100 and widens above ~1600; it is never
          hidden. Hiding it takes the live output, the guide control and the
          stop control off the screen entirely, which is a capability loss
          dressed up as responsive behaviour. */}
      <div
        className={`grid min-h-0 gap-3 overflow-hidden ${
          tasks.length === 0
            ? "grid-cols-[minmax(0,1fr)]"
            : "grid-cols-[minmax(0,1fr)_300px] min-[1100px]:grid-cols-[minmax(0,1fr)_360px] min-[1600px]:grid-cols-[minmax(0,1fr)_420px]"
        }`}
      >
        {/* The work panel owns the composer as its own last row, so no amount of
            content above can ever push it out of reach. */}
        <div className="grid min-h-0 overflow-hidden">
          <Panel className="grid-rows-[auto_minmax(0,1fr)_auto]">
            <RunHeader
              attentionCount={openQueue.length}
              configuredLevel={inspection?.autonomy.configured_level ?? "auto"}
              busy={busy}
              subject={inspection?.active_spec_title ?? null}
              integrationStatus={projection.integration.status}
              spanMs={runSpanMs(projection.recentEvents)}
              planAvailable={displayedPlan !== null}
              runActive={runActive}
              stopBusy={stopBusy}
              tasks={tasks}
              view={view}
              onViewChange={setView}
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
            ) : view === "map" ? (
              <RunMap
                inspection={inspection}
                projection={projection}
                selectedTaskId={projection.selectedTaskId}
                onSelectTask={onSelectTask}
              />
            ) : (
              <RunThread
                endRef={activityEndRef}
                events={projection.recentEvents}
                plan={displayedPlan}
                taskTitles={inspection?.task_titles ?? {}}
                onOpenPlan={() => void openPlanReview()}
              />
            )}

            <PromptDock
              busy={busy}
              composerRef={composerRef}
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

        {/* The rail holds state you glance at: what is running, and — only when
            you ask for it — what one agent is saying. */}
        {tasks.length === 0 ? null : (
        /* The task list takes the height; the inspector hugs what it has to
           say. It used to be the other way round, which put a 450px void under
           "Nothing from this agent yet" in the exact place the product's claim
           is strongest -- the largest single element on screen during a live
           run was an empty state.

           The list keeps a floor rather than a fraction: a fixed fraction once
           starved a two-task list by a dozen pixels and clipped its last row
           against the panel edge, which reads as broken rather than as "scroll
           for more" -- Radix's scrollbar is hover-only, so nothing on screen
           said otherwise. */
        <aside
          className={`grid min-h-0 gap-3 ${
            selected
              ? "grid-rows-[minmax(120px,1fr)_minmax(0,auto)]"
              : "grid-rows-[minmax(0,1fr)]"
          }`}
        >
          <Panel>
            <PanelHeader className="bg-panel">
              <PanelLabel className="text-ink">Current work</PanelLabel>
              <PanelCount>{tasks.length}</PanelCount>
            </PanelHeader>
            <TaskBoard
              groups={inspection?.execution_groups ?? []}
              integrationFailure={inspection?.integration_failure ?? null}
              selectedTaskId={projection.selectedTaskId}
              taskTitles={inspection?.task_titles ?? {}}
              tasks={tasks}
              onSelectTask={onSelectTask}
            />
          </Panel>
          {selected ? (
            <Panel className="grid-rows-[auto_auto]">
              <InspectorPane
                busy={busy}
                output={projection.selectedOutput}
                task={selected}
                onGuide={() => setRedirectOpen(true)}
                onStop={() => void stopTask(selected.task_id, "Stopped from the rail")}
              />
            </Panel>
          ) : null}
        </aside>
        )}
      </div>

      {displayedPlan ? (
        <PlanTakeover
          amendments={(inspection?.later ?? []).filter((item) => item.kind === "plan_amendment")}
          busy={busy}
          open={reviewOpen}
          plan={displayedPlan}
          ratificationPending={plan !== null}
          nonGoals={nonGoals}
          specReview={specReview}
          onNonGoalsChange={setNonGoals}
          onStartOver={() => {
            setReplanText("");
            setReplanOpen(true);
          }}
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
              /* One decision, two signatures. The spec is adopted first because
                 ratifying a plan requires a ratified spec -- ordering, not a
                 second choice. The person's non-goals are what gets written. */
              if (specReview !== null && specReview.status !== "ratified") {
                await onAction({
                  type: "spec.adopt",
                  payload: {
                    spec_id: specReview.spec_id,
                    non_goals: nonGoals
                      .filter((entry) => entry.text !== NOTHING_TO_DECLINE)
                      .map((entry) => entry.text),
                    nothing_to_decline: nonGoals.some(
                      (entry) => entry.text === NOTHING_TO_DECLINE
                    )
                  }
                });
              }
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

      <TextActionDialog
        busy={busy}
        description="Hivemind will prepare a different plan from this description. The plan waiting now is replaced, and nothing starts until you approve the new one."
        open={replanOpen}
        note="Nothing runs until you approve the new plan."
        submitLabel="Prepare a different plan"
        title="Start over with a different plan"
        value={replanText}
        onChange={setReplanText}
        onOpenChange={setReplanOpen}
        onSubmit={async () => {
          const message = replanText.trim();
          if (message === "") return;
          setBusy(true);
          setFeedback("");
          try {
            await preparePlan(message);
            setReplanText("");
            setReplanOpen(false);
            setReviewOpen(false);
            setComposer("");
          } catch (error) {
            setFeedback(plainActionError(error));
          } finally {
            setBusy(false);
          }
        }}
      />

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
      {/* The second and last decision. It gets the one solid navy edge in the
          app: nothing else is allowed to look like this, so the bar cannot be
          confused with a status strip. */}
      <section
        aria-label="Ready to ship"
        className="mb-3 rounded-lg border border-navy/25 border-l-2 border-l-navy bg-navy-wash"
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-sm bg-navy text-panel"
          >
            <Check className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-[14px] leading-snug font-semibold tracking-tight text-ink">
              {item.title}
            </strong>
            {changeSet ? (
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-muted-foreground">
                <span className="font-mono text-ink">{changeSet.task_ids.length}</span>
                <span>{changeSet.task_ids.length === 1 ? "task" : "tasks"} ·</span>
                <CollapsibleTrigger asChild>
                  <button
                    className="font-medium text-navy underline decoration-navy/30 underline-offset-2 hover:decoration-navy"
                    type="button"
                  >
                    <span className="font-mono">{files.length}</span>{" "}
                    {files.length === 1 ? "file" : "files"}
                  </button>
                </CollapsibleTrigger>
                <span>
                  · into <span className="font-mono text-ink">{changeSet.base_branch}</span>
                </span>
              </span>
            ) : (
              <span className="mt-0.5 block text-[12px] break-words text-muted-foreground">
                {plainPrimaryDetail(item.detail, item.kind)}
              </span>
            )}
          </div>
          {changeSet ? (
            <Button type="button" variant="outline" onClick={onInspect}>
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
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 border-t border-navy/15 px-4 py-3 pl-[52px]">
            {item.change_set?.changed_files.map((file) => (
              <li className="font-mono text-[12px] break-all text-muted-foreground" key={file}>
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
  rest,
  busy,
  planWaiting,
  taskTitles,
  onApprove,
  onApproveOther,
  onDismiss,
  onDismissOther,
  onOpen,
  onOpenOther
}: {
  item: WorkspaceQueueItem;
  rest: WorkspaceQueueItem[];
  busy: boolean;
  planWaiting: boolean;
  taskTitles: Record<string, string>;
  onApprove: () => void;
  onApproveOther: (item: WorkspaceQueueItem) => void;
  onDismiss: () => void;
  onDismissOther: (item: WorkspaceQueueItem) => void;
  onOpen: () => void;
  onOpenOther: (item: WorkspaceQueueItem) => void;
}): React.JSX.Element {
  const failing = /failed|stopped|blocked|rejected/iu.test(`${item.kind} ${item.title}`);
  const skin = failing
    ? "border-clay/25 border-l-clay bg-clay-wash"
    : "border-amber/25 border-l-amber bg-amber-wash";
  const mark = failing ? "text-clay" : "text-amber";
  const named = attentionHeadline(item, taskTitles);
  return (
    <Collapsible asChild>
      <section
        aria-label="Needs you"
        className={`mb-3 rounded-lg border border-l-2 px-4 py-3 ${skin}`}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`mt-px grid size-6 shrink-0 place-items-center rounded-sm bg-panel/70 ${mark}`}
          >
            <AlertTriangle className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <span
                className={`text-[11px] font-medium tracking-label uppercase ${mark}`}
              >
                Needs you
              </span>
              {rest.length > 0 ? (
                <CollapsibleTrigger asChild>
                  <button
                    className="text-[12px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-ink"
                    type="button"
                  >
                    {rest.length} more after this
                  </button>
                </CollapsibleTrigger>
              ) : null}
              {planWaiting ? (
                <span className="text-[12px] text-muted-foreground">a plan is also waiting</span>
              ) : null}
            </div>
            {/* The row leads with what the work is; what happened to it, and the
                identifier it happened to, sit underneath. */}
            <strong className="mt-1 block text-[14px] leading-snug font-semibold tracking-tight break-words text-ink">
              {named.headline}
            </strong>
            {named.predicate === null ? null : (
              <span className={`mt-0.5 block text-[12px] font-medium ${mark}`}>
                {sentenceCase(named.predicate)}
                {named.taskId === null ? null : (
                  <span className="ml-1.5 font-mono font-normal text-muted-foreground">
                    {named.taskId}
                  </span>
                )}
              </span>
            )}
            <p className="mt-1 mb-0 max-w-[760px] text-[12px] leading-relaxed break-words text-muted-foreground">
              {plainPrimaryDetail(item.detail, item.kind)}
            </p>
          </div>
          <AttentionActions
            busy={busy}
            item={item}
            onApprove={onApprove}
            onOpen={onOpen}
          />
          <Button
            aria-label="Set this aside"
            size="icon-sm"
            title="Set this aside"
            type="button"
            variant="ghost"
            onClick={onDismiss}
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <CollapsibleContent>
          <ul className="mt-3 mb-0 grid list-none gap-2.5 border-t border-ink/10 p-0 pt-3 pl-9">
            {rest.map((other) => {
              const otherNamed = attentionHeadline(other, taskTitles);
              return (
              <li className="flex items-start gap-3" key={other.id}>
                <div className="min-w-0 flex-1">
                  <strong className="block text-[13px] leading-snug font-medium break-words text-ink">
                    {otherNamed.headline}
                  </strong>
                  <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
                    {otherNamed.predicate === null
                      ? null
                      : `${sentenceCase(otherNamed.predicate)} · `}
                    {plainPrimaryDetail(other.detail, other.kind)}
                  </span>
                </div>
                <AttentionActions
                  busy={busy}
                  item={other}
                  size="sm"
                  onApprove={() => onApproveOther(other)}
                  onOpen={() => onOpenOther(other)}
                />
                <Button
                  aria-label={`Set aside ${other.title}`}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => onDismissOther(other)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/* Only offer a control when there is something behind it. An item with no action
   and nothing to open is information, not a button. */
function AttentionActions({
  item,
  busy,
  size = "default",
  onApprove,
  onOpen
}: {
  item: WorkspaceQueueItem;
  busy: boolean;
  size?: "default" | "sm";
  onApprove: () => void;
  onOpen: () => void;
}): React.JSX.Element | null {
  if (item.action) {
    return (
      <Button disabled={busy} size={size} type="button" onClick={onApprove}>
        {queueActionLabel(item.action.type)}
      </Button>
    );
  }
  if (!canOpenAttention(item)) return null;
  return (
    <Button size={size} type="button" variant="outline" onClick={onOpen}>
      Show me
    </Button>
  );
}

function canOpenAttention(item: WorkspaceQueueItem): boolean {
  return (
    item.id === "connection-interrupted" ||
    item.kind === "plan_review" ||
    item.task_id !== null
  );
}

function PlanWaitingBar({
  plan,
  onReview,
  onStartOver,
  onDismiss
}: {
  plan: WorkspacePlanReview;
  onReview: () => void;
  onStartOver: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-label="Plan ready for review"
      className="mb-3 flex items-center gap-3 rounded-lg border border-rule border-l-2 border-l-navy bg-panel px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-sm bg-navy-wash text-navy"
      >
        <Layers3 className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[14px] leading-snug font-semibold tracking-tight text-ink">
          A {plan.tasks.length}-step plan is ready
        </strong>
        <span className="mt-0.5 block text-[12px] text-muted-foreground">
          Nothing starts until you review and approve this exact plan.
        </span>
      </div>
      <Button type="button" variant="outline" onClick={onStartOver}>
        Start over
      </Button>
      <Button type="button" onClick={onReview}>
        Review the plan
        <ChevronRight aria-hidden="true" />
      </Button>
      <Button
        aria-label="Set this aside"
        size="icon-sm"
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
  subject,
  attentionCount,
  spanMs,
  runActive,
  planAvailable,
  integrationStatus,
  configuredLevel,
  busy,
  stopBusy,
  view,
  onViewChange,
  onOpenPlan,
  onStop,
  onLevelChange
}: {
  tasks: TaskProjection[];
  subject: string | null;
  attentionCount: number;
  spanMs: number | null;
  runActive: boolean;
  planAvailable: boolean;
  integrationStatus: string;
  configuredLevel: AutonomyLevel;
  busy: boolean;
  stopBusy: boolean;
  view: "thread" | "map";
  onViewChange: (view: "thread" | "map") => void;
  onOpenPlan: () => void;
  onStop: () => void;
  onLevelChange: (level: AutonomyLevel) => Promise<void>;
}): React.JSX.Element {
  const standing = runStanding(tasks);
  const working = standing.working;
  const done = standing.done;
  const files = filesInFlight(tasks);
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
            ? attentionCount > 0
              ? "All tasks finished, with something to decide"
              : "All tasks finished"
            : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} in this run`;
  /* Progress through phases, not through completed tasks.
     Counting only finished tasks meant the rule under this header sat at 0%
     for the entire first wave of a run — three agents working, and the one
     ambient-free progress signal in the app showing nothing having happened.
     Every task clearing a phase now moves it, which is what the four-segment
     gauge in the rail and the map already say per task. */
  const progress =
    tasks.length === 0
      ? 0
      : Math.round(
          (tasks.reduce((total, task) => total + Math.min(taskPhase(task).reached, PHASES.length), 0) /
            (tasks.length * PHASES.length)) *
            100
        );

  return (
    <div className="relative flex shrink-0 items-start gap-4 border-b border-rule bg-canvas px-4 py-3">
      <div className="min-w-0">
        {/* The run's subject is a sentence somebody wrote, not a field name.
            Setting it in the label voice shouted it. */}
        {subject === null ? null : (
          <span className="mb-0.5 block text-[12px] leading-snug break-words text-muted-foreground">
            {subject}
          </span>
        )}
        <h2 className="m-0 text-[15px] leading-tight font-semibold tracking-tight text-ink">
          {headline}
        </h2>
        {/* One instrument line: the figures that answer "where is this", in
            mono, separated by hairlines rather than by middots. The readings
            are collected first and the separators interleaved after, because
            rendering a separator beside each optional reading printed a
            leading hairline whenever the first one was absent. */}
        <MetaLine
          readings={[
            tasks.length > 0 ? (
              <span className="font-mono text-ink" key="done">
                {done}/{tasks.length}
                <span className="ml-1 font-sans text-muted-foreground">done</span>
              </span>
            ) : null,
            files > 0 ? (
              <span className="font-mono text-ink" key="files">
                {files}
                <span className="ml-1 font-sans text-muted-foreground">
                  {files === 1 ? "file open" : "files open"}
                </span>
              </span>
            ) : null,
            spanMs === null ? null : (
              <span className="font-mono" key="span">
                {runActive ? `running ${formatDuration(spanMs)}` : `took ${formatDuration(spanMs)}`}
              </span>
            ),
            /* One projection decides the top-level claim. Core's queue is the
               authority on whether anything is waiting, so the header never
               says "Ready to ship" over a bar saying it cannot ship. */
            attentionCount > 0 ? (
              <span className="font-medium text-amber" key="attention">
                {attentionCount === 1 ? "1 thing needs you" : `${attentionCount} things need you`}
              </span>
            ) : integrationStatus !== "idle" && tasks.length > 0 ? (
              <span className={`font-medium ${toneText[verification.tone]}`} key="check">
                {verification.label}
              </span>
            ) : null
          ]}
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {tasks.length > 0 ? (
          <ViewToggle value={view} onChange={onViewChange} />
        ) : null}
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
              size="sm"
              type="button"
              variant="ghost"
            >
              <SlidersHorizontal aria-hidden="true" />
              {autonomyLabel(configuredLevel)}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[260px]">
            <DropdownMenuLabel>Interrupt me for</DropdownMenuLabel>
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
          className="block h-[2px] bg-navy transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </span>
    </div>
  );
}

/* A hairline between two figures. Middots at 12px read as punctuation inside
   the numbers; a rule reads as a gauge, which is what this row is. */
function Divider(): React.JSX.Element {
  return <span aria-hidden="true" className="h-2.5 w-px bg-rule" />;
}

/* Readings, hairline-separated, with the separators decided by what is
   actually present rather than by each reading's own condition. */
function MetaLine({
  readings
}: {
  readings: Array<React.ReactNode | null>;
}): React.JSX.Element {
  const present = readings.filter((reading): reading is React.ReactNode => reading !== null);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted-foreground">
      {present.map((reading, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <Divider />}
          {reading}
        </Fragment>
      ))}
    </div>
  );
}

/* Two drawings of one run. It costs a pair of buttons rather than a permanent
   place in the shell, which is the whole reason it is here and not up there. */
function ViewToggle({
  value,
  onChange
}: {
  value: "thread" | "map";
  onChange: (view: "thread" | "map") => void;
}): React.JSX.Element {
  const options = [
    { key: "thread" as const, label: "Story", icon: TextQuote },
    { key: "map" as const, label: "Map", icon: ListTree }
  ];
  return (
    <span
      aria-label="How to show this run"
      className="mr-1 inline-flex divide-x divide-rule overflow-hidden rounded-md border border-rule"
      role="group"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.key;
        return (
          <button
            aria-pressed={active}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors ${
              active
                ? "bg-navy-wash text-navy"
                : "bg-panel text-muted-foreground hover:text-ink"
            }`}
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </span>
  );
}

/* ── Decision 1, before anything exists ───────────────────────────────────── */

function IdleBoard({ onPick }: { onPick: (value: string) => void }): React.JSX.Element {
  return (
    <div className="min-h-0 overflow-auto px-6 py-7">
      <div className="max-w-[560px]">
        <h2 className="m-0 text-[22px] leading-tight font-semibold tracking-tighter text-ink">
          Describe what you want built.
        </h2>
        <p className="mt-2.5 mb-0 max-w-[480px] text-[13px] leading-relaxed text-muted-foreground">
          Hivemind splits the work across agents, keeps each one inside its own
          files, and checks every change.
        </p>

        {/* The product's whole shape, stated as two numbered steps rather than
            as a paragraph. It is the one claim the empty state has to make. */}
        <ol className="mt-5 mb-0 grid list-none gap-2 border-l border-rule p-0 pl-3.5">
          <li className="flex items-baseline gap-2.5 text-[13px] text-ink">
            <span className="font-mono text-[11px] text-navy">01</span>
            You say what you want built.
          </li>
          <li className="flex items-baseline gap-2.5 text-[13px] text-ink">
            <span className="font-mono text-[11px] text-navy">02</span>
            You say ship, once it is checked.
          </li>
          <li className="flex items-baseline gap-2.5 text-[13px] text-muted-foreground">
            <span className="font-mono text-[11px] text-muted-foreground">--</span>
            Everything between those happens on its own.
          </li>
        </ol>

        <div className="mt-7 flex items-center gap-3">
          <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
            Try one of these
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-rule" />
        </div>
        <ul className="m-0 mt-2 grid list-none overflow-hidden rounded-md border border-rule p-0">
          {EXAMPLE_ASKS.map((ask, index) => (
            <li className="border-b border-rule last:border-b-0" key={ask}>
              <button
                className="group flex w-full cursor-pointer items-center gap-3 bg-panel px-3 py-2.5 text-left transition-colors hover:bg-navy-wash"
                type="button"
                onClick={() => onPick(ask)}
              >
                <span className="font-mono text-[11px] text-muted-foreground group-hover:text-navy">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 text-[13px] break-words text-ink group-hover:text-navy">
                  {ask}
                </span>
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-navy opacity-0 transition-opacity group-hover:opacity-100"
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
      <div className="pb-3">
        {lanes.length === 0 ? (
          <p className="m-0 px-4 py-5 text-[13px] leading-relaxed text-muted-foreground">
            No tasks in this run yet.
          </p>
        ) : null}
        {lanes.map((lane) => (
          <section key={lane.key}>
            <header className="sticky top-0 z-1 flex h-7 items-center gap-3 border-b border-rule bg-canvas px-3">
              <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
                {lane.label}
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {lane.tasks.length}
              </span>
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
  const phase = taskPhase(task);
  /* The only row where a dependency answers a real question: "why has this not
     started?" */
  const waitingFor =
    task.state === "planned" || task.state === "paused"
      ? task.depends_on.map((taskId) => taskLabel(taskId, taskTitles)).join(", ")
      : "";
  return (
    <button
      aria-pressed={selected}
      className={`relative flex w-full cursor-pointer items-start gap-2.5 border-b border-rule px-3 py-2.5 pl-2.5 text-left transition-colors ${
        selected
          ? "bg-navy-wash before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-navy"
          : "bg-panel hover:bg-canvas"
      }`}
      type="button"
      onClick={onSelect}
    >
      {/* A square mark, not a dot: the same shape the map uses for a phase, at
          the size a row can carry. */}
      <span
        aria-hidden="true"
        className={`mt-[5px] size-1.5 shrink-0 rounded-xs ${toneEdge[language.tone]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 text-[13px] leading-snug font-medium break-words text-ink">
            {task.title}
          </span>
          <span className={`shrink-0 text-[11px] font-medium ${toneText[language.tone]}`}>
            {language.label}
          </span>
        </span>
        {/* The map's gauge, not a smaller worse copy of it. Four named phases,
            the current one in the standing's colour, and the count beside the
            identifier — which is exactly where the map's card puts it. */}
        <span className="mt-2 block">
          <PhaseSpine advanceKey={null} phase={phase} standing={phase.standing} />
        </span>
        <span className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] break-words text-muted-foreground">
          <span className="font-mono" title={task.task_id}>
            {task.task_id}
          </span>
          <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
          <span className="font-mono">{phaseRatio(phase)}</span>
          {task.lease_files.length > 0 ? (
            <>
              <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
              <span>
                editing {task.lease_files.length}{" "}
                {task.lease_files.length === 1 ? "file" : "files"}
              </span>
            </>
          ) : null}
          {waitingFor === "" ? null : <span className="w-full">after {waitingFor}</span>}
        </span>
        {issue ? (
          <span className="mt-2 block border-l-2 border-clay/40 bg-clay-wash px-2 py-1.5 text-[11px] leading-snug break-words text-clay">
            {/* Core writes `plain_reason` beside the durable reason now, and
                `plainEvidence` prefers it, so this arrives already readable.
                The client-side rewriter that used to sit here was deleted
                rather than extended: a fourth regex would be guessing at a
                string it does not own, which is the mistake this project has
                recorded three times. Render what Core wrote. */}
            {issue}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/* ── Rail: what one agent is doing, then what just happened ──────────────── */

function InspectorPane({
  task,
  output,
  busy,
  onGuide,
  onStop
}: {
  task: TaskProjection;
  output: BoardProjection["selectedOutput"];
  busy: boolean;
  onGuide: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"summary" | "raw">("summary");
  const [filesOpen, setFilesOpen] = useState(false);
  /* Files open by default when the agent is holding some: during a live run
     that is the most useful thing this panel knows, and it is the reason the
     panel is not empty. */
  useEffect(() => {
    setMode("summary");
    setFilesOpen(task.lease_files.length > 0);
  }, [task.task_id, task.lease_files.length]);
  const files = task.lease_files;
  const phase = taskPhase(task);
  /* Only offer to stop something that is actually going. */
  const stoppable = phase.standing === "working" || phase.standing === "waiting";
  const text =
    mode === "summary"
      ? summarizeWorkerOutput(output)
      : output.map((record) => `[${formatClock(record.ts)}] ${record.text}`).join("\n");

  return (
    <>
      <header className="grid shrink-0 gap-2.5 border-b border-rule bg-canvas px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
              {task.title}
            </strong>
            <span className="mt-0.5 block text-[11px] break-words text-muted-foreground">
              <span className="font-mono">{task.task_id}</span>
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
          {stoppable ? (
            <Button
              aria-label="Stop this task"
              className="text-clay hover:bg-clay-wash hover:text-clay"
              disabled={busy}
              size="icon-sm"
              title="Stop this task"
              type="button"
              variant="outline"
              onClick={onStop}
            >
              <CircleStop aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <p className="m-0 text-[11px] leading-snug break-words text-muted-foreground">
          {phase.summary}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
            Live output
          </span>
          <span
            aria-label="How much output to show"
            className="ml-auto inline-flex divide-x divide-rule overflow-hidden rounded-md border border-rule"
            role="group"
          >
            {(["summary", "raw"] as const).map((option) => (
              <button
                className={`h-6 cursor-pointer px-2 text-[11px] font-medium transition-colors ${
                  mode === option
                    ? "bg-navy-wash text-navy"
                    : "bg-panel text-muted-foreground hover:text-ink"
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

      <div className="grid min-h-0 grid-rows-[minmax(0,auto)_auto]">
        {output.length > 0 ? (
          <ScrollArea className="max-h-[340px] min-h-0">
            <pre className="m-0 px-3 py-2.5 font-mono text-[12px] leading-[1.65] break-words whitespace-pre-wrap text-ink">
              {text}
            </pre>
          </ScrollArea>
        ) : (
          /* An agent that has said nothing is not an agent doing nothing. What
             it holds and where it has got to is the answer to the question the
             empty panel was failing to answer. */
          <div className="grid gap-1.5 px-3 py-2.5">
            <p className="m-0 text-[12px] leading-snug text-muted-foreground">
              {stoppable
                ? "This agent has not said anything yet."
                : "This agent said nothing while it worked."}
            </p>
            {files.length > 0 ? (
              <p className="m-0 text-[12px] leading-snug text-ink">
                It is holding{" "}
                <span className="font-mono">{files.length}</span>{" "}
                {files.length === 1 ? "file" : "files"}, listed below.
              </p>
            ) : null}
          </div>
        )}

        <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
          <CollapsibleTrigger asChild>
            <button
              className="flex h-9 w-full cursor-pointer items-center gap-2 border-t border-rule bg-canvas px-3 text-left hover:bg-navy-wash"
              type="button"
            >
              <FileCode2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
                Files being edited
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {files.length}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 text-muted-foreground transition-transform ${filesOpen ? "rotate-90" : ""}`}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {files.length === 0 ? (
              <p className="m-0 border-t border-rule px-3 py-2 text-[12px] text-muted-foreground">
                This task is not editing any file yet.
              </p>
            ) : (
              <ul className="m-0 max-h-[140px] list-none overflow-auto border-t border-rule p-0 py-1.5">
                {files.map((file) => (
                  <li
                    className="px-3 py-0.5 font-mono text-[12px] break-all text-muted-foreground"
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

/* ── The run, told as one story ──────────────────────────────────────────── */

function RunThread({
  events,
  taskTitles,
  plan,
  endRef,
  onOpenPlan
}: {
  events: BoardProjection["recentEvents"];
  taskTitles: Record<string, string>;
  plan: WorkspacePlanReview | null;
  endRef: React.RefObject<HTMLDivElement | null>;
  onOpenPlan: () => void;
}): React.JSX.Element {
  const entries = useMemo(
    () => buildRunThread(events, taskTitles),
    [events, taskTitles]
  );
  return (
    <ScrollArea aria-label="What has happened in this run" className="min-h-0">
      <div className="grid gap-3 px-5 py-4">
        {events.length >= RECENT_EVENT_LIMIT ? (
          <p className="m-0 text-[12px] text-muted-foreground">
            This run is long enough that its earliest activity is no longer shown.
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
            Nothing has happened yet. Describe what you want below and Hivemind
            will prepare a plan.
          </p>
        ) : null}
        {entries.map((entry) => (
          <ThreadRow
            entry={entry}
            key={entry.id}
            plan={plan}
            taskTitles={taskTitles}
            onOpenPlan={onOpenPlan}
          />
        ))}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  );
}

function ThreadRow({
  entry,
  plan,
  taskTitles,
  onOpenPlan
}: {
  entry: ThreadEntry;
  plan: WorkspacePlanReview | null;
  taskTitles: Record<string, string>;
  onOpenPlan: () => void;
}): React.JSX.Element {
  if (entry.kind === "request" || entry.kind === "guidance") {
    const guidance = entry.kind === "guidance";
    /* Not a chat bubble. A chat bubble puts the one thing the person actually
       wrote on the far right of a 900px column and leaves the left half empty,
       which is what made this surface read as a messaging app rather than as a
       record of a run. The request is a quoted block on the same left edge as
       everything else, marked by a navy rule. */
    return (
      <article className="border-l-2 border-navy pl-3.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium tracking-label text-navy uppercase">
            {guidance ? "You added" : "You asked for"}
          </span>
          <time className="font-mono text-[11px] text-muted-foreground">
            {formatClock(entry.at)}
          </time>
          {guidance ? (
            <span className="text-[11px] text-muted-foreground">
              {entry.applied ? "used on the next step" : "will be used on the next step"}
            </span>
          ) : null}
        </div>
        <p className="mt-1 mb-0 max-w-[720px] text-[14px] leading-relaxed break-words text-ink">
          {entry.text}
        </p>
      </article>
    );
  }

  if (entry.kind === "plan") {
    const matches = plan !== null && (entry.planHash === null || plan.plan_hash === entry.planHash);
    const steps = matches ? plan.tasks.length : null;
    const stages = matches ? plan.execution_groups.length : null;
    return (
      <article className="max-w-[720px] rounded-md border border-rule bg-canvas px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`grid size-6 shrink-0 place-items-center rounded-sm ${
              entry.approved ? "bg-navy text-panel" : "bg-navy-wash text-navy"
            }`}
          >
            {entry.approved ? <Check className="size-3.5" /> : <Layers3 className="size-3.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-[13px] leading-snug font-semibold text-ink">
              {steps === null
                ? entry.approved
                  ? "You approved the plan"
                  : "A plan is ready to review"
                : entry.approved
                  ? `You approved a ${steps}-step plan`
                  : `A ${steps}-step plan is ready to review`}
            </strong>
            <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              {stages !== null ? (
                <>
                  <span className="font-mono">
                    {stages} {stages === 1 ? "stage" : "stages"}
                  </span>
                  <Divider />
                </>
              ) : null}
              <time className="font-mono">{formatClock(entry.at)}</time>
            </span>
          </div>
          {plan !== null ? (
            <Button size="sm" type="button" variant="outline" onClick={onOpenPlan}>
              {entry.approved ? "See the plan" : "Review the plan"}
            </Button>
          ) : null}
        </div>
      </article>
    );
  }

  if (entry.kind === "shipped") {
    return <ShippedCard entry={entry} plan={plan} taskTitles={taskTitles} />;
  }

  /* Milestones are a log, and a log is a fixed left gutter of times against a
     rule. The eye reads down the times; the rule is what turns a stack of rows
     into one thread. */
  return (
    <div className="relative flex items-start gap-3 pl-[92px]">
      <time className="absolute top-px left-0 w-[62px] text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {formatClock(entry.at)}
      </time>
      <span
        aria-hidden="true"
        className="absolute inset-y-[-6px] left-[75px] w-px bg-rule"
      />
      <span
        aria-hidden="true"
        className={`absolute top-[5px] left-[73px] size-[5px] rounded-xs ${toneDot[entry.tone]}`}
      />
      <span className="min-w-0 flex-1 text-[13px] leading-snug break-words text-ink">
        {entry.text}
        {entry.durationMs === null ? null : (
          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
            {formatDuration(entry.durationMs)}
          </span>
        )}
        {entry.count > 1 ? (
          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">×{entry.count}</span>
        ) : null}
      </span>
    </div>
  );
}

/* The payoff. What each task set out to do, and where it landed. */
function ShippedCard({
  entry,
  plan,
  taskTitles
}: {
  entry: Extract<ThreadEntry, { kind: "shipped" }>;
  plan: WorkspacePlanReview | null;
  taskTitles: Record<string, string>;
}): React.JSX.Element {
  const [filesOpen, setFilesOpen] = useState(false);
  return (
    <article className="max-w-[720px] rounded-md border border-navy/25 border-l-2 border-l-navy bg-navy-wash px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-sm bg-navy text-panel"
        >
          <Check className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[14px] leading-snug font-semibold tracking-tight text-ink">
            Shipped {entry.taskIds.length}{" "}
            {entry.taskIds.length === 1 ? "task" : "tasks"}
            {entry.branch ? ` to ${entry.branch}` : ""}
          </strong>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <time className="font-mono">{formatClock(entry.at)}</time>
            <Divider />
            <span>this is now part of your project</span>
          </span>
        </div>
      </div>

      <ul className="mt-3 mb-0 grid list-none gap-2 border-t border-navy/15 p-0 pt-3">
        {entry.taskIds.map((taskId) => {
          const planned = plan?.tasks.find((task) => task.task_id === taskId);
          return (
            <li key={taskId}>
              <strong className="block text-[13px] leading-snug font-medium break-words text-ink">
                {planned?.title ?? taskTitles[taskId] ?? taskId}
              </strong>
              {planned?.acceptance_criterion ? (
                <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
                  {planned.acceptance_criterion}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-navy/15 pt-2.5 text-[12px] text-muted-foreground">
          {/* A commit whose record does not list its files is not a commit that
              changed none. Saying "0 files changed" over a commit that changed
              eight is the worst kind of wrong this app can be, so the missing
              field is reported as missing. */}
          {entry.changedFiles === null ? (
            <span>This project's record of the change does not list the files.</span>
          ) : (
            <CollapsibleTrigger asChild>
              <button
                className="font-medium text-navy underline decoration-navy/30 underline-offset-2 hover:decoration-navy"
                type="button"
              >
                <span className="font-mono">{entry.changedFiles.length}</span>{" "}
                {entry.changedFiles.length === 1 ? "file" : "files"} changed
              </button>
            </CollapsibleTrigger>
          )}
          {entry.adoptedRef ? (
            <span className="flex items-baseline gap-2">
              {entry.changedFiles === null ? null : <Divider />}
              <span>
                landed as{" "}
                <span className="font-mono text-ink">{entry.adoptedRef.slice(0, 10)}</span>
              </span>
            </span>
          ) : null}
        </div>
        <CollapsibleContent>
          <ul className="mt-2 mb-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
            {(entry.changedFiles ?? []).map((file) => (
              <li className="font-mono text-[12px] break-all text-muted-foreground" key={file}>
                {file}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

/* ── Decision 1, anchored forever at the bottom ──────────────────────────── */

function PromptDock({
  value,
  composerRef,
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
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
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
    <footer className="shrink-0 border-t border-rule bg-canvas p-2.5">
      <form className="grid gap-2" onSubmit={(event) => void onSubmit(event)}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-md border border-rule bg-panel p-1.5 transition-colors focus-within:border-navy/45">
          <textarea
            className="max-h-[180px] min-h-[36px] w-full resize-y border-0 bg-transparent px-1.5 py-1.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-muted-foreground"
            id="work-composer"
            placeholder={
              runActive
                ? "Add guidance for the next step…"
                : idle
                  ? "Describe what you want built…"
                  : "Describe the next change you want…"
            }
            ref={composerRef}
            rows={idle ? 3 : 2}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            className={idle ? "h-9 px-3.5" : "size-9"}
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
              <Send aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        {feedback ? (
          <p
            className="m-0 rounded-sm border-l-2 border-navy bg-navy-wash px-2.5 py-1.5 text-[12px] leading-snug break-words text-navy"
            role="status"
          >
            {feedback}
          </p>
        ) : null}
        <div className="flex items-center gap-2.5 px-1">
          <span className="min-w-0 flex-1 text-[11px] leading-snug break-words text-muted-foreground">
            {runActive
              ? "Guidance is read on the next step and does not change work already in progress."
              : "Typing describes work. Nothing runs until Hivemind has a plan it can check."}
          </span>
          <kbd className="shrink-0 rounded-sm border border-rule bg-panel px-1 font-mono text-[11px] text-muted-foreground">
            ⌘↵
          </kbd>
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
    return <span className="shrink-0 text-[11px] text-muted-foreground">no spend yet</span>;
  }
  const ratio =
    spend.session_ceiling_tokens > 0
      ? Math.min(100, (spend.committed_tokens / spend.session_ceiling_tokens) * 100)
      : 0;
  return (
    <span
      className={`flex shrink-0 items-center gap-2 rounded-sm px-1.5 py-0.5 font-mono text-[11px] ${
        spend.near_session_ceiling ? "bg-amber-wash text-amber" : "text-muted-foreground"
      }`}
      title={`${spend.run_ceiling_tokens.toLocaleString()} tokens maximum per call`}
    >
      <span>{spend.calls} calls</span>
      {/* A meter, not a capsule: a square bar reads as a gauge on an
          instrument, and it is the same 2px language as the phase spine. */}
      <span className="block h-[3px] w-[52px] overflow-hidden bg-rule">
        <span
          className={`block h-[3px] ${spend.near_session_ceiling ? "bg-amber" : "bg-navy"}`}
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
  specReview,
  nonGoals,
  onNonGoalsChange,
  amendments,
  onOpenChange,
  onRatify,
  onAdd,
  onEdit,
  onStartOver
}: {
  plan: WorkspacePlanReview;
  open: boolean;
  busy: boolean;
  ratificationPending: boolean;
  specReview: SpecReview | null;
  nonGoals: NonGoalEntry[];
  onNonGoalsChange: (entries: NonGoalEntry[]) => void;
  amendments: WorkspaceQueueItem[];
  onOpenChange: (open: boolean) => void;
  onRatify: () => Promise<void>;
  onAdd: () => void;
  onEdit: (task: WorkspacePlanTask) => void;
  onStartOver: () => void;
}): React.JSX.Element {
  /* Why approving is unavailable, in the words the person needs. Core refuses
     both of these too; this only explains the refusal before they hit it. */
  const blockedReason =
    specReview !== null && ratificationPending && specReview.open_questions.length > 0
      ? "Answer the questions above before starting."
      : specReview !== null && ratificationPending && nonGoals.length === 0
        ? "Say what this should not do, or add “nothing”, before starting."
        : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[min(780px,calc(100vh-40px))] w-[min(1120px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="gap-1.5 border-b border-rule px-6 py-5">
          <span className="text-[11px] font-medium tracking-label text-navy uppercase">
            {ratificationPending ? "Before anything starts" : "The approved plan"}
          </span>
          <DialogTitle className="text-[22px] leading-tight font-semibold tracking-tighter">
            {plan.tasks.length} {plan.tasks.length === 1 ? "step" : "steps"}, in{" "}
            {plan.execution_groups.length}{" "}
            {plan.execution_groups.length === 1 ? "stage" : "stages"}
          </DialogTitle>
          <DialogDescription className="max-w-[720px]">
            {ratificationPending
              ? "Check the order, the files each step may touch, and how each result gets checked. Approving applies to this exact version only."
              : "Read-only record of the exact approved plan, including how each step's result is checked."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="px-6 py-5">
            {specReview !== null && ratificationPending ? (
              <div className="mb-6 border-b border-rule pb-6">
                <SpecReviewPanel
                  busy={busy}
                  nonGoals={nonGoals}
                  review={specReview}
                  onNonGoalsChange={onNonGoalsChange}
                />
              </div>
            ) : null}
            {amendments.length > 0 ? (
              <section className="mb-5 rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-4 py-3">
                <strong className="block text-[13px] font-semibold text-ink">
                  {amendments.length === 1
                    ? "One change to this plan is queued"
                    : `${amendments.length} changes to this plan are queued`}
                </strong>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                  Queued changes take effect only after they pass the normal checks
                  and you approve the updated plan. The plan below does not include
                  them yet.
                </span>
                <ul className="mt-2.5 mb-0 grid list-none gap-1.5 p-0">
                  {amendments.map((amendment) => (
                    <li className="text-[13px] break-words text-ink" key={amendment.id}>
                      {amendment.title}
                      <span className="block text-[12px] text-muted-foreground">{amendment.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {/* Stages read down the left as a numbered spine, so the order the
                work runs in is the first thing the page states. */}
            {plan.execution_groups.map((group, groupIndex) => (
              <section
                className="grid grid-cols-[152px_minmax(0,1fr)] gap-5 pb-5"
                key={group.group_id}
              >
                <div className="flex items-start gap-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-xs bg-ink font-mono text-[11px] text-panel">
                    {groupIndex + 1}
                  </span>
                  <div className="min-w-0">
                    <strong className="block text-[13px] leading-snug font-semibold text-ink">
                      {group.mode === "parallel"
                        ? `${group.task_ids.length} at the same time`
                        : `${group.task_ids.length} in order`}
                    </strong>
                    <span className="mt-0.5 block font-mono text-[11px] break-words text-muted-foreground">
                      {group.group_id}
                    </span>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
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

        <DialogFooter className="items-center justify-between border-t border-rule bg-panel px-6 py-3 sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <code className="rounded-sm border border-rule bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {plan.plan_hash.slice(0, 12)}
            </code>
            <span className="text-[12px] text-muted-foreground">
              {ratificationPending
                ? "Any regenerated or edited plan needs a fresh approval."
                : "Read-only record of the exact approved plan."}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {ratificationPending ? (
              <Button type="button" variant="outline" onClick={onStartOver}>
                <RotateCcw aria-hidden="true" />
                Start over
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onAdd}>
              <Plus aria-hidden="true" />
              Add a step
            </Button>
            {blockedReason === null ? null : (
              <span className="mr-1 max-w-[320px] text-[11px] leading-snug text-clay">
                {blockedReason}
              </span>
            )}
            {ratificationPending ? (
              <Button
                disabled={busy || blockedReason !== null}
                size="lg"
                title={blockedReason ?? undefined}
                type="button"
                onClick={() => void onRatify()}
              >
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
    /* A specimen sheet, not a marketing card: a titled head, then a ruled
       field table where the label column is fixed so every card in the stage
       aligns on the same gutter and the answers can be read in a column. */
    <article className="min-w-0 overflow-hidden rounded-md border border-rule bg-panel">
      <div className="flex items-start justify-between gap-2 border-b border-rule px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="m-0 text-[13px] leading-snug font-semibold break-words text-ink">
            {task.title}
          </h3>
          <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
            {task.task_id}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.tier === "high" || task.tier === "critical" ? (
            <Badge tone={task.tier === "critical" ? "danger" : "warning"}>
              {capitalize(task.tier)} risk
            </Badge>
          ) : null}
          <Button
            aria-label={`Edit ${task.title}`}
            size="icon-xs"
            title="Edit this step"
            type="button"
            variant="ghost"
            onClick={onEdit}
          >
            <SlidersHorizontal aria-hidden="true" />
          </Button>
        </div>
      </div>
      <dl className="m-0 grid">
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
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-rule px-3.5 py-2 last:border-b-0">
      <dt className="pt-px text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={`m-0 break-words text-ink ${mono ? "font-mono text-[12px] leading-relaxed" : "text-[12px] leading-relaxed"}`}
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
    "w-full rounded-md border border-rule bg-canvas px-2 py-1.5 font-mono text-[13px] font-normal text-ink transition-colors focus-visible:border-navy/45 focus-visible:bg-panel";
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-[min(740px,calc(100vw-40px))] gap-0 p-0 sm:max-w-none">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader className="border-b border-rule px-5 py-4">
            <DialogTitle>
              {value.kind === "add_task" ? "Add a step" : `Edit ${value.draft.taskId}`}
            </DialogTitle>
            <DialogDescription>
              {value.kind === "edit_task"
                ? "If this step has already started, Hivemind will refuse the edit and tell you the safer next move."
                : "The step is queued for grounding and checks, then comes back to you as a new plan to review."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] grid-cols-2 gap-3.5 overflow-auto px-5 py-4">
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Step ID
              <input
                className={field}
                disabled={value.kind === "edit_task"}
                onChange={(event) => update("taskId", event.target.value)}
                value={value.draft.taskId}
              />
            </label>
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Title
              <input
                className={field}
                onChange={(event) => update("title", event.target.value)}
                value={value.draft.title}
              />
            </label>
            <label className="col-span-2 grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Files it may change
              <textarea
                className={field}
                onChange={(event) => update("files", event.target.value)}
                placeholder="src/example.ts"
                rows={2}
                value={value.draft.files}
              />
            </label>
            <label className="col-span-2 grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Files it may read
              <textarea
                className={field}
                onChange={(event) => update("readOnlyFiles", event.target.value)}
                rows={2}
                value={value.draft.readOnlyFiles}
              />
            </label>
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Runs after
              <input
                className={field}
                onChange={(event) => update("dependencies", event.target.value)}
                placeholder="T-001, T-002"
                value={value.draft.dependencies}
              />
            </label>
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Named check
              <input
                className={field}
                onChange={(event) => update("checks", event.target.value)}
                placeholder="npm test"
                value={value.draft.checks}
              />
            </label>
            <label className="col-span-2 grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Done when
              <textarea
                className={field}
                onChange={(event) => update("acceptance", event.target.value)}
                rows={2}
                value={value.draft.acceptance}
              />
            </label>
            <label className="col-span-2 grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
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
                <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
                  Stage
                  <input
                    className={field}
                    onChange={(event) => update("groupId", event.target.value)}
                    value={value.draft.groupId}
                  />
                </label>
                <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
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
          <DialogFooter className="items-center justify-between border-t border-rule bg-canvas px-5 py-3 sm:justify-between">
            <span className="text-[12px] text-muted-foreground">
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
  note = "Guidance cannot approve a change or ship anything.",
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
  note?: string;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => Promise<void>;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription>
              {description}
            </DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            className="min-h-[150px] w-full resize-y rounded-md border border-rule bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-ink transition-colors focus-visible:border-navy/45 focus-visible:bg-panel"
            rows={6}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <DialogFooter className="items-center justify-between sm:justify-between">
            <span className="text-[12px] text-muted-foreground">{note}</span>
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
      <DialogContent className="grid h-[min(720px,calc(100vh-40px))] w-[min(1000px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule px-5 py-4">
          <DialogTitle>
            Every line that would land
          </DialogTitle>
          <DialogDescription>
            Exactly what was checked. Nothing here has touched your branch yet.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 bg-canvas">
          {loading ? (
            <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">Loading the checked changes…</p>
          ) : null}
          {error ? (
            <p className="m-0 px-5 py-4 text-[13px] text-clay" role="status">
              {error}
            </p>
          ) : null}
          {patch ? (
            <pre className="m-0 px-5 py-4 font-mono text-[12px] leading-[1.65] break-words whitespace-pre-wrap text-ink">
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
  if (actionType === "task.resume") return "Carry on";
  if (actionType === "verification.rerun") return "Run the checks again";
  if (actionType === "adoption.review") return "Show me the changes";
  if (actionType === "adoption.execute") return "Ship it";
  return "Go ahead";
}

function actionSuccessMessage(actionType: string): string {
  if (actionType === "manager.approve_pending") return "The next step was approved.";
  if (actionType === "verification.rerun") return "Fresh project checks completed.";
  if (actionType === "task.resume") return "Picked up where it stopped.";
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

/* What to say instead, chosen by the item's typed `kind`. Keying on the kind is
   safe in a way that reading Core's sentence is not: the kind is a contract
   field this client is handed, and every one of these says only what that kind
   already means. */
const QUEUE_FALLBACK: Record<WorkspaceQueueItem["kind"], string> = {
  plan_review: "A plan is ready for you to look at. Nothing starts until you approve it.",
  manager_approval: "A step needs your approval before it can run.",
  verification_blocked: "The project's checks could not finish.",
  reverification_required:
    "The checks that passed are older than the code as it stands now. They have to run again before this can ship.",
  run_stalled: "Work stopped and has not picked up again.",
  task_attention: "This task needs you before it can carry on.",
  quality_cancel_failed:
    "A second attempt may still be running. Check it before starting another one.",
  memory_review: "There is something here for you to review outside the app.",
  quality_review: "A second attempt is ready for you to compare.",
  plan_amendment: "A change to the plan is queued for review.",
  adoption_ready: "The checks passed. This is ready to go to your branch."
};

function plainPrimaryDetail(detail: string, kind: WorkspaceQueueItem["kind"]): string {
  if (kind === "quality_cancel_failed") return QUEUE_FALLBACK[kind];
  /* Core's own sentence wins whenever it is sayable. It is more specific than
     anything chosen by kind, and it is the text that was actually recorded. */
  if (detail.trim() === "" || containsInternalVocabulary(detail)) {
    return QUEUE_FALLBACK[kind];
  }
  return detail;
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

/* Core writes its predicates lowercase because they followed an identifier.
   Once the identifier moves out of the way, they start a sentence. */
function sentenceCase(value: string): string {
  return value.replace(/^./u, (letter) => letter.toUpperCase());
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* Derived presentation of two durable timestamps, not client-held state: it
   rebuilds identically from the replayed trail. Only spans that ended are shown
   — a live elapsed counter would need a ticking clock, and a stale one that only
   moves when an unrelated event arrives would be worse than none. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

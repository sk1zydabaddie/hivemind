import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clock3,
  FileDiff,
  FileCode2,
  Layers3,
  MessageSquareText,
  PencilLine,
  Play,
  Plus,
  Send,
  TerminalSquare,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type BoardProjection,
  type HivemindEvent,
  type TaskProjection,
  type TaskState
} from "../../lib/projection";
import type {
  AutonomyLevel,
  WorkspaceAction,
  WorkspaceInspection,
  WorkspacePlanReview,
  WorkspacePlanTask,
  WorkspaceQueueItem
} from "../../lib/workspace-actions";
import { plainActionError } from "../../lib/plain-language";
import { groupConsecutiveActivity, summarizeWorkerOutput } from "../../lib/work-presentation";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";

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

type PhaseStatus = "complete" | "active" | "waiting" | "failed";

interface TaskPhase {
  key: string;
  label: string;
  status: PhaseStatus;
}

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

const stateLanguage: Record<
  TaskState,
  { label: string; tone: "neutral" | "live" | "good" | "warning" | "danger" }
> = {
  planned: { label: "Ready to start", tone: "neutral" },
  running: { label: "Working", tone: "live" },
  paused: { label: "Paused for capacity", tone: "warning" },
  submitted: { label: "Change ready", tone: "live" },
  accepted: { label: "Checks passed", tone: "good" },
  rejected: { label: "Needs revision", tone: "danger" },
  blocked: { label: "Project checks blocked", tone: "danger" },
  failed: { label: "Worker stopped", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  verified: { label: "Ready to adopt", tone: "good" },
  merged: { label: "Merged", tone: "good" }
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
  const [changeSetPatch, setChangeSetPatch] = useState<{ verificationId: string; text: string } | null>(null);
  const [changeSetPatchError, setChangeSetPatchError] = useState("");
  const [changeSetPatchLoading, setChangeSetPatchLoading] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const activityEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [projection.eventCount]);

  const connectionAttention: WorkspaceQueueItem | null = connectionState === "connection interrupted" || connectionState === "connection error"
    ? {
        id: "connection-interrupted",
        kind: "run_stalled",
        title: "Project updates stopped",
        detail: `${connectionDetail || "The desktop lost its connection to this project."} Expected next: reconnect before trusting the run's current state.`,
        created_at: new Date().toISOString(),
        task_id: null,
        action: null
      }
    : null;
  const attention = connectionAttention ?? inspection?.needs_you.find(
    (item) => !dismissedAttention.includes(item.id)
  );
  const plan = inspection?.plan_review ?? null;
  const currentPlan = inspection?.current_plan ?? null;
  const displayedPlan = plan ?? currentPlan;
  const showPlanBanner =
    plan !== null && dismissedPlanHash !== plan.plan_hash;
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
  const activeAutonomyLevel = inspection?.autonomy.run_levels.at(-1) ?? inspection?.autonomy.configured_level ?? "auto";

  const startManager = async (message = "Execute the exact ratified plan through the normal checks."): Promise<{ session_id: string }> => {
    return onAction<{ session_id: string }>({
      type: "manager.start",
      payload: {
        message,
        tool: "manager"
      }
    });
  };

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
        setFeedback("Guidance saved for the next step. Current work was not changed.");
      } else if (plan !== null) {
        setFeedback("Review the prepared plan before starting work. Typed guidance cannot approve it.");
        setReviewOpen(true);
        return;
      } else if (inspection?.current_plan === null || inspection?.current_plan === undefined) {
        const prepared = await onAction<{ status: "awaiting_ratification" | "ratified_by_policy"; autonomy_level: AutonomyLevel; task_count: number }>({
          type: "plan.prepare",
          payload: { prompt: message, tool: "planner" }
        });
        if (prepared.status === "ratified_by_policy") {
          const started = await startManager(message);
          await continueSession(started.session_id);
          setFeedback(`${prepared.task_count} ${prepared.task_count === 1 ? "task" : "tasks"}, working. You can stop the active worker at any time.`);
        } else {
          setFeedback("A tentative plan is ready to review. Nothing has started.");
        }
      } else {
        const started = await startManager(message);
        if (inspection?.autonomy.configured_level === "review_everything") {
          setFeedback("The manager prepared the first step. Continue when you are ready.");
        } else {
          await continueSession(started.session_id);
          setFeedback("Work advanced until completion or the next issue that needs you.");
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
      setFeedback("The run advanced until completion or the next decision that needs you.");
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
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
        setFeedback("The stalled run restarted from its approved plan.");
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
        setFeedback("The exact change set is ready for final authorization.");
      } else if (item.action.type === "adoption.execute") {
        const taskCount = result.task_ids?.length ?? item.change_set?.task_ids.length ?? 0;
        const branch = item.change_set?.base_branch ?? "the project branch";
        setFeedback(`Adopted ${taskCount} ${taskCount === 1 ? "task" : "tasks"} into ${branch}.`);
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
    if (!changeSet || changeSetPatch?.verificationId === changeSet.verification_id) return;
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
      setChangeSetPatch({ verificationId: changeSet.verification_id, text: sections.join("\n\n") });
    } catch (error) {
      setChangeSetPatchError(plainActionError(error));
    } finally {
      setChangeSetPatchLoading(false);
    }
  };

  return (
    <div className="work-tab">
      <div className="work-banners">
        {showPlanBanner ? (
          <PlanBanner
            plan={plan}
            onReview={() => void openPlanReview()}
            onDismiss={() => setDismissedPlanHash(plan.plan_hash)}
          />
        ) : null}

        {runActive && activeAutonomyLevel === "auto" && inspection?.current_plan ? (
          <AutoRunBanner
            taskCount={inspection.current_plan.tasks.length}
            stopBusy={stopBusy}
            onStop={async () => {
              if (!managerSession) {
                setFeedback("No project run is active to stop.");
                return;
              }
              setStopBusy(true);
              try {
                await onAction({ type: "run.stop", payload: { session_id: managerSession.session_id, reason: "Stopped from the Auto run banner" } });
                setFeedback("The run stopped; each active task was cleaned up through the normal stop path.");
              } catch (error) {
                setFeedback(plainActionError(error));
              } finally {
                setStopBusy(false);
              }
            }}
          />
        ) : null}
      </div>

      <RunSummary
        projection={projection}
        inspection={inspection}
        busy={busy}
        planAvailable={displayedPlan !== null}
        onOpenPlan={() => void openPlanReview()}
        onLevelChange={async (level) => {
          setBusy(true);
          setFeedback("");
          try {
            await onAction({ type: "autonomy.set", payload: { level } });
            setFeedback(`Interruption level changed to ${autonomyLabel(level)} for the next decision.`);
          } catch (error) {
            setFeedback(plainActionError(error));
          } finally {
            setBusy(false);
          }
        }}
      />

      <div className="work-layout">
        <div className="work-main">
          {attention ? (
            <AttentionCard
              item={attention}
              busy={busy}
              patch={attention.change_set?.verification_id === changeSetPatch?.verificationId ? changeSetPatch?.text ?? null : null}
              patchError={changeSetPatchError}
              patchLoading={changeSetPatchLoading}
              onLoadPatch={() => void loadChangeSetPatch(attention)}
              onOpen={() => {
                if (attention.id === "connection-interrupted") {
                  void onReconnect();
                } else if (attention.kind === "plan_review") {
                  void openPlanReview();
                } else if (attention.task_id) {
                  onSelectTask(attention.task_id);
                }
              }}
              onApprove={() => void approveQueueItem(attention)}
              onDismiss={() =>
                setDismissedAttention((items) => [...items, attention.id])
              }
            />
          ) : null}

          <div className="work-reading-grid">
            <CurrentWork
              tasks={tasks}
              groups={inspection?.execution_groups ?? []}
              integrationFailure={inspection?.integration_failure ?? null}
              selectedTaskId={projection.selectedTaskId}
              onSelectTask={onSelectTask}
              onAdd={() =>
                setAmendment({ kind: "add_task", draft: emptyAmendment() })
              }
              onEdit={() => {
                const task = inspection?.current_plan?.tasks.find(
                  (entry) => entry.task_id === projection.selectedTaskId
                );
                if (task) {
                  setAmendment({
                    kind: "edit_task",
                    draft: amendmentFromTask(task, inspection?.current_plan ?? null)
                  });
                } else {
                  setFeedback("Choose a task from the current plan before editing it.");
                }
              }}
            />
            <ActivityStream events={projection.recentEvents} taskTitles={inspection?.task_titles ?? {}} endRef={activityEndRef} />
          </div>

          {selected ? (
            <TaskDetails
              task={selected}
              projection={projection}
              onRedirect={() => setRedirectOpen(true)}
            />
          ) : null}
        </div>

        <QueueColumn
          inspection={inspection}
          connectionAttention={connectionAttention}
          busy={busy}
          onOpenPlan={() => void openPlanReview()}
          onSelectTask={onSelectTask}
          onApprove={(item) => void approveQueueItem(item)}
          onReconnect={() => void onReconnect()}
        />
      </div>

      <PromptComposer
        value={composer}
        runActive={runActive}
        continuationAvailable={continuationAvailable}
        managerStartAvailable={managerStartAvailable}
        busy={busy}
        feedback={feedback || plainActionError(actionError)}
        spend={inspection?.spend ?? null}
        onChange={setComposer}
        onSubmit={submitPrompt}
        onContinue={continueRun}
        onStartManager={async () => {
          setBusy(true);
          setFeedback("");
          try {
            const started = await startManager();
            if (inspection?.autonomy.configured_level === "review_everything") {
              setFeedback("The manager prepared the first step. Continue when you are ready.");
            } else {
              await continueSession(started.session_id);
              setFeedback("Work advanced until completion or the next issue that needs you.");
            }
          } catch (error) {
            setFeedback(plainActionError(error));
          } finally {
            setBusy(false);
          }
        }}
      />

      {reviewOpen && displayedPlan ? (
        <PlanTakeover
          plan={displayedPlan}
          busy={busy}
          ratificationPending={plan !== null}
          onClose={() => setReviewOpen(false)}
          onRatify={async () => {
            if (plan === null) return;
            setBusy(true);
            setFeedback("");
            try {
              await onAction({
                type: "plan.ratify",
                payload: {
                  spec_id: plan.spec_id,
                  expected_plan_hash: plan.plan_hash
                }
              });
              const started = await startManager();
              setReviewOpen(false);
              if (inspection?.autonomy.configured_level === "review_everything") {
                setFeedback("Plan approved. The manager prepared the first step; continue when you are ready.");
              } else {
                await continueSession(started.session_id);
                setFeedback("Plan approved. Work advanced until completion or the next issue that needs you.");
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
          value={amendment}
          plan={inspection.current_plan}
          busy={busy}
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
              setFeedback("Plan change queued. It must pass the normal checks and be reviewed before taking effect.");
            } catch (error) {
              setFeedback(plainActionError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {redirectOpen && selected ? (
        <TextActionDialog
          title={`Guide ${selected.title}`}
          description="This reaches the worker at its next safe correction point. File and project checks still apply."
          value={redirectText}
          busy={busy}
          submitLabel="Send guidance"
          onChange={setRedirectText}
          onClose={() => setRedirectOpen(false)}
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
              setFeedback("Worker guidance queued at the existing safe boundary.");
            } catch (error) {
              setFeedback(plainActionError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function PlanBanner({
  plan,
  onReview,
  onDismiss
}: {
  plan: WorkspacePlanReview;
  onReview: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section className="plan-banner" aria-label="Plan ready for review">
      <span className="plan-banner-icon" aria-hidden="true">
        <Layers3 size={18} />
      </span>
      <div>
        <strong>A {plan.tasks.length}-task plan is ready</strong>
        <span>Nothing starts until you review and approve this exact plan.</span>
      </div>
      <button className="button-primary" type="button" onClick={onReview}>
        Review plan <ChevronRight size={15} aria-hidden="true" />
      </button>
      <button
        className="icon-button"
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss plan banner to Needs you"
        title="Keep it in Needs you"
      >
        <X size={16} />
      </button>
    </section>
  );
}

function AutoRunBanner({
  taskCount,
  stopBusy,
  onStop
}: {
  taskCount: number;
  stopBusy: boolean;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  return (
    <section className="auto-run-banner" aria-label="Auto run active">
      <div><Play size={16} /><span><strong>{taskCount} {taskCount === 1 ? "task" : "tasks"}, working</strong><small>The full plan and every check remain available in the project trail.</small></span></div>
      <button className="button-secondary danger-button" type="button" disabled={stopBusy} onClick={() => void onStop()}><CircleStop size={14} />Stop</button>
    </section>
  );
}

function RunSummary({
  projection,
  inspection,
  busy,
  planAvailable,
  onOpenPlan,
  onLevelChange
}: {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  busy: boolean;
  planAvailable: boolean;
  onOpenPlan: () => void;
  onLevelChange: (level: AutonomyLevel) => Promise<void>;
}): React.JSX.Element {
  const tasks = inspection?.tasks ?? [];
  const active = tasks.filter((task) => ["running", "submitted", "accepted", "paused"].includes(task.state)).length;
  const attention = inspection?.needs_you.length ?? 0;
  const files = tasks.reduce((count, task) => count + task.lease_files.length, 0);
  const verification = integrationLanguage(projection.integration.status);
  return (
    <section className="run-summary" aria-label="Current run">
      <div><Activity size={15} /><span><strong>{active}</strong> active</span></div>
      <div><FileCode2 size={15} /><span><strong>{files}</strong> files being edited</span></div>
      <div><AlertTriangle size={15} /><span><strong>{attention}</strong> need you</span></div>
      <div className={`summary-verification tone-${verification.tone}`}>
        <CheckCircle2 size={15} /><span>{verification.label}</span>
      </div>
      {planAvailable ? <button className="button-secondary" type="button" onClick={onOpenPlan}><Layers3 size={14} />View plan</button> : null}
      <label className="autonomy-control">
        <span>Interruptions</span>
        <select value={inspection?.autonomy.configured_level ?? "auto"} disabled={busy} onChange={(event) => void onLevelChange(event.target.value as AutonomyLevel)}>
          <option value="auto">Auto</option>
          <option value="review_plan">Review plan</option>
          <option value="review_everything">Review everything</option>
        </select>
      </label>
    </section>
  );
}

function AttentionCard({
  item,
  busy,
  patch,
  patchError,
  patchLoading,
  onLoadPatch,
  onOpen,
  onApprove,
  onDismiss
}: {
  item: WorkspaceQueueItem;
  busy: boolean;
  patch: string | null;
  patchError: string;
  patchLoading: boolean;
  onLoadPatch: () => void;
  onOpen: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section className="attention-card" aria-label="Needs your attention">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong>{item.title}</strong>
        <p>{plainPrimaryDetail(item.detail, item.kind)}</p>
        {item.change_set ? (
          <div className="adoption-review-detail">
            <span>Into <strong>{item.change_set.base_branch}</strong></span>
            <ul aria-label="Files in this change set">
              {item.change_set.changed_files.map((file) => <li key={file}><code>{file}</code></li>)}
            </ul>
            <details onToggle={(event) => {
              if (event.currentTarget.open) onLoadPatch();
            }}>
              <summary><FileDiff size={14} />View exact patch</summary>
              {patchLoading ? <p>Loading the verified patch...</p> : null}
              {patchError ? <p role="status">{patchError}</p> : null}
              {patch ? <pre>{patch}</pre> : null}
            </details>
          </div>
        ) : null}
      </div>
      {item.action ? (
        <button className="button-primary" type="button" disabled={busy} onClick={onApprove}>
          {queueActionLabel(item.action.type)}
        </button>
      ) : (
        <button className="button-secondary" type="button" onClick={onOpen}>
          Open
        </button>
      )}
      <button className="icon-button" type="button" onClick={onDismiss} aria-label="Move to queue">
        <ArrowDown size={16} />
      </button>
    </section>
  );
}

function CurrentWork({
  tasks,
  groups,
  integrationFailure,
  selectedTaskId,
  onSelectTask,
  onAdd,
  onEdit
}: {
  tasks: TaskProjection[];
  groups: WorkspaceInspection["execution_groups"];
  integrationFailure: WorkspaceInspection["integration_failure"];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onAdd: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const groupedTasks = useMemo(() => groups.map((group) => ({
    group,
    tasks: group.task_ids.map((taskId) => tasks.find((task) => task.task_id === taskId)).filter((task): task is TaskProjection => task !== undefined)
  })), [groups, tasks]);
  return (
    <section className="surface current-work" aria-labelledby="current-work-title">
      <header className="section-heading">
        <div>
          <h2 id="current-work-title">Current work</h2>
          <span>{tasks.length} tasks</span>
        </div>
        <div className="heading-actions">
          <button className="icon-button" type="button" onClick={onEdit} title="Edit a task that has not started" aria-label="Edit selected task">
            <PencilLine size={15} />
          </button>
          <button className="icon-button" type="button" onClick={onAdd} title="Add a task" aria-label="Add task">
            <Plus size={16} />
          </button>
        </div>
      </header>
      {tasks.length === 0 ? (
        <div className="intentional-empty compact-empty">
          <Layers3 size={22} />
          <strong>No tasks yet</strong>
          <span>Describe the work below or review a ready plan.</span>
        </div>
      ) : (
        <ScrollArea className="task-list-scroll">
          <div className="task-groups">
            {groupedTasks.map(({ group, tasks: groupTasks }) => {
              return (
                <section className="task-group" key={group.group_id}>
                  <header><strong>{group.label}</strong><span>{group.capacity_note ?? (group.mode === "parallel" ? "Independent tasks" : "Runs in order")}</span></header>
                  <div className="task-lanes">
                    {groupTasks.map((task) => (
                      <TaskLane
                        key={task.task_id}
                        task={task}
                        integrationFailure={integrationFailure?.task_ids.includes(task.task_id) ? integrationFailure.reason : null}
                        selected={task.task_id === selectedTaskId}
                        onSelect={() => onSelectTask(task.task_id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function TaskLane({ task, integrationFailure, selected, onSelect }: { task: TaskProjection; integrationFailure: string | null; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const language = integrationFailure === null
    ? stateLanguage[task.state]
    : { label: "Project check stopped", tone: "danger" as const };
  return (
    <button type="button" className={`task-lane state-${task.state}${selected ? " is-selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span className="task-lane-head">
        <span className="task-identity" title={task.task_id}><strong>{task.title}</strong><span>{task.task_id}</span></span>
        <Badge tone={language.tone}>{language.label}</Badge>
      </span>
      <span className="phase-rail" aria-label={`${task.task_id} progress`}>
        {phasesFor(task, integrationFailure).map((phase, index) => (
          <span className={`phase phase-${phase.status}`} key={phase.key} title={phaseDetail(task, phase.key)}>
            {index > 0 ? <span className="phase-line" /> : null}
            <span className="phase-node">{phase.status === "complete" ? <Check size={10} /> : phase.status === "failed" ? <AlertTriangle size={10} /> : null}</span>
            <span className="phase-label">{phase.label}</span>
          </span>
        ))}
      </span>
      <span className="task-lane-foot">
        <span><Bot size={12} />{task.agent ?? "Waiting"}</span>
        <span><FileCode2 size={12} />{task.lease_files.length} files</span>
        {task.depends_on.length > 0 ? <span><ArrowRight size={12} />after {task.depends_on.join(", ")}</span> : null}
      </span>
      {integrationFailure || task.issue ? <span className="task-issue">{plainTaskIssue(integrationFailure ?? task.issue!)}</span> : null}
    </button>
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
    <section className="surface activity-stream" aria-labelledby="activity-title">
      <header className="section-heading"><div><h2 id="activity-title">Activity</h2><span>Newest at the bottom</span></div></header>
      <ScrollArea className="activity-scroll">
        {groups.length === 0 ? (
          <div className="intentional-empty compact-empty"><Clock3 size={22} /><strong>Quiet for now</strong><span>Project updates will appear here as they happen.</span></div>
        ) : (
          <ol className="activity-list">
            {groups.map(({ event, count }, index) => (
              <li key={`${event.ts}-${event.type}-${index}`}>
                <time>{formatClock(event.ts)}</time>
                <span className={`activity-dot event-${eventTone(event.type)}`} />
                <span>{eventDescription(event, taskTitles)}{count > 1 ? <small className="activity-count">{count} similar updates</small> : null}</span>
              </li>
            ))}
            <div ref={endRef} />
          </ol>
        )}
      </ScrollArea>
    </section>
  );
}

function TaskDetails({
  task,
  projection,
  onRedirect
}: {
  task: TaskProjection;
  projection: BoardProjection;
  onRedirect: () => void;
}): React.JSX.Element {
  const [outputMode, setOutputMode] = useState<"summary" | "raw">("summary");
  useEffect(() => setOutputMode("summary"), [task.task_id]);
  const files = task.lease_files;
  const output = outputMode === "summary"
    ? summarizeWorkerOutput(projection.selectedOutput)
    : projection.selectedOutput.map((record) => `[${formatClock(record.ts)}] ${record.text}`).join("\n");
  return (
    <section className="surface task-details">
      <header className="section-heading">
        <div><h2>{task.title}</h2><span>{task.task_id}</span></div>
        <button className="button-secondary" type="button" onClick={onRedirect}><MessageSquareText size={14} />Guide worker</button>
      </header>
      <div className="task-detail-grid">
        <div className="task-output-panel">
          <div className="subheading">
            <span><TerminalSquare size={13} />Live output</span>
            <span className="output-mode" role="group" aria-label="Worker output detail">
              <button type="button" className={outputMode === "summary" ? "is-active" : ""} onClick={() => setOutputMode("summary")}>Highlights</button>
              <button type="button" className={outputMode === "raw" ? "is-active" : ""} onClick={() => setOutputMode("raw")}>Full output</button>
            </span>
          </div>
          <ScrollArea className="output-scroll">
            <pre className="task-output">{projection.selectedOutput.length > 0 ? output : "Waiting for this worker to produce output."}</pre>
          </ScrollArea>
        </div>
        <div className="task-file-panel">
          <div className="subheading"><span><FileCode2 size={13} />Files being edited</span><small>{files.length}</small></div>
          {files.length === 0 ? <p className="panel-empty">No files are being edited by this task.</p> : (
            <ul>{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
          )}
        </div>
      </div>
    </section>
  );
}

function QueueColumn({
  inspection,
  connectionAttention,
  busy,
  onOpenPlan,
  onSelectTask,
  onApprove,
  onReconnect
}: {
  inspection: WorkspaceInspection | null;
  connectionAttention: WorkspaceQueueItem | null;
  busy: boolean;
  onOpenPlan: () => void;
  onSelectTask: (taskId: string) => void;
  onApprove: (item: WorkspaceQueueItem) => void;
  onReconnect: () => void;
}): React.JSX.Element {
  const items = connectionAttention === null
    ? inspection?.needs_you ?? []
    : [connectionAttention, ...(inspection?.needs_you ?? [])];
  return (
    <aside className="queue-column">
      <QueuePanel title="Needs you" count={items.length} empty="Nothing is blocking progress.">
        {items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            busy={busy}
            onOpen={() => item.id === "connection-interrupted" ? onReconnect() : item.kind === "plan_review" ? onOpenPlan() : item.task_id ? onSelectTask(item.task_id) : undefined}
            onApprove={() => onApprove(item)}
          />
        ))}
      </QueuePanel>
    </aside>
  );
}

function QueuePanel({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="surface queue-panel"><header className="section-heading"><div><h2>{title}</h2></div><Badge tone={count > 0 ? "warning" : "neutral"}>{count}</Badge></header><div className="queue-list">{count === 0 ? <p className="panel-empty">{empty}</p> : children}</div></section>;
}

function QueueRow({ item, busy, onOpen, onApprove }: { item: WorkspaceQueueItem; busy: boolean; onOpen: () => void | undefined; onApprove: () => void }): React.JSX.Element {
  return (
    <div className="queue-row">
      <div><strong>{item.title}</strong><span>{plainPrimaryDetail(item.detail, item.kind)}</span></div>
      {item.action ? <button className="queue-action" type="button" disabled={busy} onClick={onApprove}>{queueActionLabel(item.action.type)}</button> : item.kind === "plan_review" || item.kind === "run_stalled" || item.task_id ? <button className="icon-button" type="button" onClick={onOpen} aria-label={`Open ${item.title}`}><ChevronRight size={15} /></button> : null}
    </div>
  );
}

function queueActionLabel(actionType: string): string {
  if (actionType === "manager.start") return "Restart run";
  if (actionType === "manager.continue") return "Continue";
  if (actionType === "manager.retry_blocked") return "Retry";
  if (actionType === "task.stop") return "Stop worker";
  if (actionType === "verification.rerun") return "Run checks again";
  if (actionType === "adoption.review") return "Review";
  if (actionType === "adoption.execute") return "Merge exact set";
  return "Approve";
}

function actionSuccessMessage(actionType: string): string {
  if (actionType === "manager.approve_pending") return "The next project step was approved.";
  if (actionType === "verification.rerun") return "Fresh project checks completed.";
  return "The requested action completed.";
}

function PromptComposer({
  value,
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
    <footer className="prompt-dock">
      <form className="prompt-composer" onSubmit={(event) => void onSubmit(event)}>
        <div className="prompt-context">
          <span>{runActive ? "Guide the next step" : "What should Hivemind work on?"}</span>
          <SpendIndicator spend={spend} />
        </div>
        <div className="prompt-row">
          <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={runActive ? "Add context for the next proposal..." : "Describe the outcome you want..."} rows={2} />
          <button className="send-button" type="submit" disabled={busy || value.trim() === ""} aria-label={runActive ? "Save guidance" : "Start request"}><Send size={18} /></button>
        </div>
        <div className="prompt-note">
          <span>{runActive ? "Guidance is read on the next step and does not change work already in progress." : "Typed text proposes work. Review buttons approve it."}</span>
          <span className="prompt-actions">
            {managerStartAvailable ? <button className="button-secondary continue-run" type="button" disabled={busy} onClick={() => void onStartManager()}><Play size={13} />Retry manager</button> : null}
            {continuationAvailable ? <button className="button-secondary continue-run" type="button" disabled={busy} onClick={() => void onContinue()}><Play size={13} />Continue run</button> : null}
            {feedback ? <strong role="status">{feedback}</strong> : null}
          </span>
        </div>
      </form>
    </footer>
  );
}

function SpendIndicator({ spend }: { spend: WorkspaceInspection["spend"] | null }): React.JSX.Element {
  if (!spend) return <span className="spend-indicator"><Clock3 size={13} />No active spend</span>;
  const ratio = spend.session_ceiling_tokens > 0 ? Math.min(100, (spend.committed_tokens / spend.session_ceiling_tokens) * 100) : 0;
  return (
    <span className={`spend-indicator ${spend.near_session_ceiling ? "is-near-ceiling" : ""}`} title={`${spend.run_ceiling_tokens.toLocaleString()} tokens maximum per call`}>
      <span>{spend.calls} calls</span>
      <span className="spend-track"><i style={{ width: `${ratio}%` }} /></span>
      <span>{formatCompact(spend.effective_tokens)} used + {formatCompact(spend.reserved_tokens)} reserved / {formatCompact(spend.session_ceiling_tokens)}</span>
    </span>
  );
}

function autonomyLabel(level: AutonomyLevel): string {
  return level === "auto" ? "Auto" : level === "review_plan" ? "Review plan" : "Review everything";
}

function PlanTakeover({ plan, busy, ratificationPending, onClose, onRatify }: { plan: WorkspacePlanReview; busy: boolean; ratificationPending: boolean; onClose: () => void; onRatify: () => Promise<void> }): React.JSX.Element {
  return (
    <div className="takeover-backdrop" role="dialog" aria-modal="true" aria-labelledby="plan-review-title">
      <section className="plan-takeover">
        <header>
          <div><span>{ratificationPending ? "Review before work begins" : "Ratified plan"}</span><h2 id="plan-review-title">{plan.tasks.length} tasks, {plan.execution_groups.length} work groups</h2><p>{ratificationPending ? "Check the order, file boundaries, and risk. Approval applies only to this exact version." : "This is the exact durable plan used for this run, including how each task's result is checked."}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close plan review"><X size={18} /></button>
        </header>
        <div className="plan-review-body">
          {plan.execution_groups.map((group, groupIndex) => (
            <section className="plan-group" key={group.group_id}>
              <div className="plan-group-label"><span>{groupIndex + 1}</span><div><strong>{group.mode === "parallel" ? `${group.task_ids.length} at once` : `${group.task_ids.length} in order`}</strong><small>{group.group_id}</small></div></div>
              <div className="plan-task-list">
                {group.task_ids.map((taskId) => {
                  const task = plan.tasks.find((candidate) => candidate.task_id === taskId);
                  return task ? <PlanTaskCard task={task} key={taskId} /> : null;
                })}
              </div>
            </section>
          ))}
        </div>
        <footer><div><code>{plan.plan_hash.slice(0, 12)}</code><span>{ratificationPending ? "Any regenerated or edited plan needs a new approval." : "Read-only record of the exact approved plan."}</span></div>{ratificationPending ? <button className="button-primary ratify-button" type="button" disabled={busy} onClick={() => void onRatify()}><CheckCircle2 size={16} />Approve and start</button> : <button className="button-secondary" type="button" onClick={onClose}>Close</button>}</footer>
      </section>
    </div>
  );
}

function PlanTaskCard({ task }: { task: WorkspacePlanTask }): React.JSX.Element {
  return (
    <article className="plan-task-card">
      <div className="plan-task-title"><span title={task.task_id}><h3>{task.title}</h3><strong>{task.task_id}</strong></span><Badge tone={tierTone(task.tier)}>{capitalize(task.tier)} risk</Badge></div>
      <dl><div><dt>Changes</dt><dd>{task.scope.join(", ") || "No files"}</dd></div><div><dt>Reads</dt><dd>{task.read_only_scope.join(", ") || "No additional files"}</dd></div><div><dt>After</dt><dd>{task.depends_on.join(", ") || "Can start immediately"}</dd></div><div><dt>Done when</dt><dd>{task.acceptance_criterion}</dd></div><div><dt>How it is checked</dt><dd>{task.deterministic_validity_check ?? "Project checks listed in the task"}</dd></div></dl>
    </article>
  );
}

function AmendmentDialog({ value, plan, busy, onChange, onClose, onSubmit }: { value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft }; plan: WorkspacePlanReview; busy: boolean; onChange: (value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft }) => void; onClose: () => void; onSubmit: () => Promise<void> }): React.JSX.Element {
  const update = (field: keyof AmendmentDraft, next: string) => onChange({ ...value, draft: { ...value.draft, [field]: next } });
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="amend-title">
      <form className="action-dialog amendment-dialog" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
        <header><div><h2 id="amend-title">{value.kind === "add_task" ? "Add a task" : `Edit ${value.draft.taskId}`}</h2><p>{value.kind === "edit_task" ? "If this task has started, the existing Core rule will refuse the edit and explain the safer next step." : "The task will be queued for grounding, checks, and a new plan review."}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
        <div className="form-grid">
          <label>Task ID<input value={value.draft.taskId} disabled={value.kind === "edit_task"} onChange={(event) => update("taskId", event.target.value)} /></label>
          <label>Title<input value={value.draft.title} onChange={(event) => update("title", event.target.value)} /></label>
          <label className="span-two">Files to change<textarea rows={2} value={value.draft.files} onChange={(event) => update("files", event.target.value)} placeholder="src/example.ts" /></label>
          <label className="span-two">Files to read<textarea rows={2} value={value.draft.readOnlyFiles} onChange={(event) => update("readOnlyFiles", event.target.value)} /></label>
          <label>Runs after<input value={value.draft.dependencies} onChange={(event) => update("dependencies", event.target.value)} placeholder="T-001, T-002" /></label>
          <label>Named check<input value={value.draft.checks} onChange={(event) => update("checks", event.target.value)} placeholder="npm test" /></label>
          <label className="span-two">Done when<textarea rows={2} value={value.draft.acceptance} onChange={(event) => update("acceptance", event.target.value)} /></label>
          <label className="span-two">Interface check<input value={value.draft.validityCheck} onChange={(event) => update("validityCheck", event.target.value)} placeholder="Optional executable command for a named interface" /></label>
          {value.kind === "add_task" ? <><label>Work group<input value={value.draft.groupId} onChange={(event) => update("groupId", event.target.value)} /></label><label>Order<select value={value.draft.groupMode} onChange={(event) => update("groupMode", event.target.value)}><option value="sequence">In order</option><option value="parallel">At the same time</option></select></label></> : null}
        </div>
        <footer><span>Current plan: {plan.tasks.length} tasks</span><button className="button-primary" type="submit" disabled={busy}>{value.kind === "add_task" ? "Queue task" : "Queue edit"}</button></footer>
      </form>
    </div>
  );
}

function TextActionDialog({ title, description, value, busy, submitLabel, onChange, onClose, onSubmit }: { title: string; description: string; value: string; busy: boolean; submitLabel: string; onChange: (value: string) => void; onClose: () => void; onSubmit: () => Promise<void> }): React.JSX.Element {
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="text-action-title"><form className="action-dialog" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}><header><div><h2 id="text-action-title">{title}</h2><p>{description}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><textarea rows={6} value={value} onChange={(event) => onChange(event.target.value)} autoFocus /><footer><span>This guidance cannot approve a file or adopt a change.</span><button className="button-primary" type="submit" disabled={busy || value.trim() === ""}>{submitLabel}</button></footer></form></div>
  );
}

function emptyAmendment(): AmendmentDraft {
  return { taskId: "", title: "", files: "", readOnlyFiles: "", dependencies: "", acceptance: "", validityCheck: "", checks: "", groupId: "G-new", groupMode: "sequence" };
}

function amendmentFromTask(task: WorkspacePlanTask, plan: WorkspacePlanReview | null): AmendmentDraft {
  const group = plan?.execution_groups.find((entry) => entry.task_ids.includes(task.task_id));
  return { taskId: task.task_id, title: task.title, files: task.scope.join("\n"), readOnlyFiles: task.read_only_scope.join("\n"), dependencies: task.depends_on.join(", "), acceptance: task.acceptance_criterion, validityCheck: task.deterministic_validity_check ?? "", checks: task.required_tests.join("\n"), groupId: group?.group_id ?? "G-edit", groupMode: group?.mode ?? "sequence" };
}

function buildAmendment(value: { kind: "add_task" | "edit_task"; draft: AmendmentDraft }, plan: WorkspacePlanReview): Record<string, unknown> {
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
        allowedFiles.map((file) => [
          file,
          existing?.allowed_file_intents[file] ?? "modify"
        ])
      ),
      read_only_files: splitList(value.draft.readOnlyFiles),
      forbidden_files: existing?.forbidden_scope ?? [],
      must_not_change: existing?.must_not_change ?? []
    },
    depends_on: splitList(value.draft.dependencies),
    parallel_safe: existing?.parallel_safe ?? false,
    acceptance_criterion: value.draft.acceptance.trim(),
    ...(value.draft.validityCheck.trim() ? { deterministic_validity_check: value.draft.validityCheck.trim() } : {}),
    required_tests: splitList(value.draft.checks),
    patch_requirements: existing?.patch_requirements ?? ["Submit only the requested scoped change."],
    critical_path_approved: existing?.critical_path_approved ?? false
  };
  return value.kind === "add_task"
    ? { kind: value.kind, task, execution_group: { group_id: value.draft.groupId.trim(), mode: value.draft.groupMode } }
    : { kind: value.kind, task };
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
}

function phasesFor(task: TaskProjection, integrationFailure: string | null = null): TaskPhase[] {
  const failure = ["failed", "blocked", "rejected", "cancelled"].includes(task.state);
  const adopted = task.state === "merged" || task.integration === "merged";
  return [
    { key: "scoped", label: "Ready", status: task.lease_files.length > 0 || task.state !== "planned" ? "complete" : "active" },
    { key: "running", label: "Working", status: failure ? "failed" : task.state === "paused" ? "waiting" : task.state === "running" ? "active" : ["submitted", "accepted", "verified", "merged"].includes(task.state) ? "complete" : "waiting" },
    { key: "scope", label: "Files", status: task.state === "rejected" ? "failed" : adopted || task.patch.verdict === "accept" || task.state === "verified" ? "complete" : task.patch.submitted ? "active" : "waiting" },
    { key: "verified", label: "Verified", status: integrationFailure !== null || task.integration === "blocked" || task.integration === "failed" ? "failed" : adopted || task.state === "verified" || task.integration === "passed" ? "complete" : task.integration === "queued" ? "active" : "waiting" }
  ];
}

function phaseDetail(task: TaskProjection, phase: string): string {
  if (phase === "scoped") return `${task.lease_files.length} files are inside this task's working boundary`;
  if (phase === "running") return task.state === "running" ? "The worker is active" : "The worker is not active";
  if (phase === "scope") return task.patch.reason ?? "No file-check result recorded yet";
  if (task.integration === "merged" || task.state === "merged") return "Project checks passed and the change was adopted";
  return task.integration === "passed" ? "Project checks passed; ready for explicit adoption" : "Not verified against the project yet";
}

function eventDescription(event: HivemindEvent, taskTitles: Record<string, string>): string {
  const subject = event.task_id ? `${taskTitles[event.task_id] ?? "Task"} ` : "";
  if (event.type === "adoption.completed") {
    const taskCount = Array.isArray(event.data.task_ids) ? event.data.task_ids.length : 0;
    return `Adopted ${taskCount} ${taskCount === 1 ? "task" : "tasks"} into the project branch`;
  }
  const labels: Record<string, string> = {
    "task.created": "was added to the plan",
    "task.started": "started working",
    "task.completed": "finished its work",
    "task.failed": "stopped unexpectedly",
    "task.paused": "paused for capacity",
    "task.resumed": "resumed from saved work",
    "task.blocked": "needs help before it can continue",
    "task.redirected": "received new guidance",
    "human.guidance_recorded": "Guidance was saved for the next proposal",
    "plan.prepared": "A tentative plan was prepared for review",
    "plan.ratified": "The current plan was approved",
    "plan.amendment_queued": "A plan change was queued for review",
    "lease.approved": "can now edit its assigned files",
    "lease.released": "finished editing its assigned files",
    "patch.submitted": "submitted a change for checks",
    "patch.accepted": "passed the file checks",
    "patch.rejected": "needs to revise its change",
    "integration.blocked": "Project checks are blocked",
    "integration.low_confidence": "A change has thin test coverage",
    "integration.passed": "Changes passed project checks and are ready to adopt",
    "routing.observed": "A model run was measured",
    "quality.draft_started": "An independent draft started",
    "quality.draft_verified": "An independent draft was checked",
    "quality.selection_decided": "A candidate change was selected for review"
  };
  return `${subject}${labels[event.type] ?? "Project state was updated"}`.trim();
}

function eventTone(type: string): string {
  if (/failed|blocked|rejected|cancel_failed/u.test(type)) return "danger";
  if (/passed|accepted|integrated|ratified/u.test(type)) return "good";
  if (/started|submitted|guidance|draft/u.test(type)) return "live";
  return "neutral";
}

function plainPrimaryDetail(detail: string, kind: WorkspaceQueueItem["kind"]): string {
  if (kind === "quality_cancel_failed") return "A draft process may still be active. Review it before starting another one.";
  if (/oracle|tier-?2|write[-_ ]intent|lease|durable trail|provider evidence/iu.test(detail)) return "Open the details to see what needs attention.";
  return detail;
}

function plainTaskIssue(issue: string): string {
  if (/quota|429|capacity/iu.test(issue)) return "Paused until capacity is available.";
  if (/oracle|coverage/iu.test(issue)) return "Testing is too thin for this change.";
  if (/write[-_ ]intent|scope/iu.test(issue)) return "The worker tried to change a file outside this task.";
  return issue;
}

function integrationLanguage(status: string): { label: string; tone: string } {
  if (status === "merged") return { label: "Merged", tone: "good" };
  if (status === "blocked") return { label: "Project checks blocked", tone: "danger" };
  if (status === "low-confidence") return { label: "Thin test coverage", tone: "warning" };
  if (status === "failed") return { label: "Checks failed", tone: "danger" };
  if (status === "passed") return { label: "Ready to adopt", tone: "good" };
  if (status === "running" || status === "queued") return { label: "Checking", tone: "live" };
  return { label: "Not verified yet", tone: "neutral" };
}

function tierTone(tier: WorkspacePlanTask["tier"]): "neutral" | "warning" | "danger" {
  if (tier === "critical") return "danger";
  if (tier === "high") return "warning";
  return "neutral";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

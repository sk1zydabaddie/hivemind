import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileCode2,
  Layers3,
  MessageSquareText,
  PencilLine,
  Play,
  Plus,
  Route,
  Send,
  Sparkles,
  TerminalSquare,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  leaseRows,
  qualityRunRows,
  taskRows,
  taskStateCounts,
  type BoardProjection,
  type HivemindEvent,
  type TaskProjection,
  type TaskState
} from "../../lib/projection";
import type {
  WorkspaceAction,
  WorkspaceInspection,
  WorkspacePlanReview,
  WorkspacePlanTask,
  WorkspaceQueueItem
} from "../../lib/workspace-actions";
import { plainActionError } from "../../lib/plain-language";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";

interface WorkTabProps {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  actionError: string;
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
  onSelectTask,
  onAction
}: WorkTabProps): React.JSX.Element {
  const tasks = taskRows(projection);
  const selected = projection.selectedTaskId
    ? projection.tasks[projection.selectedTaskId] ?? null
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
  const activityEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [projection.eventCount]);

  const attention = inspection?.needs_you.find(
    (item) => !dismissedAttention.includes(item.id)
  );
  const plan = inspection?.plan_review ?? null;
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

  const startManager = async (): Promise<void> => {
    await onAction({
      type: "manager.start",
      payload: {
        message: "Execute the exact ratified plan through the normal checks.",
        tool: "manager"
      }
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
        await onAction({
          type: "plan.prepare",
          payload: { prompt: message, tool: "planner" }
        });
        setFeedback("A tentative plan is ready to review. Nothing has started.");
      } else {
        await onAction({
          type: "manager.start",
          payload: { message, tool: "manager" }
        });
        setFeedback("The manager prepared the first step. Continue when you are ready.");
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
    if (!plan) return;
    setReviewOpen(true);
    setFeedback("");
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
      await onAction(item.action);
      if (item.action.type === "manager.retry_blocked" && managerSession) {
        await onAction({
          type: "manager.continue",
          payload: {
            session_id: managerSession.session_id,
            tool: managerSession.tool,
            max_steps: 25
          }
        });
        setFeedback("The project check is ready for your approval with the refreshed project state.");
      } else {
        setFeedback("The reviewed action was accepted.");
      }
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="work-tab">
      {showPlanBanner ? (
        <PlanBanner
          plan={plan}
          onReview={() => void openPlanReview()}
          onDismiss={() => setDismissedPlanHash(plan.plan_hash)}
        />
      ) : null}

      <RunSummary projection={projection} inspection={inspection} />

      <div className="work-layout">
        <div className="work-main">
          {attention ? (
            <AttentionCard
              item={attention}
              busy={busy}
              onOpen={() => {
                if (attention.kind === "plan_review") {
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
            <ActivityStream events={projection.recentEvents} endRef={activityEndRef} />
          </div>

          <TaskDetails
            task={selected}
            projection={projection}
            onRedirect={() => setRedirectOpen(true)}
          />
        </div>

        <QueueColumn
          inspection={inspection}
          projection={projection}
          busy={busy}
          onOpenPlan={() => void openPlanReview()}
          onSelectTask={onSelectTask}
          onApprove={(item) => void approveQueueItem(item)}
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
            await startManager();
            setFeedback("The manager prepared the first step. Continue when you are ready.");
          } catch (error) {
            setFeedback(plainActionError(error));
          } finally {
            setBusy(false);
          }
        }}
      />

      {reviewOpen && plan ? (
        <PlanTakeover
          plan={plan}
          busy={busy}
          onClose={() => setReviewOpen(false)}
          onRatify={async () => {
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
              await startManager();
              setReviewOpen(false);
              setFeedback("Plan approved. The manager prepared the first step; continue when you are ready.");
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
          title={`Guide ${selected.task_id}`}
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

function RunSummary({
  projection,
  inspection
}: {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
}): React.JSX.Element {
  const counts = taskStateCounts(projection);
  const active = counts.running + counts.submitted + counts.accepted + counts.paused;
  const attention = inspection?.needs_you.length ?? 0;
  const files = leaseRows(projection).length;
  const verification = integrationLanguage(projection.integration.status);
  return (
    <section className="run-summary" aria-label="Current run">
      <div><Activity size={15} /><span><strong>{active}</strong> active</span></div>
      <div><FileCode2 size={15} /><span><strong>{files}</strong> files being edited</span></div>
      <div><AlertTriangle size={15} /><span><strong>{attention}</strong> need you</span></div>
      <div className={`summary-verification tone-${verification.tone}`}>
        <CheckCircle2 size={15} /><span>{verification.label}</span>
      </div>
    </section>
  );
}

function AttentionCard({
  item,
  busy,
  onOpen,
  onApprove,
  onDismiss
}: {
  item: WorkspaceQueueItem;
  busy: boolean;
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
  integrationFailure,
  selectedTaskId,
  onSelectTask,
  onAdd,
  onEdit
}: {
  tasks: TaskProjection[];
  integrationFailure: WorkspaceInspection["integration_failure"];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onAdd: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const groups = useMemo(() => {
    const value = new Map<string, TaskProjection[]>();
    for (const task of tasks) {
      const key = task.execution_group ?? "independent";
      value.set(key, [...(value.get(key) ?? []), task]);
    }
    return [...value.entries()];
  }, [tasks]);
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
            {groups.map(([group, groupTasks]) => {
              const mode = groupTasks.find((task) => task.group_mode)?.group_mode ?? "sequence";
              const label = mode === "parallel" ? `${groupTasks.length} at once` : `${groupTasks.length} in order`;
              return (
                <section className="task-group" key={group}>
                  <header><strong>{label}</strong><span>{group === "independent" ? "Independent" : group}</span></header>
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
        <span className="task-identity"><strong>{task.task_id}</strong><span>{task.title}</span></span>
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
  endRef
}: {
  events: BoardProjection["recentEvents"];
  endRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const chronological = [...events].reverse();
  return (
    <section className="surface activity-stream" aria-labelledby="activity-title">
      <header className="section-heading"><div><h2 id="activity-title">Activity</h2><span>Newest at the bottom</span></div></header>
      <ScrollArea className="activity-scroll">
        {chronological.length === 0 ? (
          <div className="intentional-empty compact-empty"><Clock3 size={22} /><strong>Quiet for now</strong><span>Project updates will appear here as they happen.</span></div>
        ) : (
          <ol className="activity-list">
            {chronological.map((event, index) => (
              <li key={`${event.ts}-${event.type}-${index}`}>
                <time>{formatClock(event.ts)}</time>
                <span className={`activity-dot event-${eventTone(event.type)}`} />
                <span>{eventDescription(event)}</span>
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
  task: TaskProjection | null;
  projection: BoardProjection;
  onRedirect: () => void;
}): React.JSX.Element {
  if (!task) {
    return (
      <section className="surface task-details intentional-empty">
        <TerminalSquare size={23} /><strong>Select a task</strong><span>Its files, live output, and current issue will appear here.</span>
      </section>
    );
  }
  const files = leaseRows(projection).filter((lease) => lease.taskId === task.task_id);
  return (
    <section className="surface task-details">
      <header className="section-heading">
        <div><h2>{task.task_id}</h2><span>{task.title}</span></div>
        <button className="button-secondary" type="button" onClick={onRedirect}><MessageSquareText size={14} />Guide worker</button>
      </header>
      <div className="task-detail-grid">
        <div className="task-output-panel">
          <div className="subheading"><span><TerminalSquare size={13} />Live output</span><small>{projection.selectedOutput.length} records</small></div>
          <ScrollArea className="output-scroll">
            <pre className="task-output">{projection.selectedOutput.length > 0 ? projection.selectedOutput.map((record) => `[${formatClock(record.ts)}] ${record.text}`).join("\n") : "Waiting for this worker to produce output."}</pre>
          </ScrollArea>
        </div>
        <div className="task-file-panel">
          <div className="subheading"><span><FileCode2 size={13} />Files being edited</span><small>{files.length}</small></div>
          {files.length === 0 ? <p className="panel-empty">No files are being edited by this task.</p> : (
            <ul>{files.map((file) => <li key={file.filePath}><code>{file.filePath}</code></li>)}</ul>
          )}
        </div>
      </div>
    </section>
  );
}

function QueueColumn({
  inspection,
  projection,
  busy,
  onOpenPlan,
  onSelectTask,
  onApprove
}: {
  inspection: WorkspaceInspection | null;
  projection: BoardProjection;
  busy: boolean;
  onOpenPlan: () => void;
  onSelectTask: (taskId: string) => void;
  onApprove: (item: WorkspaceQueueItem) => void;
}): React.JSX.Element {
  return (
    <aside className="queue-column">
      <QueuePanel title="Needs you" count={inspection?.needs_you.length ?? 0} empty="Nothing is blocking progress.">
        {inspection?.needs_you.map((item) => (
          <QueueRow key={item.id} item={item} busy={busy} onOpen={() => item.kind === "plan_review" ? onOpenPlan() : item.task_id ? onSelectTask(item.task_id) : undefined} onApprove={() => onApprove(item)} />
        ))}
      </QueuePanel>
      <QueuePanel title="Later" count={inspection?.later.length ?? 0} empty="Review backlog is clear.">
        {inspection?.later.map((item) => <QueueRow key={item.id} item={item} busy={busy} onOpen={() => item.task_id ? onSelectTask(item.task_id) : undefined} onApprove={() => undefined} />)}
      </QueuePanel>
      <RoutingPanel projection={projection} />
      <QualityPanel projection={projection} />
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
      {item.action ? <button className="queue-action" type="button" disabled={busy} onClick={onApprove}>{queueActionLabel(item.action.type)}</button> : item.kind === "plan_review" || item.task_id ? <button className="icon-button" type="button" onClick={onOpen} aria-label={`Open ${item.title}`}><ChevronRight size={15} /></button> : null}
    </div>
  );
}

function queueActionLabel(actionType: string): string {
  if (actionType === "manager.retry_blocked") return "Retry";
  if (actionType === "adoption.review") return "Review";
  if (actionType === "adoption.execute") return "Merge exact set";
  return "Approve";
}

function RoutingPanel({ projection }: { projection: BoardProjection }): React.JSX.Element {
  const observations = projection.routingObservations.slice(0, 2);
  return (
    <section className="surface compact-panel"><header className="section-heading"><div><h2>Routing</h2><span>Recent measured runs</span></div><Route size={15} /></header>
      {observations.length === 0 ? <p className="panel-empty">No measured provider runs yet.</p> : <div className="compact-list">{observations.map((item) => <div key={`${item.task_id}-${item.ts}`}><span><strong>{item.provider}</strong><small>{item.task_id}</small></span><b>{item.effective_tokens === null ? "No total" : `${formatCompact(item.effective_tokens)} tokens`}</b></div>)}</div>}
    </section>
  );
}

function QualityPanel({ projection }: { projection: BoardProjection }): React.JSX.Element {
  const runs = qualityRunRows(projection).slice(0, 2);
  return (
    <section className="surface compact-panel"><header className="section-heading"><div><h2>Draft comparisons</h2><span>Independent candidate work</span></div><Sparkles size={15} /></header>
      {runs.length === 0 ? <p className="panel-empty">No draft comparisons yet.</p> : <div className="compact-list">{runs.map((run) => <div key={run.quality_run_id}><span><strong>{run.task_id}</strong><small>{plainQualityStatus(run.status)}</small></span><b>{run.drafts_verified}/{run.drafts_started} checked</b></div>)}</div>}
    </section>
  );
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
  const ratio = spend.session_ceiling_tokens > 0 ? Math.min(100, (spend.effective_tokens / spend.session_ceiling_tokens) * 100) : 0;
  return (
    <span className="spend-indicator" title={`${spend.run_ceiling_tokens.toLocaleString()} tokens maximum per call`}>
      <span>{spend.calls} calls</span>
      <span className="spend-track"><i style={{ width: `${ratio}%` }} /></span>
      <span>{formatCompact(spend.effective_tokens)} / {formatCompact(spend.session_ceiling_tokens)} tokens</span>
    </span>
  );
}

function PlanTakeover({ plan, busy, onClose, onRatify }: { plan: WorkspacePlanReview; busy: boolean; onClose: () => void; onRatify: () => Promise<void> }): React.JSX.Element {
  return (
    <div className="takeover-backdrop" role="dialog" aria-modal="true" aria-labelledby="plan-review-title">
      <section className="plan-takeover">
        <header>
          <div><span>Review before work begins</span><h2 id="plan-review-title">{plan.tasks.length} tasks, {plan.execution_groups.length} work groups</h2><p>Check the order, file boundaries, and risk. Approval applies only to this exact version.</p></div>
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
        <footer><div><code>{plan.plan_hash.slice(0, 12)}</code><span>Any regenerated or edited plan needs a new approval.</span></div><button className="button-primary ratify-button" type="button" disabled={busy} onClick={() => void onRatify()}><CheckCircle2 size={16} />Approve and start</button></footer>
      </section>
    </div>
  );
}

function PlanTaskCard({ task }: { task: WorkspacePlanTask }): React.JSX.Element {
  return (
    <article className="plan-task-card">
      <div className="plan-task-title"><span><strong>{task.task_id}</strong><h3>{task.title}</h3></span><Badge tone={tierTone(task.tier)}>{capitalize(task.tier)} risk</Badge></div>
      <dl><div><dt>Changes</dt><dd>{task.scope.join(", ") || "No files"}</dd></div><div><dt>Reads</dt><dd>{task.read_only_scope.join(", ") || "No additional files"}</dd></div><div><dt>After</dt><dd>{task.depends_on.join(", ") || "Can start immediately"}</dd></div><div><dt>Done when</dt><dd>{task.acceptance_criterion}</dd></div></dl>
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
  return { taskId: "", title: "", files: "", readOnlyFiles: "", dependencies: "", acceptance: "", checks: "", groupId: "G-new", groupMode: "sequence" };
}

function amendmentFromTask(task: WorkspacePlanTask, plan: WorkspacePlanReview | null): AmendmentDraft {
  const group = plan?.execution_groups.find((entry) => entry.task_ids.includes(task.task_id));
  return { taskId: task.task_id, title: task.title, files: task.scope.join("\n"), readOnlyFiles: task.read_only_scope.join("\n"), dependencies: task.depends_on.join(", "), acceptance: task.acceptance_criterion, checks: task.required_tests.join("\n"), groupId: group?.group_id ?? "G-edit", groupMode: group?.mode ?? "sequence" };
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
    ...(existing?.deterministic_validity_check ? { deterministic_validity_check: existing.deterministic_validity_check } : {}),
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
  return [
    { key: "scoped", label: "Ready", status: task.lease_files.length > 0 || task.state !== "planned" ? "complete" : "active" },
    { key: "running", label: "Working", status: failure ? "failed" : task.state === "paused" ? "waiting" : task.state === "running" ? "active" : ["submitted", "accepted", "verified"].includes(task.state) ? "complete" : "waiting" },
    { key: "scope", label: "Scope", status: task.state === "rejected" ? "failed" : task.patch.verdict === "accept" || task.state === "verified" ? "complete" : task.patch.submitted ? "active" : "waiting" },
    { key: "verified", label: "Verified", status: integrationFailure !== null || task.integration === "blocked" || task.integration === "failed" ? "failed" : task.state === "verified" || task.integration === "passed" ? "complete" : task.integration === "queued" ? "active" : "waiting" }
  ];
}

function phaseDetail(task: TaskProjection, phase: string): string {
  if (phase === "scoped") return `${task.lease_files.length} files are inside this task's working boundary`;
  if (phase === "running") return task.state === "running" ? "The worker is active" : "The worker is not active";
  if (phase === "scope") return task.patch.reason ?? "No scope-check result recorded yet";
  return task.integration === "passed" ? "Project checks passed; ready for explicit adoption" : "Not verified against the project yet";
}

function eventDescription(event: HivemindEvent): string {
  const subject = event.task_id ? `${event.task_id} ` : "";
  const labels: Record<string, string> = {
    "task.created": "was added to the plan",
    "task.started": "started working",
    "task.completed": "finished its work",
    "task.failed": "stopped unexpectedly",
    "task.paused": "paused for provider capacity",
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
    "patch.accepted": "passed the file-scope checks",
    "patch.rejected": "needs to revise its change",
    "integration.blocked": "Project checks are blocked",
    "integration.low_confidence": "A change has thin test coverage",
    "integration.passed": "Changes passed project checks and are ready to adopt",
    "routing.observed": "A provider run was measured",
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
  if (/quota|429|capacity/iu.test(issue)) return "Paused until provider capacity is available.";
  if (/oracle|coverage/iu.test(issue)) return "Testing is too thin for this change.";
  if (/write[-_ ]intent|scope/iu.test(issue)) return "The worker tried to change a file outside this task.";
  return issue;
}

function integrationLanguage(status: string): { label: string; tone: string } {
  if (status === "blocked") return { label: "Project checks blocked", tone: "danger" };
  if (status === "low-confidence") return { label: "Thin test coverage", tone: "warning" };
  if (status === "failed") return { label: "Checks failed", tone: "danger" };
  if (status === "passed") return { label: "Ready to adopt", tone: "good" };
  if (status === "running" || status === "queued") return { label: "Checking", tone: "live" };
  return { label: "Not verified yet", tone: "neutral" };
}

function plainQualityStatus(status: string): string {
  const labels: Record<string, string> = { "candidate selected": "Candidate ready", "refinement complete": "Refinement ready", drafting: "Drafting", checking: "Checking", reviewing: "Reviewing", skipped: "Skipped", "no candidate": "No candidate" };
  return labels[status] ?? "Recorded";
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

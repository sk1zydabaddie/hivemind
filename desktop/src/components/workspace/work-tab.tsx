import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CirclePause,
  Clock3,
  Cpu,
  FileCode2,
  GitMerge,
  Layers3,
  Network,
  Route,
  Sparkles,
  TerminalSquare
} from "lucide-react";

import {
  leaseRows,
  qualityRunRows,
  taskRows,
  taskStateCounts,
  type BoardProjection,
  type QualityRunProjection,
  type TaskProjection,
  type TaskState
} from "../../lib/projection";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "../ui/tooltip";

interface WorkTabProps {
  projection: BoardProjection;
  onSelectTask: (taskId: string) => void;
}

type PhaseStatus = "complete" | "active" | "waiting" | "failed";

interface TaskPhase {
  key: string;
  label: string;
  status: PhaseStatus;
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
  blocked: { label: "Blocked before merge", tone: "danger" },
  failed: { label: "Worker stopped", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  integrated: { label: "Merged", tone: "good" }
};

export function WorkTab({
  projection,
  onSelectTask
}: WorkTabProps): React.JSX.Element {
  const tasks = taskRows(projection);
  const selected = projection.selectedTaskId
    ? projection.tasks[projection.selectedTaskId] ?? null
    : null;
  const leases = leaseRows(projection);
  const qualityRuns = qualityRunRows(projection);

  return (
    <div className="work-tab">
      <SummaryStrip projection={projection} />
      <div className="work-grid">
        <section className="surface task-surface" aria-labelledby="live-work-title">
          <header className="surface-heading">
            <div>
              <p className="eyebrow">Live workspace</p>
              <h2 id="live-work-title">Work moving through checks</h2>
              <p>
                Every agent stays inside a visible, deterministic path to merge.
              </p>
            </div>
            <div className="event-counter">
              <Activity size={15} aria-hidden="true" />
              <span>{projection.eventCount} events replayed and live</span>
            </div>
          </header>
          <TaskLedger
            tasks={tasks}
            selectedTaskId={projection.selectedTaskId}
            onSelectTask={onSelectTask}
          />
        </section>

        <aside className="inspector-column" aria-label="Selected task details">
          <TaskInspector
            task={selected}
            output={projection.selectedOutput}
          />
          <HeldFiles tasks={tasks} leases={leases} />
        </aside>
      </div>

      <div className="signals-grid">
        <ProviderSignals observations={projection.routingObservations} />
        <QualitySignals runs={qualityRuns} />
        <RecentActivity events={projection.recentEvents} />
      </div>
    </div>
  );
}

function SummaryStrip({
  projection
}: {
  projection: BoardProjection;
}): React.JSX.Element {
  const counts = taskStateCounts(projection);
  const active =
    counts.running + counts.submitted + counts.accepted + counts.paused;
  const attention =
    counts.failed + counts.blocked + counts.rejected + counts.paused;
  const fileCount = leaseRows(projection).length;
  const capacity = quotaLanguage(projection.quota.status);
  const merge = integrationLanguage(projection.integration.status);

  return (
    <section className="summary-strip" aria-label="Current run summary">
      <SummaryMetric
        icon={<Layers3 size={18} />}
        label="Live work"
        value={String(active)}
        detail={`${counts.integrated} merged · ${attention} need attention`}
        tone={attention > 0 ? "warning" : active > 0 ? "live" : "neutral"}
      />
      <SummaryMetric
        icon={<FileCode2 size={18} />}
        label="Files being edited"
        value={String(fileCount)}
        detail={
          fileCount === 0
            ? "No files currently held"
            : `Across ${new Set(Object.values(projection.activeLeases)).size} tasks`
        }
        tone={fileCount > 0 ? "live" : "neutral"}
      />
      <SummaryMetric
        icon={<Cpu size={18} />}
        label="Provider capacity"
        value={capacity.label}
        detail={
          projection.quota.provider
            ? `${projection.quota.provider} reported this state`
            : "No capacity warning reported"
        }
        tone={capacity.tone}
      />
      <SummaryMetric
        icon={<GitMerge size={18} />}
        label="Merge readiness"
        value={merge.label}
        detail={
          projection.integration.report ??
          `${projection.integration.applied.length} tasks merged`
        }
        tone={merge.tone}
      />
    </section>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: string;
}): React.JSX.Element {
  return (
    <div className={`summary-metric tone-${tone}`}>
      <span className="summary-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <span className="summary-label">{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function TaskLedger({
  tasks,
  selectedTaskId,
  onSelectTask
}: {
  tasks: TaskProjection[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  if (tasks.length === 0) {
    return (
      <div className="intentional-empty task-empty">
        <Network size={26} aria-hidden="true" />
        <strong>No work is moving yet</strong>
        <span>
          When a plan creates tasks, their progress will appear here immediately.
        </span>
      </div>
    );
  }

  const groups = new Map<string, TaskProjection[]>();
  for (const task of tasks) {
    const group = task.execution_group ?? "ungrouped";
    groups.set(group, [...(groups.get(group) ?? []), task]);
  }

  return (
    <ScrollArea className="task-ledger-scroll">
      <div className="task-ledger">
        {Array.from(groups.entries()).map(([groupId, groupTasks]) => (
          <TaskGroup
            key={groupId}
            groupId={groupId}
            tasks={groupTasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function TaskGroup({
  groupId,
  tasks,
  selectedTaskId,
  onSelectTask
}: {
  groupId: string;
  tasks: TaskProjection[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const explicitMode = tasks.find((task) => task.group_mode)?.group_mode;
  const mode =
    explicitMode ??
    (tasks.length > 1 && groupId !== "ungrouped" ? "parallel" : "sequence");
  const activeCount = tasks.filter((task) => task.state === "running").length;
  const groupLabel =
    groupId === "ungrouped" ? "Independent work" : `Execution set ${groupId}`;
  const modeLabel =
    mode === "parallel"
      ? `${tasks.length} at once`
      : tasks.length > 1
        ? `${tasks.length} in order`
        : "one task";

  return (
    <section className={`task-group mode-${mode}`}>
      <header className="task-group-heading">
        <div>
          <span>{groupLabel}</span>
          <strong>{modeLabel}</strong>
        </div>
        {activeCount > 0 ? (
          <Badge tone="live">{activeCount} working now</Badge>
        ) : null}
      </header>
      <div className="task-lanes">
        {tasks.map((task) => (
          <TaskLane
            key={task.task_id}
            task={task}
            selected={task.task_id === selectedTaskId}
            onSelect={() => onSelectTask(task.task_id)}
          />
        ))}
      </div>
    </section>
  );
}

function TaskLane({
  task,
  selected,
  onSelect
}: {
  task: TaskProjection;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const phases = phasesFor(task);
  const language = stateLanguage[task.state];

  return (
    <button
      type="button"
      className={`task-lane state-${task.state}${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="task-lane-head">
        <span className="task-identity">
          <strong>{task.task_id}</strong>
          <span>{task.title}</span>
        </span>
        <Badge tone={language.tone}>{language.label}</Badge>
      </span>
      <span className="phase-rail" aria-label={`${task.task_id} progress`}>
        {phases.map((phase, index) => (
          <Tooltip key={phase.key}>
            <TooltipTrigger asChild>
              <span
                className={`phase phase-${phase.status}`}
                data-phase={phase.key}
              >
                {index > 0 ? <span className="phase-line" /> : null}
                <span className="phase-node">
                  {phase.status === "complete" ? (
                    <Check size={11} />
                  ) : phase.status === "failed" ? (
                    <AlertTriangle size={11} />
                  ) : null}
                </span>
                <span className="phase-label">{phase.label}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{phaseDetail(task, phase.key)}</TooltipContent>
          </Tooltip>
        ))}
      </span>
      <span className="task-lane-foot">
        <span>
          <Bot size={13} aria-hidden="true" />
          {task.agent ?? "Unassigned"}
        </span>
        <span>
          <FileCode2 size={13} aria-hidden="true" />
          {task.lease_files.length} files
        </span>
        {task.depends_on.length > 0 ? (
          <span>
            <ArrowRight size={13} aria-hidden="true" />
            after {task.depends_on.join(", ")}
          </span>
        ) : null}
      </span>
      {task.issue ? <span className="task-issue">{task.issue}</span> : null}
    </button>
  );
}

function TaskInspector({
  task,
  output
}: {
  task: TaskProjection | null;
  output: BoardProjection["selectedOutput"];
}): React.JSX.Element {
  return (
    <section className="surface inspector-surface">
      <header className="surface-heading compact-heading">
        <div>
          <p className="eyebrow">Agent monitor</p>
          <h2>{task ? task.task_id : "Choose a task"}</h2>
        </div>
        {task ? (
          <Badge tone={stateLanguage[task.state].tone}>
            {stateLanguage[task.state].label}
          </Badge>
        ) : null}
      </header>
      {!task ? (
        <div className="intentional-empty inspector-empty">
          <TerminalSquare size={24} aria-hidden="true" />
          <strong>Open a task lane</strong>
          <span>
            Its current worker, check progress, and live output will appear here.
          </span>
        </div>
      ) : (
        <>
          <dl className="task-facts">
            <div>
              <dt>Worker</dt>
              <dd>{task.agent ?? "Not assigned"}</dd>
            </div>
            <div>
              <dt>Change</dt>
              <dd>
                {task.patch.verdict ??
                  (task.patch.submitted ? "Awaiting checks" : "Not submitted")}
              </dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{task.lease_files.length} held</dd>
            </div>
            <div>
              <dt>Merge</dt>
              <dd>{task.integration}</dd>
            </div>
          </dl>
          <div className="output-header">
            <span>
              <TerminalSquare size={14} aria-hidden="true" />
              Live worker output
            </span>
            <small>{output.length} records</small>
          </div>
          <ScrollArea className="output-scroll">
            <pre className="task-output" aria-live="polite">
              {output.length > 0
                ? output
                    .map(
                      (record) =>
                        `[${formatClock(record.ts)}] ${record.stream}  ${record.text}`
                      )
                    .join("\n")
                : "The worker has not emitted output for this task yet."}
            </pre>
          </ScrollArea>
          {task.issue ? (
            <div className="inspector-note">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{task.issue}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function HeldFiles({
  tasks,
  leases
}: {
  tasks: TaskProjection[];
  leases: Array<{ filePath: string; taskId: string }>;
}): React.JSX.Element {
  return (
    <section className="surface held-files-surface">
      <header className="surface-heading compact-heading">
        <div>
          <p className="eyebrow">Resource tethers</p>
          <h2>Files being edited</h2>
        </div>
        <Badge tone={leases.length > 0 ? "warning" : "neutral"}>
          {leases.length}
        </Badge>
      </header>
      {leases.length === 0 ? (
        <div className="inline-empty">
          No files are held. New work can claim its own isolated scope.
        </div>
      ) : (
        <div className="held-file-list">
          {leases.slice(0, 8).map((lease) => (
            <div className="held-file" key={lease.filePath}>
              <span className="tether-dot" aria-hidden="true" />
              <code>{lease.filePath}</code>
              <strong>{lease.taskId}</strong>
            </div>
          ))}
          {leases.length > 8 ? (
            <small>{leases.length - 8} more files in active scopes</small>
          ) : null}
        </div>
      )}
      <div className="held-files-footer">
        {tasks.filter((task) => task.lease_files.length > 0).length} tasks hold
        isolated file scopes
      </div>
    </section>
  );
}

function ProviderSignals({
  observations
}: {
  observations: BoardProjection["routingObservations"];
}): React.JSX.Element {
  return (
    <section className="surface signal-surface">
      <header className="signal-heading">
        <Route size={17} aria-hidden="true" />
        <div>
          <p className="eyebrow">Provider evidence</p>
          <h2>Recent routing signals</h2>
        </div>
      </header>
      {observations.length === 0 ? (
        <div className="inline-empty">
          Provider performance will appear after a worker run is measured.
        </div>
      ) : (
        <div className="signal-list">
          {observations.slice(0, 4).map((observation) => (
            <div
              className="signal-row"
              key={`${observation.task_id}-${observation.ts}`}
            >
              <span>
                <strong>{observation.provider}</strong>
                <small>
                  {observation.task_id} · {humanize(observation.routing_task_type)}
                </small>
              </span>
              <span className="signal-value">
                {formatTokens(observation.effective_tokens)}
                <small>{observation.accounting_source ?? "metered"}</small>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function QualitySignals({
  runs
}: {
  runs: QualityRunProjection[];
}): React.JSX.Element {
  return (
    <section className="surface signal-surface">
      <header className="signal-heading">
        <Sparkles size={17} aria-hidden="true" />
        <div>
          <p className="eyebrow">Candidate work</p>
          <h2>Quality runs</h2>
        </div>
      </header>
      {runs.length === 0 ? (
        <div className="inline-empty">
          Independent draft comparisons will be summarized here.
        </div>
      ) : (
        <div className="signal-list">
          {runs.slice(0, 4).map((run) => (
            <div className="signal-row quality-row" key={run.quality_run_id}>
              <span>
                <strong>{run.task_id}</strong>
                <small>{run.strategy ? humanize(run.strategy) : "quality run"}</small>
              </span>
              <span className="quality-progress">
                <span>{run.drafts_verified}/{run.drafts_started} checked</span>
                <Badge tone={qualityTone(run.status)}>
                  {humanize(run.status)}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentActivity({
  events
}: {
  events: BoardProjection["recentEvents"];
}): React.JSX.Element {
  return (
    <section className="surface signal-surface">
      <header className="signal-heading">
        <Clock3 size={17} aria-hidden="true" />
        <div>
          <p className="eyebrow">Durable trail</p>
          <h2>Recent activity</h2>
        </div>
      </header>
      {events.length === 0 ? (
        <div className="inline-empty">
          The project history will replay here when connected.
        </div>
      ) : (
        <div className="signal-list">
          {events.slice(0, 5).map((event, index) => (
            <div className="signal-row event-row" key={`${event.ts}-${index}`}>
              <span>
                <strong>{eventLanguage(event.type)}</strong>
                <small>{event.task_id ?? "Workspace"}</small>
              </span>
              <code>{formatClock(event.ts)}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function phasesFor(task: TaskProjection): TaskPhase[] {
  const failure = ["failed", "blocked", "rejected", "cancelled"].includes(
    task.state
  );
  const paused = task.state === "paused";
  return [
    {
      key: "scoped",
      label: "Ready",
      status:
        task.lease_files.length > 0 || task.state !== "planned"
          ? "complete"
          : "active"
    },
    {
      key: "running",
      label: "Working",
      status: failure
        ? "failed"
        : paused
          ? "waiting"
          : task.state === "running"
            ? "active"
            : ["submitted", "accepted", "integrated"].includes(task.state)
              ? "complete"
              : "waiting"
    },
    {
      key: "verified",
      label: "Checked",
      status:
        task.state === "rejected"
          ? "failed"
          : task.patch.verdict === "accept" || task.state === "integrated"
            ? "complete"
            : task.patch.submitted
              ? "active"
              : "waiting"
    },
    {
      key: "integrated",
      label: "Merged",
      status:
        task.integration === "blocked" || task.integration === "failed"
          ? "failed"
          : task.state === "integrated" || task.integration === "passed"
            ? "complete"
            : task.integration === "queued"
              ? "active"
              : "waiting"
    }
  ];
}

function phaseDetail(task: TaskProjection, phase: string): string {
  if (phase === "scoped") {
    return `${task.lease_files.length} files are inside this task's current scope`;
  }
  if (phase === "running") {
    return task.worktree
      ? `Worker checkout: ${task.worktree}`
      : "The worker has not started";
  }
  if (phase === "verified") {
    return task.patch.reason ?? "No change verdict recorded yet";
  }
  return task.integration === "passed"
    ? "Merged after checks passed"
    : `Merge state: ${task.integration}`;
}

function quotaLanguage(status: string): {
  label: string;
  tone: string;
} {
  if (status === "exhausted") {
    return { label: "Paused", tone: "danger" };
  }
  if (status === "low") {
    return { label: "Running low", tone: "warning" };
  }
  if (status === "unknown") {
    return { label: "No warning", tone: "neutral" };
  }
  return { label: humanize(status), tone: "good" };
}

function integrationLanguage(status: string): {
  label: string;
  tone: string;
} {
  if (status === "blocked") {
    return { label: "Blocked before merge", tone: "danger" };
  }
  if (status === "low-confidence") {
    return { label: "Thin test coverage", tone: "warning" };
  }
  if (status === "failed") {
    return { label: "Checks failed", tone: "danger" };
  }
  if (status === "passed") {
    return { label: "Checks passed", tone: "good" };
  }
  if (status === "running" || status === "queued") {
    return { label: "Checking", tone: "live" };
  }
  return { label: "Waiting", tone: "neutral" };
}

function eventLanguage(type: string): string {
  const labels: Record<string, string> = {
    "task.created": "Task added",
    "task.started": "Worker started",
    "task.completed": "Worker completed",
    "task.failed": "Worker stopped",
    "task.paused": "Task paused",
    "task.resumed": "Task resumed",
    "task.blocked": "Task needs attention",
    "lease.approved": "Files reserved",
    "lease.released": "Files released",
    "patch.submitted": "Change submitted",
    "patch.accepted": "Change passed scope checks",
    "patch.rejected": "Change needs revision",
    "integration.blocked": "Merge blocked",
    "integration.low_confidence": "Thin test coverage",
    "integration.passed": "Changes merged",
    "routing.observed": "Provider run measured",
    "quality.admission_decided": "Quality run evaluated",
    "quality.draft_started": "Candidate draft started",
    "quality.draft_verified": "Candidate draft checked",
    "quality.selection_decided": "Candidate selected"
  };
  return labels[type] ?? humanize(type.replace(".", " "));
}

function qualityTone(
  status: string
): "neutral" | "live" | "good" | "warning" | "danger" {
  if (status === "candidate selected" || status === "refinement complete") {
    return "good";
  }
  if (status === "skipped" || status === "no candidate") {
    return "warning";
  }
  if (["drafting", "checking", "reviewing"].includes(status)) {
    return "live";
  }
  return "neutral";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
}

function formatTokens(value: number | null): string {
  if (value === null) {
    return "No token total";
  }
  return `${new Intl.NumberFormat().format(value)} tokens`;
}

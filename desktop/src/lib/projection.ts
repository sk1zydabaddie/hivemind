export const TASK_STATES = [
  "planned",
  "running",
  "paused",
  "submitted",
  "accepted",
  "rejected",
  "blocked",
  "failed",
  "cancelled",
  "integrated"
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface HivemindEvent {
  ts: string;
  type: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

export interface EventMessage {
  kind: "event";
  source: "history" | "live";
  seq?: number;
  event: HivemindEvent;
}

export interface OutputRecord {
  ts: string;
  task_id: string;
  tool: string;
  stream: string;
  text: string;
}

export interface OutputMessage {
  kind: "output";
  source: "history" | "live";
  record: OutputRecord;
}

export interface TaskProjection {
  task_id: string;
  title: string;
  state: TaskState;
  agent: string | null;
  worktree: string | null;
  lease_files: string[];
  patch: {
    submitted: boolean;
    analyzed: boolean;
    verdict: string | null;
    reason: string | null;
    changed_files: number | null;
  };
  integration: string;
  issue: string | null;
  last_event: string | null;
  last_event_at: string | null;
  execution_group: string | null;
  group_mode: string | null;
  depends_on: string[];
}

export interface RoutingObservation {
  task_id: string;
  provider: string;
  routing_task_type: string;
  effective_tokens: number | null;
  accounting_source: string | null;
  wall_time_ms: number | null;
  ts: string;
}

export interface QualityRunProjection {
  quality_run_id: string;
  task_id: string;
  strategy: string | null;
  admitted: boolean | null;
  reason: string | null;
  drafts_started: number;
  drafts_verified: number;
  drafts_disposed: number;
  selected_draft_id: string | null;
  status: string;
  last_event_at: string;
}

export interface BoardProjection {
  eventCount: number;
  lastSeq: number;
  tasks: Record<string, TaskProjection>;
  activeLeases: Record<string, string>;
  quota: {
    status: string;
    provider: string | null;
    lastEvent: HivemindEvent | null;
  };
  integration: {
    status: string;
    queue: string[];
    applied: string[];
    tests: string | null;
    report: string | null;
    lastEvent: HivemindEvent | null;
  };
  context: {
    status: string;
    lastEvent: HivemindEvent | null;
  };
  orchestrator: {
    lastEvent: HivemindEvent | null;
  };
  routingObservations: RoutingObservation[];
  qualityRuns: Record<string, QualityRunProjection>;
  recentEvents: HivemindEvent[];
  selectedTaskId: string | null;
  selectedOutput: OutputRecord[];
}

export function createBoardProjection(): BoardProjection {
  return {
    eventCount: 0,
    lastSeq: 0,
    tasks: {},
    activeLeases: {},
    quota: {
      status: "unknown",
      provider: null,
      lastEvent: null
    },
    integration: {
      status: "idle",
      queue: [],
      applied: [],
      tests: null,
      report: null,
      lastEvent: null
    },
    context: {
      status: "ok",
      lastEvent: null
    },
    orchestrator: {
      lastEvent: null
    },
    routingObservations: [],
    qualityRuns: {},
    recentEvents: [],
    selectedTaskId: null,
    selectedOutput: []
  };
}

export function applyEventMessage(
  projection: BoardProjection,
  message: EventMessage | null | undefined
): BoardProjection {
  if (!message || message.kind !== "event" || !message.event) {
    return projection;
  }

  const event = message.event;
  projection.eventCount += 1;
  projection.lastSeq =
    typeof message.seq === "number" ? message.seq : projection.lastSeq;
  projection.recentEvents.unshift(event);
  projection.recentEvents = projection.recentEvents.slice(0, 40);

  const task = event.task_id
    ? ensureTask(projection, event.task_id)
    : null;
  if (task) {
    task.last_event = event.type;
    task.last_event_at = event.ts;
  }

  switch (event.type) {
    case "task.created":
      if (task) {
        task.state = "planned";
        task.title =
          readString(event.data.title) ??
          readString(event.data.goal) ??
          task.title;
        task.execution_group =
          readString(event.data.execution_group) ?? task.execution_group;
        task.group_mode =
          readString(event.data.group_mode) ?? task.group_mode;
        task.depends_on =
          readStringArray(event.data.depends_on) ?? task.depends_on;
      }
      break;
    case "task.assigned":
      if (task) {
        task.agent =
          readString(event.data.agent) ??
          readString(event.data.tool) ??
          task.agent;
      }
      break;
    case "task.started":
    case "task.resumed":
    case "task.redirected":
      if (task) {
        task.state = "running";
        task.agent = readString(event.data.tool) ?? task.agent;
        task.worktree = readString(event.data.worktree) ?? task.worktree;
        task.issue = null;
      }
      break;
    case "task.paused":
      if (task) {
        task.state = "paused";
        task.issue = readString(event.data.reason) ?? "paused";
      }
      break;
    case "task.cancelled":
      if (task) {
        task.state = "cancelled";
        task.issue = readString(event.data.reason) ?? "cancelled";
      }
      break;
    case "task.blocked":
      if (task) {
        task.state = "blocked";
        task.issue = readString(event.data.reason) ?? "blocked";
      }
      break;
    case "task.failed":
      if (task) {
        task.state = "failed";
        task.issue = readString(event.data.reason) ?? "worker stopped";
      }
      break;
    case "task.revision_requested":
      if (task) {
        task.state = "running";
        task.issue = readString(event.data.reason) ?? "revision requested";
      }
      break;
    case "patch.submitted":
      if (task) {
        task.state = "submitted";
        task.patch.submitted = true;
        task.patch.changed_files =
          readNumber(event.data.changed_files) ?? task.patch.changed_files;
      }
      break;
    case "patch.accepted":
      if (task) {
        task.state = "accepted";
        task.patch.analyzed = true;
        task.patch.verdict = "accept";
        task.patch.reason = readString(event.data.reason);
      }
      break;
    case "patch.rejected":
      if (task) {
        task.state = "rejected";
        task.patch.analyzed = true;
        task.patch.verdict = readString(event.data.verdict) ?? "reject";
        task.patch.reason = readString(event.data.reason);
      }
      break;
    case "lease.approved":
      if (task) {
        const granted =
          readStringArray(event.data.granted) ??
          readStringArray(event.data.requested_files) ??
          [];
        task.lease_files = granted;
        for (const filePath of granted) {
          projection.activeLeases[filePath] = event.task_id!;
        }
      }
      break;
    case "lease.released":
      if (task) {
        const released = readStringArray(event.data.released) ?? [];
        task.lease_files = task.lease_files.filter(
          (filePath) => !released.includes(filePath)
        );
        for (const filePath of released) {
          if (projection.activeLeases[filePath] === event.task_id) {
            delete projection.activeLeases[filePath];
          }
        }
      }
      break;
    case "lease.rejected":
      if (task) {
        task.issue = readString(event.data.reason) ?? "file access rejected";
      }
      break;
    case "integration.queued":
      if (task) {
        task.integration = "queued";
      }
      projection.integration.status = "queued";
      projection.integration.queue =
        readStringArray(event.data.queue) ?? projection.integration.queue;
      projection.integration.lastEvent = event;
      break;
    case "integration.started":
      projection.integration.status = "running";
      projection.integration.lastEvent = event;
      break;
    case "integration.passed":
      projection.integration.status = "passed";
      projection.integration.applied =
        readStringArray(event.data.applied) ?? projection.integration.applied;
      projection.integration.tests =
        readString(event.data.tests) ?? projection.integration.tests;
      projection.integration.report =
        readString(event.data.report) ?? projection.integration.report;
      projection.integration.lastEvent = event;
      for (const taskId of projection.integration.applied) {
        const appliedTask = ensureTask(projection, taskId);
        appliedTask.state = "integrated";
        appliedTask.integration = "passed";
      }
      break;
    case "integration.failed":
    case "integration.blocked":
      projection.integration.status =
        event.type === "integration.blocked" ? "blocked" : "failed";
      projection.integration.tests =
        readString(event.data.tests) ?? projection.integration.tests;
      projection.integration.report =
        readString(event.data.report) ?? projection.integration.report;
      projection.integration.lastEvent = event;
      if (task) {
        task.integration = projection.integration.status;
      }
      break;
    case "integration.low_confidence":
      projection.integration.status = "low-confidence";
      projection.integration.report =
        readString(event.data.report) ?? projection.integration.report;
      projection.integration.lastEvent = event;
      break;
    case "quota.low":
    case "quota.exhausted":
      projection.quota.status =
        event.type === "quota.low" ? "low" : "exhausted";
      projection.quota.provider =
        readString(event.data.provider) ??
        readString(event.data.tool) ??
        projection.quota.provider;
      projection.quota.lastEvent = event;
      break;
    case "context.low":
      projection.context.status = "low";
      projection.context.lastEvent = event;
      break;
    case "orchestrator.checkpointed":
    case "orchestrator.resumed":
      projection.orchestrator.lastEvent = event;
      break;
    case "routing.observed":
      if (event.task_id) {
        projection.routingObservations.unshift({
          task_id: event.task_id,
          provider:
            readString(event.data.provider) ??
            readString(event.data.tool) ??
            "unknown provider",
          routing_task_type:
            readString(event.data.routing_task_type) ?? "other",
          effective_tokens: readNumber(event.data.effective_tokens),
          accounting_source: readString(event.data.accounting_source),
          wall_time_ms: readNumber(event.data.wall_time_ms),
          ts: event.ts
        });
        projection.routingObservations =
          projection.routingObservations.slice(0, 12);
      }
      break;
    default:
      if (event.type.startsWith("quality.")) {
        applyQualityEvent(projection, event);
      }
      break;
  }

  return projection;
}

export function selectTask(
  projection: BoardProjection,
  taskId: string | null
): BoardProjection {
  projection.selectedTaskId = taskId;
  projection.selectedOutput = [];
  if (taskId) {
    ensureTask(projection, taskId);
  }
  return projection;
}

export function applyOutputMessage(
  projection: BoardProjection,
  message: OutputMessage | null | undefined
): BoardProjection {
  if (!message || message.kind !== "output" || !message.record) {
    return projection;
  }
  if (projection.selectedTaskId !== message.record.task_id) {
    return projection;
  }
  projection.selectedOutput.push(message.record);
  projection.selectedOutput = projection.selectedOutput.slice(-500);
  return projection;
}

export function taskRows(projection: BoardProjection): TaskProjection[] {
  return Object.values(projection.tasks).sort((left, right) =>
    left.task_id.localeCompare(right.task_id)
  );
}

export function leaseRows(
  projection: BoardProjection
): Array<{ filePath: string; taskId: string }> {
  return Object.entries(projection.activeLeases)
    .map(([filePath, taskId]) => ({ filePath, taskId }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function qualityRunRows(
  projection: BoardProjection
): QualityRunProjection[] {
  return Object.values(projection.qualityRuns).sort((left, right) =>
    right.last_event_at.localeCompare(left.last_event_at)
  );
}

export function taskStateCounts(
  projection: BoardProjection
): Record<TaskState, number> {
  const counts = Object.fromEntries(
    TASK_STATES.map((state) => [state, 0])
  ) as Record<TaskState, number>;
  for (const task of Object.values(projection.tasks)) {
    counts[task.state] += 1;
  }
  return counts;
}

function applyQualityEvent(
  projection: BoardProjection,
  event: HivemindEvent
): void {
  const qualityRunId = readString(event.data.quality_run_id);
  if (!qualityRunId || !event.task_id) {
    return;
  }
  const run =
    projection.qualityRuns[qualityRunId] ??
    (projection.qualityRuns[qualityRunId] = {
      quality_run_id: qualityRunId,
      task_id: event.task_id,
      strategy: null,
      admitted: null,
      reason: null,
      drafts_started: 0,
      drafts_verified: 0,
      drafts_disposed: 0,
      selected_draft_id: null,
      status: "requested",
      last_event_at: event.ts
    });

  run.last_event_at = event.ts;
  run.strategy = readString(event.data.strategy) ?? run.strategy;
  switch (event.type) {
    case "quality.admission_decided":
      run.admitted = readBoolean(event.data.admitted);
      run.reason = readString(event.data.reason);
      run.status = run.admitted ? "admitted" : "skipped";
      break;
    case "quality.draft_started":
      run.drafts_started += 1;
      run.status = "drafting";
      break;
    case "quality.draft_verified":
      run.drafts_verified += 1;
      run.status = "checking";
      break;
    case "quality.draft_disposed":
      run.drafts_disposed += 1;
      run.status = "reviewing";
      break;
    case "quality.selection_decided":
      run.selected_draft_id =
        readString(event.data.selected_draft_id) ?? null;
      run.status = run.selected_draft_id ? "candidate selected" : "no candidate";
      break;
    case "quality.refinement_completed":
      run.selected_draft_id =
        readString(event.data.selected_draft_id) ?? run.selected_draft_id;
      run.status = "refinement complete";
      break;
  }
}

function ensureTask(
  projection: BoardProjection,
  taskId: string
): TaskProjection {
  if (!projection.tasks[taskId]) {
    projection.tasks[taskId] = {
      task_id: taskId,
      title: taskId,
      state: "planned",
      agent: null,
      worktree: null,
      lease_files: [],
      patch: {
        submitted: false,
        analyzed: false,
        verdict: null,
        reason: null,
        changed_files: null
      },
      integration: "not queued",
      issue: null,
      last_event: null,
      last_event_at: null,
      execution_group: null,
      group_mode: null,
      depends_on: []
    };
  }
  return projection.tasks[taskId];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

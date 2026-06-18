export const TASK_STATES = ["planned", "running", "submitted", "accepted", "rejected", "blocked", "integrated"];

export function createBoardProjection() {
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
    recentEvents: [],
    selectedTaskId: null,
    selectedOutput: []
  };
}

export function applyEventMessage(projection, message) {
  if (!message || message.kind !== "event" || !message.event) {
    return projection;
  }

  const event = message.event;
  projection.eventCount += 1;
  projection.lastSeq = typeof message.seq === "number" ? message.seq : projection.lastSeq;
  projection.recentEvents.unshift(event);
  projection.recentEvents = projection.recentEvents.slice(0, 30);

  const task = event.task_id ? ensureTask(projection, event.task_id) : null;
  if (task) {
    task.last_event = event.type;
    task.last_event_at = event.ts;
  }

  switch (event.type) {
    case "task.created":
      if (task) {
        task.state = "planned";
        task.title = readString(event.data.title) ?? readString(event.data.goal) ?? task.title;
      }
      break;
    case "task.assigned":
      if (task) {
        task.agent = readString(event.data.agent) ?? readString(event.data.tool) ?? task.agent;
      }
      break;
    case "task.started":
      if (task) {
        task.state = "running";
        task.agent = readString(event.data.tool) ?? task.agent;
        task.worktree = readString(event.data.worktree) ?? task.worktree;
      }
      break;
    case "task.paused":
    case "task.cancelled":
    case "task.blocked":
      if (task) {
        task.state = "blocked";
        task.issue = readString(event.data.reason) ?? event.type;
      }
      break;
    case "patch.submitted":
      if (task) {
        task.state = "submitted";
        task.patch.submitted = true;
        task.patch.changed_files = readNumber(event.data.changed_files) ?? task.patch.changed_files;
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
        const granted = readStringArray(event.data.granted) ?? readStringArray(event.data.requested_files) ?? [];
        task.lease_files = granted;
        for (const filePath of granted) {
          projection.activeLeases[filePath] = event.task_id;
        }
      }
      break;
    case "lease.released":
      if (task) {
        const released = readStringArray(event.data.released) ?? [];
        task.lease_files = task.lease_files.filter((filePath) => !released.includes(filePath));
        for (const filePath of released) {
          if (projection.activeLeases[filePath] === event.task_id) {
            delete projection.activeLeases[filePath];
          }
        }
      }
      break;
    case "lease.rejected":
      if (task) {
        task.issue = readString(event.data.reason) ?? "lease rejected";
      }
      break;
    case "integration.queued":
      if (task) {
        task.integration = "queued";
      }
      projection.integration.status = "queued";
      projection.integration.queue = readStringArray(event.data.queue) ?? projection.integration.queue;
      projection.integration.lastEvent = event;
      break;
    case "integration.started":
      projection.integration.status = "running";
      projection.integration.lastEvent = event;
      break;
    case "integration.passed":
      projection.integration.status = "passed";
      projection.integration.applied = readStringArray(event.data.applied) ?? projection.integration.applied;
      projection.integration.tests = readString(event.data.tests) ?? projection.integration.tests;
      projection.integration.report = readString(event.data.report) ?? projection.integration.report;
      projection.integration.lastEvent = event;
      for (const taskId of projection.integration.applied) {
        const appliedTask = ensureTask(projection, taskId);
        appliedTask.state = "integrated";
        appliedTask.integration = "passed";
      }
      break;
    case "integration.failed":
      projection.integration.status = "failed";
      projection.integration.tests = readString(event.data.tests) ?? projection.integration.tests;
      projection.integration.report = readString(event.data.report) ?? projection.integration.report;
      projection.integration.lastEvent = event;
      break;
    case "quota.low":
    case "quota.exhausted":
      projection.quota.status = event.type === "quota.low" ? "low" : "exhausted";
      projection.quota.provider = readString(event.data.provider) ?? readString(event.data.tool) ?? projection.quota.provider;
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
    default:
      break;
  }

  return projection;
}

export function selectTask(projection, taskId) {
  projection.selectedTaskId = taskId;
  projection.selectedOutput = [];
  if (taskId) {
    ensureTask(projection, taskId);
  }
  return projection;
}

export function applyOutputMessage(projection, message) {
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

export function taskRows(projection) {
  return Object.values(projection.tasks).sort((left, right) => left.task_id.localeCompare(right.task_id));
}

export function leaseRows(projection) {
  return Object.entries(projection.activeLeases)
    .map(([filePath, taskId]) => ({ filePath, taskId }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

export function taskStateCounts(projection) {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of Object.values(projection.tasks)) {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
  }
  return counts;
}

function ensureTask(projection, taskId) {
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
      last_event_at: null
    };
  }
  return projection.tasks[taskId];
}

function readString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function readStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

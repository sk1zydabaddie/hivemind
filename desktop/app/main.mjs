import {
  applyEventMessage,
  applyOutputMessage,
  createBoardProjection,
  leaseRows,
  selectTask,
  taskRows,
  taskStateCounts
} from "./projection.mjs";
import { createProjectSession, createProjectStreamGuard } from "./project-session.mjs";

const projection = createBoardProjection();
let eventSource = null;
let outputSource = null;
let activeDaemonUrl = null;
const streamGuard = createProjectStreamGuard();

const els = {
  form: document.querySelector("#connection-form"),
  projectPath: document.querySelector("#project-path"),
  connectionState: document.querySelector("#connection-state"),
  taskCounts: document.querySelector("#task-counts"),
  leaseSummary: document.querySelector("#lease-summary"),
  quotaSummary: document.querySelector("#quota-summary"),
  integrationSummary: document.querySelector("#integration-summary"),
  eventCount: document.querySelector("#event-count"),
  taskBoard: document.querySelector("#task-board"),
  leaseList: document.querySelector("#lease-list"),
  agentSummary: document.querySelector("#agent-summary"),
  selectedTaskGates: document.querySelector("#selected-task-gates"),
  taskOutput: document.querySelector("#task-output"),
  recentEvents: document.querySelector("#recent-events")
};

const invoke = window.__TAURI__?.core?.invoke;
const projectSession = createProjectSession({
  selectProject: async (projectPath) => {
    if (typeof invoke !== "function") {
      throw new Error("Project selection requires the native Hivemind desktop shell.");
    }
    return invoke("select_project", { projectPath });
  },
  onSwitchStart: resetForProjectSwitch,
  onConnected: connectVerifiedProject,
  onError: (error) => {
    setConnectionState("connection error", error.message);
    render();
  }
});
const initialProjectPath = new URLSearchParams(window.location.search).get("project") ?? ".";
els.projectPath.value = initialProjectPath;

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void projectSession.switchProject(els.projectPath.value);
});

window.addEventListener("beforeunload", closeStreams);
void projectSession.switchProject(initialProjectPath);
render();

function connectVerifiedProject(connection) {
  activeDaemonUrl = connection.daemon_url;
  els.projectPath.value = connection.project_root;
  setConnectionState(connection.status, connection.project_root);
  connectEventStream();
}

function connectEventStream() {
  if (!activeDaemonUrl) {
    return;
  }
  const isCurrentProject = streamGuard.capture();
  setConnectionState("connecting");
  eventSource = new EventSource(`${activeDaemonUrl}/events/stream`);
  eventSource.onopen = () => {
    if (isCurrentProject()) {
      setConnectionState("streaming");
    }
  };
  eventSource.onerror = () => {
    if (isCurrentProject()) {
      setConnectionState("stream interrupted");
    }
  };
  eventSource.onmessage = (event) => {
    if (!isCurrentProject()) {
      return;
    }
    const message = parseMessage(event.data);
    if (message) {
      applyEventMessage(projection, message);
      openDefaultOutputStream();
      render();
    }
  };
  render();
}

function resetForProjectSwitch() {
  streamGuard.advance();
  closeStreams();
  activeDaemonUrl = null;
  Object.assign(projection, createBoardProjection());
  setConnectionState("selecting project");
  render();
}

function openOutputStream(taskId) {
  if (!activeDaemonUrl) {
    return;
  }
  if (outputSource) {
    outputSource.close();
    outputSource = null;
  }
  selectTask(projection, taskId);
  const isCurrentProject = streamGuard.capture();
  outputSource = new EventSource(`${activeDaemonUrl}/tasks/${encodeURIComponent(taskId)}/output/stream`);
  outputSource.onmessage = (event) => {
    if (!isCurrentProject()) {
      return;
    }
    const message = parseMessage(event.data);
    if (message) {
      applyOutputMessage(projection, message);
      renderAgentMonitor();
    }
  };
  render();
}

function closeStreams() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (outputSource) {
    outputSource.close();
    outputSource = null;
  }
}

function openDefaultOutputStream() {
  if (projection.selectedTaskId || outputSource) {
    return;
  }
  const candidate = taskRows(projection).find((task) => task.state === "running") ?? taskRows(projection)[0];
  if (candidate) {
    openOutputStream(candidate.task_id);
  }
}

function render() {
  renderSummary();
  renderTaskBoard();
  renderLeases();
  renderAgentMonitor();
  renderEvents();
}

function renderSummary() {
  const counts = taskStateCounts(projection);
  els.taskCounts.innerHTML = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => metric(state, String(count)))
    .join("") || metric("tasks", "0");

  els.leaseSummary.innerHTML = metric("active files", String(leaseRows(projection).length));

  const quotaText = projection.quota.lastEvent
    ? `${projection.quota.status}${projection.quota.provider ? ` / ${projection.quota.provider}` : ""}`
    : "no quota events";
  els.quotaSummary.innerHTML = metric("state", quotaText);

  els.integrationSummary.innerHTML = [
    metric("state", projection.integration.status),
    metric("applied", String(projection.integration.applied.length))
  ].join("");
  els.eventCount.textContent = `${projection.eventCount} events replayed/live`;
}

function renderTaskBoard() {
  const rows = taskRows(projection);
  if (rows.length === 0) {
    els.taskBoard.innerHTML = `<div class="empty empty-ledger">No task events have arrived yet.</div>`;
    return;
  }
  const groups = rows.reduce((groupMap, task) => {
    const key = task.execution_group ?? "ungrouped";
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key).push(task);
    return groupMap;
  }, new Map());
  els.taskBoard.innerHTML = Array.from(groups.entries())
    .map(([groupId, tasks]) => groupMarkup(groupId, tasks))
    .join("");

  for (const row of els.taskBoard.querySelectorAll("[data-task-id]")) {
    row.addEventListener("click", () => openOutputStream(row.dataset.taskId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openOutputStream(row.dataset.taskId);
      }
    });
  }
}

function renderLeases() {
  const rows = leaseRows(projection);
  els.leaseList.innerHTML = rows.length === 0
    ? `<div class="empty panel-empty">No active lease approvals in the event stream.</div>`
    : rows.map((row) => `
      <div class="detail-row lease-row">
        <span><i aria-hidden="true"></i>${escapeHtml(row.filePath)}</span>
        <strong>${escapeHtml(row.taskId)}</strong>
      </div>
    `).join("");
}

function renderAgentMonitor() {
  const selected = projection.selectedTaskId ? projection.tasks[projection.selectedTaskId] : null;
  if (!selected) {
    els.agentSummary.innerHTML = `<div class="empty monitor-empty">Select a Swarm Ledger lane to open its live worker stream and gate detail.</div>`;
    els.selectedTaskGates.innerHTML = "";
    els.taskOutput.textContent = "No task selected.\n\nWorker stdout/stderr appears here only after you choose a lane. Output is observable chatter; gates and state remain authoritative in the event trail.";
    return;
  }
  els.agentSummary.innerHTML = `
    <div class="detail-row"><span>task</span><strong>${escapeHtml(selected.task_id)}</strong></div>
    <div class="detail-row"><span>agent</span><strong>${escapeHtml(selected.agent ?? "unknown")}</strong></div>
    <div class="detail-row"><span>state</span><strong>${escapeHtml(selected.state)}</strong></div>
    <div class="detail-row"><span>worktree</span><strong>${escapeHtml(selected.worktree ?? "not reported")}</strong></div>
  `;
  els.selectedTaskGates.innerHTML = gateDetailMarkup(selected);
  els.taskOutput.textContent = projection.selectedOutput
    .map((record) => `[${record.ts}] ${record.stream}: ${record.text}`)
    .join("");
}

function renderEvents() {
  els.recentEvents.innerHTML = projection.recentEvents.length === 0
    ? `<div class="empty panel-empty">No events yet.</div>`
    : projection.recentEvents
        .slice(0, 12)
        .map((event) => `<div class="detail-row event-row"><span>${escapeHtml(event.type)}</span><strong>${escapeHtml(event.task_id ?? "system")}</strong></div>`)
        .join("");
}

function metric(label, value) {
  return `<span class="metric"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></span>`;
}

function swarmPhases(task) {
  return [
    { key: "scoped", label: "Scoped", status: task.lease_files.length > 0 || beyond(task.state, "planned") ? "complete" : "active" },
    { key: "running", label: "Running", status: phaseStatus(task.state, ["running"], ["submitted", "accepted", "integrated"]) },
    { key: "verified", label: "Verified", status: verificationStatus(task) },
    { key: "integrated", label: "Integrated", status: integrationStatus(task) }
  ];
}

function groupMarkup(groupId, tasks) {
  const modes = new Set(tasks.map((task) => task.group_mode).filter(Boolean));
  const explicitMode = modes.values().next().value;
  const mode = explicitMode ?? (tasks.length > 1 && groupId !== "ungrouped" ? "parallel" : "sequence");
  const activeCount = tasks.filter((task) => task.state === "running").length;
  const label = groupId === "ungrouped" ? "Ungrouped" : groupId;
  return `
    <section class="task-group group-${escapeAttr(mode)}">
      <div class="group-heading">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(mode)}${activeCount > 0 ? ` / ${activeCount} active` : ""}</strong>
      </div>
      <div class="group-lanes">
        ${tasks.map((task) => taskLaneMarkup(task)).join("")}
      </div>
    </section>
  `;
}

function taskLaneMarkup(task) {
  const selected = task.task_id === projection.selectedTaskId ? " selected" : "";
  const phases = swarmPhases(task);
  const phaseKey = currentPhaseKey(phases);
  return `
    <article class="task-lane lane-${escapeAttr(task.state)}${selected}" data-task-id="${escapeAttr(task.task_id)}" data-active-phase="${escapeAttr(phaseKey)}" tabindex="0">
      <div class="lane-head">
        <div class="task-main">
          <strong>${escapeHtml(task.task_id)}</strong>
          <span>${escapeHtml(task.title)}</span>
        </div>
        <span class="state state-${escapeAttr(task.state)}">${escapeHtml(task.state)}</span>
      </div>
      <div class="swarm-rail" aria-label="${escapeAttr(task.task_id)} grouped phase state">
        ${phases.map((phase) => phaseMarkup(phase)).join("")}
      </div>
      <div class="lane-foot">
        <span>${escapeHtml(task.agent ?? "unassigned")}</span>
        <span>${task.lease_files.length} leased</span>
        <span>${escapeHtml(task.patch.verdict ?? (task.patch.submitted ? "submitted" : "no patch"))}</span>
        <span>${task.depends_on.length > 0 ? `after ${task.depends_on.join(", ")}` : task.integration}</span>
      </div>
    </article>
  `;
}

function currentPhaseKey(phases) {
  const active = phases.find((phase) => phase.status === "active");
  if (active) {
    return active.key;
  }
  return phases.every((phase) => phase.status === "complete") ? "integrated" : "scoped";
}

function phaseMarkup(phase) {
  return `
    <span class="phase phase-${escapeAttr(phase.status)}" data-phase="${escapeAttr(phase.key)}">
      <span class="phase-track"></span>
      <span class="phase-node" aria-hidden="true"></span>
      <span class="phase-label">${escapeHtml(phase.label)}</span>
    </span>
  `;
}

function phaseStatus(state, activeStates, completeStates) {
  if (state === "rejected" || state === "blocked") {
    return "failed";
  }
  if (completeStates.includes(state)) {
    return "complete";
  }
  if (activeStates.includes(state)) {
    return "active";
  }
  return "pending";
}

function verificationStatus(task) {
  if (task.state === "rejected" || task.state === "blocked") {
    return "failed";
  }
  if (task.patch.verdict === "accept" || task.state === "integrated") {
    return "complete";
  }
  if (task.patch.submitted || task.state === "submitted") {
    return "active";
  }
  return "pending";
}

function integrationStatus(task) {
  if (task.state === "blocked") {
    return "failed";
  }
  if (task.state === "integrated" || task.integration === "passed") {
    return "complete";
  }
  if (task.integration === "queued") {
    return "active";
  }
  return "pending";
}

function beyond(state, baseline) {
  const order = ["planned", "running", "submitted", "accepted", "integrated"];
  return order.indexOf(state) > order.indexOf(baseline);
}

function gateDetailMarkup(task) {
  const gates = [
    ["contract", "task.created", "complete"],
    ["lease", task.lease_files.length > 0 ? `${task.lease_files.length} files held` : "waiting", task.lease_files.length > 0 ? "complete" : "pending"],
    ["run", task.state === "running" ? "active" : task.worktree ? "completed" : "waiting", task.state === "running" ? "active" : task.worktree ? "complete" : "pending"],
    ["submit", task.patch.submitted ? `${task.patch.changed_files ?? "?"} files` : "waiting", task.patch.submitted ? "complete" : "pending"],
    ["analyze", task.patch.verdict ?? "waiting", task.patch.verdict === "reject" || task.patch.verdict === "escalate" ? "failed" : task.patch.analyzed ? "complete" : "pending"],
    ["integrate", task.integration, task.integration === "passed" ? "complete" : task.integration === "queued" ? "active" : "pending"]
  ];
  return `
    <div class="gate-heading">Gate detail</div>
    <div class="gate-grid">
      ${gates.map(([label, value, status]) => `
        <div class="gate-chip gate-${escapeAttr(status)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function setConnectionState(value, detail = "") {
  els.connectionState.textContent = value;
  els.connectionState.dataset.state = value;
  els.connectionState.title = detail;
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

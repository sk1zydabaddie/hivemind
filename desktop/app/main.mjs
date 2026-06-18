import {
  applyEventMessage,
  applyOutputMessage,
  createBoardProjection,
  leaseRows,
  selectTask,
  taskRows,
  taskStateCounts
} from "./projection.mjs";

const projection = createBoardProjection();
let eventSource = null;
let outputSource = null;

const els = {
  form: document.querySelector("#connection-form"),
  daemonUrl: document.querySelector("#daemon-url"),
  connectionState: document.querySelector("#connection-state"),
  taskCounts: document.querySelector("#task-counts"),
  leaseSummary: document.querySelector("#lease-summary"),
  quotaSummary: document.querySelector("#quota-summary"),
  integrationSummary: document.querySelector("#integration-summary"),
  eventCount: document.querySelector("#event-count"),
  taskBoard: document.querySelector("#task-board"),
  leaseList: document.querySelector("#lease-list"),
  agentSummary: document.querySelector("#agent-summary"),
  taskOutput: document.querySelector("#task-output"),
  recentEvents: document.querySelector("#recent-events")
};

const initialDaemonUrl = new URLSearchParams(window.location.search).get("daemon") ?? localStorage.getItem("hivemind.daemonUrl") ?? "http://127.0.0.1:8765";
els.daemonUrl.value = initialDaemonUrl;

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  connect(els.daemonUrl.value);
});

connect(initialDaemonUrl);
render();

function connect(rawDaemonUrl) {
  const daemonUrl = normalizeDaemonUrl(rawDaemonUrl);
  els.daemonUrl.value = daemonUrl;
  localStorage.setItem("hivemind.daemonUrl", daemonUrl);
  closeStreams();
  Object.assign(projection, createBoardProjection());
  setConnectionState("connecting");
  eventSource = new EventSource(`${daemonUrl}/events/stream`);
  eventSource.onopen = () => setConnectionState("streaming");
  eventSource.onerror = () => setConnectionState("stream interrupted");
  eventSource.onmessage = (event) => {
    const message = parseMessage(event.data);
    if (message) {
      applyEventMessage(projection, message);
      render();
    }
  };
  render();
}

function openOutputStream(taskId) {
  if (outputSource) {
    outputSource.close();
    outputSource = null;
  }
  selectTask(projection, taskId);
  const daemonUrl = normalizeDaemonUrl(els.daemonUrl.value);
  outputSource = new EventSource(`${daemonUrl}/tasks/${encodeURIComponent(taskId)}/output/stream`);
  outputSource.onmessage = (event) => {
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
    els.taskBoard.innerHTML = `<div class="empty">No task events have arrived yet.</div>`;
    return;
  }
  els.taskBoard.innerHTML = rows
    .map((task) => {
      const selected = task.task_id === projection.selectedTaskId ? " selected" : "";
      return `
        <article class="task-row${selected}" data-task-id="${escapeAttr(task.task_id)}" tabindex="0">
          <div class="task-main">
            <strong>${escapeHtml(task.task_id)}</strong>
            <span>${escapeHtml(task.title)}</span>
          </div>
          <span class="state state-${escapeAttr(task.state)}">${escapeHtml(task.state)}</span>
          <span>${escapeHtml(task.agent ?? "unassigned")}</span>
          <span>${task.lease_files.length} leased</span>
          <span>${escapeHtml(task.patch.verdict ?? (task.patch.submitted ? "submitted" : "no patch"))}</span>
          <span>${escapeHtml(task.integration)}</span>
        </article>
      `;
    })
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
    ? `<div class="empty">No active lease approvals in the event stream.</div>`
    : rows.map((row) => `<div class="detail-row"><span>${escapeHtml(row.filePath)}</span><strong>${escapeHtml(row.taskId)}</strong></div>`).join("");
}

function renderAgentMonitor() {
  const selected = projection.selectedTaskId ? projection.tasks[projection.selectedTaskId] : null;
  if (!selected) {
    els.agentSummary.innerHTML = `<div class="empty">Select a task to subscribe to its output stream.</div>`;
    els.taskOutput.textContent = "";
    return;
  }
  els.agentSummary.innerHTML = `
    <div class="detail-row"><span>task</span><strong>${escapeHtml(selected.task_id)}</strong></div>
    <div class="detail-row"><span>agent</span><strong>${escapeHtml(selected.agent ?? "unknown")}</strong></div>
    <div class="detail-row"><span>state</span><strong>${escapeHtml(selected.state)}</strong></div>
    <div class="detail-row"><span>worktree</span><strong>${escapeHtml(selected.worktree ?? "not reported")}</strong></div>
  `;
  els.taskOutput.textContent = projection.selectedOutput
    .map((record) => `[${record.ts}] ${record.stream}: ${record.text}`)
    .join("");
}

function renderEvents() {
  els.recentEvents.innerHTML = projection.recentEvents.length === 0
    ? `<div class="empty">No events yet.</div>`
    : projection.recentEvents
        .slice(0, 12)
        .map((event) => `<div class="detail-row"><span>${escapeHtml(event.type)}</span><strong>${escapeHtml(event.task_id ?? "system")}</strong></div>`)
        .join("");
}

function metric(label, value) {
  return `<span class="metric"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></span>`;
}

function setConnectionState(value) {
  els.connectionState.textContent = value;
  els.connectionState.dataset.state = value;
}

function normalizeDaemonUrl(value) {
  return value.trim().replace(/\/+$/u, "") || "http://127.0.0.1:8765";
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

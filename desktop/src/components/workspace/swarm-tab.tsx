import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileCode2,
  GitCompareArrows,
  Layers3,
  MessageSquareText,
  Minus,
  Network,
  Plus,
  RotateCcw,
  SearchCheck,
  Send,
  Sparkles,
  TestTube2,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { plainActionError } from "../../lib/plain-language";
import type { BoardProjection, TaskProjection } from "../../lib/projection";
import {
  buildSwarmTree,
  defaultCollapsedGroups,
  type SwarmGroupNode,
  type SwarmSubagentNode,
  type SwarmTaskNode,
  type SwarmTree
} from "../../lib/swarm-model";
import type { WorkspaceAction, WorkspaceInspection } from "../../lib/workspace-actions";

interface SwarmTabProps {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  actionError: string;
  onSelectTask: (taskId: string) => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}

type Selection =
  | { type: "root"; id: "orchestrator" }
  | { type: "group"; id: string }
  | { type: "task"; id: string }
  | { type: "subagent"; id: string };

type ActionMode = "redirect" | "stop" | "cancel-quality" | null;

export function SwarmTab({
  projection,
  inspection,
  actionError,
  onSelectTask,
  onAction
}: SwarmTabProps): React.JSX.Element {
  const tree = useMemo(
    () => buildSwarmTree(projection, inspection),
    [projection, inspection]
  );
  const suggestedCollapsed = useMemo(
    () => defaultCollapsedGroups(tree.groups),
    [tree.groups]
  );
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Selection>({ type: "root", id: "orchestrator" });
  const [zoom, setZoom] = useState(0.9);
  const movements = useMemo(
    () => new Map(projection.artifactMovements.map((movement) => [movement.task_id, movement])),
    [projection.artifactMovements]
  );

  const collapsed = (groupId: string): boolean =>
    groupOverrides[groupId] ?? suggestedCollapsed.has(groupId);
  const selectTask = (taskId: string): void => {
    setSelection({ type: "task", id: `task:${taskId}` });
    onSelectTask(taskId);
  };
  const adjustZoom = (next: number): void => setZoom(Math.max(0.62, Math.min(1.22, next)));

  return (
    <section className="swarm-tab">
      <header className="swarm-toolbar surface">
        <div>
          <h2>Swarm</h2>
          <span>{tree.task_count} tasks / {tree.subagent_count} supporting agents</span>
        </div>
        <StateLegend />
        <div className="zoom-controls" aria-label="Swarm zoom controls">
          <button className="icon-button" type="button" onClick={() => adjustZoom(zoom - 0.08)} aria-label="Zoom out" title="Zoom out"><Minus size={14} /></button>
          <output>{Math.round(zoom * 100)}%</output>
          <button className="icon-button" type="button" onClick={() => adjustZoom(zoom + 0.08)} aria-label="Zoom in" title="Zoom in"><Plus size={14} /></button>
          <button className="icon-button" type="button" onClick={() => setZoom(0.9)} aria-label="Reset zoom" title="Reset zoom"><RotateCcw size={14} /></button>
        </div>
      </header>

      <div className="swarm-layout">
        <section
          className="swarm-canvas surface"
          aria-label="Agent tree"
          onWheel={(event) => {
            event.preventDefault();
            adjustZoom(zoom + (event.deltaY < 0 ? 0.06 : -0.06));
          }}
        >
          {tree.groups.length === 0 ? (
            <div className="swarm-empty">
              <Network size={30} aria-hidden="true" />
              <strong>The team will appear here</strong>
              <span>Tasks and supporting agents join the tree as the daemon publishes their work.</span>
            </div>
          ) : (
            <div className="swarm-scale" style={{ transform: `scale(${zoom})` }}>
              <SwarmTreeView
                tree={tree}
                selection={selection}
                movements={movements}
                isCollapsed={collapsed}
                onToggleGroup={(groupId) => setGroupOverrides((current) => ({
                  ...current,
                  [groupId]: !(current[groupId] ?? suggestedCollapsed.has(groupId))
                }))}
                onSelectRoot={() => setSelection({ type: "root", id: "orchestrator" })}
                onSelectGroup={(groupId) => setSelection({ type: "group", id: groupId })}
                onSelectTask={selectTask}
                onSelectSubagent={(id) => setSelection({ type: "subagent", id })}
              />
            </div>
          )}
        </section>

        <AgentInspector
          tree={tree}
          selection={selection}
          projection={projection}
          inspection={inspection}
          actionError={actionError}
          onAction={onAction}
        />
      </div>
    </section>
  );
}

function SwarmTreeView({
  tree,
  selection,
  movements,
  isCollapsed,
  onToggleGroup,
  onSelectRoot,
  onSelectGroup,
  onSelectTask,
  onSelectSubagent
}: {
  tree: SwarmTree;
  selection: Selection;
  movements: Map<string, BoardProjection["artifactMovements"][number]>;
  isCollapsed: (groupId: string) => boolean;
  onToggleGroup: (groupId: string) => void;
  onSelectRoot: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectSubagent: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="agent-tree">
      <button
        type="button"
        className={`agent-node root-node tone-${tree.state} ${selection.type === "root" ? "is-selected" : ""}`}
        onClick={onSelectRoot}
      >
        <Network size={19} aria-hidden="true" />
        <span><strong>Orchestrator</strong><small>{tree.task_count} tasks in view</small></span>
      </button>
      <div className="root-connector" aria-hidden="true" />
      <div className="group-branches">
        {tree.groups.map((group) => {
          const closed = isCollapsed(group.id);
          return (
            <div className="group-branch" key={group.id}>
              <div className="group-connector" aria-hidden="true" />
              <div className="group-node-wrap">
                <button
                  type="button"
                  className={`agent-node group-node tone-${group.state} ${selection.type === "group" && selection.id === group.id ? "is-selected" : ""}`}
                  onClick={() => onSelectGroup(group.id)}
                >
                  <Layers3 size={15} aria-hidden="true" />
                  <span><strong>{group.label}</strong><small>{group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}</small></span>
                </button>
                <button
                  type="button"
                  className="collapse-button"
                  onClick={() => onToggleGroup(group.id)}
                  aria-label={`${closed ? "Expand" : "Collapse"} ${group.label}`}
                  title={closed ? "Show tasks" : "Collapse group"}
                >
                  {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {closed ? (
                <div className="collapsed-count">{group.tasks.length} tasks contained</div>
              ) : (
                <div className="task-branches">
                  {group.tasks.map((task) => (
                    <TaskBranch
                      key={task.id}
                      task={task}
                      selected={selection}
                      movement={movements.get(task.task.task_id)}
                      onSelectTask={onSelectTask}
                      onSelectSubagent={onSelectSubagent}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskBranch({
  task,
  selected,
  movement,
  onSelectTask,
  onSelectSubagent
}: {
  task: SwarmTaskNode;
  selected: Selection;
  movement?: BoardProjection["artifactMovements"][number];
  onSelectTask: (taskId: string) => void;
  onSelectSubagent: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className={`task-branch ${movement ? "has-artifact-event" : ""}`}>
      <div className="task-connector" aria-hidden="true">
        {movement ? <span key={movement.id} className={`artifact-marker stage-${movement.stage}`} title={movementLabel(movement.stage)} /> : null}
      </div>
      <button
        type="button"
        className={`agent-node task-node tone-${task.state} ${selected.type === "task" && selected.id === task.id ? "is-selected" : ""}`}
        onClick={() => onSelectTask(task.task.task_id)}
      >
        {task.state === "needs-you" ? <AlertTriangle size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
        <span>
          <strong>{task.task.task_id}</strong>
          <small>{task.task.title}</small>
        </span>
        <i className="node-state-dot" aria-hidden="true" />
      </button>
      {task.subagents.length > 0 ? (
        <div className="subagent-branch">
          {task.subagents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className={`subagent-node tone-${agent.state} ${selected.type === "subagent" && selected.id === agent.id ? "is-selected" : ""}`}
              onClick={() => onSelectSubagent(agent.id)}
            >
              {subagentIcon(agent.kind)}
              <span><strong>{agent.label}</strong><small>{agent.status}</small></span>
              {agent.selected ? <Check size={11} aria-label="Selected candidate" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentInspector({
  tree,
  selection,
  projection,
  inspection,
  actionError,
  onAction
}: {
  tree: SwarmTree;
  selection: Selection;
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  actionError: string;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const selected = resolveSelection(tree, selection);
  const [mode, setMode] = useState<ActionMode>(null);
  const [message, setMessage] = useState("");
  const [feedback, setFeedback] = useState("");
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setMode(null);
    setMessage("");
    setFeedback("");
    setDiff("");
  }, [selection.id, selection.type]);
  useEffect(() => {
    if (selected.type !== "task" || selected.node.task.state !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [selected.type, selected.type === "task" ? selected.node.task.task_id : null, selected.type === "task" ? selected.node.task.state : null]);

  const runAction = async (action: WorkspaceAction, success: string): Promise<void> => {
    setBusy(true);
    setFeedback("");
    try {
      await onAction(action);
      setFeedback(success);
      setMode(null);
      setMessage("");
    } catch (error) {
      setFeedback(plainActionError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="agent-inspector surface" aria-label="Agent inspector">
      <header>
        <div>
          <span>{selectionLabel(selected)}</span>
          <h2>{selectionTitle(selected)}</h2>
        </div>
        <Badge tone={toneBadge(selected.node.state)}>{stateLabel(selected.node.state)}</Badge>
      </header>
      <ScrollArea className="inspector-scroll">
        <div className="inspector-body">
          {selected.type === "task" ? (
            <TaskInspector
              task={selected.node.task}
              output={projection.selectedTaskId === selected.node.task.task_id ? projection.selectedOutput : []}
              now={now}
              onRedirect={() => setMode("redirect")}
              onStop={() => setMode("stop")}
              onSeeChange={async () => {
                setBusy(true);
                setFeedback("");
                try {
                  const result = await onAction<{ diff: string }>({ type: "change.inspect", payload: { task_id: selected.node.task.task_id } });
                  setDiff(result.diff);
                } catch (error) {
                  setFeedback(plainActionError(error));
                } finally {
                  setBusy(false);
                }
              }}
              busy={busy}
            />
          ) : selected.type === "subagent" ? (
            <SubagentInspector agent={selected.node} onCancel={() => setMode("cancel-quality")} />
          ) : selected.type === "group" ? (
            <GroupInspector group={selected.node} />
          ) : (
            <RootInspector tree={tree} inspection={inspection} />
          )}

          {mode && (selected.type === "task" || selected.type === "subagent") ? (
            <ActionComposer
              mode={mode}
              value={message}
              busy={busy}
              onChange={setMessage}
              onClose={() => setMode(null)}
              onSubmit={() => {
                if (selected.type === "task" && mode === "redirect") {
                  void runAction({ type: "task.redirect", payload: { task_id: selected.node.task.task_id, correction: message } }, "Guidance was sent to the worker's safe correction point.");
                } else if (selected.type === "task" && mode === "stop") {
                  void runAction({ type: "task.stop", payload: { task_id: selected.node.task.task_id, reason: message } }, "The task stopped and its owned work was cleaned up.");
                } else if (selected.type === "subagent" && mode === "cancel-quality" && selected.node.quality_run_id) {
                  void runAction({ type: "quality.cancel", payload: { quality_run_id: selected.node.quality_run_id, reason: message } }, "The entire draft run was stopped. Completed evidence remains available.");
                }
              }}
            />
          ) : null}
          {feedback || actionError ? <p className="action-feedback" role="status">{feedback || plainActionError(actionError)}</p> : null}
          {diff ? (
            <section className="change-preview">
              <header><strong>Submitted change</strong><button className="icon-button" type="button" onClick={() => setDiff("")} aria-label="Close change"><X size={13} /></button></header>
              <pre>{diff}</pre>
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function TaskInspector({ task, output, now, onRedirect, onStop, onSeeChange, busy }: {
  task: TaskProjection;
  output: BoardProjection["selectedOutput"];
  now: number;
  onRedirect: () => void;
  onStop: () => void;
  onSeeChange: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <>
      <p className="agent-current-work">{taskWorkLabel(task)}</p>
      <dl className="agent-facts">
        <div><dt>Agent</dt><dd>{task.agent ?? "Not assigned"}</dd></div>
        <div><dt>Running</dt><dd>{formatDuration(task.started_at, task.worker_finished_at, now)}</dd></div>
        <div><dt>Files</dt><dd>{task.lease_files.length || "None yet"}</dd></div>
        <div><dt>Change</dt><dd>{task.patch.changed_files === null ? "Not submitted" : `${task.patch.changed_files} files`}</dd></div>
      </dl>
      <section className="inspector-section">
        <h3>Files being edited</h3>
        {task.lease_files.length > 0 ? <ul>{task.lease_files.map((file) => <li key={file}><FileCode2 size={12} /><code>{file}</code></li>)}</ul> : <p>No files are being edited yet.</p>}
      </section>
      <section className="inspector-section live-output-section">
        <h3>Live output <span>{output.length} records</span></h3>
        <pre>{output.length > 0 ? output.map((record) => `[${formatClock(record.ts)}] ${record.text}`).join("\n") : "Output will appear here while this worker reports progress."}</pre>
      </section>
      <div className="inspector-actions">
        <button className="button-secondary" type="button" disabled={busy} onClick={onRedirect}><MessageSquareText size={14} /> Redirect</button>
        <button className="button-secondary" type="button" disabled={busy} onClick={onStop}><CircleStop size={14} /> Stop</button>
        <button className="button-secondary" type="button" disabled={busy} onClick={onSeeChange}><GitCompareArrows size={14} /> See change</button>
      </div>
    </>
  );
}

function SubagentInspector({ agent, onCancel }: { agent: SwarmSubagentNode; onCancel: () => void }): React.JSX.Element {
  return (
    <>
      <p className="agent-current-work">{agent.detail ?? agent.status}</p>
      <dl className="agent-facts">
        <div><dt>Parent task</dt><dd>{agent.task_id}</dd></div>
        <div><dt>Agent</dt><dd>{agent.tool ?? plainSubagentKind(agent.kind)}</dd></div>
        <div><dt>Status</dt><dd>{agent.status}</dd></div>
        <div><dt>Files</dt><dd>{agent.files.length || "Evidence only"}</dd></div>
      </dl>
      {agent.files.length > 0 ? <section className="inspector-section"><h3>Candidate files</h3><ul>{agent.files.map((file) => <li key={file}><FileCode2 size={12} /><code>{file}</code></li>)}</ul></section> : null}
      <section className="inspector-section helper-boundary">
        <h3>Steering</h3>
        <p>This supporting agent cannot be guided individually. Its evidence stays attached to the parent task.</p>
      </section>
      {agent.quality_run_id ? (
        <button className="button-secondary danger-button" type="button" onClick={onCancel}><CircleStop size={14} /> Stop the entire draft run</button>
      ) : null}
    </>
  );
}

function GroupInspector({ group }: { group: SwarmGroupNode }): React.JSX.Element {
  return <><p className="agent-current-work">{group.mode === "parallel" ? "These tasks may work at the same time when their real run events overlap." : "These tasks follow their dependency order."}</p><dl className="agent-facts"><div><dt>Tasks</dt><dd>{group.tasks.length}</dd></div><div><dt>Working now</dt><dd>{group.tasks.filter((task) => task.task.state === "running").length}</dd></div><div><dt>Finished</dt><dd>{group.tasks.filter((task) => task.task.state === "integrated").length}</dd></div><div><dt>Needs you</dt><dd>{group.tasks.filter((task) => task.state === "needs-you").length}</dd></div></dl></>;
}

function RootInspector({ tree, inspection }: { tree: SwarmTree; inspection: WorkspaceInspection | null }): React.JSX.Element {
  return <><p className="agent-current-work">{inspection?.manager_session?.status === "active" ? "Coordinating the next project step from durable state." : "Watching the project and waiting for the next scheduled step."}</p><dl className="agent-facts"><div><dt>Work groups</dt><dd>{tree.groups.length}</dd></div><div><dt>Tasks</dt><dd>{tree.task_count}</dd></div><div><dt>Supporting agents</dt><dd>{tree.subagent_count}</dd></div><div><dt>Session</dt><dd>{inspection?.manager_session?.status ?? "Not running"}</dd></div></dl></>;
}

function ActionComposer({ mode, value, busy, onChange, onClose, onSubmit }: { mode: Exclude<ActionMode, null>; value: string; busy: boolean; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }): React.JSX.Element {
  const labels = mode === "redirect"
    ? { title: "Guide at the safe boundary", note: "This does not approve a file change.", submit: "Send guidance" }
    : mode === "stop"
      ? { title: "Stop this task", note: "The task keeps ownership until cleanup is proven complete.", submit: "Stop task" }
      : { title: "Stop this draft run", note: "Individual drafts are not steerable.", submit: "Stop run" };
  return <section className="inspector-composer"><header><strong>{labels.title}</strong><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={13} /></button></header><textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder="Give a clear reason or correction..." rows={4} /><footer><span>{labels.note}</span><button className="button-primary" type="button" disabled={busy || value.trim() === ""} onClick={onSubmit}>{mode === "redirect" ? <Send size={13} /> : <CircleStop size={13} />}{labels.submit}</button></footer></section>;
}

function StateLegend(): React.JSX.Element {
  return <div className="swarm-legend" aria-label="Agent state legend">{(["healthy", "needs-you", "waiting", "done"] as const).map((state) => <span key={state}><i className={`legend-dot tone-${state}`} />{state === "needs-you" ? "Needs you" : capitalize(state)}</span>)}</div>;
}

function resolveSelection(tree: SwarmTree, selection: Selection):
  | { type: "root"; node: SwarmTree }
  | { type: "group"; node: SwarmGroupNode }
  | { type: "task"; node: SwarmTaskNode }
  | { type: "subagent"; node: SwarmSubagentNode } {
  if (selection.type === "group") {
    const group = tree.groups.find((candidate) => candidate.id === selection.id);
    if (group) return { type: "group", node: group };
  }
  for (const group of tree.groups) {
    if (selection.type === "task") {
      const task = group.tasks.find((candidate) => candidate.id === selection.id);
      if (task) return { type: "task", node: task };
    }
    if (selection.type === "subagent") {
      for (const task of group.tasks) {
        const agent = task.subagents.find((candidate) => candidate.id === selection.id);
        if (agent) return { type: "subagent", node: agent };
      }
    }
  }
  return { type: "root", node: tree };
}

function selectionLabel(selected: ReturnType<typeof resolveSelection>): string {
  if (selected.type === "root") return "Project coordinator";
  if (selected.type === "group") return "Work group";
  if (selected.type === "task") return "Task worker";
  return "Supporting agent";
}

function selectionTitle(selected: ReturnType<typeof resolveSelection>): string {
  if (selected.type === "root") return "Orchestrator";
  if (selected.type === "group") return selected.node.label;
  if (selected.type === "task") return `${selected.node.task.task_id} ${selected.node.task.title}`;
  return selected.node.label;
}

function taskWorkLabel(task: TaskProjection): string {
  const labels: Record<string, string> = { planned: "Waiting for its dependencies and turn.", running: "Working inside the approved file boundary.", paused: "Paused until provider capacity returns.", submitted: "Change submitted for checks.", accepted: "Scope checks passed; waiting for merge checks.", rejected: "The submitted change needs a revision.", blocked: "This task cannot continue without attention.", failed: "The worker stopped before completing the task.", cancelled: "This task was stopped.", integrated: "The checked change has been merged." };
  return labels[task.state] ?? "Current state published by the daemon.";
}

function stateLabel(state: SwarmTree["state"]): string { return state === "needs-you" ? "Needs you" : capitalize(state); }
function toneBadge(state: SwarmTree["state"]): "live" | "danger" | "warning" | "good" { return state === "needs-you" ? "danger" : state === "waiting" ? "warning" : state === "done" ? "good" : "live"; }
function movementLabel(stage: string): string { return stage === "checks" ? "Scope checks passed" : stage === "tests" ? "Tests completed" : "Merged"; }
function plainSubagentKind(kind: SwarmSubagentNode["kind"]): string { return kind === "quality-draft" ? "Independent draft" : kind === "characterization" ? "Test writer" : "Scout"; }
function capitalize(value: string): string { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
function formatClock(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function formatDuration(started: string | null, finished: string | null, now: number): string { if (!started) return "Not started"; const start = new Date(started).valueOf(); const end = finished ? new Date(finished).valueOf() : now; if (!Number.isFinite(start) || !Number.isFinite(end)) return "Unknown"; const seconds = Math.max(0, Math.floor((end - start) / 1_000)); const minutes = Math.floor(seconds / 60); return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
function subagentIcon(kind: SwarmSubagentNode["kind"]): React.JSX.Element { if (kind === "scout") return <SearchCheck size={12} aria-hidden="true" />; if (kind === "characterization") return <TestTube2 size={12} aria-hidden="true" />; return <Sparkles size={12} aria-hidden="true" />; }

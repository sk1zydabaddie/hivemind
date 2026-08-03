import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileSearch,
  BadgeCheck,
  History,
  ReceiptText,
  TimerReset
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import type { WorkspaceAction, WorkspaceHistoryRun, WorkspaceInspection } from "../../lib/workspace-actions";

interface DurableTrailEvent {
  ts: string;
  type: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

export function HistoryTab({ inspection, onAction }: { inspection: WorkspaceInspection | null; onAction: <T>(action: WorkspaceAction) => Promise<T> }): React.JSX.Element {
  const [trail, setTrail] = useState<DurableTrailEvent[] | null>(null);
  const [trailError, setTrailError] = useState("");
  const [trailLoading, setTrailLoading] = useState(false);
  const history = inspection?.history;
  const totals = (history?.runs ?? []).reduce((sum, run) => ({
    calls: sum.calls + run.calls,
    tokens: sum.tokens + run.effective_tokens,
    verified: sum.verified + run.verified_tasks.length,
    merged: sum.merged + run.merged_tasks.length,
    stopped: sum.stopped + run.stopped_tasks.length
  }), { calls: 0, tokens: 0, verified: 0, merged: 0, stopped: 0 });

  return (
    <section className="history-tab">
      <header className="history-summary surface">
        <div>
          <h2>History</h2>
          <span>Past project runs, their outcomes, and what they cost.</span>
        </div>
        <div className="history-totals" aria-label="Project history summary">
          <HistoryTotal icon={<History size={15} />} label="Runs" value={history?.runs.length ?? 0} />
          <HistoryTotal icon={<ReceiptText size={15} />} label="Calls" value={totals.calls} />
          <HistoryTotal icon={<BadgeCheck size={15} />} label="Verified" value={totals.verified} />
          <HistoryTotal icon={<CheckCircle2 size={15} />} label="Merged" value={totals.merged} />
          <HistoryTotal icon={<AlertTriangle size={15} />} label="Stopped" value={totals.stopped} />
          <button className="button-secondary trail-button" type="button" disabled={trailLoading} onClick={() => {
            setTrailLoading(true);
            setTrailError("");
            void onAction<DurableTrailEvent[]>({ type: "trail.inspect", payload: {} })
              .then(setTrail)
              .catch((error: unknown) => setTrailError(error instanceof Error ? error.message : String(error)))
              .finally(() => setTrailLoading(false));
          }}><FileSearch size={14} />{trailLoading ? "Opening..." : "Full trail"}</button>
        </div>
      </header>

      <div className="history-layout">
        <section className="surface run-history-panel">
          <header className="section-heading">
            <div><h2>Past runs</h2><span>Newest first / read-only project evidence</span></div>
            <Badge tone={history?.runs.length ? "live" : "neutral"}>{history?.runs.length ?? 0}</Badge>
          </header>
          <ScrollArea className="history-scroll">
            <div className="history-run-list">
              {history?.runs.length ? history.runs.map((run) => <RunCard key={run.session_id} run={run} taskTitles={inspection?.task_titles ?? {}} />) : (
                <div className="history-empty">
                  <span><TimerReset size={25} /></span>
                  <h3>No completed runs yet</h3>
                  <p>Runs will appear here after the project records a manager session. Task outcomes, evidence paths, and spend stay tied to this project.</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </section>

        <aside className="surface spend-history-panel">
          <header className="section-heading">
            <div><h2>Spend</h2><span>Measured use against the configured limits</span></div>
            <ReceiptText size={16} aria-hidden="true" />
          </header>
          <div className="spend-history-body">
            <SpendMeter label="Recorded sessions" value={totals.tokens} ceiling={history?.session_ceiling_tokens ?? 500_000} />
            <dl className="spend-facts">
              <div><dt>Total measured tokens</dt><dd>{formatNumber(totals.tokens)}</dd></div>
              <div><dt>Provider calls</dt><dd>{formatNumber(totals.calls)}</dd></div>
              <div><dt>Per-call stop</dt><dd>{formatNumber(history?.run_ceiling_tokens ?? 150_000)}</dd></div>
              <div><dt>Per-session stop</dt><dd>{formatNumber(history?.session_ceiling_tokens ?? 500_000)}</dd></div>
            </dl>
            <p className="spend-explanation">Provider totals are used when available. The local estimate remains visible in each run so undercounting cannot disappear.</p>
            <div className="history-cost-list">
              {(history?.runs ?? []).slice(0, 5).map((run) => (
                <div key={run.session_id}>
                  <span><strong>{run.spec_id}</strong><small>{formatDateTime(run.started_at)}</small></span>
                  <b>{formatCompact(run.effective_tokens)}</b>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
      {trail !== null || trailError !== "" ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setTrail(null)}>
          <section className="durable-trail-dialog surface" role="dialog" aria-modal="true" aria-label="Full project trail" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><h2>Full project trail</h2><span>Every recorded decision and check, newest last.</span></div>
              <button className="button-secondary" type="button" onClick={() => { setTrail(null); setTrailError(""); }}>Close</button>
            </header>
            {trailError !== "" ? <p className="trail-error">{trailError}</p> : (
              <ScrollArea className="durable-trail-scroll"><ol>{(trail ?? []).map((event, index) => (
                <li key={`${event.ts}-${index}`}>
                  <time>{formatDateTime(event.ts)}</time><strong>{plainEventName(event.type)}</strong><span>{event.task_id ?? "Project"}</span>
                  <details><summary>Details</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>
                </li>
              ))}</ol></ScrollArea>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function RunCard({ run, taskTitles }: { run: WorkspaceHistoryRun; taskTitles: Record<string, string> }): React.JSX.Element {
  const tone = run.outcome === "completed" ? "good" : run.outcome === "active" ? "live" : run.outcome === "paused" ? "warning" : "danger";
  return (
    <article className={`history-run-card run-${run.outcome}`}>
      <header>
        <div className="run-identity">
          <span className="run-state-mark" aria-hidden="true" />
          <div><strong>{run.spec_id}</strong><small>{formatDateTime(run.started_at)}</small></div>
        </div>
        <div className="run-head-facts">
          <span><Clock3 size={13} />{formatDuration(run.duration_ms)}</span>
          <Badge tone={tone}>{plainOutcome(run.outcome)}</Badge>
        </div>
      </header>
      <div className="run-summary-line">
        <p className="run-outcome-detail">{run.outcome_detail}</p>
        <span className="run-autonomy">Interruptions: {run.autonomy_levels.map(plainAutonomyLevel).join(" -> ")}</span>
      </div>
      <div className="run-detail-grid">
        <section>
          <h3><BadgeCheck size={14} />Passed project checks <Badge tone="good">{run.verified_tasks.length}</Badge></h3>
          {run.verified_tasks.length ? <ul>{run.verified_tasks.map((taskId) => <li key={taskId} title={taskId}><CheckCircle2 size={12} /><span>{taskTitles[taskId] ?? taskId}<small>{taskId}</small></span></li>)}</ul> : <p>No task passed the project checks in this run.</p>}
        </section>
        <section>
          <h3><CheckCircle2 size={14} />Merged <Badge tone="good">{run.merged_tasks.length}</Badge></h3>
          {run.merged_tasks.length ? <ul>{run.merged_tasks.map((taskId) => <li key={taskId} title={taskId}><CheckCircle2 size={12} /><span>{taskTitles[taskId] ?? taskId}<small>{taskId}</small></span></li>)}</ul> : <p>No verified change was merged into the project branch.</p>}
        </section>
        <section>
          <h3><AlertTriangle size={14} />Stopped <Badge tone={run.stopped_tasks.length ? "danger" : "neutral"}>{run.stopped_tasks.length}</Badge></h3>
          {run.stopped_tasks.length ? <ul>{run.stopped_tasks.map((task) => <li key={task.task_id}><span title={task.task_id}><strong>{taskTitles[task.task_id] ?? task.task_id}</strong><small>{task.task_id} / {plainStoppedState(task.state)}</small></span><p>{task.reason}</p></li>)}</ul> : <p>No stopped tasks in this run.</p>}
        </section>
        <section className="run-spend-section">
          <h3><ReceiptText size={14} />Spend</h3>
          <dl>
            <div><dt>Calls</dt><dd>{run.calls}</dd></div>
            <div><dt>Counted</dt><dd>{formatCompact(run.effective_tokens)}</dd></div>
            <div><dt>Provider</dt><dd>{formatCompact(run.provider_reported_tokens)}</dd></div>
            <div><dt>Local estimate</dt><dd>{formatCompact(run.self_measured_tokens)}</dd></div>
          </dl>
        </section>
      </div>
      <details className="run-evidence">
        <summary><FileSearch size={13} />Evidence paths</summary>
        <ul>{run.evidence_paths.map((evidencePath) => <li key={evidencePath}><code>{evidencePath}</code></li>)}</ul>
      </details>
    </article>
  );
}

function HistoryTotal({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }): React.JSX.Element {
  return <div><span>{icon}</span><strong>{formatNumber(value)}</strong><small>{label}</small></div>;
}

function SpendMeter({ label, value, ceiling }: { label: string; value: number; ceiling: number }): React.JSX.Element {
  const percent = ceiling <= 0 ? 100 : Math.min(100, (value / ceiling) * 100);
  return (
    <div className="history-spend-meter">
      <header><span>{label}</span><strong>{formatCompact(value)} / {formatCompact(ceiling)}</strong></header>
      <div><i style={{ width: `${percent}%` }} /></div>
      <small>{Math.round(percent)}% of one default session ceiling across the history shown</small>
    </div>
  );
}

function plainOutcome(outcome: WorkspaceHistoryRun["outcome"]): string {
  return ({ active: "Active", completed: "Complete", needs_attention: "Needs attention", paused: "Waiting" })[outcome];
}

function plainStoppedState(state: WorkspaceHistoryRun["stopped_tasks"][number]["state"]): string {
  return ({ failed: "Worker stopped", blocked: "Could not continue", cancelled: "Stopped by a person", paused: "Waiting for capacity" })[state];
}

function plainAutonomyLevel(level: WorkspaceHistoryRun["autonomy_levels"][number]): string {
  return ({ auto: "Auto", review_plan: "Review plan", review_everything: "Review everything" })[level];
}

function plainEventName(type: string): string {
  return type.replaceAll("_", " ").replaceAll(".", " / ");
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1 sec";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} sec`;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes} min`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

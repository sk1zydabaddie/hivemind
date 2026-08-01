import {
  BookOpenCheck,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  GitBranch,
  Route,
  ShieldCheck
} from "lucide-react";

import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import type {
  WorkspaceCharacterization,
  WorkspaceInspection,
  WorkspaceMemoryProposal,
  WorkspaceRoutingChange,
  WorkspaceRoutingProvider,
  WorkspaceRoutingTaskType
} from "../../lib/workspace-actions";

export function MemoryTab({ inspection }: { inspection: WorkspaceInspection | null }): React.JSX.Element {
  const memory = inspection?.memory;
  const pendingCount = (memory?.pending_lessons.length ?? 0) +
    (memory?.routing_changes.length ?? 0) +
    (memory?.draft_tests.length ?? 0);

  return (
    <section className="memory-tab">
      <header className="memory-summary surface">
        <div>
          <h2>Memory</h2>
          <span>Review project evidence without turning it into a decision automatically.</span>
        </div>
        <div className="memory-summary-counts" aria-label="Memory summary">
          <SummaryCount label="Waiting for review" value={pendingCount} tone={pendingCount > 0 ? "warning" : "neutral"} />
          <SummaryCount label="In force" value={memory?.canon.length ?? 0} tone="good" />
          <SummaryCount label="Draft tests" value={memory?.draft_tests.length ?? 0} tone="live" />
        </div>
      </header>

      <div className="memory-layout">
        <section className="memory-review surface">
          <header className="section-heading">
            <div><h2>Later</h2><span>Evidence waiting for a deliberate review</span></div>
            <Badge tone={pendingCount > 0 ? "warning" : "neutral"}>{pendingCount}</Badge>
          </header>
          <div className="memory-review-grid">
            <ReviewColumn
              icon={<BookOpenCheck size={15} />}
              title="Things to remember"
              count={memory?.pending_lessons.length ?? 0}
              empty="Nothing is waiting. Useful lessons from future runs will appear here with their evidence."
            >
              {memory?.pending_lessons.map((proposal) => <LessonCard key={proposal.proposal_id} proposal={proposal} />)}
            </ReviewColumn>
            <ReviewColumn
              icon={<Route size={15} />}
              title="Routing changes"
              count={memory?.routing_changes.length ?? 0}
              empty="No measured routing change is waiting for review."
            >
              {memory?.routing_changes.map((proposal) => <RoutingCard key={proposal.proposal_id} proposal={proposal} />)}
            </ReviewColumn>
            <ReviewColumn
              icon={<FlaskConical size={15} />}
              title="Draft tests"
              count={memory?.draft_tests.length ?? 0}
              empty="No draft test has been generated for review."
            >
              {memory?.draft_tests.map((candidate) => <DraftTestCard key={candidate.candidate_id} candidate={candidate} />)}
            </ReviewColumn>
          </div>
        </section>

        <aside className="memory-active">
          <section className="surface active-memory-panel">
            <header className="section-heading">
              <div><h2>Remembered</h2><span>Reviewed guidance currently used by planning</span></div>
              <ShieldCheck size={16} aria-hidden="true" />
            </header>
            <ScrollArea className="memory-side-scroll">
              <div className="memory-side-list">
                {memory?.canon.length ? memory.canon.map((entry) => (
                  <article className="canon-card" key={entry.canon_id}>
                    <header><strong>{entry.title}</strong><Badge tone="good">In force</Badge></header>
                    <p>{entry.lesson}</p>
                    <EvidenceList items={entry.evidence} />
                    <small>Reviewed {formatDate(entry.approved_at)}</small>
                  </article>
                )) : (
                  <IntentionalEmpty
                    icon={<BookOpenCheck size={22} />}
                    title="Nothing has been promoted"
                    detail="This project has no reviewed memory yet. Pending items remain evidence until a person reviews them in a terminal."
                  />
                )}
              </div>
            </ScrollArea>
          </section>

          <section className="surface active-memory-panel active-routing-panel">
            <header className="section-heading">
              <div><h2>Active routing</h2><span>Reviewed provider preferences currently in use</span></div>
              <GitBranch size={16} aria-hidden="true" />
            </header>
            <ScrollArea className="memory-side-scroll">
              <div className="memory-side-list">
                {memory?.active_routing.status === "active" ? (
                  <>
                    {memory.active_routing.task_types.map((taskType) => (
                      <RoutingMetrics key={taskType.routing_task_type} taskType={taskType} compact />
                    ))}
                    <p className="active-policy-note">Reviewed policy {memory.active_routing.canon_id}</p>
                  </>
                ) : (
                  <IntentionalEmpty
                    icon={<Route size={22} />}
                    title="Default routing is active"
                    detail={plainRoutingStatus(memory?.active_routing.reason)}
                  />
                )}
              </div>
            </ScrollArea>
          </section>
        </aside>
      </div>
    </section>
  );
}

function SummaryCount({ label, value, tone }: { label: string; value: number; tone: "neutral" | "live" | "good" | "warning" }): React.JSX.Element {
  return <div><strong>{value}</strong><span>{label}</span><i className={`summary-rule tone-${tone}`} /></div>;
}

function ReviewColumn({ icon, title, count, empty, children }: { icon: React.ReactNode; title: string; count: number; empty: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="memory-column">
      <header><span>{icon}</span><strong>{title}</strong><Badge tone={count > 0 ? "warning" : "neutral"}>{count}</Badge></header>
      <ScrollArea className="memory-column-scroll">
        <div className="memory-card-list">
          {count === 0 ? <IntentionalEmpty icon={<CircleDashed size={20} />} title="All clear" detail={empty} /> : children}
        </div>
      </ScrollArea>
    </section>
  );
}

function LessonCard({ proposal }: { proposal: WorkspaceMemoryProposal }): React.JSX.Element {
  return (
    <article className="review-card">
      <header><strong>{proposal.title}</strong><Badge tone="warning">Review</Badge></header>
      <p>{proposal.lesson}</p>
      <EvidenceList items={proposal.evidence} />
      <ReviewHandoff command={proposal.review_command} />
    </article>
  );
}

function RoutingCard({ proposal }: { proposal: WorkspaceRoutingChange }): React.JSX.Element {
  return (
    <article className="review-card routing-review-card">
      <header><strong>{proposal.title}</strong><Badge tone="warning">Review</Badge></header>
      <p>{proposal.lesson}</p>
      {proposal.change_kind === "routing_weights" ? proposal.task_types.map((taskType) => <RoutingMetrics key={taskType.routing_task_type} taskType={taskType} />) : (
        <div className="quality-eligibility">
          <strong>Extra review spending proposed for</strong>
          <div>{proposal.error_prone_task_types.map((taskType) => <Badge key={taskType} tone="warning">{plainTaskType(taskType)}</Badge>)}</div>
        </div>
      )}
      <ReviewHandoff command={proposal.review_command} />
    </article>
  );
}

function RoutingMetrics({ taskType, compact = false }: { taskType: WorkspaceRoutingTaskType; compact?: boolean }): React.JSX.Element {
  return (
    <section className={`routing-metrics ${compact ? "is-compact" : ""}`}>
      <header><strong>{plainTaskType(taskType.routing_task_type)}</strong><span>{taskType.providers.length} providers compared</span></header>
      {taskType.providers.map((provider) => <ProviderMetric key={provider.provider} provider={provider} />)}
    </section>
  );
}

function ProviderMetric({ provider }: { provider: WorkspaceRoutingProvider }): React.JSX.Element {
  return (
    <div className="provider-metric">
      <div><strong>{provider.provider}</strong><b>{provider.weight.toFixed(2)}</b></div>
      <div className="metric-bar" aria-label={`${provider.provider} weight ${provider.weight.toFixed(2)}`}><i style={{ width: `${Math.max(4, Math.min(100, provider.weight * 100))}%` }} /></div>
      <p>{provider.sample_count} samples / {provider.integrated_count} verified / {provider.failed_count} stopped / {provider.revision_count} revisions</p>
      <p>{formatCompact(provider.merged_diff_bytes)} changed bytes / {formatCompact(provider.effective_tokens)} tokens / {provider.cost_source.replaceAll("_", " ")}</p>
      <EvidenceList items={provider.evidence} compact />
    </div>
  );
}

function DraftTestCard({ candidate }: { candidate: WorkspaceCharacterization }): React.JSX.Element {
  const tone = candidate.classification === "valid_characterization" ? "good" : candidate.classification === "regression_signal" ? "warning" : "danger";
  return (
    <article className="review-card draft-test-card">
      <header><strong>{candidate.task_id} test draft</strong><Badge tone={tone}>{plainClassification(candidate.classification)}</Badge></header>
      <p>{candidate.reason}</p>
      <div className="test-verdicts">
        <Verdict label="Before change" outcome={candidate.base_outcome} />
        <Verdict label="After change" outcome={candidate.post_change_outcome} />
      </div>
      <details>
        <summary>See test patch</summary>
        <pre>{candidate.patch}</pre>
      </details>
      <small>{candidate.check_id} / {candidate.artifact_path}</small>
    </article>
  );
}

function Verdict({ label, outcome }: { label: string; outcome: "pass" | "fail" | "unknown" }): React.JSX.Element {
  return <span className={`verdict verdict-${outcome}`}><CheckCircle2 size={12} aria-hidden="true" /><b>{label}</b>{outcome}</span>;
}

function EvidenceList({ items, compact = false }: { items: string[]; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`evidence-list ${compact ? "is-compact" : ""}`}>
      <strong>Evidence</strong>
      <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </div>
  );
}

function ReviewHandoff({ command }: { command: string }): React.JSX.Element {
  return (
    <div className="review-handoff">
      <span>Review in a terminal</span>
      <code>{command}</code>
      <small>The app cannot approve this item.</small>
    </div>
  );
}

function IntentionalEmpty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }): React.JSX.Element {
  return <div className="intentional-empty"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function plainTaskType(value: string): string {
  if (value === "ui") return "UI";
  if (value === "api") return "API";
  return value.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function plainClassification(value: WorkspaceCharacterization["classification"]): string {
  return ({
    valid_characterization: "Passes both",
    regression_signal: "Behavior changed",
    rejected: "Rejected",
    indeterminate: "Could not verify"
  })[value];
}

function plainRoutingStatus(reason: string | null | undefined): string {
  if (!reason) return "No reviewed routing change is active. Tasks use the repository's default provider rules.";
  if (/stale/iu.test(reason)) return "A reviewed change no longer matches current evidence. Default provider rules remain in use.";
  if (/invalid/iu.test(reason)) return "The reviewed routing data could not be read. Default provider rules remain in use.";
  return "No reviewed routing change is active. Tasks use the repository's default provider rules.";
}

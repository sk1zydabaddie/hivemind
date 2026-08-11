import { ChevronRight, Clock3, FileSearch, Lightbulb, ScrollText } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import {
  Panel,
  PanelCount,
  PanelHeader,
  PanelLabel
} from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { plainActionError } from "@/lib/plain-language";
import type {
  WorkspaceAction,
  WorkspaceCharacterization,
  WorkspaceHistoryRun,
  WorkspaceInspection,
  WorkspaceMemoryProposal,
  WorkspaceRoutingChange,
  WorkspaceRoutingTaskType
} from "@/lib/workspace-actions";

/* Memory and History were two tabs describing one subject: this project's past.
 * Neither could act -- every memory item ends in "review this in a terminal"
 * and history is read-only -- so two inspection tabs asked for a decision the
 * product does not have. They are one surface now.
 *
 * Read-only, except for the audited `trail.inspect` read.
 */

interface DurableTrailEvent {
  ts: string;
  type: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

export function ProjectTab({
  inspection,
  projectName,
  onAction
}: {
  inspection: WorkspaceInspection | null;
  projectName: string;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const [trail, setTrail] = useState<DurableTrailEvent[] | null>(null);
  const [trailError, setTrailError] = useState("");
  const [trailLoading, setTrailLoading] = useState(false);
  const [trailOpen, setTrailOpen] = useState(false);

  const runs = inspection?.history.runs ?? [];
  const memory = inspection?.memory;
  const learned = memory?.canon ?? [];
  const waiting: Array<{ key: string; node: React.ReactNode }> = [
    ...(memory?.pending_lessons ?? []).map((proposal) => ({
      key: `lesson:${proposal.proposal_id}`,
      node: <LessonCard key={proposal.proposal_id} proposal={proposal} />
    })),
    ...(memory?.routing_changes ?? []).map((proposal) => ({
      key: `routing:${proposal.proposal_id}`,
      node: <RoutingCard key={proposal.proposal_id} proposal={proposal} />
    })),
    ...(memory?.draft_tests ?? []).map((candidate) => ({
      key: `draft:${candidate.candidate_id}`,
      node: (
        <DraftTestCard
          candidate={candidate}
          key={candidate.candidate_id}
          taskTitle={inspection?.task_titles[candidate.task_id] ?? candidate.task_id}
        />
      )
    }))
  ];

  const openTrail = (): void => {
    setTrailOpen(true);
    if (trail !== null) return;
    setTrailLoading(true);
    setTrailError("");
    void onAction<DurableTrailEvent[]>({ type: "trail.inspect", payload: {} })
      .then(setTrail)
      .catch((error: unknown) => setTrailError(plainActionError(error)))
      .finally(() => setTrailLoading(false));
  };

  /* Nothing recorded yet is the ordinary state of a new project, and it is one
     fact. Splitting it across four empty panels would turn one honest sentence
     into a grid of shrugs. */
  const bare = runs.length === 0 && learned.length === 0 && waiting.length === 0;

  return (
    <div
      className={`grid h-full min-h-0 overflow-hidden p-3 ${
        bare ? "content-start grid-rows-[auto_auto]" : "grid-rows-[auto_minmax(0,1fr)]"
      }`}
    >
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4 pb-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] leading-tight font-semibold tracking-tight text-ink">
            What {projectName} has done
          </h2>
          <p className="mt-1 mb-0 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
            Every run this project has finished, and everything it has been told
            to remember. Nothing here changes your code.
          </p>
        </div>
        <Button
          disabled={trailLoading}
          type="button"
          variant="outline"
          onClick={openTrail}
        >
          <FileSearch aria-hidden="true" />
          {trailLoading ? "Opening…" : "See the full record"}
        </Button>
      </header>

      {bare ? (
        /* Nothing to show is not a reason to hold the whole viewport open. The
           panel hugs its one sentence and the canvas carries the rest. */
        <section className="self-start rounded-lg border border-rule bg-panel py-12">
          <Empty className="mx-auto max-w-[520px] p-0 md:p-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollText aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>Nothing recorded yet</EmptyTitle>
              <EmptyDescription>
                When a run finishes it lands here, with what it changed and what
                it cost. Anything this project learns along the way shows up
                beside it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </section>
      ) : (
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-3 overflow-hidden">
          <Panel>
            <PanelHeader className="bg-panel">
              <PanelLabel className="text-ink">Past runs</PanelLabel>
              <PanelCount>{runs.length}</PanelCount>
            </PanelHeader>
            <ScrollArea className="min-h-0">
              {runs.length === 0 ? (
                <p className="m-0 px-4 py-5 text-[13px] leading-relaxed text-muted-foreground">
                  No run has finished in this project yet.
                </p>
              ) : (
                <div className="grid">
                  {runs.map((run) => (
                    <RunCard
                      key={run.session_id}
                      run={run}
                      taskTitles={inspection?.task_titles ?? {}}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </Panel>

          <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden">
            <Panel>
              <PanelHeader className="bg-panel">
                <PanelLabel className="text-ink">What it has learned</PanelLabel>
                <PanelCount>{learned.length}</PanelCount>
              </PanelHeader>
              <ScrollArea className="min-h-0">
                <div className="grid gap-2.5 px-3 py-3">
                  {learned.length === 0 && waiting.length === 0 ? (
                    <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
                      Nothing has been added to this project's standing guidance.
                    </p>
                  ) : null}
                  {learned.map((entry) => (
                    <article
                      className="rounded-md border border-rule bg-canvas px-3 py-2.5"
                      key={entry.canon_id}
                    >
                      <div className="flex items-start gap-2">
                        <Lightbulb
                          aria-hidden="true"
                          className="mt-0.5 size-3.5 shrink-0 text-navy"
                        />
                        <div className="min-w-0">
                          <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
                            {entry.title}
                          </strong>
                          <p className="mt-1 mb-0 text-[12px] leading-relaxed break-words text-muted-foreground">
                            {entry.lesson}
                          </p>
                          <span className="mt-1.5 block text-[11px] text-muted-foreground">
                            In use since {formatDate(entry.approved_at)}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}

                  {waiting.length > 0 ? (
                    <>
                      <div className="flex items-center gap-2 pt-1">
                        <h4 className="m-0 text-[11px] font-medium tracking-label text-amber uppercase">
                          Waiting for you to look at
                        </h4>
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                          {waiting.length}
                        </span>
                      </div>
                      {waiting.map((item) => item.node)}
                    </>
                  ) : null}
                </div>
              </ScrollArea>
            </Panel>
          </aside>
        </div>
      )}

      <TrailDialog
        error={trailError}
        loading={trailLoading}
        open={trailOpen}
        trail={trail}
        onOpenChange={setTrailOpen}
      />
    </div>
  );
}

function RunCard({
  run,
  taskTitles
}: {
  run: WorkspaceHistoryRun;
  taskTitles: Record<string, string>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tone =
    run.outcome === "completed"
      ? "text-navy"
      : run.outcome === "needs_attention"
        ? "text-clay"
        : run.outcome === "paused"
          ? "text-amber"
          : "text-muted-foreground";
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      {/* A record, not a card. Rows are flush to the panel and separated by one
          rule, with the date fixed in a mono gutter so a stack of runs reads
          down a single column. */}
      <article className="border-b border-rule px-3 py-3 last:border-b-0">
        <div className="flex items-start gap-3">
          <div className="grid w-[124px] shrink-0 gap-0.5 pt-px">
            <time className="font-mono text-[11px] text-muted-foreground">
              {formatDateTime(run.started_at)}
            </time>
            <span className={`text-[11px] font-medium ${tone}`}>
              {plainOutcome(run.outcome)}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            {/* Lead with what the run did, not with the identifier that names it. */}
            <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
              {run.outcome_detail || plainOutcome(run.outcome)}
            </strong>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
              <Tally
                label={run.merged_tasks.length === 1 ? "task shipped" : "tasks shipped"}
                tone="navy"
                value={run.merged_tasks.length}
              />
              <Rule />
              <Tally
                label={run.verified_tasks.length === 1 ? "task checked" : "tasks checked"}
                tone="muted"
                value={run.verified_tasks.length}
              />
              {run.stopped_tasks.length > 0 ? (
                <>
                  <Rule />
                  <Tally
                    label={run.stopped_tasks.length === 1 ? "task stopped" : "tasks stopped"}
                    tone="clay"
                    value={run.stopped_tasks.length}
                  />
                </>
              ) : null}
              {/* What it cost belongs on the summary line, not behind a
                  disclosure. Replaying a real run showed a card that said what
                  shipped and stayed silent about the bill. */}
              {run.calls > 0 ? (
                <>
                  <Rule />
                  <span className="inline-flex items-baseline gap-1.5 text-muted-foreground">
                    <b className="font-mono text-[12px] font-semibold text-ink">
                      {formatCompact(run.effective_tokens)}
                    </b>
                    <span>
                      tokens over {run.calls} {run.calls === 1 ? "call" : "calls"}
                    </span>
                  </span>
                </>
              ) : null}
              <Rule />
              <span className="inline-flex items-baseline gap-1 font-mono text-muted-foreground">
                <Clock3 aria-hidden="true" className="size-3 translate-y-0.5" />
                {formatDuration(run.duration_ms)}
              </span>
              <Rule />
              <span className="font-mono text-muted-foreground">{run.spec_id}</span>
            </div>
          </div>
          <CollapsibleTrigger asChild>
            <button
              aria-label={open ? "Hide the detail" : "Show the detail"}
              className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-canvas hover:text-ink"
              type="button"
            >
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
              />
            </button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <div className="mt-3 ml-[136px] grid gap-3.5 border-t border-rule pt-3">
            <TaskList
              empty="Nothing from this run reached your branch."
              items={run.merged_tasks.map((taskId) => ({
                id: taskId,
                title: taskTitles[taskId] ?? taskId
              }))}
              title="Shipped to your branch"
            />
            {run.stopped_tasks.length > 0 ? (
              <section className="grid gap-1.5">
                <h4 className="m-0 text-[11px] font-medium tracking-label text-clay uppercase">
                  Stopped before finishing
                </h4>
                <ul className="m-0 grid list-none gap-2 p-0">
                  {run.stopped_tasks.map((task) => (
                    <li key={task.task_id}>
                      <strong className="block text-[13px] leading-snug font-medium break-words text-ink">
                        {taskTitles[task.task_id] ?? task.task_id}
                      </strong>
                      <span className="block text-[12px] leading-relaxed break-words text-muted-foreground">
                        {task.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-3">
              <Fact label="Agent calls" value={formatNumber(run.calls)} />
              <Fact label="Tokens counted" value={formatCompact(run.effective_tokens)} />
              <Fact
                label="Reported by provider"
                value={formatCompact(run.provider_reported_tokens)}
              />
            </dl>
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  );
}

function Tally({
  value,
  label,
  tone
}: {
  value: number;
  label: string;
  tone: "navy" | "clay" | "muted";
}): React.JSX.Element {
  /* A bold navy zero reads like an achievement. Nothing happened is muted. */
  const color =
    value === 0
      ? "text-muted-foreground"
      : tone === "navy"
        ? "text-navy"
        : tone === "clay"
          ? "text-clay"
          : "text-muted-foreground";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <b className={`font-mono text-[12px] font-semibold ${color}`}>{value}</b>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/* The same hairline the Work header uses between figures. Two surfaces, one
   separator — middots would have been a third punctuation style. */
function Rule(): React.JSX.Element {
  return <span aria-hidden="true" className="h-2.5 w-px bg-rule" />;
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="font-medium tracking-label text-muted-foreground uppercase">{label}</dt>
      <dd className="m-0 font-mono text-[12px] text-ink">{value}</dd>
    </div>
  );
}

function TaskList({
  title,
  items,
  empty
}: {
  title: string;
  items: Array<{ id: string; title: string }>;
  empty: string;
}): React.JSX.Element {
  return (
    <section className="grid gap-1.5">
      <h4 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">{title}</h4>
      {items.length === 0 ? (
        <p className="m-0 text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {items.map((item) => (
            <li
              className="text-[13px] leading-snug break-words text-ink"
              key={item.id}
              title={item.id}
            >
              {item.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* Everything below is evidence a person reviews outside the app. The app shows
   what it is and hands over the exact command; it never offers to approve it. */

function ReviewCard({
  title,
  body,
  command,
  children
}: {
  title: string;
  body: string;
  command: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <article className="rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-3 py-2.5">
      <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
        {title}
      </strong>
      <p className="mt-1 mb-0 text-[12px] leading-relaxed break-words text-muted-foreground">
        {body}
      </p>
      {children}
      <div className="mt-2.5 grid gap-1 border-t border-amber/20 pt-2">
        <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          Review this in a terminal
        </span>
        <code className="font-mono text-[11px] break-all text-ink">{command}</code>
        <span className="text-[11px] text-muted-foreground">
          The app cannot approve this item.
        </span>
      </div>
    </article>
  );
}

function LessonCard({ proposal }: { proposal: WorkspaceMemoryProposal }): React.JSX.Element {
  return (
    <ReviewCard body={proposal.lesson} command={proposal.review_command} title={proposal.title} />
  );
}

function RoutingCard({ proposal }: { proposal: WorkspaceRoutingChange }): React.JSX.Element {
  return (
    <ReviewCard body={proposal.lesson} command={proposal.review_command} title={proposal.title}>
      {proposal.change_kind === "routing_weights" ? (
        <div className="mt-2 grid gap-2">
          {proposal.task_types.map((taskType) => (
            <ProviderComparison key={taskType.routing_task_type} taskType={taskType} />
          ))}
        </div>
      ) : (
        <p className="mt-2 mb-0 text-[12px] leading-relaxed text-muted-foreground">
          Suggests spending more on a second opinion for{" "}
          {proposal.error_prone_task_types.map(plainWorkKind).join(", ")}.
        </p>
      )}
    </ReviewCard>
  );
}

function ProviderComparison({
  taskType
}: {
  taskType: WorkspaceRoutingTaskType;
}): React.JSX.Element {
  return (
    <section className="grid gap-1.5">
      <span className="text-[11px] font-medium text-ink">
        {plainWorkKind(taskType.routing_task_type)}
      </span>
      {taskType.providers.map((provider) => (
        <div className="grid gap-1" key={provider.provider}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="min-w-0 break-words text-ink">{provider.provider}</span>
            <b className="shrink-0 font-mono text-muted-foreground">
              {provider.integrated_count}/{provider.sample_count} worked
            </b>
          </div>
          <span
            aria-hidden="true"
            className="block h-[3px] overflow-hidden bg-rule"
          >
            <span
              className="block h-[3px] bg-navy"
              style={{ width: `${Math.max(3, Math.min(100, provider.weight * 100))}%` }}
            />
          </span>
        </div>
      ))}
    </section>
  );
}

function DraftTestCard({
  candidate,
  taskTitle
}: {
  candidate: WorkspaceCharacterization;
  taskTitle: string;
}): React.JSX.Element {
  return (
    <article className="rounded-md border border-rule bg-canvas px-3 py-2.5">
      <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
        A test was drafted for {taskTitle}
      </strong>
      <p className="mt-1 mb-0 text-[12px] leading-relaxed break-words text-muted-foreground">
        {candidate.reason}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Before the change:{" "}
          <b className="font-mono text-ink">{plainOutcomeWord(candidate.base_outcome)}</b>
        </span>
        <span>
          After:{" "}
          <b className="font-mono text-ink">
            {plainOutcomeWord(candidate.post_change_outcome)}
          </b>
        </span>
      </div>
    </article>
  );
}

function TrailDialog({
  open,
  trail,
  loading,
  error,
  onOpenChange
}: {
  open: boolean;
  trail: DurableTrailEvent[] | null;
  loading: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(720px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule px-5 py-4">
          <DialogTitle>
            Everything this project recorded
          </DialogTitle>
          <DialogDescription>
            Every step the project wrote down, oldest first. This is the record
            the app reads; it is shown here exactly as it was written.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 bg-canvas">
          <div className="px-5 py-4">
            {error !== "" ? (
              <p className="m-0 rounded-md bg-clay-wash px-3 py-2 text-[13px] break-words text-clay">
                {error}
              </p>
            ) : loading ? (
              <p className="m-0 text-[13px] text-muted-foreground">Reading the record…</p>
            ) : (
              <ol className="m-0 grid list-none gap-0 p-0">
                {(trail ?? []).map((event, index) => (
                  <li
                    className="grid grid-cols-[124px_minmax(0,1fr)] items-baseline gap-3 border-b border-rule py-1.5 last:border-b-0"
                    key={`${event.ts}-${index}`}
                  >
                    <time className="font-mono text-[11px] text-muted-foreground">
                      {formatDateTime(event.ts)}
                    </time>
                    <div className="min-w-0">
                      <span className="text-[13px] break-words text-ink">
                        {plainEventName(event.type)}
                      </span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {event.task_id ?? "run"}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function plainOutcome(outcome: WorkspaceHistoryRun["outcome"]): string {
  return {
    active: "Still running",
    completed: "Finished",
    needs_attention: "Needs you",
    paused: "Waiting"
  }[outcome];
}

function plainOutcomeWord(outcome: "pass" | "fail" | "unknown"): string {
  return { pass: "passed", fail: "failed", unknown: "not known" }[outcome];
}

function plainWorkKind(value: string): string {
  if (value === "ui") return "UI work";
  if (value === "api") return "API work";
  return value.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function plainEventName(type: string): string {
  return type.replaceAll("_", " ").replaceAll(".", " · ");
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return "under a second";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)}s`;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

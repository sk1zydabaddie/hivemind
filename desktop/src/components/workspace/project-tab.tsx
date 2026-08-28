import { Hex } from "@/components/workspace/hex";
import { ChevronRight, Clock3, Copy, FileSearch, FlaskConical, Layers3, Lightbulb, ScrollText, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AgentsFileCard } from "@/components/workspace/agents-file-card";
import { Button } from "@/components/ui/button";
import { ActionFailure } from "@/components/ui/action-failure";
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
import { VirtualList } from "@/components/ui/virtual-list";
import { AccountsPanel } from "@/components/workspace/accounts-panel";
import { ANONYMOUS_TASK, taskTitleOrNull } from "@/lib/identifiers";
import type { BoardProjection } from "@/lib/projection";
import { buildUsagePanel, formatTokens, type UsagePanel } from "@/lib/provider-usage";
import { projectTotals, type ProjectTotals } from "@/lib/project-totals";
import { plainActionError } from "@/lib/plain-language";
import type {
  DurableTrailPage,
  MemoryReviewHandoff,
  ProjectConfigView,
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

export function ProjectTab({
  inspection,
  projection,
  projectName,
  onAction
}: {
  inspection: WorkspaceInspection | null;
  projection: BoardProjection;
  projectName: string;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  /* Which accounts are connected and what each has spent. Read through the
     audited `config.inspect`; the figures come from `routing.observed`, which
     is a durable event. Nothing here writes, and nothing here estimates. */
  const [config, setConfig] = useState<ProjectConfigView | null>(null);
  const [configError, setConfigError] = useState("");
  const [configLoading, setConfigLoading] = useState(false);
  const loadConfigView = useCallback(async (): Promise<void> => {
    setConfigLoading(true);
    setConfigError("");
    try {
      setConfig(await onAction<ProjectConfigView>({ type: "config.inspect", payload: {} }));
    } catch (error) {
      setConfig(null);
      setConfigError(plainActionError(error));
    } finally {
      setConfigLoading(false);
    }
  }, [onAction]);
  useEffect(() => {
    let cancelled = false;
    setConfigLoading(true);
    setConfigError("");
    void onAction<ProjectConfigView>({ type: "config.inspect", payload: {} })
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((error) => {
        if (!cancelled) setConfigError(plainActionError(error));
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onAction]);
  const usage = buildUsagePanel(inspection, projection, config?.adapters ?? []);
  const [trailPages, setTrailPages] = useState<DurableTrailPage[]>([]);
  const [trailPageIndex, setTrailPageIndex] = useState(0);
  const [trailError, setTrailError] = useState("");
  const [trailLoading, setTrailLoading] = useState(false);
  const [trailOpen, setTrailOpen] = useState(false);

  const runs = inspection?.history.runs ?? [];
  const totals = projectTotals(runs);
  const memory = inspection?.memory;
  const learned = memory?.canon ?? [];
  const waiting: Array<{ key: string; node: React.ReactNode }> = [
    ...(memory?.pending_lessons ?? []).map((proposal) => ({
      key: `lesson:${proposal.proposal_id}`,
      node: <LessonCard key={proposal.proposal_id} proposal={proposal} onAction={onAction} />
    })),
    ...(memory?.routing_changes ?? []).map((proposal) => ({
      key: `routing:${proposal.proposal_id}`,
      node: <RoutingCard key={proposal.proposal_id} proposal={proposal} onAction={onAction} />
    })),
    ...(memory?.draft_tests ?? []).map((candidate) => ({
      key: `draft:${candidate.candidate_id}`,
      node: (
        <DraftTestCard
          candidate={candidate}
          key={candidate.candidate_id}
          taskTitle={
            taskTitleOrNull(candidate.task_id, inspection?.task_titles ?? {}) ??
            ANONYMOUS_TASK
          }
        />
      )
    }))
  ];

  const openTrail = (): void => {
    setTrailOpen(true);
    if (trailPages.length > 0) return;
    setTrailLoading(true);
    setTrailError("");
    void onAction<DurableTrailPage>({ type: "trail.inspect", payload: { limit: 160 } })
      .then((page) => setTrailPages([page]))
      .catch((error: unknown) => setTrailError(plainActionError(error)))
      .finally(() => setTrailLoading(false));
  };

  const loadOlderTrail = async (): Promise<void> => {
    if (trailPageIndex + 1 < trailPages.length) {
      setTrailPageIndex(trailPageIndex + 1);
      return;
    }
    const cursor = trailPages[trailPageIndex]?.next_before;
    if (cursor === null || cursor === undefined) return;
    setTrailLoading(true);
    setTrailError("");
    try {
      const page = await onAction<DurableTrailPage>({
        type: "trail.inspect",
        payload: { before: cursor, limit: 160 }
      });
      setTrailPages((pages) => [...pages, page]);
      setTrailPageIndex(trailPageIndex + 1);
    } catch (error) {
      setTrailError(plainActionError(error));
    } finally {
      setTrailLoading(false);
    }
  };

  /* Nothing recorded yet is the ordinary state of a new project, and it is one
     fact. Splitting it across four empty panels would turn one honest sentence
     into a grid of shrugs. */
  const bare = runs.length === 0 && learned.length === 0 && waiting.length === 0;

  return (
    <div
      data-slot="project-root"
      className={`grid h-full min-h-0 overflow-hidden p-3 ${
        bare ? "content-start grid-rows-[auto_auto]" : "grid-rows-[auto_minmax(0,1fr)]"
      }`}
    >
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4 pb-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] leading-tight font-semibold tracking-tight text-ink">
            What {projectName} has done
          </h2>
          {totals.runsRecorded === 0 ? (
            <p className="mt-1 mb-0 max-w-[560px] text-[12px] leading-relaxed text-muted-foreground">
              Every run this project has finished, and everything it has been
              told to remember. Nothing here changes your code.
            </p>
          ) : (
            <>
              <Comb shipped={totals.tasksShipped} checked={totals.tasksChecked} />
              <Totals totals={totals} />
            </>
          )}
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
        /* The card belongs here too, and this is where it matters most: a
           project with no runs yet is exactly the project whose workers have
           never had an AGENTS.md, and the bare branch used to omit the aside
           entirely -- so the proposal was hidden precisely when it was worth
           the most. Found by walking a fresh project on the installed app. */
        <div className="grid gap-3 self-start">
        {configError === "" ? null : (
          <ActionFailure busy={configLoading} detail={configError} title="Hivemind could not read this project's agent settings" onRetry={() => void loadConfigView()} />
        )}
        <AccountsPanel onAction={onAction} />
        <SpendPanel usage={usage} />
        <section className="rounded-lg border border-rule bg-panel py-12">
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
        <div className="mx-auto w-full max-w-[520px]">
          <AgentsFileCard onAction={onAction} />
        </div>
        </div>
      ) : (
        /* Panels hug what they hold and the canvas carries the rest. Stretching
           two panels to the viewport over one run left ~60% of the surface as
           held-open white, which reads as unfinished rather than as empty --
           the same reasoning the bare state above already followed. */
        <div className="project-history-layout grid min-h-0 grid-cols-[minmax(0,1fr)_340px] items-start gap-3 overflow-hidden">
          <Panel className="max-h-full">
            <PanelHeader>
              <PanelLabel className="text-ink">Past runs</PanelLabel>
              <PanelCount>{runs.length}</PanelCount>
            </PanelHeader>
            {runs.length === 0 ? (
                <p className="m-0 px-4 py-5 text-[13px] leading-relaxed text-muted-foreground">
                  No run has finished in this project yet.
                </p>
              ) : (
                <VirtualList
                  ariaLabel="Past runs"
                  className="min-h-0"
                  estimateSize={116}
                  itemKey={(run) => run.session_id}
                  items={runs}
                  testId="project-run-list"
                  renderItem={(run) => (
                    <RunCard
                      run={run}
                      taskTitles={inspection?.task_titles ?? {}}
                    />
                  )}
                />
              )}
          </Panel>

          {/* The last row holds a scroll area, so it takes the leftover space
              rather than sizing to its content. As `minmax(0,auto)` it grew
              with whatever was inside and the aside -- which hides its
              overflow -- clipped the difference, putting content behind a
              scrollbar nobody had. Caught by the reachability run at 358px
              hidden the first time a tall card landed here. */}
          <aside className="grid max-h-full min-h-0 auto-rows-min gap-3 overflow-y-auto">
            {configError === "" ? null : (
              <ActionFailure busy={configLoading} detail={configError} title="Hivemind could not read this project's agent settings" onRetry={() => void loadConfigView()} />
            )}
            <AccountsPanel onAction={onAction} />
            <SpendPanel usage={usage} />
            <AdvancedActionsPanel config={config} inspection={inspection} projection={projection} onAction={onAction} />
            <Panel>
              <PanelHeader>
                <PanelLabel className="text-ink">What it has learned</PanelLabel>
                <PanelCount>{learned.length}</PanelCount>
              </PanelHeader>
              <div className="grid gap-2.5 px-3 py-3">
                <div className="contents">
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

                  {/* Rendered outside the waiting list rather than inside it,
                      because the card decides for itself whether it has
                      anything to say -- counting an invisible proposal in
                      "Waiting for you to look at" would be a number that does
                      not match what is on screen. */}
                  <AgentsFileCard onAction={onAction} />
                </div>
              </div>
            </Panel>
          </aside>
        </div>
      )}

      <TrailDialog
        error={trailError}
        loading={trailLoading}
        open={trailOpen}
        page={trailPages[trailPageIndex] ?? null}
        pageIndex={trailPageIndex}
        onOpenChange={setTrailOpen}
        onNewer={() => setTrailPageIndex(Math.max(0, trailPageIndex - 1))}
        onOlder={() => void loadOlderTrail()}
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
            </div>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              aria-label={open ? "Hide the detail" : "Show the detail"}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
              />
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <div className="mt-3 ml-[136px] grid gap-3.5 border-t border-rule pt-3">
            <TaskList
              empty="Nothing from this run reached your branch."
              items={run.merged_tasks.map((taskId) => ({
                id: taskId,
                title: taskTitleOrNull(taskId, taskTitles) ?? ANONYMOUS_TASK
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
                        {taskTitleOrNull(task.task_id, taskTitles) ?? ANONYMOUS_TASK}
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

/* What has piled up, on the surface whose whole subject is the past.
 *
 * The figures are the satisfying part and the last line is the honest part:
 * every number is a sum over runs Core recorded, and the two a person would
 * most like to see — files touched, time saved — are named as missing rather
 * than estimated into existence. A fabricated "you saved 14 hours" would be the
 * single most corrosive thing this app could put on a screen.
 */
function Totals({ totals }: { totals: ProjectTotals }): React.JSX.Element {
  return (
    <div className="mt-2 grid gap-1.5">
      <dl className="m-0 flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        <Total
          label={totals.tasksShipped === 1 ? "task shipped" : "tasks shipped"}
          strong
          value={formatNumber(totals.tasksShipped)}
        />
        <Total
          label={totals.runsShipped === 1 ? "run shipped" : "runs shipped"}
          value={`${formatNumber(totals.runsShipped)}`}
        />
        <Total label="working" value={formatDuration(totals.workingMs)} />
        <Total
          label={`over ${formatNumber(totals.calls)} ${totals.calls === 1 ? "call" : "calls"}`}
          value={formatCompact(totals.effectiveTokens)}
        />
      </dl>
      {totals.absent.length === 0 ? null : (
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
          Not counted here, because this project's record does not carry it:{" "}
          {totals.absent.join(", and ")}.
        </p>
      )}
    </div>
  );
}

function Total({
  value,
  label,
  strong = false
}: {
  value: string;
  label: string;
  strong?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="sr-only">{label}</dt>
      <dd
        className={`m-0 font-mono font-semibold ${
          strong ? "text-[20px] tracking-tighter text-navy" : "text-[15px] text-ink"
        }`}
      >
        {value}
      </dd>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

/* Which accounts are connected, and what each has spent.
 *
 * Built because three days went to an exhausted quota with nothing on screen
 * saying so. The rule that makes it worth having is the one about what it
 * REFUSES to draw: a provider whose spending Hivemind cannot read is marked
 * unreadable, never rendered as a confident zero. A meter reading nought when
 * it means "I cannot see" is how the next three days go.
 */
function SpendPanel({ usage }: { usage: UsagePanel }): React.JSX.Element | null {
  if (
    usage.providers.length === 0 &&
    usage.unattributedTokens === 0 &&
    usage.session === null &&
    usage.quota === null
  ) return null;
  return (
    <Panel>
      <PanelHeader>
        <PanelLabel className="text-ink">Usage</PanelLabel>
        {usage.providers.length === 0 ? null : <PanelCount>{usage.providers.length}</PanelCount>}
      </PanelHeader>
      <div className="grid gap-2.5 px-3 py-3">
        {usage.providers.map((provider) => (
          <article className="grid gap-1" key={provider.role}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <strong className="text-[13px] font-semibold text-ink">{provider.role}</strong>
              {provider.model === null ? null : (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {provider.model}
                </span>
              )}
              <span className="ml-auto font-mono text-[13px] font-semibold">
                {provider.standing === "measured" ? (
                  <span className="text-ink">{formatTokens(provider.tokens)}</span>
                ) : (
                  <span className="text-amber">not readable</span>
                )}
              </span>
            </div>
            {provider.standing === "measured" ? (
              <span className="text-[11px] text-muted-foreground">
                {provider.observations === 0
                  ? "Nothing recorded against it in this project yet."
                  : `across ${provider.observations} ${provider.observations === 1 ? "task" : "tasks"}`}
              </span>
            ) : (
              <span className="text-[11px] leading-relaxed text-amber">{provider.caveat}</span>
            )}
          </article>
        ))}

        {usage.unattributedTokens === 0 ? null : (
          <p className="m-0 border-t border-rule pt-2 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-mono text-ink">{formatTokens(usage.unattributedTokens)}</span>{" "}
            was spent by something that is not one of the agents above. It is shown
            separately rather than added in, because a total that absorbs work
            nobody can place is the one that hides a problem.
          </p>
        )}

        {usage.session === null ? null : (
          <div className="grid gap-1 border-t border-rule pt-2">
            <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
              <span className="font-medium tracking-label uppercase">This run</span>
              <span className="ml-auto font-mono text-ink">
                {formatTokens(usage.session.tokens)}
              </span>
              <span>
                of {formatTokens(usage.session.sessionCeiling)}
              </span>
            </div>
            {/* Core's own ledger, not a sum of events -- it is the number the
                ceiling is actually enforced against. */}
            <span
              aria-hidden="true"
              className="block h-1 w-full overflow-hidden bg-rule"
            >
              <span
                className={`block h-1 ${usage.session.nearCeiling ? "bg-amber" : "bg-navy"}`}
                style={{
                  width: `${Math.min(100, Math.round((usage.session.tokens / Math.max(1, usage.session.sessionCeiling)) * 100))}%`
                }}
              />
            </span>
            {usage.session.nearCeiling ? (
              <span className="text-[11px] text-amber">
                Close to this project's limit. Work will stop rather than overrun it.
              </span>
            ) : null}
          </div>
        )}

        {usage.quota === null ? null : (
          <div className="grid gap-1 border-t border-rule pt-2 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="font-medium text-ink">
              Provider usage{usage.quota.provider === null ? "" : ` · ${usage.quota.provider}`}
              {usage.quota.plan === null ? "" : ` · ${usage.quota.plan}`}
            </strong>
            {usage.quota.windows.map((window) => (
              <span key={window.name}>
                {window.name}: {Math.max(0, 100 - window.usedPercent).toLocaleString()}% left
                {window.windowMinutes === null ? "" : ` in its ${window.windowMinutes.toLocaleString()}-minute window`}
                {window.resetsAt === null ? "" : `; resets ${formatDateTime(window.resetsAt)}`}
              </span>
            ))}
            {usage.quota.at === null ? null : <span>Last reported {formatDateTime(usage.quota.at)}.</span>}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Deliberately secondary: these actions spend extra work to inspect or compare
 * an existing task. They do not belong in the ordinary two-decision run, but a
 * mechanism kept in the audited action registry must have one honest product
 * consumer. Core still owns admission, routing, budgets and cancellation.
 */
function AdvancedActionsPanel({
  config,
  inspection,
  projection,
  onAction
}: {
  config: ProjectConfigView | null;
  inspection: WorkspaceInspection | null;
  projection: BoardProjection;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element | null {
  const tasks = Object.entries(inspection?.task_titles ?? {}).sort((left, right) => left[1].localeCompare(right[1]));
  const tools = [...new Set(
    (config?.adapters ?? [])
      .filter((adapter) => adapter.installed)
      .map((adapter) => adapter.tool)
      .filter((entry): entry is string => entry !== null)
  )].sort();
  const [taskId, setTaskId] = useState("");
  const [tool, setTool] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const activeQuality = Object.values(projection.qualityRuns).filter((run) =>
    ["requested", "admitted", "drafting", "checking", "reviewing"].includes(run.status)
  );

  useEffect(() => {
    if (taskId === "" && tasks[0] !== undefined) setTaskId(tasks[0][0]);
    if (tool === "" && tools[0] !== undefined) setTool(tools[0]);
  }, [taskId, tasks, tool, tools]);

  if (tasks.length === 0 && activeQuality.length === 0) return null;

  const run = async (label: string, action: WorkspaceAction): Promise<void> => {
    setWorking(label);
    setNotice("");
    setProblem("");
    try {
      await onAction(action);
      setNotice(`${label} started. Its result will appear in this project's record.`);
    } catch (error) {
      setProblem(`${label} did not start. ${plainActionError(error)}`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <PanelLabel className="text-ink">Extra review</PanelLabel>
      </PanelHeader>
      <div className="grid gap-2.5 px-3 py-3">
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
          Optional second-pass work. These controls can use your connected agents and their quota; nothing runs merely because this panel is open.
        </p>
        {tasks.length === 0 ? null : (
          <>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              Task
              <select className="h-8 rounded-md border border-input bg-canvas px-2 text-[12px] text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
                {tasks.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
              </select>
            </label>
            {tools.length === 0 ? null : (
              <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
                Agent for the characterization
                <select className="h-8 rounded-md border border-input bg-canvas px-2 text-[12px] text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20" value={tool} onChange={(event) => setTool(event.target.value)}>
                  {tools.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              </label>
            )}
            <div className="grid grid-cols-1 gap-1.5">
              <Button disabled={working !== null || taskId === "" || tool === ""} size="xs" type="button" variant="outline" onClick={() => void run("Characterization", { type: "verify.characterize", payload: { task_id: taskId, tool } })}>
                <FlaskConical aria-hidden="true" /> Characterize a failing case
              </Button>
              <Button disabled={working !== null || taskId === ""} size="xs" type="button" variant="outline" onClick={() => void run("Two-draft comparison", { type: "quality.best_of_n", payload: { task_id: taskId, n: 2, ...(tool === "" ? {} : { tool }) } })}>
                <Layers3 aria-hidden="true" /> Compare two drafts
              </Button>
              <Button disabled={working !== null || taskId === ""} size="xs" type="button" variant="outline" onClick={() => void run("Draft and refine", { type: "quality.draft_refine", payload: { task_id: taskId } })}>
                <Sparkles aria-hidden="true" /> Draft, then refine
              </Button>
            </div>
          </>
        )}
        {activeQuality.map((quality) => (
          <div className="flex items-center justify-between gap-2 border-t border-rule pt-2" key={quality.quality_run_id}>
            <span className="min-w-0 text-[11px] text-muted-foreground">
              {taskTitleOrNull(quality.task_id, inspection?.task_titles ?? {}) ?? "Quality review"} · {quality.status}
            </span>
            <Button disabled={working !== null} size="xs" type="button" variant="outline-destructive" onClick={() => void run("Quality review cancellation", { type: "quality.cancel", payload: { quality_run_id: quality.quality_run_id, reason: "Stopped from the Project screen" } })}>
              <Square aria-hidden="true" /> Stop
            </Button>
          </div>
        ))}
        {working === null ? null : <span className="text-[11px] text-navy" role="status">{working} is starting…</span>}
        {notice === "" ? null : <span className="text-[11px] leading-relaxed text-navy" role="status">{notice}</span>}
        {problem === "" ? null : <span className="text-[11px] leading-relaxed text-clay" role="alert">{problem} You can try the same control again.</span>}
      </div>
    </Panel>
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

function LessonCard({
  proposal,
  onAction
}: {
  proposal: WorkspaceMemoryProposal;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  return (
    <ReviewCard body={proposal.lesson} command={proposal.review_command} title={proposal.title}>
      <MemoryReviewButton onAction={onAction} proposal={proposal} />
    </ReviewCard>
  );
}

function RoutingCard({
  proposal,
  onAction
}: {
  proposal: WorkspaceRoutingChange;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
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
      <MemoryReviewButton onAction={onAction} proposal={proposal} />
    </ReviewCard>
  );
}

function MemoryReviewButton({
  proposal,
  onAction
}: {
  proposal: WorkspaceMemoryProposal;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "working" | "copied">("idle");
  const [problem, setProblem] = useState("");
  const copyReviewCommand = async (): Promise<void> => {
    setState("working");
    setProblem("");
    try {
      const result = await onAction<MemoryReviewHandoff>({
        type: "memory.review_handoff",
        payload: { proposal_id: proposal.proposal_id }
      });
      await navigator.clipboard.writeText(result.command);
      setState("copied");
    } catch (error) {
      setState("idle");
      setProblem(plainActionError(error));
    }
  };
  return (
    <div className="mt-2 grid gap-1.5">
      <Button className="justify-self-start" disabled={state === "working"} size="xs" type="button" variant="outline" onClick={() => void copyReviewCommand()}>
        <Copy aria-hidden="true" />
        {state === "working" ? "Preparing…" : state === "copied" ? "Review command copied" : "Copy review command"}
      </Button>
      {problem === "" ? null : <span className="text-[11px] leading-relaxed text-clay" role="alert">{problem} Try again.</span>}
    </div>
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
  page,
  pageIndex,
  loading,
  error,
  onOpenChange,
  onNewer,
  onOlder
}: {
  open: boolean;
  page: DurableTrailPage | null;
  pageIndex: number;
  loading: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onNewer: () => void;
  onOlder: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame className="grid h-[min(720px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] sm:max-w-none">
        <DialogHeader frame>
          <DialogTitle>
            Everything this project recorded
          </DialogTitle>
          {/* The one surface that shows internal identifiers, and the reason
              they are gone everywhere else: a person who needs one is reading
              the raw record or quoting it to support, and has asked for it. */}
          <DialogDescription>
            Every step the project wrote down, newest first. This is the record
            the app reads, shown exactly as it was written — including the
            internal names for things, which is what support will ask for.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-canvas">
          <div className="flex min-h-10 items-center gap-2 border-b border-rule px-5 py-1.5">
            {pageIndex > 0 ? <Button size="sm" variant="ghost" onClick={onNewer}>Newer</Button> : null}
            {page?.next_before !== null && page !== null ? (
              <Button disabled={loading} size="sm" variant="ghost" onClick={onOlder}>
                {loading ? "Reading…" : "Older"}
              </Button>
            ) : null}
          </div>
          <div className="min-h-0">
            {error !== "" ? (
              <p className="m-5 rounded-md bg-clay-wash px-3 py-2 text-[13px] break-words text-clay">
                {error}
              </p>
            ) : loading ? (
              <p className="m-5 text-[13px] text-muted-foreground">Reading the record…</p>
            ) : (
              <VirtualList
                ariaLabel="Full project record"
                className="h-full"
                estimateSize={78}
                itemKey={(event) => JSON.stringify(event)}
                items={page?.events ?? []}
                testId="project-trail-list"
                renderItem={(event) => (
                  <article
                    className="grid grid-cols-[124px_minmax(0,1fr)] items-start gap-3 border-b border-rule px-5 py-2"
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
                      <pre className="mt-1 mb-0 overflow-x-auto font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                        {JSON.stringify(event.data, null, 2)}
                      </pre>
                    </div>
                  </article>
                )}
              />
            )}
          </div>
        </div>
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

/**
 * One hexagon per task this project has shipped.
 *
 * The accumulation surface, and the whole of it: a count of rows in the durable
 * run history rendered as the product's own shape. `tasksShipped` sums
 * `merged_tasks` over recorded runs and `tasksChecked` sums `verified_tasks` --
 * both are Core's numbers, neither is derived here.
 *
 * What it deliberately is NOT: a streak, a weekly average, a percentage against
 * a previous period, or a number that counts up on mount. Every one of those
 * was on offer in the components surveyed for this pass and every one is
 * invented. The only thing that makes this feel like accumulation is that it is
 * genuinely accumulating -- a comb that is one cell longer than last week is
 * one shipped change longer, and nothing else.
 *
 * Filled cells shipped. Outlined cells were verified and not adopted, which is
 * a real distinction the history already records and which a person can act on:
 * work that passed its checks and is still waiting on them.
 */
function Comb({ shipped, checked }: { shipped: number; checked: number }): React.JSX.Element | null {
  if (shipped === 0 && checked === 0) return null;
  /* A cap, because a long-running project would otherwise wrap a thousand
     hexagons across the header. Said out loud rather than silently truncated:
     a comb that stops without saying so is a count that lies. */
  const CAP = 60;
  const waiting = Math.max(0, checked - shipped);
  const filled = Math.min(shipped, CAP);
  const hollow = Math.min(waiting, Math.max(0, CAP - filled));
  const hidden = shipped + waiting - filled - hollow;
  return (
    <div className="mt-3">
      <div className="comb" role="img" aria-label={`${shipped} tasks shipped in this project`}>
        {Array.from({ length: filled }, (_, index) => (
          <Hex fill="fill-navy" key={`s${index}`} size="cell" stroke="stroke-navy" />
        ))}
        {Array.from({ length: hollow }, (_, index) => (
          <Hex key={`w${index}`} size="cell" stroke="stroke-rule" />
        ))}
      </div>
      <p className="mt-2 mb-0 text-[11px] leading-snug text-muted-foreground">
        <span className="font-medium text-ink">{shipped.toLocaleString()}</span>{" "}
        {shipped === 1 ? "task" : "tasks"} shipped
        {waiting > 0 ? (
          <>
            {" · "}
            {waiting.toLocaleString()} checked and not adopted
          </>
        ) : null}
        {hidden > 0 ? <> · {hidden.toLocaleString()} more not drawn</> : null}
      </p>
    </div>
  );
}

import { FlaskConical, Radar, Sparkles } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { BoardProjection, TaskProjection } from "@/lib/projection";
import { PHASES, taskPhase, type PhaseStanding, type TaskPhase } from "@/lib/phases";
import { buildSwarmTree, type SwarmSubagentNode, type SwarmTaskNode } from "@/lib/swarm-model";
import type { WorkspaceInspection } from "@/lib/workspace-actions";

/* The run drawn as shape rather than as a list: stages top to bottom in the
 * order the daemon runs them, tasks inside each stage, and each task's own
 * progress through the four phases on the card itself.
 *
 * This is a VIEW, not a place. It selects a task and nothing else -- every
 * control that acts on a task lives in the rail beside it, so there is exactly
 * one inspector and one set of task actions in the app.
 */

const standingEdge: Record<PhaseStanding, string> = {
  working: "border-navy/35",
  waiting: "border-rule",
  attention: "border-clay/40",
  done: "border-navy/25",
  stopped: "border-rule"
};

const standingFill: Record<PhaseStanding, string> = {
  working: "bg-navy",
  waiting: "bg-rule",
  attention: "bg-clay",
  done: "bg-navy",
  stopped: "bg-rule"
};

const standingText: Record<PhaseStanding, string> = {
  working: "text-navy",
  waiting: "text-muted-foreground",
  attention: "text-clay",
  done: "text-navy",
  stopped: "text-muted-foreground"
};

export function RunMap({
  projection,
  inspection,
  selectedTaskId,
  onSelectTask
}: {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const tree = buildSwarmTree(projection, inspection);
  /* Core's queue is the authority on what needs a person. The map never decides
     that for itself; it only marks the tasks the queue already named. */
  const flagged = new Set(
    (inspection?.needs_you ?? [])
      .map((item) => item.task_id)
      .filter((taskId): taskId is string => taskId !== null)
  );
  /* The live stream records a change clearing a phase. Keying the spine on that
     record is what makes the animation an event's reader rather than an idle
     flourish -- and it is the only motion on this surface. */
  const advancing = new Map(
    projection.artifactMovements.map((movement) => [movement.task_id, movement.id])
  );

  if (tree.groups.length === 0) {
    return (
      <div className="grid min-h-0 place-items-center overflow-auto px-8 py-12">
        <div className="max-w-[420px] text-center">
          <p className="m-0 text-[15px] leading-relaxed text-muted-foreground">
            Nothing is running yet. Once work starts, this shows every task and
            how far each one has got.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea aria-label="How the run is laid out" className="min-h-0">
      <div className="grid gap-7 px-6 py-6">
        {tree.groups.map((group, index) => (
          <section className="grid gap-3" key={group.id}>
            <header className="flex items-baseline gap-2.5">
              <span className="grid size-[22px] shrink-0 place-items-center rounded-sm bg-ink font-mono text-[11px] text-panel">
                {index + 1}
              </span>
              <h3 className="m-0 text-[13px] font-semibold text-ink">
                {group.mode === "parallel"
                  ? `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"} at the same time`
                  : `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"} in order`}
              </h3>
              {group.capacity_note ? (
                <span className="min-w-0 text-[12px] break-words text-amber">
                  {group.capacity_note}
                </span>
              ) : null}
              {/* The rule carries the eye across the stage without drawing a box
                  around it. */}
              <span aria-hidden="true" className="ml-1 h-px min-w-6 flex-1 bg-rule" />
            </header>

            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(288px,1fr))]">
              {group.tasks.map((node) => (
                <PhaseCard
                  advanceKey={advancing.get(node.task.task_id) ?? null}
                  flagged={flagged.has(node.task.task_id)}
                  key={node.id}
                  node={node}
                  selected={node.task.task_id === selectedTaskId}
                  onSelect={() => onSelectTask(node.task.task_id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

/* The four-phase card. Its whole job is to answer "how far has this got?"
   without the person having to know what any of the phases mean mechanically. */
function PhaseCard({
  node,
  selected,
  flagged,
  advanceKey,
  onSelect
}: {
  node: SwarmTaskNode;
  selected: boolean;
  flagged: boolean;
  advanceKey: string | null;
  onSelect: () => void;
}): React.JSX.Element {
  const task = node.task;
  const phase = taskPhase(task);
  /* A queue item naming this task does NOT change how far the task got. A real
     trail has a verified task sitting behind a "needs fresh checks" item: its
     checks passed, they are merely stale. Recolouring the spine from the queue
     drew that card in failure red directly above the words "Checks passed,
     ready to ship". The phase reports Core's task state and nothing else; the
     queue gets its own quiet mark. */
  const standing = phase.standing;
  return (
    <button
      aria-pressed={selected}
      className={`grid gap-3 rounded-lg border bg-panel px-4 py-3.5 text-left transition-colors ${
        selected
          ? "border-navy bg-navy-wash"
          : flagged
            ? "border-amber/40 hover:border-amber"
            : `${standingEdge[standing]} hover:border-navy/40`
      }`}
      type="button"
      onClick={onSelect}
    >
      <div className="grid gap-1">
        <strong className="text-[13px] leading-snug font-semibold break-words text-ink">
          {task.title}
        </strong>
        <span className={`text-[12px] leading-snug break-words ${standingText[standing]}`}>
          {phase.summary}
        </span>
        {flagged ? (
          <span className="mt-0.5 inline-flex w-fit items-center gap-1.5 rounded-sm bg-amber-wash px-1.5 py-0.5 text-[11px] font-medium text-amber">
            Needs you
          </span>
        ) : null}
      </div>

      <PhaseSpine advanceKey={advanceKey} phase={phase} standing={standing} />

      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[12px] text-muted-foreground">
        <span className="font-mono">{task.task_id}</span>
        {task.lease_files.length > 0 ? (
          <span>
            editing {task.lease_files.length}{" "}
            {task.lease_files.length === 1 ? "file" : "files"}
          </span>
        ) : null}
      </div>

      {node.subagents.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-rule-soft pt-2.5">
          {node.subagents.map((agent) => (
            <HelperChip agent={agent} key={agent.id} />
          ))}
        </div>
      ) : null}
    </button>
  );
}

/* Four segments, one per phase. Filled for cleared, hollow-with-a-bar for the
   one it is in, empty for not reached. The label under the current segment is
   the only text, so the row reads as progress rather than as a legend. */
function PhaseSpine({
  phase,
  standing,
  advanceKey
}: {
  phase: TaskPhase;
  standing: PhaseStanding;
  advanceKey: string | null;
}): React.JSX.Element {
  const current = Math.min(phase.reached, PHASES.length - 1);
  /* The segment the change most recently cleared. Only that one animates, and
     only while the live record naming it is still the newest one. */
  const advanced = Math.max(0, phase.reached - 1);
  return (
    <div className="grid gap-1.5">
      <div aria-hidden="true" className="flex gap-1">
        {PHASES.map((name, index) => {
          const cleared = index < phase.reached || standing === "done";
          const active = index === current && standing !== "done" && standing !== "stopped";
          return (
            <span
              className={`relative h-[3px] flex-1 overflow-hidden rounded-full ${
                cleared ? standingFill[standing] : "bg-rule"
              }`}
              key={name}
            >
              {active && !cleared ? (
                <span className={`block h-[3px] w-1/2 rounded-full ${standingFill[standing]}`} />
              ) : null}
              {advanceKey !== null && cleared && index === advanced ? (
                <span
                  className="artifact-marker absolute inset-0 rounded-full bg-panel/75"
                  key={advanceKey}
                />
              ) : null}
            </span>
          );
        })}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] font-medium ${standingText[standing]}`}>
          {standing === "done" && phase.reached >= PHASES.length
            ? "Shipped"
            : standing === "stopped"
              ? "Stopped"
              : PHASES[current]}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {Math.min(phase.reached, PHASES.length)}/{PHASES.length}
        </span>
      </div>
    </div>
  );
}

/* Supporting agents are evidence attached to a task, not things you steer. They
   read as attributes of the card, which is what they are. */
function HelperChip({ agent }: { agent: SwarmSubagentNode }): React.JSX.Element {
  const icon =
    agent.kind === "scout" ? (
      <Radar aria-hidden="true" className="size-3" />
    ) : agent.kind === "characterization" ? (
      <FlaskConical aria-hidden="true" className="size-3" />
    ) : (
      <Sparkles aria-hidden="true" className="size-3" />
    );
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] ${
        agent.state === "needs-you"
          ? "bg-clay-wash text-clay"
          : agent.state === "done"
            ? "bg-navy-wash text-navy"
            : "bg-canvas text-muted-foreground"
      }`}
      title={agent.detail ?? agent.status}
    >
      {icon}
      {helperLabel(agent)}
    </span>
  );
}

function helperLabel(agent: SwarmSubagentNode): string {
  if (agent.kind === "scout") return "Looked around first";
  if (agent.kind === "characterization") return "Wrote a test";
  return "Second attempt compared";
}

/** Files a single task has spoken for, for the rail's summary line. */
export function taskFileCount(task: TaskProjection): number {
  return task.lease_files.length;
}

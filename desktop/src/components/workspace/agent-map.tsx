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

const standingLeft: Record<PhaseStanding, string> = {
  working: "border-l-navy",
  waiting: "border-l-rule",
  attention: "border-l-clay",
  done: "border-l-navy/45",
  stopped: "border-l-rule"
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
      <div className="min-h-0 overflow-auto px-6 py-7">
        <p className="m-0 max-w-[440px] text-[13px] leading-relaxed text-muted-foreground">
          Nothing is running yet. Once work starts, this shows every task and
          how far each one has got.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea aria-label="How the run is laid out" className="min-h-0">
      <div className="grid gap-5 px-5 py-4">
        {tree.groups.map((group, index) => (
          <section className="grid gap-2.5" key={group.id}>
            <header className="flex items-center gap-2.5">
              <span className="grid size-5 shrink-0 place-items-center rounded-xs bg-ink font-mono text-[11px] text-panel">
                {index + 1}
              </span>
              <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
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
              <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-rule" />
            </header>

            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
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
    /* One task, drawn as an instrument reading rather than as a content card:
       a coloured spine down the left edge saying how it is going, the title, a
       four-segment gauge with its phases named underneath, and identifiers in
       a ruled footer. The colour on the left is the whole point -- a wall of
       these can be scanned for the one that is not navy. */
    <button
      aria-pressed={selected}
      className={`grid cursor-pointer content-start gap-2.5 overflow-hidden rounded-md border border-l-2 bg-panel py-3 pr-3.5 pl-3 text-left transition-colors ${
        selected
          ? "border-navy bg-navy-wash"
          : flagged
            ? "border-amber/40 border-l-amber hover:border-amber/70"
            : `${standingEdge[standing]} ${standingLeft[standing]} hover:border-navy/40`
      }`}
      type="button"
      onClick={onSelect}
    >
      <div className="grid gap-0.5">
        <div className="flex items-start justify-between gap-2">
          <strong className="text-[13px] leading-snug font-semibold break-words text-ink">
            {task.title}
          </strong>
          {flagged ? (
            <span className="mt-px shrink-0 rounded-sm bg-amber-wash px-1.5 py-px text-[11px] leading-[15px] font-medium text-amber">
              Needs you
            </span>
          ) : null}
        </div>
        <span className={`text-[12px] leading-snug break-words ${standingText[standing]}`}>
          {phase.summary}
        </span>
      </div>

      <PhaseSpine advanceKey={advanceKey} phase={phase} standing={standing} />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-rule pt-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{task.task_id}</span>
        <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
        <span className={`font-mono ${standingText[standing]}`}>{phaseRatio(phase)}</span>
        {task.lease_files.length > 0 ? (
          <>
            <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
            <span>
              editing {task.lease_files.length}{" "}
              {task.lease_files.length === 1 ? "file" : "files"}
            </span>
          </>
        ) : null}
        {node.subagents.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {node.subagents.map((agent) => (
              <HelperChip agent={agent} key={agent.id} />
            ))}
          </span>
        ) : null}
      </div>
    </button>
  );
}

/* Four segments, one per phase, each with its name underneath and the one the
 * task is in set in the standing's colour.
 *
 * Exported because the rail draws the same thing about the same task. It used
 * to draw four unlabelled grey underlines, which communicated nothing and read
 * as a rendering bug — the same data, told worse, on the surface a person looks
 * at most. One component, so the two cannot diverge again.
 */
export function PhaseSpine({
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
  const finished = standing === "done" && phase.reached >= PHASES.length;
  return (
    <div className="grid gap-1.5">
      <div aria-hidden="true" className="flex gap-1">
        {PHASES.map((name, index) => {
          const cleared = index < phase.reached || standing === "done";
          const active = index === current && standing !== "done" && standing !== "stopped";
          return (
            <span
              className={`relative h-[3px] flex-1 overflow-hidden ${
                cleared ? standingFill[standing] : "bg-rule"
              }`}
              key={name}
            >
              {active && !cleared ? (
                <span className={`block h-[3px] w-1/2 ${standingFill[standing]}`} />
              ) : null}
              {advanceKey !== null && cleared && index === advanced ? (
                <span className="artifact-marker absolute inset-0 bg-panel/75" key={advanceKey} />
              ) : null}
            </span>
          );
        })}
      </div>
      {/* The phase names sit under their own segments, so the gauge says what
          it is measuring instead of needing a legend somewhere else. The one
          the task is in is the only one set in the standing's colour. */}
      <div aria-hidden="true" className="flex gap-1">
        {PHASES.map((name, index) => (
          <span
            className={`flex-1 text-[10px] leading-none ${
              index === current && !finished && standing !== "stopped"
                ? `font-medium ${standingText[standing]}`
                : index < phase.reached || standing === "done"
                  ? "text-muted-foreground"
                  : "text-rule"
            }`}
            key={name}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* How many phases are cleared, for the card's footer. The gauge shows it; the
   figure states it, next to the identifier where the other facts live. */
export function phaseRatio(phase: TaskPhase): string {
  return `${Math.min(phase.reached, PHASES.length)}/${PHASES.length}`;
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
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[11px] leading-[15px] ${
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

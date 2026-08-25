import { AlertTriangle, Check, Cpu, Pause } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionControl } from "@/components/ui/selection-control";
import { taskTitleOrNull } from "@/lib/identifiers";
import { taskPhase, type PhaseStanding } from "@/lib/phases";
import type { BoardProjection } from "@/lib/projection";
import { buildSwarmTree, type SwarmGroupNode, type SwarmTaskNode } from "@/lib/swarm-model";
import type { WorkspaceInspection } from "@/lib/workspace-actions";

import {
  PhaseSpine,
  standingEdge,
  standingFill,
  standingLeft,
  standingText
} from "./phase-spine";

/* The run drawn as a graph of agents.
 *
 * This view was folded into a Story/Map toggle on the argument that its inputs
 * are a subset of the run thread's. The inputs are a subset; the picture is not.
 * A list can say "three tasks are running". Only a shape can show three agents
 * hanging off one branch with a fourth waiting below them, which is the single
 * thing this product does that a person cannot get anywhere else — and it is
 * legible in about a second.
 *
 * It answers four questions and is designed so each has an answer before the
 * viewer has read a word:
 *
 *   which agents exist        one node each, all on screen at once
 *   what is each doing        the node's own sentence, from its phase
 *   what waits on what        the connector: a fan-out branches, a chain drops
 *   which needs a human       the only clay node with a filled badge
 *
 * It remains a VIEW. It selects an agent and dispatches nothing; every control
 * that acts on a task is in the rail beside it, so there is exactly one
 * inspector in the app. That consolidation was the right half of the change
 * this restores the other half of.
 */

const standingRing: Record<PhaseStanding, string> = {
  working: "ring-navy/25",
  waiting: "ring-transparent",
  attention: "ring-clay/30",
  done: "ring-navy/20",
  stopped: "ring-transparent"
};

export function AgentGraph({
  projection,
  inspection,
  selectedTaskId,
  connected,
  onSelectTask
}: {
  projection: BoardProjection;
  inspection: WorkspaceInspection | null;
  selectedTaskId: string | null;
  /** Who is connected, for the state where nothing is running yet. */
  connected: Array<{ role: string; agent: string | null; model: string | null }>;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const tree = buildSwarmTree(projection, inspection);
  /* Core's queue is the authority on what needs a person. The graph never
     decides that for itself; it marks the tasks the queue already named. */
  const flagged = new Set(
    (inspection?.needs_you ?? [])
      .map((item) => item.task_id)
      .filter((taskId): taskId is string => taskId !== null)
  );
  const advancing = new Map(
    projection.artifactMovements.map((movement) => [movement.task_id, movement.id])
  );
  /* The moment a task finishes, and it is a real one: `recordArtifactMovements`
     writes these only from the LIVE stream, and only `verified`/`merged` mean
     the work landed. A replayed history produces none of them, which is
     correct -- reading an old trail should not celebrate. */
  const finishing = new Map(
    projection.artifactMovements
      .filter((movement) => movement.stage === "verified" || movement.stage === "merged")
      .map((movement) => [movement.task_id, movement.id])
  );
  const titles = inspection?.task_titles ?? {};

  if (tree.groups.length === 0) {
    /* A tab called "Agents" that says you have none, while four are connected,
       describes the wrong thing: the name promises a roster and the surface was
       only ever a live-run view. So with nothing running it answers the
       question the name asks -- who is connected -- and says plainly that the
       live picture appears when work starts. */
    return (
      <div className="min-h-0 overflow-auto px-6 py-7">
        {connected.length === 0 ? (
          <p className="m-0 max-w-[440px] text-[13px] leading-relaxed text-muted-foreground">
            No coding agent is connected for this project yet. Open Set up to
            connect one.
          </p>
        ) : (
          <div className="grid max-w-[560px] gap-3">
            <h3 className="m-0 text-[13px] font-medium text-ink">
              Connected for this project
            </h3>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {connected.map((entry) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-rule bg-panel px-3 py-2"
                  key={`${entry.role}:${entry.agent ?? "none"}`}
                >
                  <span className="text-[12px] font-medium text-ink">{entry.role}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {entry.agent ?? "not connected"}
                  </span>
                  {entry.model === null ? null : (
                    <span className="font-mono text-[11px] text-muted-foreground">{entry.model}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
              When a run starts, this becomes the live picture of what each one
              is doing.
            </p>
          </div>
        )}
      </div>
    );
  }

  const working = tree.groups.reduce(
    (count, group) =>
      count + group.tasks.filter((task) => taskPhase(task.task).standing === "working").length,
    0
  );

  return (
    <ScrollArea aria-label="The agents working on this run" className="min-h-0">
      <div className="grid justify-items-center gap-0 px-5 py-5">
        {/* The root. Everything below hangs off it, which is what makes the
            picture a graph rather than a stack of sections. */}
        <div className="flex items-center gap-2.5 rounded-md border border-rule bg-panel px-3 py-2">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-sm bg-ink text-panel"
          >
            <Cpu className="size-3.5" />
          </span>
          <span className="text-[13px] leading-tight font-semibold tracking-tight text-ink">
            Hivemind
          </span>
          <span className="text-[12px] text-muted-foreground">
            {working > 0
              ? `running ${working} ${working === 1 ? "agent" : "agents"}`
              : "coordinating the work"}
          </span>
        </div>

        {tree.groups.map((group, index) => (
          <Stage
            advancing={advancing}
            finishing={finishing}
            first={index === 0}
            flagged={flagged}
            group={group}
            key={group.id}
            selectedTaskId={selectedTaskId}
            titles={titles}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

/* One stage: the connector that says how its agents relate, then the agents.
 *
 * The connector is the whole argument for this view. A fan-out is drawn as a
 * branch — one line down, a bar across, a drop into each agent — so "these
 * three run at the same time" is a shape. A chain is drawn as a single line
 * with an arrowhead, so "this one waits" is also a shape. Neither needs its
 * label read to be understood; the labels are confirmation, not instruction.
 */
function Stage({
  group,
  first,
  flagged,
  advancing,
  finishing,
  selectedTaskId,
  titles,
  onSelectTask
}: {
  group: SwarmGroupNode;
  first: boolean;
  flagged: Set<string>;
  advancing: Map<string, string>;
  finishing: Map<string, string>;
  selectedTaskId: string | null;
  titles: Record<string, string>;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const parallel = group.mode === "parallel" && group.tasks.length > 1;
  /* A stage nobody has reached is drawn faint and dashed, so "later" reads
     as later at a glance rather than as an equal peer of the live work. */
  const pending = group.tasks.every((task) => taskPhase(task.task).standing === "waiting");
  const line = pending ? "border-rule" : "border-navy/40";

  return (
    <section className="grid w-full justify-items-center gap-0">
      {/* Trunk from whatever is above. */}
      <span
        aria-hidden="true"
        className={`h-5 border-l ${line} ${pending ? "border-dashed" : ""}`}
      />

      <p className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        {parallel
          ? `${group.tasks.length} at the same time`
          : first
            ? `${group.tasks.length} ${group.tasks.length === 1 ? "agent" : "agents"}`
            : "then"}
      </p>

      {group.capacity_note ? (
        <p className="m-0 mt-1 max-w-[520px] text-center text-[12px] text-amber">
          {group.capacity_note}
        </p>
      ) : null}

      <span
        aria-hidden="true"
        className={`h-4 border-l ${line} ${pending ? "border-dashed" : ""}`}
      />

      {parallel ? (
        <FanOut count={group.tasks.length} line={line} pending={pending} />
      ) : (
        <span
          aria-hidden="true"
          className={`h-3 border-l ${line} ${pending ? "border-dashed" : ""}`}
        />
      )}

      <div
        className={
          parallel
            ? "grid w-full gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]"
            : "grid w-full max-w-[520px] gap-3"
        }
      >
        {group.tasks.map((node) => (
          <AgentNode
            advanceKey={advancing.get(node.task.task_id) ?? null}
            finishKey={finishing.get(node.task.task_id) ?? null}
            flagged={flagged.has(node.task.task_id)}
            key={node.id}
            node={node}
            selected={node.task.task_id === selectedTaskId}
            titles={titles}
            onSelect={() => onSelectTask(node.task.task_id)}
          />
        ))}
      </div>
    </section>
  );
}

/* The branch. A bar across the stage with a drop into each column, clipped at
   the ends so the outermost drops sit under the outermost nodes rather than
   the bar running past them into nothing. */
function FanOut({
  count,
  line,
  pending
}: {
  count: number;
  line: string;
  pending: boolean;
}): React.JSX.Element {
  const dash = pending ? "border-dashed" : "";
  return (
    <span
      aria-hidden="true"
      className="grid w-full"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: count }, (_, index) => (
        <span className="grid h-3 justify-items-center" key={index}>
          <span className="relative w-full">
            {/* Half-bars, so the ends of the run terminate at a node. */}
            <span
              className={`absolute top-0 border-t ${line} ${dash} ${
                index === 0 ? "left-1/2 right-0" : index === count - 1 ? "left-0 right-1/2" : "inset-x-0"
              }`}
            />
            <span className={`absolute top-0 bottom-0 left-1/2 border-l ${line} ${dash}`} />
          </span>
        </span>
      ))}
    </span>
  );
}

/* One agent. Everything a person needs about it, and nothing they do not:
   what it is building, what it is doing right now, how far it has got, what it
   is holding, and whether it is the one that needs them. */
function AgentNode({
  node,
  selected,
  flagged,
  advanceKey,
  finishKey,
  titles,
  onSelect
}: {
  node: SwarmTaskNode;
  selected: boolean;
  flagged: boolean;
  advanceKey: string | null;
  finishKey: string | null;
  titles: Record<string, string>;
  onSelect: () => void;
}): React.JSX.Element {
  const task = node.task;
  const phase = taskPhase(task);
  const standing = phase.standing;
  /* A queue item naming this task does NOT change how far the task got. A real
     trail has a verified task sitting behind a "needs fresh checks" item; its
     checks passed, they are merely stale. The gauge reports Core's task state
     and nothing else, and the queue gets its own mark. */
  const waitingFor = task.depends_on
    .map((id) => taskTitleOrNull(id, titles))
    .filter((title): title is string => title !== null);

  return (
    <SelectionControl
      active={selected}
      className={
        selected
          ? undefined
          : flagged
            ? "border-clay/40 border-l-clay ring-clay/20 hover:border-clay/70"
            : `${standingEdge[standing]} ${standingLeft[standing]} ${standingRing[standing]} hover:border-navy/40`
      }
      shape="graph"
      onClick={onSelect}
    >
      {/* The completion moment. One wipe of the run's own colour across the
          node the instant the live stream says its work landed -- the same
          animation, and the same rule, as the phase gauge: an overlay on a
          card that is already correct underneath, so reduced motion removes it
          and loses nothing. It cannot fire on a replayed history, because
          nothing writes these movements outside the live stream. */}
      {finishKey === null ? null : (
        <span
          aria-hidden="true"
          className="artifact-marker absolute inset-0 bg-navy/25"
          key={finishKey}
        />
      )}
      <div className="flex items-start gap-2">
        <StatusMark flagged={flagged} standing={standing} />
        <span className="min-w-0 flex-1">
          <strong className="block text-[13px] leading-snug font-semibold break-words text-ink">
            {task.title}
          </strong>
          <span className={`mt-0.5 block text-[12px] leading-snug ${standingText[standing]}`}>
            {flagged ? "Waiting for you" : phase.summary}
          </span>
        </span>
      </div>

      <PhaseSpine advanceKey={advanceKey} phase={phase} standing={standing} />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {task.lease_files.length > 0 ? (
          <span>
            holding {task.lease_files.length}{" "}
            {task.lease_files.length === 1 ? "file" : "files"}
          </span>
        ) : null}
        {waitingFor.length > 0 ? (
          <span className="w-full break-words">after {waitingFor.join(", ")}</span>
        ) : null}
        {node.subagents.length > 0 ? (
          <span className="w-full break-words">
            {node.subagents.map((agent) => helperLabel(agent.kind)).join(" · ")}
          </span>
        ) : null}
      </div>
    </SelectionControl>
  );
}

/* The one mark that has to survive being glanced at from across a desk: a
   filled square whose colour is the whole message. Working is navy, needs-you
   is clay and carries a glyph, done carries a tick. */
function StatusMark({
  standing,
  flagged
}: {
  standing: PhaseStanding;
  flagged: boolean;
}): React.JSX.Element {
  if (flagged) {
    return (
      <span
        aria-hidden="true"
        className="mt-px grid size-5 shrink-0 place-items-center rounded-xs bg-clay text-panel"
      >
        <AlertTriangle className="size-3" />
      </span>
    );
  }
  if (standing === "done") {
    return (
      <span
        aria-hidden="true"
        className="mt-px grid size-5 shrink-0 place-items-center rounded-xs bg-navy text-panel"
      >
        <Check className="size-3" />
      </span>
    );
  }
  if (standing === "attention") {
    return (
      <span
        aria-hidden="true"
        className="mt-px grid size-5 shrink-0 place-items-center rounded-xs bg-clay text-panel"
      >
        <AlertTriangle className="size-3" />
      </span>
    );
  }
  if (standing === "waiting" || standing === "stopped") {
    return (
      <span
        aria-hidden="true"
        className="mt-px grid size-5 shrink-0 place-items-center rounded-xs bg-canvas text-muted-foreground"
      >
        <Pause className="size-3" />
      </span>
    );
  }
  /* Working: a filled square with the run's own pulse, which is the same
     treatment the phase gauge uses so the two read as one instrument. */
  return (
    <span
      aria-hidden="true"
      className={`mt-px grid size-5 shrink-0 place-items-center rounded-xs ${standingFill[standing]}`}
    >
      <span className="size-1.5 rounded-xs bg-panel" />
    </span>
  );
}

function helperLabel(kind: SwarmTaskNode["subagents"][number]["kind"]): string {
  if (kind === "scout") return "looked around first";
  if (kind === "characterization") return "wrote a test";
  return "second attempt compared";
}

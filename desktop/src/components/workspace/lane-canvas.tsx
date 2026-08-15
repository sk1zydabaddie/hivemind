import { Hex, hexTone } from "@/components/workspace/hex";
import { PHASES, taskPhase, type PhaseStanding } from "@/lib/phases";
import type { GateRule } from "@/lib/gates";
import type { TaskProjection } from "@/lib/projection";

/**
 * The lanes, at the size the claim deserves.
 *
 * In the rail a lane was a 2px tick about 20px tall — smaller than the phase
 * pips beside it. The product's signature object was the least visible thing on
 * screen, during the exact moment its claim is strongest, while the centre
 * column held a timeline of three lines and a large empty region.
 *
 * So while work is in flight the centre column draws the lanes as COLUMNS: one
 * per task, tracks running down side by side, four phase stations on each. The
 * point is literal — three agents working in parallel is three tracks next to
 * each other, and you can count them from across the room. No other tool's
 * screenshot has this, because no other tool runs three agents at once inside
 * one change set.
 *
 * The gates sit above as rules the whole set descends from. They are NOT
 * positioned between the phase stations: the trail records that a lease was
 * approved, not which phase boundary it belongs between, and drawing them at a
 * boundary would be inventing a position to make a nicer picture.
 *
 * Everything here is Core's: the phase comes from `taskPhase`, the file count
 * from the task's own lease, the gate counts from durable events. Nothing is
 * derived, estimated or animated on a clock.
 */

const STANDING_TRACK: Record<PhaseStanding, string> = {
  working: "bg-navy",
  waiting: "bg-rule",
  attention: "bg-clay",
  done: "bg-navy/40",
  stopped: "bg-rule"
};

const STANDING_LABEL: Record<PhaseStanding, string> = {
  working: "text-navy",
  waiting: "text-muted-foreground",
  attention: "text-clay",
  done: "text-muted-foreground",
  stopped: "text-muted-foreground"
};

export function LaneCanvas({
  tasks,
  gates,
  selectedTaskId,
  onSelectTask
}: {
  tasks: TaskProjection[];
  gates: GateRule[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element | null {
  if (tasks.length === 0) return null;
  const passed = gates.filter((gate) => gate.standing === "passed");
  const held = gates.filter((gate) => gate.standing === "held");
  return (
    <section
      aria-label="Lanes"
      className="shrink-0 border-b border-rule bg-canvas px-4 pt-3 pb-4"
    >
      {/* The gates, full width, as rules the lanes descend from. Still one per
          gate and still hairlines — the canvas makes them longer, not louder. */}
      {/* ONE rule, however many gates it names.
          Three stacked rules across the canvas is the horizontal noise this was
          explicitly not to become — at rail width they were three hairlines in
          a column, at canvas width they were a decorative divider stack. The
          passed gates are one line the lanes descend from, and a HELD gate gets
          its own because it is the one that has stopped something. */}
      {passed.length === 0 ? null : (
        <div className="mb-3 flex items-center gap-2.5">
          <span aria-hidden="true" className="h-px flex-1 bg-rule" />
          <span className="flex shrink-0 flex-wrap items-baseline gap-x-2.5 text-[10px] leading-none text-muted-foreground">
            {passed.map((gate) => (
              <span key={gate.id}>
                <span className="tracking-label uppercase">{gate.label}</span>{" "}
                <span className="text-muted-foreground/75">{gate.detail}</span>
              </span>
            ))}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-rule" />
        </div>
      )}
      {held.map((gate) => (
        <div className="mb-3 flex items-center gap-2.5" key={gate.id}>
          <span aria-hidden="true" className="h-0.5 flex-1 bg-clay" />
          <span className="shrink-0 text-[10px] leading-none font-semibold tracking-label text-clay uppercase">
            {gate.label}
          </span>
          <span className="shrink-0 text-[10px] leading-none text-clay">{gate.detail}</span>
          <span aria-hidden="true" className="h-0.5 flex-1 bg-clay" />
        </div>
      ))}

      <div className="flex items-stretch gap-2">
        {tasks.map((task) => (
          <Lane
            key={task.task_id}
            selected={task.task_id === selectedTaskId}
            task={task}
            onSelect={() => onSelectTask(task.task_id)}
          />
        ))}
      </div>
    </section>
  );
}

function Lane({
  task,
  selected,
  onSelect
}: {
  task: TaskProjection;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const phase = taskPhase(task);
  const standing = phase.standing;
  const reached = Math.min(phase.reached, PHASES.length);
  const current = Math.min(phase.reached, PHASES.length - 1);
  const tone = hexTone[standing];
  return (
    <button
      aria-pressed={selected}
      className={`group grid min-w-0 flex-1 cursor-pointer grid-rows-[auto_minmax(0,1fr)] gap-2 rounded-md border px-2.5 pt-2.5 pb-2 text-left transition-colors ${
        selected ? "border-navy/35 bg-navy-wash" : "border-transparent hover:bg-panel"
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="grid gap-0.5">
        <span className="text-[12px] leading-snug font-medium break-words text-ink">
          {task.title}
        </span>
        <span className={`text-[10px] leading-none tracking-label uppercase ${STANDING_LABEL[standing]}`}>
          {standing === "done" ? "Ready" : PHASES[current]}
        </span>
      </span>

      {/* The track, running down. Four stations, filled to the phase reached. */}
      <span className="relative flex flex-col items-start gap-0 pt-0.5">
        {PHASES.map((name, index) => {
          const cleared = index < reached || standing === "done";
          /* The station the task is standing in. Cleared stations are filled;
             this one is outlined in the standing's colour, so "where it is" and
             "what it has finished" are two different marks rather than one. */
          const active = index === current && standing !== "done";
          const last = index === PHASES.length - 1;
          return (
            <span className="flex items-center gap-2" key={name}>
              <span className="relative flex w-[15px] flex-col items-center">
                <Hex
                  checked={standing === "done" && last}
                  fill={cleared ? tone.fill : undefined}
                  size="node"
                  stroke={cleared || active ? tone.stroke : "stroke-rule"}
                />
                {last ? null : (
                  <span
                    aria-hidden="true"
                    /* The segment is coloured when the task has travelled it,
                       which includes the one it is on right now. */
                    className={`h-5 w-0.5 ${
                      index < reached || standing === "done"
                        ? STANDING_TRACK[standing]
                        : "bg-rule"
                    }`}
                  />
                )}
              </span>
              <span
                className={`text-[10px] leading-none ${
                  index === current && standing !== "done"
                    ? STANDING_LABEL[standing]
                    : cleared
                      ? "text-muted-foreground"
                      : "text-rule"
                }`}
              >
                {name}
              </span>
            </span>
          );
        })}
      </span>

      {task.lease_files.length === 0 ? null : (
        <span className="text-[10px] leading-snug break-words text-muted-foreground">
          {task.lease_files.length} {task.lease_files.length === 1 ? "file" : "files"}
        </span>
      )}
    </button>
  );
}

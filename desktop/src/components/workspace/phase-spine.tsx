import { PHASES, type PhaseStanding, type TaskPhase } from "@/lib/phases";

/* The four-phase gauge, in one file because three surfaces draw it about the
 * same task: the graph's agent node, the rail's task row, and the completion
 * moment. It used to live inside the map, which meant the map had to exist for
 * the rail to have a gauge.
 */

export const standingFill: Record<PhaseStanding, string> = {
  working: "bg-navy",
  waiting: "bg-rule",
  attention: "bg-clay",
  done: "bg-navy",
  stopped: "bg-rule"
};

export const standingText: Record<PhaseStanding, string> = {
  working: "text-navy",
  waiting: "text-muted-foreground",
  attention: "text-clay",
  done: "text-navy",
  stopped: "text-muted-foreground"
};

export const standingEdge: Record<PhaseStanding, string> = {
  working: "border-navy/35",
  waiting: "border-rule",
  attention: "border-clay/40",
  done: "border-navy/25",
  stopped: "border-rule"
};

export const standingLeft: Record<PhaseStanding, string> = {
  working: "border-l-navy",
  waiting: "border-l-rule",
  attention: "border-l-clay",
  done: "border-l-navy/45",
  stopped: "border-l-rule"
};

/* Four segments, one per phase, each with its name underneath and the one the
 * task is in set in the standing's colour.
 *
 * The rail used to draw four unlabelled grey underlines for the same fact,
 * which communicated nothing and read as a rendering bug. One component, so the
 * two cannot diverge again.
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
          it is measuring instead of needing a legend somewhere else. */}
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

/** How many phases are cleared, as a figure beside the gauge. */
export function phaseRatio(phase: TaskPhase): string {
  return `${Math.min(phase.reached, PHASES.length)}/${PHASES.length}`;
}

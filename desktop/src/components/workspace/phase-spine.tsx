import { Hex, hexTone } from "@/components/workspace/hex";
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
  /* Four hexes and the live phase named, rather than four grey rules with four
     labels under them. Same component, same data, same four facts — but the
     rules read as a rendering artefact, and four of anything repeated in a
     dense column is exactly where a product should be putting its own shape. */
  const tone = hexTone[standing];
  return (
    <div aria-hidden="true" className="flex items-center gap-1">
      {PHASES.map((name, index) => {
        const cleared = index < phase.reached || standing === "done";
        const active = index === current && standing !== "done" && standing !== "stopped";
        return (
          <span
            className={
              advanceKey !== null && cleared && index === advanced ? "hex-advance" : undefined
            }
            key={advanceKey !== null && index === advanced ? `${name}-${advanceKey}` : name}
          >
            <Hex
              checked={finished && index === PHASES.length - 1}
              fill={cleared ? tone.fill : undefined}
              size="pip"
              stroke={cleared || active ? tone.stroke : "stroke-rule"}
            />
          </span>
        );
      })}
      {/* One name, not four. The other three are inferable from the hexes and
          were only ever legend for the rules they sat under. */}
      <span
        className={`ml-1 text-[10px] leading-none tracking-label uppercase ${
          finished
            ? "text-muted-foreground"
            : standing === "stopped"
              ? "text-muted-foreground"
              : `font-semibold ${standingText[standing]}`
        }`}
      >
        {finished ? "Ready" : PHASES[current]}
      </span>
    </div>
  );
}

/** How many phases are cleared, as a figure beside the gauge. */
export function phaseRatio(phase: TaskPhase): string {
  return `${Math.min(phase.reached, PHASES.length)}/${PHASES.length}`;
}

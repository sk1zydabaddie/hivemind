import type { PhaseStanding } from "@/lib/phases";

/**
 * The hexagon, which is the product's own mark used as its status shape.
 *
 * The brand is two interlocking hexagonal links and it appeared nowhere in the
 * interface — the app used squares, dots and grey rules, which is what any
 * shadcn project uses. One shape carried everywhere is what the identity was
 * missing, and it costs nothing: a hexagon reads at 8px as clearly as a square,
 * and unlike a square it belongs to something.
 *
 * Three sizes, one geometry:
 *
 * - `pip` (10px) — one phase of four, on a lane.
 * - `node` (14px) — the head of a lane: what this task is doing.
 * - `cell` (16px) — one adopted change in the comb.
 *
 * Pointy-top, matching the navy link in the mark. The flat-top rotation belongs
 * to the other link and is deliberately not used here: two orientations would
 * read as two different shapes at this size.
 */

const GEOMETRY = {
  pip: { w: 10, h: 9, stroke: 1.8 },
  node: { w: 15, h: 13, stroke: 2 },
  cell: { w: 17, h: 15, stroke: 2.1 }
} as const;

export type HexSize = keyof typeof GEOMETRY;

/** Pointy-top hexagon inscribed in the box, inset by half a stroke. */
function path(w: number, h: number, stroke: number): string {
  const inset = stroke / 2 + 0.2;
  const x0 = inset;
  const x1 = w - inset;
  const y0 = inset;
  const y1 = h - inset;
  const cx = w / 2;
  const q = (y1 - y0) / 4;
  return [
    `M${cx} ${y0}`,
    `L${x1} ${y0 + q}`,
    `L${x1} ${y1 - q}`,
    `L${cx} ${y1}`,
    `L${x0} ${y1 - q}`,
    `L${x0} ${y0 + q}`,
    "Z"
  ].join(" ");
}

/* The check is drawn rather than faded in.
 *
 * Taken from 21st.dev's AI Task List, whose reasoning is right and worth
 * keeping: a check that draws itself reads as the ACT of ticking the box, where
 * one that fades reads as a state that was always there. Its implementation
 * note is also worth keeping — the draw is a CSS keyframe on a dash offset
 * rather than an animated motion value, so `prefers-reduced-motion` is handled
 * in CSS with no JS branch and nothing to get out of step.
 *
 * Rewritten to our tokens and our stroke weights; none of its styling survives.
 */
const CHECK = "M4.4 6.4 L6.4 8.5 L10.4 4.3";

export function Hex({
  size = "pip",
  fill,
  stroke,
  checked = false,
  className = ""
}: {
  size?: HexSize;
  /** A token class name, e.g. `fill-navy`. Omit for a hollow hex. */
  fill?: string;
  stroke: string;
  /** Draws the check on mount. Only ever passed when something really finished. */
  checked?: boolean;
  className?: string;
}): React.JSX.Element {
  const { w, h, stroke: width } = GEOMETRY[size];
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 ${className}`}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
    >
      <path
        className={`${stroke} ${fill ?? "fill-none"}`}
        d={path(w, h, width)}
        strokeLinejoin="round"
        strokeWidth={width}
      />
      {checked ? (
        <path
          className="hex-check stroke-panel"
          d={CHECK}
          fill="none"
          pathLength={1}
          strokeDasharray="1 1"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.7}
        />
      ) : null}
    </svg>
  );
}

/** The stroke/fill token pair for a standing, so nothing picks colours ad hoc. */
export const hexTone: Record<PhaseStanding, { stroke: string; fill?: string }> = {
  working: { stroke: "stroke-navy", fill: "fill-navy" },
  waiting: { stroke: "stroke-rule" },
  attention: { stroke: "stroke-clay", fill: "fill-clay" },
  done: { stroke: "stroke-navy", fill: "fill-navy" },
  stopped: { stroke: "stroke-rule" }
};

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { Hex } from "../src/components/workspace/hex";

/* A regular pointy-top hexagon with circumradius R is 2R tall and R√3 wide, so
 * height = width × 2/√3 ≈ 1.1547 × width -- TALLER than it is wide.
 *
 * The phase markers were 10×9, 15×13 and 17×15: wider than tall, the ratio
 * inverted, so every one was a squashed hexagon rather than the shape in the
 * product's own mark. The path was always right; the box was not.
 *
 * Proven to bite: set any height back below its width and the ratio fails.
 */
const REGULAR = 2 / Math.sqrt(3);

describe("the hexagon is the shape the mark is", () => {
  for (const size of ["pip", "node", "cell"] as const) {
    test(`${size} is a regular hexagon`, () => {
      const markup = renderToStaticMarkup(createElement(Hex, { size, stroke: "stroke-navy" }));
      const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/u.exec(markup);
      expect(box, `no viewBox in ${markup.slice(0, 120)}`).not.toBeNull();
      const width = Number(box?.[1]);
      const height = Number(box?.[2]);
      expect(height).toBeGreaterThan(width);
      expect(height / width).toBeCloseTo(REGULAR, 3);
    });
  }

  /* And the flat sides sit at a quarter and three quarters of the height, which
     is what makes the six sides equal once the box is right. */
  test("the vertices are at the quarter points", () => {
    const markup = renderToStaticMarkup(createElement(Hex, { size: "node", stroke: "stroke-navy" }));
    const d = /d="([^"]+)"/u.exec(markup)?.[1] ?? "";
    const ys = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/gu)].map((match) => Number(match[2]));
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const quarter = top + (bottom - top) / 4;
    expect(ys.filter((y) => Math.abs(y - quarter) < 0.01).length).toBe(2);
  });
});

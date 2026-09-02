/**
 * `distributeToWidth` — the "fit the columns to the window" half of the grid's
 * sizing, kept honest without a DOM.
 *
 * Everything here is arithmetic over a width map, which is the reason the
 * function takes `available` as a number rather than reading a scrollport: the
 * hard part is the water-filling, and a test that needed layout could not reach
 * it. The measurement half (`computeAutoFitWidths`) needs a canvas and is
 * exercised through the grid instead.
 */

import { describe, expect, it } from "vitest";
import { distributeToWidth } from "./autoFitColumn";

const MIN = 40;
const total = (o: Record<string, number>) =>
  Object.values(o).reduce((a, b) => a + b, 0);

describe("it lands exactly on the available width", () => {
  it("grows a narrow table to fill", () => {
    const out = distributeToWidth({ a: 100, b: 200, c: 100 }, 800, MIN);
    expect(total(out)).toBe(800);
  });

  it("shrinks a wide table to fit", () => {
    const out = distributeToWidth({ a: 600, b: 900, c: 300 }, 800, MIN);
    expect(total(out)).toBe(800);
  });

  it("leaves an already-exact table alone", () => {
    const out = distributeToWidth({ a: 300, b: 500 }, 800, MIN);
    expect(out).toEqual({ a: 300, b: 500 });
  });

  it("absorbs rounding drift rather than leaving a sliver of scrollbar", () => {
    // Three columns over a width that does not divide evenly: rounding each
    // independently lands a px or two short, and on `table-fixed` that gap is
    // the scrollbar this gesture exists to remove.
    const out = distributeToWidth({ a: 100, b: 100, c: 100 }, 1000, MIN);
    expect(total(out)).toBe(1000);
  });
});

describe("it keeps the content's proportions", () => {
  it("scales rather than equalising", () => {
    // The content fit is what carries the hierarchy: `id` is narrow because its
    // values are. Splitting the width equally would hand a boolean column the
    // same room as a paragraph.
    const out = distributeToWidth({ id: 50, body: 450 }, 1000, MIN);
    expect(out.body).toBeGreaterThan(out.id * 5);
  });

  it("preserves order of width", () => {
    const out = distributeToWidth({ a: 100, b: 300, c: 200 }, 300, MIN);
    expect(out.b).toBeGreaterThanOrEqual(out.c);
    expect(out.c).toBeGreaterThanOrEqual(out.a);
  });
});

describe("the floor is respected without overshooting", () => {
  it("never returns a column under min", () => {
    const out = distributeToWidth({ a: 1000, b: 60, c: 40 }, 400, MIN);
    for (const w of Object.values(out)) expect(w).toBeGreaterThanOrEqual(MIN);
  });

  it("still hits the target when some columns clamp", () => {
    // The bug a single multiply-then-clamp produces: the clamped columns keep
    // more than their share, the total overshoots, and the scrollbar stays.
    const out = distributeToWidth(
      { wide: 2000, tiny: 45, tiny2: 45 },
      600,
      MIN,
    );
    expect(total(out)).toBe(600);
    expect(out.tiny).toBe(MIN);
    expect(out.tiny2).toBe(MIN);
    expect(out.wide).toBe(600 - 2 * MIN);
  });

  it("bottoms out at min for every column when nothing can fit", () => {
    // Honest failure: no assignment fits, so the grid keeps scrolling rather
    // than rendering columns too narrow to hold a character.
    const out = distributeToWidth({ a: 500, b: 500, c: 500 }, 60, MIN);
    expect(out).toEqual({ a: MIN, b: MIN, c: MIN });
  });
});

describe("degenerate input cannot reach the DOM as NaN", () => {
  it("returns nothing for an empty map", () => {
    expect(distributeToWidth({}, 800, MIN)).toEqual({});
  });

  it("returns nothing for a collapsed or negative viewport", () => {
    // A dropped `style.width` rather than an error is what a NaN would cost,
    // so these are guarded at the entrance.
    expect(distributeToWidth({ a: 100 }, 0, MIN)).toEqual({});
    expect(distributeToWidth({ a: 100 }, -20, MIN)).toEqual({});
    expect(distributeToWidth({ a: 100 }, Number.NaN, MIN)).toEqual({});
  });

  it("survives a zero-width natural fit", () => {
    // `computeAutoFitWidths` clamps to `min`, but this function is public and a
    // zero would otherwise make the proportional scale divide by zero.
    const out = distributeToWidth({ a: 0, b: 0 }, 400, MIN);
    expect(total(out)).toBe(400);
    for (const w of Object.values(out)) expect(w).toBeGreaterThanOrEqual(MIN);
  });
});

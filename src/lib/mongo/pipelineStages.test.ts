/**
 * Stage identity — the one thing in `pipeline.ts` that has to be right for the
 * aggregation editor to work at all.
 *
 * A stage's `id` is its React key, its entry in the tab's collapsed set, and
 * its slot in the per-stage preview map. Two stages sharing one means two cards
 * collapsing together, one preview painted under both, and a drag moving the
 * wrong one — none of which looks like an id bug when you hit it. So the
 * minting is module-local and this pins that duplication goes through it.
 */

import { describe, expect, it } from "vitest";
import { duplicateStage, newStage } from "./pipeline";

describe("every stage gets its own identity", () => {
  it("mints a fresh id per new stage", () => {
    expect(newStage("$match").id).not.toBe(newStage("$match").id);
  });

  it("gives a duplicate a new id rather than its source's", () => {
    const source = newStage("$match");
    expect(duplicateStage(source).id).not.toBe(source.id);
  });

  it("keeps ids unique across a burst of copies", () => {
    // The shape that would break a naive `${source.id}-copy`: duplicating the
    // same stage twice.
    const source = newStage("$group");
    const ids = [
      source.id,
      duplicateStage(source).id,
      duplicateStage(source).id,
    ];
    expect(new Set(ids).size).toBe(3);
  });
});

describe("a duplicate is a copy, not a fresh stage", () => {
  it("carries the body over verbatim", () => {
    const source = { ...newStage("$match"), body: '{ "status": "A" }' };
    expect(duplicateStage(source).body).toBe('{ "status": "A" }');
  });

  it("copies the disabled flag rather than resetting it", () => {
    // Duplicating a stage you had switched off should not quietly switch the
    // copy on — it would join the next preview run and change the result.
    const source = { ...newStage("$match"), enabled: false };
    expect(duplicateStage(source).enabled).toBe(false);
  });

  it("does not mutate its source", () => {
    const source = newStage("$match");
    const before = { ...source };
    duplicateStage(source);
    expect(source).toEqual(before);
  });
});

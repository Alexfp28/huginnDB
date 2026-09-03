import { describe, expect, it } from "vitest";
import { completionPositionAt, siblingStringValue } from "./completionContext";

/**
 * Characterization tests for the pipeline body cursor scanner.
 *
 * These pin the cases the Mongo completion provider actually branches on:
 * key vs. value position, which key a value belongs to, and — the whole
 * point of the feature — recognising the inside of a `$lookup` so `from`,
 * `localField` and `foreignField` can each get the right suggestion list.
 * Comments and strings must never perturb the brace count, and the scan must
 * never look past the cursor (an auto-closed quote sitting after it doesn't
 * count as "closed" from the cursor's point of view).
 */

describe("completionPositionAt", () => {
  it("reports unknown before any bracket has opened", () => {
    const text = "  ";
    expect(completionPositionAt(text, 1)).toMatchObject({ slot: "unknown" });
  });

  it("reports key position right after the opening brace", () => {
    const text = "{ }";
    const pos = completionPositionAt(text, 2);
    expect(pos.slot).toBe("key");
    expect(pos.path.at(-1)?.type).toBe("object");
  });

  it("reports key position mid-way through typing a bare key", () => {
    const text = "{ stat";
    expect(completionPositionAt(text, text.length).slot).toBe("key");
  });

  it("reports value position and forKey right after a colon", () => {
    const text = '{ status: ';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("value");
    expect(pos.forKey).toBe("status");
  });

  it("reports value position and forKey inside an open string value", () => {
    const text = '{ status: "act';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("value");
    expect(pos.forKey).toBe("status");
  });

  it("does not look past the cursor at an auto-closed quote", () => {
    // Monaco auto-closes the pair; the cursor sits between the two quotes.
    const text = '{ status: "" }';
    const cursor = text.indexOf('""') + 1; // right after the opening quote
    const pos = completionPositionAt(text, cursor);
    expect(pos.slot).toBe("value");
    expect(pos.forKey).toBe("status");
  });

  it("resets to key position after a comma", () => {
    const text = '{ status: "active", ';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("key");
  });

  it("does not report key position inside an array", () => {
    const text = "{ $or: [ ";
    const pos = completionPositionAt(text, text.length);
    expect(pos.path.at(-1)?.type).toBe("array");
    expect(pos.slot).toBe("unknown");
  });

  it("attributes a nested object frame to its enclosing key", () => {
    const text = "{ $lookup: { ";
    const pos = completionPositionAt(text, text.length);
    expect(pos.path.at(-1)?.key).toBe("$lookup");
    expect(pos.slot).toBe("key");
  });

  it("reports an accumulator picked inside an already-open $group field as a key one level under $group", () => {
    // The exact shape a $group stage snippet's own accumulator tabstop
    // produces: the braces are already there, so the cursor sits at the
    // *key* position of the field's own object, one frame below $group —
    // not at $group's own value slot (monacoMongo.ts's completion provider
    // has to tell these two cases apart to insert the right shape).
    const text = '{ $group: { _id: "$_entity", count: { $su';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("key");
    expect(pos.path.at(-1)?.key).toBe("count");
    expect(pos.path.at(-2)?.key).toBe("$group");
  });

  it("recognises from/localField/foreignField inside $lookup", () => {
    const from = completionPositionAt('{ $lookup: { from: "', '{ $lookup: { from: "'.length);
    expect(from.path.at(-1)?.key).toBe("$lookup");
    expect(from.slot).toBe("value");
    expect(from.forKey).toBe("from");

    const local = completionPositionAt(
      '{ $lookup: { from: "orders", localField: "',
      '{ $lookup: { from: "orders", localField: "'.length,
    );
    expect(local.path.at(-1)?.key).toBe("$lookup");
    expect(local.forKey).toBe("localField");

    const foreign = completionPositionAt(
      '{ $lookup: { from: "orders", localField: "id", foreignField: "',
      '{ $lookup: { from: "orders", localField: "id", foreignField: "'.length,
    );
    expect(foreign.path.at(-1)?.key).toBe("$lookup");
    expect(foreign.forKey).toBe("foreignField");
  });

  it("ignores braces and colons inside comments", () => {
    const text = '{ /* { a: 1 } */ status: ';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("value");
    expect(pos.forKey).toBe("status");
    expect(pos.path).toHaveLength(2);
  });

  it("ignores braces and colons inside strings", () => {
    const text = '{ note: "a { b : c", status: ';
    const pos = completionPositionAt(text, text.length);
    expect(pos.slot).toBe("value");
    expect(pos.forKey).toBe("status");
    expect(pos.path).toHaveLength(2);
  });

  it("pops back to the parent frame after a nested object closes", () => {
    const text = '{ $lookup: { from: "orders" }, ';
    const pos = completionPositionAt(text, text.length);
    expect(pos.path).toHaveLength(2);
    expect(pos.path.at(-1)?.key).toBeNull();
    expect(pos.slot).toBe("key");
  });
});

describe("siblingStringValue", () => {
  it("reads a quoted sibling value from inside the same frame", () => {
    const text = '{ $lookup: { from: "orders", localField: "id" } }';
    const pos = completionPositionAt(text, text.indexOf("localField"));
    const frame = pos.path.at(-1)!;
    expect(siblingStringValue(text, frame, "from")).toBe("orders");
  });

  it("returns null when the key is absent", () => {
    const text = '{ $lookup: { localField: "id" } }';
    const pos = completionPositionAt(text, text.indexOf("localField"));
    const frame = pos.path.at(-1)!;
    expect(siblingStringValue(text, frame, "from")).toBeNull();
  });

  it("returns null for the virtual root frame", () => {
    const text = "{ }";
    const pos = completionPositionAt(text, 1);
    expect(siblingStringValue(text, pos.path[0], "from")).toBeNull();
  });
});

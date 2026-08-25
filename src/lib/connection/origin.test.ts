import { describe, expect, it } from "vitest";

import type { HasOrigin } from "./origin";
import { filterByScope, isFromOrigin, originIdOf } from "./origin";

/** `HasOrigin` is a weak type, so an id-only fixture needs the annotation. */
type Fixture = HasOrigin & { id: string };

const local: Fixture = { id: "a", origin_id: null };
const shared: Fixture = { id: "b", origin_id: "origin-1" };
const blank: Fixture = { id: "c", origin_id: "" };
const absent: Fixture = { id: "d" };

describe("isFromOrigin", () => {
  it("is false for a local profile, however the field is spelled", () => {
    expect(isFromOrigin(local)).toBe(false);
    expect(isFromOrigin(absent)).toBe(false);
    expect(isFromOrigin(undefined)).toBe(false);
    expect(isFromOrigin(null)).toBe(false);
  });

  // An empty string is a field serde will round-trip happily; treating it as
  // "shared" would make the profile read-only with no origin to look up.
  it("treats an empty origin id as local", () => {
    expect(isFromOrigin(blank)).toBe(false);
  });

  it("is true for a profile a shared origin published", () => {
    expect(isFromOrigin(shared)).toBe(true);
  });
});

describe("originIdOf", () => {
  it("returns the owning origin id", () => {
    expect(originIdOf(shared)).toBe("origin-1");
  });

  it("normalises every local spelling to null", () => {
    expect(originIdOf(local)).toBeNull();
    expect(originIdOf(blank)).toBeNull();
    expect(originIdOf(absent)).toBeNull();
    expect(originIdOf(undefined)).toBeNull();
  });
});

describe("filterByScope", () => {
  const all = [local, shared, blank, absent];

  it("hands back the same array for `all`, not a copy", () => {
    expect(filterByScope(all, "all")).toBe(all);
  });

  it("splits the list on provenance", () => {
    expect(filterByScope(all, "local")).toEqual([local, blank, absent]);
    expect(filterByScope(all, "shared")).toEqual([shared]);
  });

  it("preserves the input order within a scope", () => {
    const many: Fixture[] = [shared, local, { id: "e", origin_id: "origin-2" }];
    expect(filterByScope(many, "shared").map((p) => p.id)).toEqual(["b", "e"]);
  });
});

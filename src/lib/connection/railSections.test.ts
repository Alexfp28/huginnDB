import { describe, expect, it } from "vitest";

import { buildRailSections } from "./railSections";
import type { ConnectionProfile } from "@/types";

function profile(
  id: string,
  extra: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    id,
    name: id,
    driver: "postgres",
    host: "localhost",
    port: 5432,
    database: "db",
    username: "u",
    ssl: false,
    ...extra,
  } as ConnectionProfile;
}

const NAMES: Record<string, string> = { o1: "ERP", o2: "Industria" };
const nameOf = (id: string) => NAMES[id] ?? null;
const labels = {
  shared: (origin: string) => `Shared · ${origin}`,
  orphaned: "Shared · unknown origin",
};

const localA = profile("a");
const localB = profile("b", { group: "Producción" });
const sharedA = profile("c", { origin_id: "o1", group: "Producción" });
const sharedB = profile("d", { origin_id: "o1" });
const sharedC = profile("e", { origin_id: "o2" });
const orphan = profile("f", { origin_id: "gone" });
const all = [localA, localB, sharedA, sharedB, sharedC, orphan];

describe("buildRailSections", () => {
  it("returns nothing for an empty scope", () => {
    expect(buildRailSections([], "all", nameOf, labels)).toEqual([]);
    expect(
      buildRailSections([sharedA], "local", nameOf, labels),
    ).toEqual([]);
  });

  // The `all` / `local` layout must stay exactly what the rail rendered before
  // provenance existed: one headerless list, grouped by `group`.
  it("gives `all` and `local` a single headerless section", () => {
    for (const scope of ["all", "local"] as const) {
      const [only, ...rest] = buildRailSections(all, scope, nameOf, labels);
      expect(rest).toEqual([]);
      expect(only.label).toBeNull();
      expect(only.originId).toBeNull();
      expect(only.readOnly).toBe(false);
    }
  });

  it("splits `shared` into one section per origin, named and read-only", () => {
    const sections = buildRailSections(all, "shared", nameOf, labels);
    expect(sections.map((s) => s.label)).toEqual([
      "Shared · ERP",
      "Shared · Industria",
      "Shared · unknown origin",
    ]);
    expect(sections.every((s) => s.readOnly)).toBe(true);
    expect(sections[0].ids).toEqual(["d", "c"]);
    expect(sections[1].ids).toEqual(["e"]);
  });

  it("orders origin sections by name, not by id or insertion", () => {
    // "Industria" is registered second but appears first once the ids sort the
    // other way round.
    const names: Record<string, string> = { zz: "Alfa", aa: "Zulu" };
    const sections = buildRailSections(
      [profile("x", { origin_id: "aa" }), profile("y", { origin_id: "zz" })],
      "shared",
      (id) => names[id] ?? null,
      labels,
    );
    expect(sections.map((s) => s.label)).toEqual([
      "Shared · Alfa",
      "Shared · Zulu",
    ]);
  });

  // A profile whose origin was unregistered keeps a dangling `origin_id` and is
  // still read-only, so it can't be filed under "local".
  it("puts a dangling origin id in one trailing section", () => {
    const sections = buildRailSections([orphan], "shared", nameOf, labels);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Shared · unknown origin");
    expect(sections[0].originId).toBeNull();
    expect(sections[0].readOnly).toBe(true);
  });

  // The decision this module exists for: the same group name on both sides of
  // the provenance split must not merge into one header.
  it("keeps a group name that exists locally and in an origin apart", () => {
    const local = buildRailSections(all, "local", nameOf, labels)[0];
    const shared = buildRailSections(all, "shared", nameOf, labels)[0];
    expect(local.groups.map((g) => g.name)).toEqual(["Producción"]);
    expect(shared.groups.map((g) => g.name)).toEqual(["Producción"]);
    expect(local.groups[0].items).toEqual([localB]);
    expect(shared.groups[0].items).toEqual([sharedA]);
  });

  it("lists `ids` in render order, groups included", () => {
    const [section] = buildRailSections(all, "all", nameOf, labels);
    // Ungrouped first, then each group's rows — what the rail paints.
    expect(section.ungrouped.map((p) => p.id)).toEqual(["a", "d", "e", "f"]);
    expect(section.groups.map((g) => g.name)).toEqual(["Producción"]);
    expect(section.ids).toEqual(["a", "d", "e", "f", "b", "c"]);
  });
});

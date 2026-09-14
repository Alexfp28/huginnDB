import { describe, expect, it } from "vitest";
import type { OriginPeek, OriginScope } from "@/types";
import {
  FULL_SCOPE,
  isEmptyScope,
  isFullScope,
  originScope,
  scopeWarnings,
  slicesAvailable,
} from "./scope";

const scope = (over: Partial<OriginScope> = {}): OriginScope => ({
  ...FULL_SCOPE,
  ...over,
});

const peek = (over: Partial<OriginPeek> = {}): OriginPeek => ({
  kind: "environment",
  encrypted: false,
  connections: 3,
  environments: 2,
  schemas: 1,
  bindings: 1,
  ...over,
});

describe("originScope", () => {
  it("reads an origin registered before the field existed as pulling everything", () => {
    // The load-bearing one. A closed reading here would tell the user their
    // origin pulls nothing, while the backend keeps pulling everything.
    expect(originScope({})).toEqual(FULL_SCOPE);
    expect(originScope({ scope: undefined })).toEqual(FULL_SCOPE);
  });

  it("honours a stored scope verbatim", () => {
    const stored = scope({ environments: false, schemas: false });
    expect(originScope({ scope: stored })).toEqual(stored);
  });
});

describe("isFullScope / isEmptyScope", () => {
  it("separates all, some and none", () => {
    expect(isFullScope(FULL_SCOPE)).toBe(true);
    expect(isFullScope(scope({ schemas: false }))).toBe(false);
    expect(isEmptyScope(scope({ schemas: false }))).toBe(false);
    expect(
      isEmptyScope({ connections: false, environments: false, schemas: false }),
    ).toBe(true);
  });
});

describe("slicesAvailable", () => {
  it("offers everything while the file is still unread", () => {
    expect(slicesAvailable()).toEqual(FULL_SCOPE);
    expect(slicesAvailable(null)).toEqual(FULL_SCOPE);
  });

  it("limits a plain profile bundle to connections", () => {
    // Including the legacy `""` kind, which every check treats as "profiles".
    for (const kind of ["profiles", ""]) {
      expect(slicesAvailable(peek({ kind }))).toEqual({
        connections: true,
        environments: false,
        schemas: false,
      });
    }
  });

  it("offers all three for an environment file", () => {
    expect(slicesAvailable(peek())).toEqual(FULL_SCOPE);
  });
});

describe("scopeWarnings", () => {
  it("says nothing about an ordinary connections-only subscription", () => {
    // The case the whole feature exists for: "I already have my environments,
    // I just want the servers." It must be silent.
    expect(
      scopeWarnings(scope({ environments: false, schemas: false }), peek()),
    ).toEqual([]);
  });

  it("says nothing when everything is pulled", () => {
    expect(scopeWarnings(FULL_SCOPE, peek())).toEqual([]);
  });

  it("flags a registration that would do nothing, and only that", () => {
    const none = { connections: false, environments: false, schemas: false };
    expect(scopeWarnings(none, peek())).toEqual(["origins.scope.warnEmpty"]);
  });

  it("flags environments pulled without their connections", () => {
    expect(
      scopeWarnings(scope({ connections: false, schemas: false }), peek()),
    ).toEqual(["origins.scope.warnEnvironmentsWithoutConnections"]);
  });

  it("flags schemas pulled without their connections", () => {
    expect(
      scopeWarnings(scope({ connections: false, environments: false }), peek()),
    ).toEqual(["origins.scope.warnSchemasWithoutConnections"]);
  });

  it("stays quiet about a slice the file does not actually publish", () => {
    // An environment file carrying no environments and no bindings cannot
    // produce an empty environment or a disabled binding, so warning would be
    // noise about something that cannot happen.
    expect(
      scopeWarnings(
        scope({ connections: false }),
        peek({ environments: 0, bindings: 0 }),
      ),
    ).toEqual([]);
  });

  it("warns on an unread file rather than assuming the best", () => {
    expect(scopeWarnings(scope({ connections: false }))).toEqual([
      "origins.scope.warnEnvironmentsWithoutConnections",
      "origins.scope.warnSchemasWithoutConnections",
    ]);
  });
});

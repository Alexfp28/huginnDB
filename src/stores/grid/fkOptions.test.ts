import { afterEach, describe, expect, it } from "vitest";
import { fkOptionsCache } from "./fkOptions";

const page = { kind: "ready" as const, options: [{ value: "1", label: null }] };

function seed(connectionId: string) {
  fkOptionsCache.set(connectionId, "public", "artist", "id", page);
}

afterEach(() => {
  for (const id of ["c1", "c10", "c1::db::shop", "c2"]) {
    fkOptionsCache.clearConnection(id);
  }
});

describe("fkOptionsCache.clearConnection", () => {
  it("drops the connection's entries and its multi-DB children", () => {
    seed("c1");
    seed("c1::db::shop");
    fkOptionsCache.clearConnection("c1");
    expect(fkOptionsCache.get("c1", "public", "artist", "id")).toBeUndefined();
    expect(
      fkOptionsCache.get("c1::db::shop", "public", "artist", "id"),
    ).toBeUndefined();
  });

  it("leaves other connections alone, including ones sharing a prefix", () => {
    seed("c1");
    seed("c10");
    seed("c2");
    fkOptionsCache.clearConnection("c1");
    expect(fkOptionsCache.get("c10", "public", "artist", "id")).toEqual(page);
    expect(fkOptionsCache.get("c2", "public", "artist", "id")).toEqual(page);
  });
});

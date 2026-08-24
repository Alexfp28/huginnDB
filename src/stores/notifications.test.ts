import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reads one preference — the history cap — and nothing else. Stubbing
// the preferences store keeps this a test of the history semantics rather than
// of `prefs.json` hydration (which would drag in the Tauri IPC wrapper).
let historyLimit = 50;
vi.mock("@/stores/preferences/preferences", () => ({
  usePreferences: {
    getState: () => ({ prefs: { notifications: { historyLimit } } }),
  },
}));

const { useNotifications } = await import("./notifications");

function push(title: string, over: Record<string, unknown> = {}) {
  return useNotifications.getState().push({ kind: "success", title, ...over });
}

describe("useNotifications", () => {
  beforeEach(() => {
    historyLimit = 50;
    useNotifications.getState().clear();
  });

  it("keeps entries newest-first", () => {
    push("first");
    push("second");
    expect(useNotifications.getState().entries.map((e) => e.title)).toEqual([
      "second",
      "first",
    ]);
  });

  it("starts every entry unread with a count of one", () => {
    push("only");
    const [entry] = useNotifications.getState().entries;
    expect(entry.count).toBe(1);
    expect(entry.read).toBe(false);
  });

  it("caps the list at the configured limit, dropping the oldest", () => {
    historyLimit = 3;
    for (const title of ["a", "b", "c", "d"]) push(title);
    expect(useNotifications.getState().entries.map((e) => e.title)).toEqual([
      "d",
      "c",
      "b",
    ]);
  });

  it("keeps nothing when the history is turned off", () => {
    historyLimit = 0;
    push("gone");
    expect(useNotifications.getState().entries).toHaveLength(0);
  });

  it("folds a repeat into the entry it was told to bump", () => {
    const id = push("Cell saved", { description: "row 4" });
    push("Something else");
    useNotifications
      .getState()
      .bump(id, { count: 3, title: "Cell saved", description: "row 9" });

    const entry = useNotifications.getState().entries.find((e) => e.id === id);
    expect(entry?.count).toBe(3);
    // The latest wording wins: it describes the occurrence the user just saw.
    expect(entry?.description).toBe("row 9");
    expect(entry?.read).toBe(false);
    // Still two entries — a bump is an update, never an insert.
    expect(useNotifications.getState().entries).toHaveLength(2);
  });

  it("clears a stale `missing` flag when the group writes a new file", () => {
    const id = push("Table exported", {
      kind: "file",
      file: { path: "/tmp/a.csv", name: "a.csv" },
    });
    useNotifications.getState().markMissing(id);
    expect(useNotifications.getState().entries[0].missing).toBe(true);

    useNotifications.getState().bump(id, {
      count: 2,
      title: "Table exported",
      file: { path: "/tmp/b.csv", name: "b.csv" },
    });
    const entry = useNotifications.getState().entries[0];
    expect(entry.missing).toBeUndefined();
    expect(entry.file?.name).toBe("b.csv");
  });

  it("ignores a bump for an entry the cap already evicted", () => {
    historyLimit = 1;
    const first = push("a");
    push("b");
    expect(() =>
      useNotifications.getState().bump(first, { count: 2, title: "a" }),
    ).not.toThrow();
    expect(useNotifications.getState().entries.map((e) => e.title)).toEqual(["b"]);
  });

  it("marks everything read without churning the array when nothing changed", () => {
    push("a");
    push("b");
    useNotifications.getState().markAllRead();
    const after = useNotifications.getState().entries;
    expect(after.every((e) => e.read)).toBe(true);

    useNotifications.getState().markAllRead();
    // Same reference: a no-op must not hand every subscriber a new array.
    expect(useNotifications.getState().entries).toBe(after);
  });

  it("removes one entry by id", () => {
    const id = push("a");
    push("b");
    useNotifications.getState().remove(id);
    expect(useNotifications.getState().entries.map((e) => e.title)).toEqual(["b"]);
  });
});

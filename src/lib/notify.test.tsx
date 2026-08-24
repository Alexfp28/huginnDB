import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The policy in `notify` — how long each kind lives, when an error stops
 * expiring, and what counts as a repeat — is invisible until it is wrong: a
 * broken multiplier looks like "the notification felt short". These pin it.
 */

interface Captured {
  id: string;
  duration: number;
  dismissible?: boolean;
  onAutoClose?: () => void;
  onDismiss?: () => void;
}

const captured: Captured[] = [];
const toastDismiss = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    custom: (_jsx: unknown, opts: Captured) => {
      captured.push(opts);
      return opts.id;
    },
    dismiss: toastDismiss,
  },
}));

// The card is a React component reaching for Tauri and i18n; nothing about it
// is under test here.
vi.mock("@/components/shell/NotificationCard", () => ({
  NotificationCard: () => null,
}));
vi.mock("@/lib/grid/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

const prefs = {
  position: "bottom-right",
  durationMs: 6000,
  errorsPersist: true,
  maxVisible: 3,
  expandOnHover: true,
  density: "comfortable" as const,
  historyLimit: 50,
  showBell: true,
};
vi.mock("@/stores/preferences/preferences", () => ({
  usePreferences: { getState: () => ({ prefs: { notifications: prefs } }) },
}));

const { notify, useToastStack } = await import("./notify");
const { useNotifications } = await import("@/stores/notifications");

/** The most recent `toast.custom` call. */
const last = () => captured[captured.length - 1];

// `notify` keeps its live groups in module state, so each test starts a minute
// later than the last: a leftover group can never fall inside the 5 s window.
let clock = Date.parse("2026-08-24T10:00:00Z");

beforeEach(() => {
  clock += 60_000;
  captured.length = 0;
  toastDismiss.mockClear();
  prefs.durationMs = 6000;
  prefs.errorsPersist = true;
  prefs.maxVisible = 3;
  useNotifications.getState().clear();
  useToastStack.setState({ entries: [] });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(clock));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("duration", () => {
  it("gives a confirmation the configured duration", () => {
    notify.success("Cell saved");
    expect(last().duration).toBe(6000);
  });

  it("gives a warning twice as long — it has to be read, not just noticed", () => {
    notify.warning("Import finished with 3 rows skipped");
    expect(last().duration).toBe(12000);
  });

  it("gives a file notification the longest run, since it is there to be clicked", () => {
    notify.file("Table exported", { path: "/tmp/artist.csv" });
    expect(last().duration).toBe(24000);
  });

  it("caps the multiplied lifetime", () => {
    prefs.durationMs = 20000;
    notify.file("Table exported", { path: "/tmp/artist.csv" });
    expect(last().duration).toBe(30000);
  });

  it("keeps an error until it is dismissed by default", () => {
    notify.error("Could not save the cell");
    expect(last().duration).toBe(Infinity);
  });

  it("lets an error expire when the user turned that off", () => {
    prefs.errorsPersist = false;
    notify.error("Could not save the cell");
    expect(last().duration).toBe(12000);
  });

  it("treats a configured 0 as until-dismissed for every kind", () => {
    prefs.durationMs = 0;
    notify.success("Cell saved");
    expect(last().duration).toBe(Infinity);
  });

  it("honours a per-call override of 0", () => {
    notify.success("Cell saved", { durationMs: 0 });
    expect(last().duration).toBe(Infinity);
  });

  it("clamps a duration below the floor rather than flashing", () => {
    prefs.durationMs = 10;
    notify.success("Cell saved");
    expect(last().duration).toBe(1500);
  });
});

describe("grouping", () => {
  it("folds a repeat into the same card and counts it", () => {
    notify.success("Cell saved");
    const first = last().id;
    notify.success("Cell saved");

    expect(last().id).toBe(first);
    expect(captured).toHaveLength(2);
    // One history entry, not two.
    const entries = useNotifications.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
  });

  it("starts a fresh card once the grouping window has passed", () => {
    notify.success("Cell saved");
    const first = last().id;
    vi.advanceTimersByTime(6000);
    notify.success("Cell saved");

    expect(last().id).not.toBe(first);
    expect(useNotifications.getState().entries).toHaveLength(2);
  });

  it("does not group across kinds or titles", () => {
    notify.success("Cell saved");
    notify.success("Row deleted");
    notify.error("Cell saved");
    expect(new Set(captured.map((c) => c.id)).size).toBe(3);
  });

  it("groups by an explicit key when the titles differ", () => {
    notify.success("Saved Artist", { group: "cell-save" });
    const first = last().id;
    notify.success("Saved Album", { group: "cell-save" });
    expect(last().id).toBe(first);
    expect(useNotifications.getState().entries).toHaveLength(1);
  });

  it("never groups when asked not to", () => {
    notify.success("Cell saved", { group: false });
    notify.success("Cell saved", { group: false });
    expect(new Set(captured.map((c) => c.id)).size).toBe(2);
    expect(useNotifications.getState().entries).toHaveLength(2);
  });

  it("ends the group when the card closes, so the next one starts at one", () => {
    notify.success("Cell saved");
    const first = last().id;
    last().onAutoClose?.();
    notify.success("Cell saved");

    expect(last().id).not.toBe(first);
    expect(useNotifications.getState().entries[0].count).toBe(1);
  });
});

describe("history", () => {
  it("records the file so the panel can reveal it later", () => {
    notify.file("Table exported", {
      path: "C:\\Users\\me\\exports\\artist.csv",
      size: "18 KB",
    });
    const [entry] = useNotifications.getState().entries;
    expect(entry.kind).toBe("file");
    expect(entry.file).toEqual({
      path: "C:\\Users\\me\\exports\\artist.csv",
      name: "artist.csv",
      size: "18 KB",
    });
  });

  it("monospaces an error description without being asked", () => {
    notify.error("Could not save the cell", { description: "ERROR 1062" });
    expect(useNotifications.getState().entries[0].mono).toBe(true);
  });
});

describe("progress", () => {
  it("starts as a persistent, non-dismissible card and records nothing yet", () => {
    notify.progress("Importing connections…");

    expect(last().duration).toBe(Infinity);
    expect(last().dismissible).toBe(false);
    expect(useNotifications.getState().entries).toHaveLength(0);
  });

  it("updates the same card in place as ticks arrive", () => {
    const handle = notify.progress("Importing connections…");
    const toastId = last().id;

    handle.update({ done: 1, total: 4 });
    handle.update({ done: 2, total: 4 });

    expect(captured).toHaveLength(3);
    expect(new Set(captured.map((c) => c.id))).toEqual(new Set([toastId]));
  });

  it("resolves into the same slot and records the outcome, not the progress", () => {
    const handle = notify.progress("Importing connections…");
    const toastId = last().id;

    handle.update({ done: 4, total: 4 });
    handle.success("Import complete");

    expect(last().id).toBe(toastId);
    expect(useNotifications.getState().entries).toHaveLength(1);
    expect(useNotifications.getState().entries[0]).toMatchObject({
      kind: "success",
      title: "Import complete",
    });
  });

  it("resolves into an error card when the task failed", () => {
    const handle = notify.progress("Importing connections…");
    handle.error("Import failed", { description: "bad passphrase" });

    expect(useNotifications.getState().entries[0]).toMatchObject({
      kind: "error",
      title: "Import failed",
    });
  });

  it("ignores anything after it has already settled", () => {
    const handle = notify.progress("Importing connections…");
    handle.success("Import complete");
    handle.error("Import failed");
    handle.update({ done: 1, total: 1 });

    expect(useNotifications.getState().entries).toHaveLength(1);
  });

  it("never groups two concurrent progress bars into one card", () => {
    notify.progress("Importing profiles…");
    notify.progress("Importing environments…");

    expect(new Set(captured.map((c) => c.id)).size).toBe(2);
  });

  it("dismisses without recording anything", () => {
    const handle = notify.progress("Importing connections…");
    handle.dismiss();

    expect(toastDismiss).toHaveBeenCalled();
    expect(useNotifications.getState().entries).toHaveLength(0);
  });
});

describe("stack protection", () => {
  // "Un error nunca es desalojado": when the stack is full, the oldest
  // *confirmation* closes, never an open error — see the Stack.dc.html
  // canvas artboard this pins.
  it("evicts the oldest confirmation instead of pushing a live error behind maxVisible", () => {
    prefs.maxVisible = 2;
    notify.error("Connection lost");
    const errorId = last().id;
    notify.success("Row saved");

    notify.success("Cell updated");

    expect(toastDismiss).toHaveBeenCalledTimes(1);
    expect(toastDismiss).not.toHaveBeenCalledWith(errorId);
  });

  it("gives the same protection to a live progress bar", () => {
    prefs.maxVisible = 2;
    const handle = notify.progress("Importing…");
    notify.success("Row saved");

    notify.success("Cell updated");

    expect(toastDismiss).toHaveBeenCalledTimes(1);
    // The progress card itself was never the one dismissed.
    handle.dismiss();
    expect(toastDismiss).toHaveBeenCalledTimes(2);
  });

  it("does not evict anything when the boundary slot is not protected", () => {
    prefs.maxVisible = 2;
    notify.success("Row saved");
    notify.success("Cell updated");
    notify.success("Table exported");

    expect(toastDismiss).not.toHaveBeenCalled();
  });
});

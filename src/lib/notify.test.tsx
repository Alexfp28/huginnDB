import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The policy in `notify` — how long each kind lives, when an error stops
 * expiring, and what counts as a repeat — is invisible until it is wrong: a
 * broken multiplier looks like "the notification felt short". These pin it.
 */

interface Captured {
  id: string;
  duration: number;
  onAutoClose?: () => void;
  onDismiss?: () => void;
}

const captured: Captured[] = [];
vi.mock("sonner", () => ({
  toast: {
    custom: (_jsx: unknown, opts: Captured) => {
      captured.push(opts);
      return opts.id;
    },
    dismiss: vi.fn(),
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

const { notify } = await import("./notify");
const { useNotifications } = await import("@/stores/notifications");

/** The most recent `toast.custom` call. */
const last = () => captured[captured.length - 1];

// `notify` keeps its live groups in module state, so each test starts a minute
// later than the last: a leftover group can never fall inside the 5 s window.
let clock = Date.parse("2026-08-24T10:00:00Z");

beforeEach(() => {
  clock += 60_000;
  captured.length = 0;
  prefs.durationMs = 6000;
  prefs.errorsPersist = true;
  useNotifications.getState().clear();
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

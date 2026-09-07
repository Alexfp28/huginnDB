import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The policy in `notify` — how long each kind lives, when an error stops
 * expiring, and what counts as a repeat — is invisible until it is wrong: a
 * broken multiplier looks like "the notification felt short". These pin it.
 */

interface Captured {
  id: string;
  /** Which host Sonner will route it to; `undefined` is the default (card). */
  toasterId?: string;
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
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

const prefs = {
  position: "bottom-right",
  pillPosition: "bottom-center",
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
  prefs.position = "bottom-right";
  prefs.pillPosition = "bottom-center";
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

  // A bare warning is a pill now: one line, nothing to act on, and the bell
  // keeps it either way — so it takes the base duration like any other pill.
  it("gives a bare warning the base duration — a pill is noticed, not read", () => {
    notify.warning("Import finished with 3 rows skipped");
    expect(last().duration).toBe(6000);
  });

  // The ×2 was never about the word "warning": it buys reading time, and only
  // a card has anything to read. Carrying an action is what earns it back.
  it("gives a warning that carries an action twice as long", () => {
    notify.warning("Import finished with 3 rows skipped", {
      actions: [{ label: "View skipped", onClick: () => {} }],
    });
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
    // Both anatomies in one corner, which is what puts errors and
    // confirmations in the same stack at all.
    prefs.pillPosition = prefs.position;
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

  // Two stacks fold independently: a pill crossing its own boundary has no
  // business closing a card the user has not read, and vice versa.
  it("never evicts across hosts", () => {
    prefs.maxVisible = 2;
    notify.error("Connection lost");
    notify.success("Row saved");
    notify.success("Cell updated");
    notify.success("Table exported");

    // The three pills folded among themselves; the error is in the other
    // stack and was never a candidate.
    expect(toastDismiss).not.toHaveBeenCalled();
  });

  it("does not evict anything when the boundary slot is not protected", () => {
    prefs.maxVisible = 2;
    notify.success("Row saved");
    notify.success("Cell updated");
    notify.success("Table exported");

    expect(toastDismiss).not.toHaveBeenCalled();
  });
});

describe("surface", () => {
  // The whole point of `surfaceFor` is that no call site has to know the rule,
  // so these assert the rule itself rather than any one caller's behaviour.
  // `toasterId` is the observable: the pill host is the one with an id.
  const PILLS = "huginn-pills";

  it("puts a bare confirmation on a pill", () => {
    notify.success("Cell saved");
    expect(last().toasterId).toBe(PILLS);
  });

  it("keeps info on a pill too", () => {
    notify.info("Connection restored", { description: "prod-eu" });
    expect(last().toasterId).toBe(PILLS);
  });

  it("never puts an error on a pill — it carries a message to copy", () => {
    notify.error("Could not save the cell");
    expect(last().toasterId).toBeUndefined();
  });

  it("never puts a file notification on a pill — the buttons are the point", () => {
    notify.file("Table exported", { path: "/tmp/artist.csv" });
    expect(last().toasterId).toBeUndefined();
  });

  it("escalates anything carrying an action — a pill has no room for a button", () => {
    notify.success("Row saved", {
      actions: [{ label: "Undo", onClick: () => {} }],
    });
    expect(last().toasterId).toBeUndefined();
  });

  it("escalates a description that would wrap to a second line", () => {
    notify.success("Import finished", {
      description: "x".repeat(29),
    });
    expect(last().toasterId).toBeUndefined();
  });

  it("keeps a description that still fits", () => {
    notify.success("Import finished", { description: "x".repeat(28) });
    expect(last().toasterId).toBe(PILLS);
  });

  it("escalates when title and description together outgrow the line", () => {
    notify.success("y".repeat(40), { description: "x".repeat(20) });
    expect(last().toasterId).toBeUndefined();
  });

  it("escalates a description that already contains a newline", () => {
    notify.success("Import finished", { description: "one\ntwo" });
    expect(last().toasterId).toBeUndefined();
  });

  it("runs a progress bar as a pill", () => {
    notify.progress("Exporting Track…");
    expect(last().toasterId).toBe(PILLS);
  });

  // Both anatomies in one corner is the user asking for a single stack, not a
  // collision: the pill host is not mounted, so nothing may be tagged for it.
  it("tags nothing for the pill host when both stacks share a corner", () => {
    prefs.pillPosition = prefs.position;
    notify.success("Cell saved");
    expect(last().toasterId).toBeUndefined();
  });
});

describe("progress re-homing", () => {
  it("keeps its slot when the outcome renders the same way", () => {
    const handle = notify.progress("Importing connections…");
    const toastId = last().id;

    handle.success("Import complete");

    expect(last().id).toBe(toastId);
    expect(last().toasterId).toBe("huginn-pills");
    expect(toastDismiss).not.toHaveBeenCalled();
  });

  // A pill cannot become a card in place: the two live in different hosts, so
  // the running bar is withdrawn and the error raised fresh in the card stack.
  it("moves to the card host when it fails, instead of relabelling in place", () => {
    const handle = notify.progress("Importing connections…");
    const progressId = last().id;

    handle.error("Import failed", { description: "bad passphrase" });

    expect(toastDismiss).toHaveBeenCalledWith(progressId);
    expect(last().id).not.toBe(progressId);
    expect(last().toasterId).toBeUndefined();
    // The outcome is still recorded exactly once, and as the outcome.
    expect(useNotifications.getState().entries).toHaveLength(1);
    expect(useNotifications.getState().entries[0]).toMatchObject({
      kind: "error",
      title: "Import failed",
    });
  });
});

describe("grouping across anatomies", () => {
  // A repeat that would render the other way cannot fold into the live card:
  // doing so would drop whatever earned it the escalation.
  it("breaks the group rather than folding an escalated repeat into a pill", () => {
    notify.success("Row saved");
    const pillId = last().id;

    notify.success("Row saved", {
      actions: [{ label: "Undo", onClick: () => {} }],
    });

    expect(last().id).not.toBe(pillId);
    expect(last().toasterId).toBeUndefined();
    // Two separate notifications, not one folded to ×2.
    expect(useNotifications.getState().entries).toHaveLength(2);
  });
});

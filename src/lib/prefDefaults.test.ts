import { describe, expect, it } from "vitest";
import type { Preferences } from "@/types";
import {
  isPrefModified,
  modifiedPrefIds,
  resettablePath,
  withDefaults,
} from "./prefDefaults";

/**
 * A hand-built snapshot rather than the store's `DEFAULT_PREFS`: importing the
 * store drags in Tauri, and these tests are about the path/identity rules, not
 * about what the stock values happen to be.
 */
const defaults = {
  version: 1,
  editor: { fontSize: 13, wordWrap: false, theme: "huginn-dark" },
  grid: { defaultPageSize: 100 },
  ui: { language: "en", confirmDestructive: true, defaultDriver: null },
  notifications: { durationMs: 6000 },
  connections: { keepaliveSecs: 180 },
  pulse: { retentionDays: 30 },
  ai: { enabled: false, model: "" },
  themes: {},
  keybindings: {},
} as unknown as Preferences;

const withPatch = (patch: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(defaults).map(([group, value]) => [
      group,
      patch[group] ? { ...(value as object), ...patch[group] } : value,
    ]),
  ) as unknown as Preferences;

describe("resettablePath", () => {
  it("splits a knob into its group and key", () => {
    expect(resettablePath("editor.fontSize")).toEqual({
      group: "editor",
      key: "fontSize",
    });
  });

  it("refuses the groups and ids that describe configuration, not taste", () => {
    expect(resettablePath("ai.model")).toBeNull();
    expect(resettablePath("ai.enabled")).toBeNull();
    expect(resettablePath("ui.language")).toBeNull();
    expect(resettablePath("keybinding.openSettings")).toBeNull();
  });
});

describe("isPrefModified", () => {
  it("is false at the default and true off it", () => {
    expect(isPrefModified(defaults, defaults, "editor.fontSize")).toBe(false);
    const prefs = withPatch({ editor: { fontSize: 14 } });
    expect(isPrefModified(prefs, defaults, "editor.fontSize")).toBe(true);
  });

  it("treats a null default as a value like any other", () => {
    const prefs = withPatch({ ui: { defaultDriver: "postgres" } });
    expect(isPrefModified(prefs, defaults, "ui.defaultDriver")).toBe(true);
    expect(isPrefModified(defaults, defaults, "ui.defaultDriver")).toBe(false);
  });

  it("never reports a setting that has no reset, however far it moved", () => {
    const prefs = withPatch({ ui: { language: "es" }, ai: { model: "llama3" } });
    expect(isPrefModified(prefs, defaults, "ui.language")).toBe(false);
    expect(isPrefModified(prefs, defaults, "ai.model")).toBe(false);
  });
});

describe("modifiedPrefIds", () => {
  it("keeps only the ids that moved, in the order given", () => {
    const prefs = withPatch({
      editor: { wordWrap: true, fontSize: 15 },
      ai: { enabled: true },
    });
    expect(
      modifiedPrefIds(prefs, defaults, [
        "editor.wordWrap",
        "editor.theme",
        "ai.enabled",
        "editor.fontSize",
      ]),
    ).toEqual(["editor.wordWrap", "editor.fontSize"]);
  });
});

describe("withDefaults", () => {
  it("returns the same object when there is nothing to reset", () => {
    expect(withDefaults(defaults, defaults, ["editor.fontSize"])).toBe(defaults);
    const prefs = withPatch({ ai: { model: "llama3" } });
    expect(withDefaults(prefs, defaults, ["ai.model"])).toBe(prefs);
  });

  it("resets only the listed ids and keeps untouched groups' identity", () => {
    const prefs = withPatch({
      editor: { fontSize: 15, wordWrap: true },
      grid: { defaultPageSize: 500 },
    });
    const next = withDefaults(prefs, defaults, ["editor.fontSize"]);
    expect(next).not.toBe(prefs);
    expect(next.editor).toEqual({ ...prefs.editor, fontSize: 13 });
    expect(next.editor.wordWrap).toBe(true);
    // The slice selectors depend on this: a group nobody reset must be the
    // very same object, or every subscriber to it re-renders.
    expect(next.grid).toBe(prefs.grid);
    expect(next.ui).toBe(prefs.ui);
  });

  it("resets across groups in one pass", () => {
    const prefs = withPatch({
      notifications: { durationMs: 10000 },
      connections: { keepaliveSecs: 60 },
    });
    const next = withDefaults(prefs, defaults, [
      "notifications.durationMs",
      "connections.keepaliveSecs",
    ]);
    expect(next.notifications.durationMs).toBe(6000);
    expect(next.connections.keepaliveSecs).toBe(180);
  });
});

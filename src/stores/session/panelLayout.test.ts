/**
 * @vitest-environment jsdom
 *
 * Tests for the outer shell's layout store. The first four blocks are
 * characterization tests, written against the store *before* the right dock
 * grew a second occupant (Pulse) so the refactor had something to be measured
 * against; the last two cover what that refactor added. The store rehydrates
 * from `localStorage` at *module load*, so every case seeds storage and then
 * re-imports the module under `vi.resetModules()` — reaching for
 * `persist.rehydrate()` after the fact would test a different code path than
 * the one that actually runs at app boot.
 *
 * What these pin down, and why each is worth pinning: the defaults are the
 * shape every other consumer destructures; the clamps are the invariant that
 * kept the panel edge under the cursor (see `nudgePanel`'s doc comment); and
 * the persisted-blob cases are the only thing standing between a schema
 * change here and every user silently losing their layout on upgrade.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/constants";

type Store = typeof import("./panelLayout");

/** Seed `localStorage` the way `persist` writes it, then load the module. */
async function loadWith(persisted: unknown, version?: number): Promise<Store> {
  vi.resetModules();
  localStorage.clear();
  if (persisted !== undefined) {
    localStorage.setItem(
      STORAGE_KEYS.panelLayout,
      JSON.stringify({ state: persisted, version }),
    );
  }
  return import("./panelLayout");
}

beforeEach(() => {
  localStorage.clear();
});

describe("defaults", () => {
  it("opens the schema panel and nothing else", async () => {
    const { useSessionPanelLayout } = await loadWith(undefined);
    const s = useSessionPanelLayout.getState();

    expect(s.schemaOpen).toBe(true);
    expect(s.schemaWidth).toBe(280);
    expect(s.savedWidth).toBe(260);
    expect(s.consoleOpen).toBe(false);
    expect(s.consoleHeight).toBe(190);
    expect(s.sideEditorOpen).toBe(false);
    expect(s.sideEditorWidth).toBe(420);
  });
});

describe("nudgePanel", () => {
  it("clamps each key to its own bounds", async () => {
    const { useSessionPanelLayout, PANEL_CLAMPS } = await loadWith(undefined);

    useSessionPanelLayout.getState().nudgePanel("schemaWidth", -9999);
    expect(useSessionPanelLayout.getState().schemaWidth).toBe(
      PANEL_CLAMPS.schemaWidth.min,
    );

    useSessionPanelLayout.getState().nudgePanel("schemaWidth", 9999);
    expect(useSessionPanelLayout.getState().schemaWidth).toBe(
      PANEL_CLAMPS.schemaWidth.max,
    );

    useSessionPanelLayout.getState().nudgePanel("consoleHeight", 9999);
    expect(useSessionPanelLayout.getState().consoleHeight).toBe(
      PANEL_CLAMPS.consoleHeight.max,
    );
  });

  it("reads the current value from inside the update, not the caller's closure", async () => {
    const { useSessionPanelLayout } = await loadWith(undefined);
    // Two nudges dispatched back to back against a value read once: the
    // second must see the first's result, which is the whole reason
    // `nudgePanel` takes a delta instead of an absolute width.
    useSessionPanelLayout.getState().nudgePanel("schemaWidth", 20);
    useSessionPanelLayout.getState().nudgePanel("schemaWidth", 20);
    expect(useSessionPanelLayout.getState().schemaWidth).toBe(320);
  });
});

describe("rehydration", () => {
  it("restores sizes from a stored blob", async () => {
    const { useSessionPanelLayout } = await loadWith(
      {
        schemaOpen: false,
        schemaWidth: 333,
        savedWidth: 275,
        consoleOpen: true,
        consoleHeight: 240,
        sideEditorOpen: true,
        sideEditorWidth: 500,
      },
      1,
    );
    const s = useSessionPanelLayout.getState();

    expect(s.schemaOpen).toBe(false);
    expect(s.schemaWidth).toBe(333);
    expect(s.savedWidth).toBe(275);
    expect(s.consoleOpen).toBe(true);
    expect(s.consoleHeight).toBe(240);
    expect(s.sideEditorOpen).toBe(true);
    expect(s.sideEditorWidth).toBe(500);
  });

  it("falls back to the defaults for a blob from an unknown version", async () => {
    const { useSessionPanelLayout } = await loadWith(
      { schemaWidth: 333, consoleOpen: true },
      99,
    );
    const s = useSessionPanelLayout.getState();

    expect(s.schemaWidth).toBe(280);
    expect(s.consoleOpen).toBe(false);
  });
});

describe("resetLayout", () => {
  it("returns every value to its default", async () => {
    const { useSessionPanelLayout } = await loadWith(undefined);
    useSessionPanelLayout.getState().nudgePanel("schemaWidth", 100);
    useSessionPanelLayout.getState().toggleConsole();

    useSessionPanelLayout.getState().resetLayout();
    const s = useSessionPanelLayout.getState();

    expect(s.schemaWidth).toBe(280);
    expect(s.consoleOpen).toBe(false);
  });
});

describe("right dock", () => {
  it("selecting the active panel collapses the dock; selecting the other switches", async () => {
    const { useSessionPanelLayout } = await loadWith(undefined);
    const select = () => useSessionPanelLayout.getState().selectRightPanel;

    select()("saved");
    expect(useSessionPanelLayout.getState().rightPanel).toBe("saved");

    select()("pulse");
    expect(useSessionPanelLayout.getState().rightPanel).toBe("pulse");

    select()("pulse");
    expect(useSessionPanelLayout.getState().rightPanel).toBeNull();
  });

  it("remembers the last panel so the edge toggle brings it back", async () => {
    const { useSessionPanelLayout } = await loadWith(undefined);

    useSessionPanelLayout.getState().selectRightPanel("pulse");
    useSessionPanelLayout.getState().toggleRightDock();
    expect(useSessionPanelLayout.getState().rightPanel).toBeNull();

    useSessionPanelLayout.getState().toggleRightDock();
    expect(useSessionPanelLayout.getState().rightPanel).toBe("pulse");
  });

  it("keeps a separate width per panel", async () => {
    const { useSessionPanelLayout, rightPanelSizeKey } = await loadWith(undefined);

    useSessionPanelLayout.getState().nudgePanel(rightPanelSizeKey("saved"), 20);
    expect(useSessionPanelLayout.getState().savedWidth).toBe(280);
    expect(useSessionPanelLayout.getState().pulseWidth).toBe(320);
  });
});

describe("migration v1 → v2", () => {
  it("reopens the dock on Saved for someone who had it open", async () => {
    const { useSessionPanelLayout } = await loadWith(
      { savedOpen: true, savedWidth: 288, schemaWidth: 310 },
      1,
    );
    const s = useSessionPanelLayout.getState();

    expect(s.rightPanel).toBe("saved");
    expect(s.lastRightPanel).toBe("saved");
    // The rest of the layout must survive the schema change untouched — this
    // is the assertion that catches a lazy `return DEFAULTS` migration.
    expect(s.savedWidth).toBe(288);
    expect(s.schemaWidth).toBe(310);
    expect(s.pulseWidth).toBe(320);
  });

  it("leaves the dock collapsed for someone who had Saved closed", async () => {
    const { useSessionPanelLayout } = await loadWith(
      { savedOpen: false, consoleOpen: true, consoleHeight: 300 },
      1,
    );
    const s = useSessionPanelLayout.getState();

    expect(s.rightPanel).toBeNull();
    expect(s.lastRightPanel).toBe("saved");
    expect(s.consoleOpen).toBe(true);
    expect(s.consoleHeight).toBe(300);
  });

  it("does not carry the dead savedOpen key across", async () => {
    const { useSessionPanelLayout } = await loadWith({ savedOpen: true }, 1);
    expect("savedOpen" in useSessionPanelLayout.getState()).toBe(false);
  });

  it("leaves a v2 blob alone", async () => {
    const { useSessionPanelLayout } = await loadWith(
      { ...{ rightPanel: "pulse", lastRightPanel: "pulse", pulseWidth: 400 } },
      2,
    );
    const s = useSessionPanelLayout.getState();

    expect(s.rightPanel).toBe("pulse");
    expect(s.pulseWidth).toBe(400);
  });
});

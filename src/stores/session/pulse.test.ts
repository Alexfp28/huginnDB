/**
 * @vitest-environment jsdom
 *
 * `usePulse` mixes persisted UI state (`collapsedSections`) with in-memory
 * session state (the live series, on-demand detail reads, the pin). The only
 * thing worth pinning down here is `partialize`: a wrong one doesn't throw,
 * it just silently persists too much or too little, and this store's specific
 * failure mode — the rolling health series landing in `localStorage` — is
 * exactly the unbounded-file growth the design deliberately avoids (see the
 * module doc comment).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/lib/constants";
import { usePulse } from "./pulse";

function persisted(): Record<string, unknown> | null {
  const raw = localStorage.getItem(STORAGE_KEYS.pulse);
  if (!raw) return null;
  return JSON.parse(raw).state;
}

beforeEach(() => {
  localStorage.clear();
  usePulse.setState({
    samples: {},
    errors: {},
    pinnedConnectionId: null,
    topQueries: {},
    storage: {},
    collapsedSections: {},
  });
});

describe("toggleSection", () => {
  it("flips one section without touching the others", () => {
    usePulse.getState().toggleSection("alerts");
    expect(usePulse.getState().collapsedSections).toEqual({ alerts: true });

    usePulse.getState().toggleSection("storage");
    expect(usePulse.getState().collapsedSections).toEqual({
      alerts: true,
      storage: true,
    });

    usePulse.getState().toggleSection("alerts");
    expect(usePulse.getState().collapsedSections).toEqual({
      alerts: false,
      storage: true,
    });
  });
});

describe("persistence", () => {
  it("persists collapsedSections", () => {
    usePulse.getState().toggleSection("status");
    expect(persisted()).toEqual({ collapsedSections: { status: true } });
  });

  it("never persists the live series, on-demand reads or the pin", () => {
    usePulse.getState().push("conn-1", {
      driver: "mysql",
      serverVersion: "8.0",
      uptimeSecs: null,
      sampledAtMs: 1,
      metrics: [],
      notes: [],
    });
    usePulse.getState().setTopQueries("conn-1", { items: [], atMs: 1 });
    usePulse.getState().setStorage("conn-1", { items: [], atMs: 1 });
    usePulse.getState().setPinned("conn-1");
    usePulse.getState().toggleSection("slowest");

    const stored = persisted();
    expect(stored).toEqual({ collapsedSections: { slowest: true } });
    expect(stored).not.toHaveProperty("samples");
    expect(stored).not.toHaveProperty("topQueries");
    expect(stored).not.toHaveProperty("storage");
    expect(stored).not.toHaveProperty("pinnedConnectionId");
  });
});

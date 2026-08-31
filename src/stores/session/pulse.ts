/**
 * The live Pulse series, per connection.
 *
 * Kept in a store rather than in the panel's own state because the same
 * connection can be on screen twice — the side panel and the expanded Pulse
 * window — and two components each running their own five-second poll would
 * double the load on the very server they are measuring. One store, one
 * series, one clock; whoever is visible drives it (see `usePulseLive`).
 *
 * Only `collapsedSections` is persisted — a UI fold, not data. Everything
 * else stays in memory: the series is a rolling half hour that only exists
 * while Pulse is being watched (the durable history is the backend's job and
 * lands with the sampler), and the pin is deliberately session-only —
 * reopening the app pinned to a connection nobody remembers fixing is worse
 * than having to pin it again.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";
import type { PulseHealth, PulseStorageItem, PulseTopQuery } from "@/types";

/** The panel's four collapsible sections, keyed the same as `pulse.section.*`. */
export type PulseSectionId = "status" | "alerts" | "slowest" | "storage";

/** Half an hour at the five-second live interval. Past that the oldest sample
 *  falls off — the panel's charts cover the last 30 minutes and the expanded
 *  window reads longer spans from the history store, not from here. */
const MAX_SAMPLES = 360;

/**
 * A gap this long means nobody was watching (the panel was closed, the app was
 * in the background, the connection went away and came back). Differencing
 * across it would divide a large counter delta by a large interval and draw a
 * plausible, wrong, very flat line right where the interesting thing happened.
 * The series restarts instead, which shows up honestly as a chart that begins
 * again.
 */
const STALE_GAP_MS = 60_000;

/**
 * A read that is fetched on demand rather than polled, plus when it happened.
 *
 * `atMs` is what makes reopening the panel cheap: a detail younger than the
 * refresh interval is reused instead of re-issuing the most expensive statement
 * Pulse knows how to send. `error` and `items` coexist on purpose — a refresh
 * that fails leaves the last good answer on screen with the failure noted,
 * rather than blanking a section that was fine a minute ago.
 */
export interface PulseDetail<T> {
  items: T[];
  atMs: number;
  error?: string;
}

interface PulseState {
  /** Oldest first. A connection with no entry has never been sampled. */
  samples: Record<string, PulseHealth[]>;
  /** Last failure per connection, cleared by the next successful sample. Holds
   *  the "driver not supported" rejection too, which is why the panel can tell
   *  "cannot measure this" from "has not measured yet". */
  errors: Record<string, string | undefined>;
  /**
   * The connection Pulse is pinned to, or `null` to follow the tree's
   * selection. Pinning exists because the selection moves on its own — opening
   * a tab or navigating from the command palette changes it — and a panel that
   * silently switched servers mid-diagnosis is worse than no panel.
   */
  pinnedConnectionId: string | null;

  /** Top statements per connection. Absent = never fetched. */
  topQueries: Record<string, PulseDetail<PulseTopQuery> | undefined>;
  /** Biggest relations per connection. Absent = never fetched. */
  storage: Record<string, PulseDetail<PulseStorageItem> | undefined>;

  /** Which of the panel's sections are folded. Absent = expanded — this is
   *  the persisted slice (see `partialize` below). */
  collapsedSections: Partial<Record<PulseSectionId, boolean>>;
  toggleSection: (id: PulseSectionId) => void;

  setTopQueries: (
    connectionId: string,
    detail: PulseDetail<PulseTopQuery>,
  ) => void;
  setStorage: (
    connectionId: string,
    detail: PulseDetail<PulseStorageItem>,
  ) => void;

  push: (connectionId: string, health: PulseHealth) => void;
  fail: (connectionId: string, message: string) => void;
  drop: (connectionId: string) => void;
  setPinned: (connectionId: string | null) => void;
}

export const usePulse = create<PulseState>()(
  persist(
    (set) => ({
      samples: {},
      errors: {},
      pinnedConnectionId: null,
      topQueries: {},
      storage: {},
      collapsedSections: {},

      setTopQueries: (connectionId, detail) =>
        set((s) => ({ topQueries: { ...s.topQueries, [connectionId]: detail } })),

      setStorage: (connectionId, detail) =>
        set((s) => ({ storage: { ...s.storage, [connectionId]: detail } })),

      push: (connectionId, health) =>
        set((s) => {
          const previous = s.samples[connectionId] ?? [];
          const last = previous[previous.length - 1];
          const stale = last && health.sampledAtMs - last.sampledAtMs > STALE_GAP_MS;
          const next = stale ? [health] : [...previous, health].slice(-MAX_SAMPLES);
          return {
            samples: { ...s.samples, [connectionId]: next },
            errors: { ...s.errors, [connectionId]: undefined },
          };
        }),

      fail: (connectionId, message) =>
        set((s) => ({ errors: { ...s.errors, [connectionId]: message } })),

      drop: (connectionId) =>
        set((s) => {
          const samples = { ...s.samples };
          const errors = { ...s.errors };
          const topQueries = { ...s.topQueries };
          const storage = { ...s.storage };
          delete samples[connectionId];
          delete errors[connectionId];
          delete topQueries[connectionId];
          delete storage[connectionId];
          return { samples, errors, topQueries, storage };
        }),

      setPinned: (connectionId) => set({ pinnedConnectionId: connectionId }),

      toggleSection: (id) =>
        set((s) => ({
          collapsedSections: { ...s.collapsedSections, [id]: !s.collapsedSections[id] },
        })),
    }),
    {
      name: STORAGE_KEYS.pulse,
      // Everything else here is session state (a live series, on-demand
      // reads, the pin) — see the module doc comment for why.
      partialize: (s) => ({ collapsedSections: s.collapsedSections }),
    },
  ),
);

/** No samples yet, as a stable reference — returning a fresh `[]` from a
 *  selector would be a new array every call and re-render forever (gotcha #1). */
export const NO_SAMPLES: readonly PulseHealth[] = [];

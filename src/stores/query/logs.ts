/**
 * In-app Console / SQL log store.
 *
 * Subscribes to the Rust `huginndb://log` Tauri event and accumulates
 * entries for the Console panel. Session-only (no persistence) — the log
 * is debugging context, not user data, and writing thousands of entries
 * to disk would hammer I/O for no benefit.
 *
 * Reference-stable selectors are critical here (see CLAUDE.md): the
 * `entries` array is replaced wholesale on each push, so subscribing
 * components get a single stable reference per state mutation. Derived
 * filtering must happen in component-level `useMemo`, never inside a
 * selector.
 */

import { create } from "zustand";
import type { LogEntry } from "@/types";

/** Hard cap on retained entries. Old entries are dropped from the head
 *  to keep memory bounded during long sessions. 2000 covers typical
 *  debugging stretches without measurably impacting render perf with
 *  the virtualized list. */
const MAX_ENTRIES = 2000;

export type LogKindFilter = "sql" | "connection";

interface LogState {
  entries: LogEntry[];
  /** When true, incoming events are dropped instead of appended. The
   *  Rust side keeps emitting; we just stop recording. */
  paused: boolean;
  /** Free-text search over SQL / message / driver / error. Case-insensitive. */
  query: string;
  /** Which kinds are currently visible in the panel. */
  kinds: Record<LogKindFilter, boolean>;
  push: (entry: LogEntry) => void;
  clear: () => void;
  setPaused: (paused: boolean) => void;
  setQuery: (query: string) => void;
  toggleKind: (kind: LogKindFilter) => void;
}

export const useLogs = create<LogState>((set) => ({
  entries: [],
  paused: false,
  query: "",
  kinds: { sql: true, connection: true },
  push: (entry) =>
    set((state) => {
      if (state.paused) return state;
      const next =
        state.entries.length >= MAX_ENTRIES
          ? [...state.entries.slice(state.entries.length - MAX_ENTRIES + 1), entry]
          : [...state.entries, entry];
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
  setPaused: (paused) => set({ paused }),
  setQuery: (query) => set({ query }),
  toggleKind: (kind) =>
    set((state) => ({ kinds: { ...state.kinds, [kind]: !state.kinds[kind] } })),
}));

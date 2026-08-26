/**
 * What the Schema panel's filter box is searching, and where.
 *
 * **Its own store rather than three more fields on `useUi`.** `useUi` is the
 * home of the three *persisted* view filters, and their contract is written
 * down there: `LaunchView` / `applyLaunchView` / `currentLaunchView` are read,
 * written and cleared as one value, and that value round-trips through
 * `LaunchState` into a typed Rust struct. Putting an ephemeral search next to
 * them is an invitation for someone to add it to `LaunchView` — at which point
 * it either silently vanishes at the IPC boundary (gotcha #14) or, worse, does
 * not: a restored needle would paint every connection folded with a `0` badge
 * during the launch reconnect, which is the worst possible first frame.
 * `pendingChord.ts` is the precedent for a tiny, deliberately unpersisted
 * session store.
 *
 * **Nothing here is persisted, and the scope is why that is safe.** A scope is
 * a modifier on a needle, not a setting: `clear()` drops both together, so
 * "narrowed to Producción" can never outlive the search that motivated it, and
 * there is no state to restore that would need explaining after a restart.
 *
 * **`patterns` is the reference the tree passes down.** It is recomputed only
 * in `commit`, which the box calls at most once per debounce interval, so the
 * explorers below can depend on its identity instead of re-parsing a raw
 * string per table (see `matchesFilter`'s header). `raw` is read by exactly one
 * component — the `<input>` itself.
 */

import { create } from "zustand";
import { parsePatterns } from "@/lib/schema/matchesFilter";
import {
  ALL_SCOPE,
  pruneScope,
  sameScope,
  widenScope,
  type FilterScope,
} from "@/lib/schema/filterScope";

/**
 * How long the box waits before committing a needle.
 *
 * It was 250 ms, chosen to throttle a fan-out of `open_database_view` calls
 * that typing no longer performs at all (see `warmForSearch`). With no network
 * on the path this is purely render throttling, so it can be shorter.
 */
export const TREE_SEARCH_DEBOUNCE_MS = 180;

/** What an Escape keystroke actually did, so the caller can do the rest. */
export type EscapeOutcome = "cleared-text" | "widened" | "none";

interface TreeSearchState {
  /** Exactly what is in the `<input>`. Only `TreeFilterBox` reads this. */
  raw: string;
  /** The committed needle: trimmed, lowercased, debounced. */
  needle: string;
  /** `needle` split on `;`. Reference-stable between commits. */
  patterns: string[];
  scope: FilterScope;
  /**
   * Monotonic counter the box watches to focus and select itself. A counter
   * rather than a boolean so two focus requests in a row both land, and so
   * nothing has to remember to reset a flag.
   */
  focusRequest: number;
  /**
   * True once a warm hit the server's connection limit. Everything still
   * queued would be refused identically, so the offer to warm is withdrawn
   * until the user releases some pools.
   */
  limitReached: boolean;

  setRaw: (value: string) => void;
  /** Commit `raw` (or an explicit value) as the live needle. */
  commit: (value?: string) => void;
  narrowTo: (scope: FilterScope) => void;
  /** One level out: database → connection → all. */
  widen: () => void;
  /** All the way out, keeping the needle — the scope chip's ✕. */
  clearScope: () => void;
  /** Escape's layers: clear the text, else widen the scope, else nothing. */
  escape: () => EscapeOutcome;
  /** Drop the text AND the scope — the box's ✕. */
  clear: () => void;
  requestFocus: () => void;
  setLimitReached: (value: boolean) => void;
  /** Drop a scope whose connection is no longer reachable. */
  pruneScopeAgainst: (isReachable: (connectionId: string) => boolean) => void;
}

const NO_PATTERNS: string[] = [];

export const useTreeSearch = create<TreeSearchState>((set, get) => ({
  raw: "",
  needle: "",
  patterns: NO_PATTERNS,
  scope: ALL_SCOPE,
  focusRequest: 0,
  limitReached: false,

  setRaw: (value) => set((s) => (s.raw === value ? s : { raw: value })),

  commit: (value) =>
    set((s) => {
      const needle = (value ?? s.raw).trim().toLowerCase();
      // Identical needle → keep the existing `patterns` reference so every
      // memo downstream stays valid. This is the whole reason `patterns` can
      // be a dependency rather than a re-parse.
      if (needle === s.needle) return s;
      return {
        needle,
        patterns: needle ? parsePatterns(needle) : NO_PATTERNS,
        // A new needle deserves a fresh look at a server that was full when
        // the last one asked.
        limitReached: false,
      };
    }),

  narrowTo: (scope) =>
    set((s) => (sameScope(s.scope, scope) ? s : { scope, limitReached: false })),

  widen: () =>
    set((s) => {
      const next = widenScope(s.scope);
      return sameScope(s.scope, next) ? s : { scope: next, limitReached: false };
    }),

  clearScope: () =>
    set((s) => (s.scope.kind === "all" ? s : { scope: ALL_SCOPE, limitReached: false })),

  escape: () => {
    const s = get();
    if (s.raw.length > 0) {
      // Layer 1 keeps the scope: the user narrowed it deliberately and is most
      // likely about to type a different needle in the same place. The ✕ and
      // `clear()` are what drop both.
      set({ raw: "", needle: "", patterns: NO_PATTERNS, limitReached: false });
      return "cleared-text";
    }
    if (s.scope.kind !== "all") {
      get().widen();
      return "widened";
    }
    return "none";
  },

  clear: () =>
    set((s) =>
      s.raw === "" && s.needle === "" && s.scope.kind === "all" && !s.limitReached
        ? s
        : {
            raw: "",
            needle: "",
            patterns: NO_PATTERNS,
            scope: ALL_SCOPE,
            limitReached: false,
          },
    ),

  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

  setLimitReached: (value) =>
    set((s) => (s.limitReached === value ? s : { limitReached: value })),

  pruneScopeAgainst: (isReachable) =>
    set((s) => {
      const next = pruneScope(s.scope, isReachable);
      return next === s.scope ? s : { scope: next };
    }),
}));

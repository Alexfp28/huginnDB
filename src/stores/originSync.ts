/**
 * Background sync of the active environment's shared origins (#108), and the
 * per-connection notices it produces.
 *
 * Two halves, deliberately kept apart from the connection stores:
 *
 * * **The pull.** `syncAll()` walks the registered origins and calls
 *   `syncOrigin` for each. Runs at launch, on a long interval, and on demand.
 * * **The notices.** A connection that vanished from its origin's file is
 *   surfaced as a persistent, non-blocking entry in `vanished` — the same shape
 *   as `connectionHealth`'s lost-connection flag, and for the same reason: a
 *   background task must never open a modal. There is nobody guaranteed to be
 *   watching, and a `window.confirm` fired mid-query steals the keystroke.
 *
 * Nothing here deletes on its own. The backend only ever reports a
 * disappearance; `adopt` and `retire` are the user acting on it.
 *
 * Selector note (gotcha #1): components read `vanished` / `syncing` raw and
 * derive with `useMemo`.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Origin } from "@/types";

/**
 * How often to re-check the shared files. Deliberately the updater's tier
 * (hours), not the keepalive's (minutes): a shared config file doesn't change by
 * the minute, and twenty workstations polling an SMB share continuously is felt
 * on the file server. Launch + this + a manual "Sync now" covers it.
 */
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** One connection that is no longer published by the origin it came from. */
export interface VanishedConnection {
  profileId: string;
  originId: string;
  originName: string;
  /** RFC 3339; when the sync that noticed it ran. */
  noticedAt: string;
}

interface OriginSyncState {
  /** Keyed by profile id so a component can look one up while rendering a row. */
  vanished: Record<string, VanishedConnection>;
  /**
   * Profile ids the user has already decided about. Filtered out of every later
   * sync so a connection that stays absent from the file — which it will, that
   * being the point — cannot re-raise its notice on the next poll.
   */
  decided: string[];
  /** Ids whose metadata update is waiting for the connection to close. */
  deferred: string[];
  syncing: boolean;
  /** Per-origin failure text (unreachable share, unparseable file, missing
   *  passphrase), keyed by origin id so it can be shown next to that origin. */
  errors: Record<string, string>;

  syncAll: () => Promise<void>;
  /** Keep the connection, as the user's own: clears its `origin_id`. */
  adopt: (profileId: string) => Promise<void>;
  /** Drop the connection and its stored credentials. */
  retire: (profileId: string) => Promise<void>;
}

export const useOriginSync = create<OriginSyncState>((set, get) => ({
  vanished: {},
  decided: [],
  deferred: [],
  syncing: false,
  errors: {},

  syncAll: async () => {
    // Origins are scoped to the active environment, which only the main window
    // owns (gotcha #8). A secondary window syncing would mutate profiles behind
    // the main one's back.
    if (getCurrentWindow().label !== "main") return;
    if (get().syncing) return;
    set({ syncing: true });

    let origins: Origin[] = [];
    try {
      origins = await api.listOrigins();
    } catch (e) {
      console.error("[originSync] could not list origins", e);
      set({ syncing: false });
      return;
    }

    const errors: Record<string, string> = {};
    const found: Record<string, VanishedConnection> = {};
    let touchedProfiles = false;

    for (const origin of origins) {
      try {
        const report = await api.syncOrigin(origin.id);
        if (report.added.length > 0 || report.updated.length > 0) {
          touchedProfiles = true;
        }
        set((s) => ({
          deferred: Array.from(new Set([...s.deferred, ...report.deferred])),
        }));
        // `suspicious` already means the backend cleared `vanished`, so this
        // loop simply finds nothing — no special case needed here, but the
        // invariant is worth knowing when reading the report shape.
        for (const profileId of report.vanished) {
          if (get().decided.includes(profileId)) continue;
          found[profileId] = {
            profileId,
            originId: origin.id,
            originName: origin.name,
            noticedAt: report.syncedAt,
          };
        }
      } catch (e) {
        // A failed read is not evidence of anything: the backend touched
        // nothing, so neither do we. Record it against the origin and move on to
        // the next one rather than aborting the whole sweep.
        errors[origin.id] = String(e);
      }
    }

    // Replace rather than merge: an entry that reappeared in the file (the
    // publisher restored it, or the earlier read was simply wrong) must stop
    // being flagged without anyone having to dismiss it.
    set({ vanished: found, errors, syncing: false });
    if (touchedProfiles) await useConnections.getState().refreshProfiles();
  },

  adopt: async (profileId) => {
    const profile = useConnections
      .getState()
      .profiles.find((p) => p.id === profileId);
    if (!profile) return;
    // Clearing `origin_id` is what makes it locally editable again — and stops
    // any future origin from claiming it.
    await useConnections.getState().save({ ...profile, origin_id: null });
    set((s) => ({
      decided: [...s.decided, profileId],
      vanished: withoutKey(s.vanished, profileId),
    }));
  },

  retire: async (profileId) => {
    // `remove` deletes the profile and its keychain entries. The caller is
    // responsible for confirming first (`confirmIrreversible`) — this is the
    // deletion the user chose, not one the shared file imposed.
    await useConnections.getState().remove(profileId);
    set((s) => ({
      decided: [...s.decided, profileId],
      vanished: withoutKey(s.vanished, profileId),
    }));
  },
}));

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * Start the periodic sweep. Idempotent: the timer is module-level and guarded,
 * so a StrictMode double-effect can't stack two of them (the same trap
 * `useUpdateStore.startPeriodicChecks` documents).
 */
let timer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicOriginSync(): void {
  if (timer) return;
  if (getCurrentWindow().label !== "main") return;
  void useOriginSync.getState().syncAll();
  timer = setInterval(() => {
    void useOriginSync.getState().syncAll();
  }, SYNC_INTERVAL_MS);
}

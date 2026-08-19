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
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
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

/** One environment mirror (#108) whose origin stopped publishing its bundle. */
export interface VanishedEnvironment {
  environmentId: string;
  originId: string;
  originName: string;
  /** RFC 3339; when the sync that noticed it ran. */
  noticedAt: string;
}

interface OriginSyncState {
  /** Keyed by profile id so a component can look one up while rendering a row. */
  vanished: Record<string, VanishedConnection>;
  /** Keyed by environment id, same shape/purpose as `vanished` one level up. */
  vanishedEnvironments: Record<string, VanishedEnvironment>;
  /**
   * Profile ids the user has already decided about. Filtered out of every later
   * sync so a connection that stays absent from the file — which it will, that
   * being the point — cannot re-raise its notice on the next poll.
   */
  decided: string[];
  /** Same as `decided`, for environment ids. Kept as a separate list: the two
   *  id spaces never overlap, but conflating them would make either lookup
   *  ambiguous to read. */
  decidedEnvironments: string[];
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
  /** Keep the environment, as the user's own: clears its `originId`/
   *  `originSourceId` via `adopt_environment`. */
  adoptEnvironment: (environmentId: string) => Promise<void>;
  /** Drop the environment and the session state it remembered. */
  retireEnvironment: (environmentId: string) => Promise<void>;
  /**
   * Raise a vanished-notice for every connection and environment the given
   * origin owns, *before* it's actually removed from the registry.
   *
   * Without this, removing an origin orphaned its connections (and, once
   * environment-mirroring shipped, its environments) forever: the only path
   * that ever populates `vanished`/`vanishedEnvironments` is `syncAll()`,
   * which iterates `listOrigins()` — and a removed origin is no longer in
   * that list, so it can never again report anything as vanished. The
   * profile/environment keeps its `origin_id` (removing an origin
   * deliberately leaves what it imported in place — see `remove_origin`'s
   * doc comment), which makes `ConnectionDialog.isFromOrigin` (and the
   * equivalent environment gating) block editing/deleting it, with no
   * `adopt`/`retire` ever offered. Synthesizing the notice here — from local
   * state, while the origin's name is still known — reuses the exact same
   * decide-later flow a real sync produces, instead of inventing a second one.
   */
  noticeOriginRemoved: (origin: Origin) => void;
}

export const useOriginSync = create<OriginSyncState>((set, get) => ({
  vanished: {},
  vanishedEnvironments: {},
  decided: [],
  decidedEnvironments: [],
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
    const foundEnvironments: Record<string, VanishedEnvironment> = {};
    const held: string[] = [];
    let touchedProfiles = false;
    let touchedEnvironments = false;

    for (const origin of origins) {
      try {
        const report = await api.syncOrigin(origin.id);
        if (report.added.length > 0 || report.updated.length > 0) {
          touchedProfiles = true;
        }
        if (report.environmentsAdded.length > 0 || report.environmentsUpdated.length > 0) {
          touchedEnvironments = true;
        }
        held.push(...report.deferred);
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
        // Same reasoning as above, one level up: `environmentsSuspicious`
        // already means the backend cleared `environmentsVanished`.
        for (const environmentId of report.environmentsVanished) {
          if (get().decidedEnvironments.includes(environmentId)) continue;
          foundEnvironments[environmentId] = {
            environmentId,
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
    // being flagged without anyone having to dismiss it. `deferred` is replaced
    // for the same reason and one more — it used to be unioned, so an id that
    // had since been applied stayed in the list forever and kept arming a
    // pointless re-sync. Each sweep recomputes it from what the backend actually
    // held back this time. An origin that failed to read contributes nothing, so
    // its held-back ids drop out until the next successful sweep re-reports
    // them; the trigger below and the poll both re-check, so this self-heals.
    set({
      vanished: found,
      vanishedEnvironments: foundEnvironments,
      deferred: held,
      errors,
      syncing: false,
    });
    if (touchedProfiles) await useConnections.getState().refreshProfiles();
    if (touchedEnvironments) await useEnvironments.getState().load();
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
    // responsible for confirming first (a real confirm dialog) — this is the
    // deletion the user chose, not one the shared file imposed.
    await useConnections.getState().remove(profileId);
    set((s) => ({
      decided: [...s.decided, profileId],
      vanished: withoutKey(s.vanished, profileId),
    }));
  },

  adoptEnvironment: async (environmentId) => {
    await api.adoptEnvironment(environmentId);
    await useEnvironments.getState().load();
    set((s) => ({
      decidedEnvironments: [...s.decidedEnvironments, environmentId],
      vanishedEnvironments: withoutKey(s.vanishedEnvironments, environmentId),
    }));
  },

  retireEnvironment: async (environmentId) => {
    // `remove` deletes the environment and the session state it remembered.
    // The caller is responsible for confirming first (a real confirm dialog).
    await useEnvironments.getState().remove(environmentId);
    set((s) => ({
      decidedEnvironments: [...s.decidedEnvironments, environmentId],
      vanishedEnvironments: withoutKey(s.vanishedEnvironments, environmentId),
    }));
  },

  noticeOriginRemoved: (origin) => {
    const noticedAt = new Date().toISOString();
    const ownedProfiles = useConnections
      .getState()
      .profiles.filter((p) => p.origin_id === origin.id);
    const ownedEnvironments = useEnvironments
      .getState()
      .environments.filter((e) => e.originId === origin.id);
    if (ownedProfiles.length === 0 && ownedEnvironments.length === 0) return;
    set((s) => {
      const found = { ...s.vanished };
      for (const profile of ownedProfiles) {
        // A connection already decided about (adopted/retired earlier, e.g.
        // via a genuine sync) shouldn't be re-raised just because the origin
        // itself is now gone.
        if (s.decided.includes(profile.id)) continue;
        found[profile.id] = {
          profileId: profile.id,
          originId: origin.id,
          originName: origin.name,
          noticedAt,
        };
      }
      const foundEnvironments = { ...s.vanishedEnvironments };
      for (const env of ownedEnvironments) {
        if (s.decidedEnvironments.includes(env.id)) continue;
        foundEnvironments[env.id] = {
          environmentId: env.id,
          originId: origin.id,
          originName: origin.name,
          noticedAt,
        };
      }
      return { vanished: found, vanishedEnvironments: foundEnvironments };
    });
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
let watching = false;

export function startPeriodicOriginSync(): void {
  if (getCurrentWindow().label !== "main") return;
  watchDeferred();
  if (timer) return;
  void useOriginSync.getState().syncAll();
  timer = setInterval(() => {
    void useOriginSync.getState().syncAll();
  }, SYNC_INTERVAL_MS);
}

/**
 * Apply a held-back metadata update once its pool closes.
 *
 * `sync_origin` refuses to rewrite a profile that has a live connection — moving
 * host/port under a running query would point the user at a different server
 * mid-statement — and reports the id in `deferred` instead. Something has to
 * notice the pool closing, or the update waits for the next four-hourly poll.
 *
 * Re-running the whole sweep is deliberate, rather than caching the pending
 * profile and writing it here: the file is the truth, it may have changed again
 * in the meantime, and a cached copy would be a second source of truth that can
 * go stale. With the pool gone the same code path simply stops deferring.
 */
function watchDeferred(): void {
  if (watching) return;
  watching = true;
  useConnections.subscribe((s, prev) => {
    // `active` is replaced (never mutated) on connect/disconnect, so identity
    // is a sound "did the set change" test.
    if (s.active === prev.active) return;
    const { deferred, syncing } = useOriginSync.getState();
    if (deferred.length === 0 || syncing) return;
    // Only a *closure* can unblock anything; a new connection can't.
    if (deferred.every((id) => s.active.has(id))) return;
    void useOriginSync.getState().syncAll();
  });
}

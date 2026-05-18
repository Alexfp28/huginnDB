/**
 * Update store — drives the in-app "new version available" UX.
 *
 * Lifecycle:
 *   idle      → no check has happened yet (or last check returned nothing)
 *   checking  → a check is in flight
 *   available → the updater reported a newer version; UI shows badge + toast
 *   downloading → installer is being fetched (progress in `downloadProgress`)
 *   ready     → installer finished; the app is about to relaunch
 *   error     → last attempt failed; surfaced inside Settings → About
 *
 * `lastDismissedVersion` is persisted in localStorage so the launch toast
 * doesn't reappear after the user clicks "Later", but the dot on the
 * settings gear stays visible until the update is actually installed.
 *
 * Note on selectors: components subscribe to raw slices and derive any
 * arrays / objects inside a `useMemo`, following the same rule as
 * `src/stores/theme.ts`. Never add a selector that returns a fresh array.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Update } from "@tauri-apps/plugin-updater";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  checkForUpdate,
  downloadAndInstall,
  getCurrentVersion,
  relaunchApp,
} from "@/lib/updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string | null;
  availableVersion: string | null;
  releaseNotes: string | null;
  downloadProgress: { downloaded: number; total: number | null } | null;
  error: string | null;
  lastDismissedVersion: string | null;
  /** Internal handle to the latest Update object reported by the plugin. */
  _update: Update | null;

  checkOnLaunch: () => Promise<void>;
  checkManually: () => Promise<void>;
  installAndRelaunch: () => Promise<void>;
  dismiss: () => void;
}

/**
 * Shared core for both `checkOnLaunch` and `checkManually`. Idempotent:
 * returns early if a check is already in flight (or an install is
 * downloading). All errors are captured into the store rather than
 * thrown — this is a background operation that must never crash the
 * caller's effect.
 */
async function runCheck(
  get: () => UpdateState,
  set: (partial: Partial<UpdateState>) => void,
): Promise<void> {
  const { status } = get();
  if (status === "checking" || status === "downloading") return;
  set({ status: "checking", error: null });
  try {
    const [current, update] = await Promise.all([
      getCurrentVersion(),
      checkForUpdate(),
    ]);
    if (!update) {
      set({
        status: "idle",
        currentVersion: current,
        availableVersion: null,
        releaseNotes: null,
        _update: null,
      });
      return;
    }
    set({
      status: "available",
      currentVersion: current,
      availableVersion: update.version,
      releaseNotes: update.body ?? null,
      _update: update,
    });
  } catch (e) {
    set({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      status: "idle",
      currentVersion: null,
      availableVersion: null,
      releaseNotes: null,
      downloadProgress: null,
      error: null,
      lastDismissedVersion: null,
      _update: null,

      checkOnLaunch: async () => {
        await runCheck(get, set);
      },

      checkManually: async () => {
        // Clear any dismissed version so the toast can fire again if the
        // same available release is reported, and reset error state from
        // a previous failed attempt.
        set({ lastDismissedVersion: null, error: null });
        await runCheck(get, set);
      },

      installAndRelaunch: async () => {
        const update = get()._update;
        if (!update) return;
        set({
          status: "downloading",
          downloadProgress: { downloaded: 0, total: null },
          error: null,
        });
        try {
          await downloadAndInstall(update, (downloaded, total) => {
            set({ downloadProgress: { downloaded, total } });
          });
          set({ status: "ready" });
          await relaunchApp();
        } catch (e) {
          set({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },

      dismiss: () => {
        const v = get().availableVersion;
        if (v) set({ lastDismissedVersion: v });
      },
    }),
    {
      name: STORAGE_KEYS.update,
      partialize: (state) => ({
        lastDismissedVersion: state.lastDismissedVersion,
      }),
    },
  ),
);

/**
 * True when an unseen update is available — i.e. the plugin reported a
 * newer version and the user has not yet dismissed *that specific*
 * version. Returns a primitive boolean, so subscribing to it is safe
 * (it does not allocate, and `Object.is` comparisons stay stable across
 * unrelated state changes).
 */
export function selectUpdateNotificationVisible(state: UpdateState): boolean {
  return (
    state.status === "available" &&
    state.availableVersion !== null &&
    state.availableVersion !== state.lastDismissedVersion
  );
}

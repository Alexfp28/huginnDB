/**
 * Update store — drives the in-app "new version available" UX.
 *
 * Lifecycle:
 *   idle           → no check has happened yet (or last check returned nothing)
 *   checking       → a check is in flight
 *   available      → the updater reported a newer version; download starts
 *                     automatically in the background (no UI wait — see
 *                     `startBackgroundDownload`)
 *   downloading    → the installer is being fetched; progress in
 *                     `downloadProgress`. Purely a byte fetch — never touches
 *                     installed files, never prompts for elevation.
 *   readyToRestart → download finished, install NOT yet applied. One click
 *                     away; nothing happens without it.
 *   ready          → install is being applied and the app is about to
 *                     relaunch (transient — only visible for a frame).
 *   error          → last attempt failed; surfaced inside Settings → About.
 *
 * Why the download/install split: `checkOnLaunch` used to be the only time
 * an update was ever noticed, so a long-running instance that's never
 * relaunched would never see one, no matter how many versions shipped in
 * the meantime. `startPeriodicChecks` re-runs the same check on a timer
 * so those instances catch up on their own. Pairing that with a silent
 * background download (instead of only downloading once the user clicks
 * install) means the moment they do notice, installing is instant — but
 * `install()` (the step that overwrites files, force-kills the `huginndb-mcp`
 * sidecar on Windows per `windows/hooks.nsi`, and may prompt for admin
 * elevation) is NEVER called until `installAndRelaunch` runs off an explicit
 * user click. A silent background *download* is safe to run unattended; a
 * silent background *install* is not.
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
import i18n from "@/lib/i18n";
import { api } from "@/lib/tauri";
import {
  checkForUpdate,
  downloadUpdate,
  getCurrentVersion,
  installUpdate,
  relaunchApp,
} from "@/lib/updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "readyToRestart"
  | "ready"
  | "error";

/** How often to re-check while the app stays open without a fresh launch. */
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Module-level (not store state): guards `startPeriodicChecks` so a
 * remount / React StrictMode double-effect doesn't stack a second timer. */
let periodicTimer: ReturnType<typeof setInterval> | null = null;

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
  /** In-flight (or settled) background download, shared by the periodic
   * timer and an explicit "install" click so neither starts a second
   * download against the same `_update`. */
  _downloadPromise: Promise<void> | null;

  checkOnLaunch: () => Promise<void>;
  checkManually: () => Promise<void>;
  startPeriodicChecks: () => void;
  startBackgroundDownload: () => void;
  installAndRelaunch: () => Promise<void>;
  dismiss: () => void;
}

/** Maps a raw plugin/OS error to a friendlier string for known cases
 * (elevation refused/cancelled), otherwise returns it unchanged. */
function friendlyInstallError(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes("denied") ||
    lower.includes("elevat") ||
    lower.includes("admin")
  ) {
    return i18n.t("update.errorPermission");
  }
  return raw;
}

/**
 * Shared core for `checkOnLaunch`, `checkManually`, and the periodic timer.
 * Idempotent: returns early if a check or download is already in flight.
 * All errors are captured into the store rather than thrown — this is a
 * background operation that must never crash the caller's effect.
 */
async function runCheck(
  get: () => UpdateState,
  set: (partial: Partial<UpdateState>) => void,
): Promise<void> {
  const { status: statusBefore, availableVersion: versionBefore } = get();
  if (statusBefore === "checking" || statusBefore === "downloading") return;
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
        downloadProgress: null,
        _update: null,
        _downloadPromise: null,
      });
      return;
    }

    // Same version we were already tracking (possibly mid-download or
    // already sitting at readyToRestart) — restore that status instead of
    // clobbering the in-flight `_update`/`_downloadPromise` with a fresh,
    // undownloaded instance from this poll. `install()` must run on the
    // exact Update instance that `download()` was called on.
    const alreadyTracked =
      versionBefore === update.version &&
      (statusBefore === "available" ||
        statusBefore === "readyToRestart" ||
        statusBefore === "ready");
    if (alreadyTracked) {
      set({ status: statusBefore, currentVersion: current });
      return;
    }

    set({
      status: "available",
      currentVersion: current,
      availableVersion: update.version,
      releaseNotes: update.body ?? null,
      downloadProgress: null,
      _update: update,
      _downloadPromise: null,
    });
    get().startBackgroundDownload();
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
      _downloadPromise: null,

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

      startPeriodicChecks: () => {
        if (periodicTimer) return;
        periodicTimer = setInterval(() => {
          void runCheck(get, set);
        }, BACKGROUND_CHECK_INTERVAL_MS);
      },

      startBackgroundDownload: () => {
        const { _update, _downloadPromise } = get();
        if (!_update || _downloadPromise) return;
        set({
          status: "downloading",
          downloadProgress: { downloaded: 0, total: null },
        });
        const promise = downloadUpdate(_update, (downloaded, total) => {
          set({ downloadProgress: { downloaded, total } });
        })
          .then(() => {
            set({ status: "readyToRestart" });
          })
          .catch((e) => {
            set({
              status: "error",
              error: e instanceof Error ? e.message : String(e),
              _downloadPromise: null,
            });
          });
        set({ _downloadPromise: promise });
      },

      installAndRelaunch: async () => {
        const { _update } = get();
        if (!_update) return;
        set({ error: null });
        try {
          if (get().status !== "readyToRestart") {
            get().startBackgroundDownload();
            await get()._downloadPromise;
            if (get().status === "error") return;
          }

          // Installing force-kills the huginndb-mcp sidecar on Windows (see
          // windows/hooks.nsi) so the installer can overwrite it. If some
          // MCP client (Claude Code, Cursor, ...) currently has it running,
          // warn before pulling that rug — the user may not remember an
          // agent session is relying on it right now.
          const sidecarRunning = await api
            .isMcpSidecarRunning()
            .catch(() => false);
          if (
            sidecarRunning &&
            !window.confirm(i18n.t("update.mcpSidecarWarning"))
          ) {
            return; // stays at readyToRestart; the user can retry later
          }

          set({ status: "ready" });
          await installUpdate(_update);
          await relaunchApp();
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          set({ status: "error", error: friendlyInstallError(raw) });
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
 * newer version (in any stage from detected through downloaded-and-ready)
 * and the user has not yet dismissed *that specific* version. Returns a
 * primitive boolean, so subscribing to it is safe (it does not allocate,
 * and `Object.is` comparisons stay stable across unrelated state changes).
 */
export function selectUpdateNotificationVisible(state: UpdateState): boolean {
  return (
    (state.status === "available" ||
      state.status === "downloading" ||
      state.status === "readyToRestart") &&
    state.availableVersion !== null &&
    state.availableVersion !== state.lastDismissedVersion
  );
}

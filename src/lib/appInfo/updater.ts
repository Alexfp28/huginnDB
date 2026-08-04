/**
 * Thin wrapper around `@tauri-apps/plugin-updater` so the rest of the
 * frontend can stay decoupled from the plugin's exact API surface.
 *
 * The plugin reads its endpoints + public key from `tauri.conf.json`
 * (`plugins.updater`) — there is no JS-side configuration to do here.
 * `check()` resolves to `null` when the running version is already
 * the latest; otherwise it returns an `Update` object that exposes
 * `download`, `install`, and `downloadAndInstall`.
 *
 * `download` and `install` are exposed separately (not just the combined
 * `downloadAndInstall`) so the update store can fetch the installer
 * silently in the background while the app keeps running, and only apply
 * it — the part that actually touches files on disk and may prompt for
 * elevation — once the user explicitly confirms a restart.
 */

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** Callback shape used to report download progress. */
export type ProgressCallback = (
  downloaded: number,
  contentLength: number | null,
) => void;

export async function getCurrentVersion(): Promise<string> {
  return getVersion();
}

export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** Wraps a plugin download-event handler with running-total bookkeeping. */
function trackProgress(onProgress?: ProgressCallback) {
  let downloaded = 0;
  let contentLength: number | null = null;
  return (evt: DownloadEvent) => {
    switch (evt.event) {
      case "Started":
        contentLength = evt.data.contentLength ?? null;
        onProgress?.(0, contentLength);
        break;
      case "Progress":
        downloaded += evt.data.chunkLength;
        onProgress?.(downloaded, contentLength);
        break;
      case "Finished":
        onProgress?.(contentLength ?? downloaded, contentLength);
        break;
    }
  };
}

/** Fetches the installer to a temp location. Does not touch installed files. */
export async function downloadUpdate(
  update: Update,
  onProgress?: ProgressCallback,
): Promise<void> {
  await update.download(trackProgress(onProgress));
}

/**
 * Applies an already-downloaded installer. On Windows this is the step that
 * force-kills the `huginndb-mcp` sidecar (see `windows/hooks.nsi`) and may
 * prompt for elevation — only call this after explicit user confirmation to
 * restart, never as part of a silent background check.
 */
export async function installUpdate(update: Update): Promise<void> {
  await update.install();
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}

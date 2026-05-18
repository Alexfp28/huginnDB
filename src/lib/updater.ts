/**
 * Thin wrapper around `@tauri-apps/plugin-updater` so the rest of the
 * frontend can stay decoupled from the plugin's exact API surface.
 *
 * The plugin reads its endpoints + public key from `tauri.conf.json`
 * (`plugins.updater`) — there is no JS-side configuration to do here.
 * `check()` resolves to `null` when the running version is already
 * the latest; otherwise it returns an `Update` object that exposes
 * `download`, `install`, and `downloadAndInstall`.
 */

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** Callback shape used by {@link downloadAndInstall} to report progress. */
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

export async function downloadAndInstall(
  update: Update,
  onProgress?: ProgressCallback,
): Promise<void> {
  let downloaded = 0;
  let contentLength: number | null = null;
  await update.downloadAndInstall((evt) => {
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
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}

/**
 * Environment avatar images — picking one, normalising it, and telling one
 * apart from the initials fallback.
 *
 * The image is stored *inline*, as a `data:` URL in `Environment.icon` (the
 * slot the old lucide icon picker used to write; the backend keeps it opaque —
 * see `tab_state.rs`). That is why everything here downscales aggressively
 * first: `icon` round-trips through `tab_state.json` on every environment
 * write, so the payload has to stay in the kilobytes. A 128px square at WebP
 * q0.82 lands around 3–6 KB, which is the same order as the theme id and name
 * already stored beside it.
 *
 * Inline rather than a file under the config dir on purpose: the avatar then
 * has no lifecycle of its own. It is copied when an environment is replicated,
 * discarded when one is deleted, and travels through the same single write as
 * the rest of the environment — no orphan sweep, no second failure mode where
 * the JSON points at a file that isn't there.
 */

import { api } from "@/lib/tauri";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

/**
 * Stored avatar edge, in CSS pixels. Deliberately larger than the biggest
 * place it renders (48px in the editor preview) so a HiDPI display still has
 * real pixels to work with — 128 covers 2× at every call site with room to
 * spare, and the cost of the extra pixels is a couple of KB.
 */
const AVATAR_PX = 128;

/** Extensions offered in the native picker; mirrors the backend's sniff list
 *  in `commands::dump::sniff_image_mime` (no SVG — see the note there). */
export const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/**
 * Whether an environment's `icon` holds an image (as opposed to nothing, or a
 * legacy lucide icon key left over from before the icon picker was removed —
 * those are plain identifiers like `"database"` and must keep falling back to
 * the initials avatar rather than being fed to an `<img>`).
 */
export function isAvatarImage(icon: string | null | undefined): icon is string {
  return typeof icon === "string" && icon.startsWith("data:image/");
}

/**
 * Open the native picker and return a normalised avatar data URL, or `null` if
 * the user cancelled. Throws with a human-readable message when the file isn't
 * a usable image (the backend's own validation) or can't be decoded.
 */
export async function pickAvatarImage(title: string): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title,
    filters: [{ name: "Image", extensions: AVATAR_EXTENSIONS }],
  });
  if (typeof picked !== "string" || !picked) return null;
  // The dialog hands back a path, which the webview can't read itself — the
  // backend turns it into a data URL (and validates the format there).
  return await normalizeAvatarImage(await api.readImageDataUrl(picked));
}

/**
 * Same result from a dropped `File`. The drop path never goes through the
 * backend: the browser already has the bytes, and an object URL is cheaper
 * than base64-ing them through IPC just to re-decode them here.
 *
 * (HTML drag-and-drop reaches the page at all because `dragDropEnabled` is
 * `false` in `tauri.conf.json`; with Tauri's own drag-drop handling on, these
 * events never fire in the webview on Windows.)
 */
export async function avatarImageFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("not an image");
  }
  const url = URL.createObjectURL(file);
  try {
    return await normalizeAvatarImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode `src`, centre-crop it to a square and re-encode it at [`AVATAR_PX`].
 *
 * Centre-crop rather than letterbox: the avatar is a filled rounded square in
 * every call site, so a "contain" fit would bake the source's aspect ratio into
 * the stored pixels as transparent bands that then sit inside the coloured
 * tile. Cropping keeps the tile fully covered at any input ratio.
 */
async function normalizeAvatarImage(src: string): Promise<string> {
  const img = await loadImage(src);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("image has no dimensions");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas is unavailable");
  // Upscaling a tiny source looks better smoothed than nearest-neighbour, and
  // this is the browser default anyway — set explicitly so it doesn't depend on
  // which webview we're in.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PX,
    AVATAR_PX,
  );

  // WebP is ~3× smaller than PNG here and both webviews we ship on decode it,
  // but only Chromium-based ones *encode* it: `toDataURL` silently returns PNG
  // when the type is unsupported, which the prefix check below detects so the
  // PNG is used as-is rather than mislabelled.
  const webp = canvas.toDataURL("image/webp", 0.82);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode the image"));
    img.src = src;
  });
}

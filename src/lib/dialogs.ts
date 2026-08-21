/**
 * Thin wrappers over Tauri's native file dialogs.
 *
 * The plugin's `open()` returns `string | string[] | null` — the array form for
 * a multi-select it was not asked for — so every caller has to narrow it, and
 * six of them wrote `if (typeof picked !== "string") return;` with three
 * different spellings of the empty check on top. These collapse that to `null`
 * once, so a call site can read `if (!path) return;`.
 */

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

/**
 * Ask the user for one JSON file. `null` when they cancel.
 *
 * `extensions` defaults to `["json"]`; the JSON-Schema library passes
 * `["json", "schema.json"]` so a `foo.schema.json` is offered too.
 */
export async function pickJsonFile(
  title: string,
  extensions: string[] = ["json"],
): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title,
    filters: [{ name: "JSON", extensions }],
  });
  return typeof picked === "string" && picked ? picked : null;
}

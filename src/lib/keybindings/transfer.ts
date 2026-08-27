/**
 * Shortcut export/import — pure logic (no dialog, no I/O), so the file-format
 * decisions are testable and don't get lost inside the settings section. Same
 * split, and the same on-disk shape, as `lib/themeTransfer.ts`.
 *
 * What travels is the **overrides map**, not the resolved bindings. Exporting
 * every action's effective combo would freeze this version's defaults into the
 * file, so importing it on a later build would pin the user to yesterday's
 * catalogue and silently opt them out of every new default. An override is the
 * only part that is genuinely the user's.
 *
 * Two shapes are tolerated per action, matching the backend: a bare string
 * (the pre-1.19 file shape) and a list.
 */

import { ACTION_BY_ID } from "./actions";
import { parseSequence } from "./chord";
import type { Keybindings } from "./resolve";

const KIND = "huginndb-shortcuts";
const CURRENT_VERSION = 1;

interface ShortcutExportFile {
  kind: typeof KIND;
  version: number;
  keybindings: Keybindings;
}

/** Suggested filename — used as the save dialog's default. */
export const SHORTCUTS_FILE_NAME = "shortcuts.huginndb-shortcuts.json";

export function serializeKeybindings(keybindings: Keybindings): string {
  const file: ShortcutExportFile = {
    kind: KIND,
    version: CURRENT_VERSION,
    keybindings,
  };
  return JSON.stringify(file, null, 2);
}

export class ShortcutImportError extends Error {}

export interface ShortcutImportResult {
  keybindings: Keybindings;
  /** Action ids in the file that this build has never heard of. Reported
   *  rather than silently dropped: it is how a user finds out the file came
   *  from a newer version, instead of wondering why one shortcut is missing. */
  unknownActions: string[];
}

/**
 * Parse a previously exported shortcuts file.
 *
 * Unknown action ids are dropped and named. Unparseable bindings are dropped
 * silently, because a binding with no key token can never match anything and
 * keeping it would put a permanently dead entry in the user's map. Every
 * binding is normalized on the way in, so a file written before `Ctrl` became
 * `Mod` imports as `Mod`.
 */
export function parseKeybindingsFile(raw: string): ShortcutImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShortcutImportError("notJson");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).kind !== KIND ||
    typeof (parsed as Record<string, unknown>).keybindings !== "object" ||
    (parsed as Record<string, unknown>).keybindings === null
  ) {
    throw new ShortcutImportError("notShortcuts");
  }

  const source = (parsed as ShortcutExportFile).keybindings as Record<string, unknown>;
  const keybindings: Keybindings = {};
  const unknownActions: string[] = [];

  for (const [id, value] of Object.entries(source)) {
    if (!ACTION_BY_ID.has(id as never)) {
      unknownActions.push(id);
      continue;
    }
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list)) continue;
    keybindings[id] = list
      .filter((b): b is string => typeof b === "string")
      .map((b) => parseSequence(b).join(" "))
      .filter((b) => b.length > 0);
  }

  return { keybindings, unknownActions };
}

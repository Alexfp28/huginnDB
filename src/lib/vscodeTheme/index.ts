/**
 * Public surface of the VS Code theme importer.
 *
 * One import produces BOTH halves of the app's colour story from the same
 * source file: a `ThemeFamily` for the chrome (derived - see `map.ts`) and a
 * Monaco theme per variant (translated - see `monaco.ts`). They are returned
 * together because they must not drift: an editor painted in Dracula inside a
 * panel painted in something else is worse than either alone.
 *
 * Everything here is pure. Reading the `.vsix` is the backend's job
 * (`commands::themes::read_vsix`); this module only ever sees text.
 */

import type * as monaco from "monaco-editor";
import type { ThemeFamily } from "@/lib/themes";
import { customThemeId } from "@/lib/utils";
import { mapVariant, paletteWarnings } from "./map";
import { isLightVariant, loadThemeFile, payloadFromBareThemeFile, readManifestThemes } from "./parse";
import { toMonacoTheme } from "./monaco";
import { VsCodeThemeError, type VsixPayload, type VsixThemeContribution } from "./types";

export { VsCodeThemeError, payloadFromBareThemeFile, readManifestThemes };
export type { VsixPayload, VsixThemeContribution };

/** One selectable variant, as the import dialog lists it. */
export interface ThemeVariantChoice extends VsixThemeContribution {
  /** Which half of a `ThemeFamily` this variant can fill. */
  side: "light" | "dark";
}

/** The variants a payload offers, split by side so the dialog can ask for
 *  one of each. An extension contributes several (GitHub ships nine, Gruvbox
 *  six), so "install the extension" is not the unit here - "pick a variant"
 *  is. */
export function describeVariants(payload: VsixPayload): ThemeVariantChoice[] {
  return payload.themes.map((t) => ({
    ...t,
    side: isLightVariant(t.uiTheme) ? "light" : "dark",
  }));
}

export interface ThemeImportSelection {
  /** Contributed path of the variant to use for the light half. */
  lightPath?: string;
  /** Contributed path of the variant to use for the dark half. */
  darkPath?: string;
  /** Overrides the name derived from the payload. */
  name?: string;
}

export interface ThemeImportResult {
  family: ThemeFamily;
  /** Monaco theme per side, keyed by the id the caller should register under.
   *  Absent when the corresponding side was filled by duplication rather than
   *  by its own variant. */
  monacoThemes: { id: string; data: monaco.editor.IStandaloneThemeData; side: "light" | "dark" }[];
  /** Surface/foreground pairs still short of the readability floor after
   *  `ensureContrast` did what it could. Shown as a caveat, never a refusal:
   *  the result lands in the Appearance editor where it can be fixed. */
  warnings: string[];
  /** The variant paths this result was built from, resolved (so both sides
   *  are filled even when the user picked one). Carried back out because an
   *  install has to record which variants were chosen — an update rebuilds
   *  the same pairing rather than asking again. */
  selection: { lightPath: string; darkPath: string };
}

/** Stable Monaco theme ids for an imported family. Prefixed so they cannot
 *  collide with the curated catalogue in `lib/monaco/monaco-themes.ts`. */
export function monacoThemeId(familyId: string, side: "light" | "dark"): string {
  return `vscode-${familyId}-${side}`;
}

/**
 * Turn a payload plus a selection into a ready-to-store theme.
 *
 * At least one side must be chosen. When only one is, it fills both halves -
 * the same fallback `parseThemeFile` already applies to a v1 export, and the
 * honest one: a dark-only extension has no light palette to infer, and
 * inventing one produces a variant nobody designed.
 */
export function buildThemeImport(
  payload: VsixPayload,
  selection: ThemeImportSelection,
): ThemeImportResult {
  const lightPath = selection.lightPath ?? selection.darkPath;
  const darkPath = selection.darkPath ?? selection.lightPath;
  if (!lightPath || !darkPath) throw new VsCodeThemeError("noVariantSelected");

  const contributions = new Map(payload.themes.map((t) => [t.path, t]));
  const lightEntry = contributions.get(lightPath);
  const darkEntry = contributions.get(darkPath);
  if (!lightEntry || !darkEntry) throw new VsCodeThemeError("themeFileMissing");

  const lightFile = loadThemeFile(lightPath, payload.files);
  const sameSource = lightPath === darkPath;
  const darkFile = sameSource ? lightFile : loadThemeFile(darkPath, payload.files);

  // When one variant fills both halves it is derived ONCE, under its own
  // side, and copied. Deriving it twice with opposite `isLight` flags would
  // mix a dark palette with light-side rules (`scrim` taken from the
  // foreground, `brandHover` deepening instead of lifting) and produce a
  // half nobody designed — the failure this branch exists to avoid.
  const ownSideIsLight = sameSource ? isLightVariant(lightEntry.uiTheme) : true;
  const light = sameSource
    ? mapVariant(lightFile, ownSideIsLight)
    : mapVariant(lightFile, true);
  const dark = sameSource ? light : mapVariant(darkFile, false);

  const id = customThemeId();
  const name =
    selection.name?.trim() ||
    payload.displayName.trim() ||
    darkEntry.label ||
    "Imported theme";

  const monacoThemes: ThemeImportResult["monacoThemes"] = [
    {
      id: monacoThemeId(id, "light"),
      data: toMonacoTheme(lightFile, lightEntry.uiTheme),
      side: "light",
    },
    {
      id: monacoThemeId(id, "dark"),
      data: toMonacoTheme(darkFile, darkEntry.uiTheme),
      side: "dark",
    },
  ];

  return {
    family: { id, name, builtin: false, light, dark },
    monacoThemes,
    selection: { lightPath, darkPath },
    warnings: [
      ...paletteWarnings(light).map((w) => `light:${w}`),
      ...paletteWarnings(dark).map((w) => `dark:${w}`),
    ],
  };
}

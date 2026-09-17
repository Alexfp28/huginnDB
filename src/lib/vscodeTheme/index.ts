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

/**
 * The variants to install when nobody is asked.
 *
 * Installing used to open the variant picker unconditionally, which made a
 * one-click action a three-step one and asked a question most extensions do
 * not pose: the answer is simply "the light one and the dark one". This picks
 * the **first** contribution on each side, because a manifest's order is the
 * author's own — `GitHub Light Default` precedes its high-contrast and
 * colourblind siblings, `Dracula Theme` precedes `Dracula Theme Soft` — so
 * first is the variant the author leads with.
 *
 * A side with no contribution is left undefined and `buildThemeImport` fills
 * it from the other, which is the honest fallback: a dark-only extension has
 * no light palette to infer.
 *
 * The picker is still reachable for the cases where the first is not what
 * someone wants (Gruvbox Dark Hard rather than Medium); it just stopped being
 * compulsory.
 */
export function autoPairVariants(variants: VsixThemeContribution[]): ThemeImportSelection {
  const firstOn = (side: "light" | "dark") =>
    variants.find((v) => (isLightVariant(v.uiTheme) ? "light" : "dark") === side)?.path;
  return { lightPath: firstOn("light"), darkPath: firstOn("dark") };
}

/**
 * Find the installed family that came from a given registry extension.
 *
 * Matched on `namespace`/`name` — the registry's identity — and **not** on the
 * display name, which is what the first version did and why an install did not
 * show up as installed. Two independent ways that failed: the name recorded at
 * install time comes from the package manifest while the search row shows the
 * registry's `displayName`, and nothing requires those to be equal; and
 * renaming a theme in Appearance afterwards made it stop matching itself.
 *
 * A theme imported from a local `.vsix` has no registry origin at all, so it
 * is reconciled on its manifest identifier instead — otherwise downloading
 * Dracula by hand and then opening the panel would offer it as if it were not
 * already installed.
 *
 * Kept here rather than in the panel so it can be tested without mounting
 * anything — it is the join between two stores, not a rendering concern.
 */
export function findInstalledFamily(
  installed: Record<
    string,
    {
      source?: { namespace: string; name: string } | null;
      identifier?: string | null;
    }
  >,
  extension: { namespace: string; name: string },
): string | null {
  const target = `${extension.namespace}.${extension.name}`.toLowerCase();
  const hit = Object.entries(installed).find(([, v]) => {
    // Installed from this registry: the recorded namespace/name is exact.
    if (v.source?.namespace === extension.namespace && v.source?.name === extension.name) {
      return true;
    }
    // Installed from a local `.vsix`: it has no registry origin, but its
    // manifest names the same extension. `publisher.name` equals the
    // registry's `namespace.name` for every colour theme sampled — compared
    // case-insensitively anyway, since a namespace may be capitalised
    // differently in one place than the other (`GitHub`).
    return (v.identifier ?? "").toLowerCase() === target;
  });
  return hit ? hit[0] : null;
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
  /** The extension's `publisher.name`, from its manifest. Recorded for every
   *  install so a theme that arrived as a local `.vsix` is still recognised
   *  in the registry listing. Empty for a bare `*-color-theme.json`, which
   *  has no manifest to name it. */
  identifier: string;
  /** The package version, from the manifest. Recorded with the identifier so
   *  a locally imported theme has something for an update check to compare
   *  a registry's latest against. */
  packageVersion: string;
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
    identifier: payload.identifier,
    packageVersion: payload.version,
    warnings: [
      ...paletteWarnings(light).map((w) => `light:${w}`),
      ...paletteWarnings(dark).map((w) => `dark:${w}`),
    ],
  };
}

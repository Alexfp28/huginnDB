/**
 * Curated registry for the in-app Documentation viewer (Help → Documentation,
 * {@link ../components/DocsDialog}).
 *
 * Each entry bundles a user-facing markdown file from the repo `docs/` folder
 * at build time via Vite's `?raw` import — no network, works offline, mirroring
 * `lib/changelog.ts`. Only files listed here are shown; internal roadmaps in
 * `docs/` are deliberately left out. To surface a new doc: add its `?raw`
 * import + an entry here, and add its path to `DOC_FILES` in `vite.config.ts`
 * so its last-updated date is injected.
 *
 * Titles/descriptions are i18n keys (`docs.entries.<id>.*`). The body is
 * per-language, same idea as `getReleases` in `lib/changelog.ts`: English is
 * authoritative and always present; a translation (`docs/<Name>.<lang>.md`)
 * is optional and may lag behind — `getDocBody` falls back to English for any
 * language without one, so a missing translation never surfaces a blank
 * panel. `updated` reflects the English file's last git-commit date for both.
 */

import type { AppLanguage } from "@/types";
import mcpRaw from "../../docs/MCP.md?raw";
import mcpEsRaw from "../../docs/MCP.es.md?raw";

export interface DocEntry {
  /** Stable id (used as the selected-doc key and React key). */
  id: string;
  /** i18n key for the sidebar title. */
  titleKey: string;
  /** i18n key for the one-line description under the title. */
  descriptionKey: string;
  /** Repo-relative path — the key into `__DOC_UPDATED__`. */
  path: string;
  /** Raw markdown body per UI language. `en` is always present. */
  bodies: Partial<Record<AppLanguage, string>> & { en: string };
  /** ISO last-updated date, or null when unavailable. */
  updated: string | null;
}

const dates: Record<string, string | undefined> =
  typeof __DOC_UPDATED__ !== "undefined" ? __DOC_UPDATED__ : {};

export const DOCS: DocEntry[] = [
  {
    id: "mcp",
    titleKey: "docs.entries.mcp.title",
    descriptionKey: "docs.entries.mcp.description",
    path: "docs/MCP.md",
    bodies: { en: mcpRaw, es: mcpEsRaw },
    updated: dates["docs/MCP.md"] ?? null,
  },
];

/** Look up a doc entry by id. */
export function getDoc(id: string): DocEntry | undefined {
  return DOCS.find((d) => d.id === id);
}

/** Markdown body for the given UI language, falling back to English. */
export function getDocBody(doc: DocEntry, lang: string): string {
  return doc.bodies[lang as AppLanguage] ?? doc.bodies.en;
}

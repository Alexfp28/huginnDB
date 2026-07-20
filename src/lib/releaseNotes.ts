/**
 * Curated "What's new" content — the highlights shown in the post-update
 * {@link WhatsNewDialog} presentation.
 *
 * This is a hand-authored, bundled catalogue (no runtime CHANGELOG parsing):
 * each entry lists a few user-facing highlights for one release, and only
 * entries flagged `major` pop the dialog automatically on the first launch
 * after updating to that version (see `stores/whatsNew.ts`). Non-major
 * releases can still carry an entry — it just won't auto-present; it's only
 * reachable via Help → "What's new".
 *
 * Copy lives in i18n (`whatsNew.releases.<key>.*` in en.json / es.json), so
 * the strings here are only the *keys*. The icon is a lucide component
 * rendered in a brand-tinted chip.
 *
 * CONTRACT: `version` must EXACTLY equal the app version the release ships as
 * (the `version` in `tauri.conf.json` / `package.json`, i.e. what
 * `getVersion()` returns at runtime) — the auto-trigger matches on an exact
 * string compare. When you cut a release, bump BOTH the manifest version and
 * the newest entry's `version` here (and its i18n keys) together.
 */

import type { LucideIcon } from "lucide-react";
import {
  Bot,
  HardDrive,
  ListTree,
  Palette,
  Pencil,
  Plug,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Tags,
  Target,
} from "lucide-react";

export interface ReleaseHighlight {
  /** lucide icon shown in the highlight's chip. */
  icon: LucideIcon;
  /** i18n key for the highlight's short title. */
  titleKey: string;
  /** i18n key for the highlight's one-line body. */
  bodyKey: string;
}

export interface ReleaseNote {
  /** App version this note describes — must match `getVersion()` exactly. */
  version: string;
  /**
   * When true, the first launch on this version auto-presents the dialog.
   * This is the "big changes / new system" flag the presentation keys off.
   */
  major: boolean;
  /** i18n key for the release's one-line tagline under the title. */
  taglineKey: string;
  highlights: ReleaseHighlight[];
}

/**
 * Newest first. The auto-trigger only ever looks at the entry whose `version`
 * equals the running version; the ordering matters for `latestReleaseNote()`
 * (the manual Help entry) and for any future "history" view.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "1.9.0",
    major: true,
    taglineKey: "whatsNew.releases.1_9_0.tagline",
    highlights: [
      {
        icon: Pencil,
        titleKey: "whatsNew.releases.1_9_0.items.mcpWrite.title",
        bodyKey: "whatsNew.releases.1_9_0.items.mcpWrite.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_9_0.items.mcpPolicy.title",
        bodyKey: "whatsNew.releases.1_9_0.items.mcpPolicy.body",
      },
    ],
  },
  {
    version: "1.8.0",
    major: true,
    taglineKey: "whatsNew.releases.1_8_0.tagline",
    highlights: [
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_8_0.items.security.title",
        bodyKey: "whatsNew.releases.1_8_0.items.security.body",
      },
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_8_0.items.mcpMongo.title",
        bodyKey: "whatsNew.releases.1_8_0.items.mcpMongo.body",
      },
      {
        icon: Target,
        titleKey: "whatsNew.releases.1_8_0.items.mcpMongoDatabase.title",
        bodyKey: "whatsNew.releases.1_8_0.items.mcpMongoDatabase.body",
      },
      {
        icon: Tags,
        titleKey: "whatsNew.releases.1_8_0.items.columnTypes.title",
        bodyKey: "whatsNew.releases.1_8_0.items.columnTypes.body",
      },
      {
        icon: HardDrive,
        titleKey: "whatsNew.releases.1_8_0.items.collectionSize.title",
        bodyKey: "whatsNew.releases.1_8_0.items.collectionSize.body",
      },
    ],
  },
  {
    version: "1.7.0",
    major: true,
    taglineKey: "whatsNew.releases.1_7_0.tagline",
    highlights: [
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_7_0.items.connector.title",
        bodyKey: "whatsNew.releases.1_7_0.items.connector.body",
      },
      {
        icon: ShieldCheck,
        titleKey: "whatsNew.releases.1_7_0.items.safety.title",
        bodyKey: "whatsNew.releases.1_7_0.items.safety.body",
      },
    ],
  },
  {
    version: "1.6.0",
    major: true,
    taglineKey: "whatsNew.releases.1_6_0.tagline",
    highlights: [
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_6_0.items.design.title",
        bodyKey: "whatsNew.releases.1_6_0.items.design.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_6_0.items.grid.title",
        bodyKey: "whatsNew.releases.1_6_0.items.grid.body",
      },
      {
        icon: ListTree,
        titleKey: "whatsNew.releases.1_6_0.items.schema.title",
        bodyKey: "whatsNew.releases.1_6_0.items.schema.body",
      },
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_6_0.items.editor.title",
        bodyKey: "whatsNew.releases.1_6_0.items.editor.body",
      },
      {
        icon: Plug,
        titleKey: "whatsNew.releases.1_6_0.items.chrome.title",
        bodyKey: "whatsNew.releases.1_6_0.items.chrome.body",
      },
    ],
  },
];

/** The release note for a specific version, if one exists. */
export function getReleaseNote(version: string): ReleaseNote | null {
  return RELEASE_NOTES.find((r) => r.version === version) ?? null;
}

/** The most recent release note in the catalogue (for the manual entry). */
export function latestReleaseNote(): ReleaseNote | null {
  return RELEASE_NOTES[0] ?? null;
}

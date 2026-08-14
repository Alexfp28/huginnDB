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
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  FolderTree,
  ImagePlus,
  Gauge,
  HardDrive,
  Keyboard,
  Layers,
  LayoutList,
  ListFilter,
  ListTree,
  Palette,
  PanelTop,
  Pencil,
  Plug,
  Power,
  Server,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Table2,
  Tags,
  Target,
  Timer,
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
    version: "1.15.0",
    major: true,
    taglineKey: "whatsNew.releases.1_15_0.tagline",
    highlights: [
      {
        icon: ImagePlus,
        titleKey: "whatsNew.releases.1_15_0.items.environmentAvatars.title",
        bodyKey: "whatsNew.releases.1_15_0.items.environmentAvatars.body",
      },
      {
        icon: Download,
        titleKey: "whatsNew.releases.1_15_0.items.linuxBuilds.title",
        bodyKey: "whatsNew.releases.1_15_0.items.linuxBuilds.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_15_0.items.independentFolds.title",
        bodyKey: "whatsNew.releases.1_15_0.items.independentFolds.body",
      },
      {
        icon: Power,
        titleKey: "whatsNew.releases.1_15_0.items.restartFeedback.title",
        bodyKey: "whatsNew.releases.1_15_0.items.restartFeedback.body",
      },
    ],
  },
  {
    version: "1.14.0",
    major: true,
    taglineKey: "whatsNew.releases.1_14_0.tagline",
    highlights: [
      {
        icon: SquareTerminal,
        titleKey: "whatsNew.releases.1_14_0.items.paletteLauncher.title",
        bodyKey: "whatsNew.releases.1_14_0.items.paletteLauncher.body",
      },
      {
        icon: PanelTop,
        titleKey: "whatsNew.releases.1_14_0.items.activityBarShell.title",
        bodyKey: "whatsNew.releases.1_14_0.items.activityBarShell.body",
      },
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_14_0.items.environmentRail.title",
        bodyKey: "whatsNew.releases.1_14_0.items.environmentRail.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_14_0.items.themeTransfer.title",
        bodyKey: "whatsNew.releases.1_14_0.items.themeTransfer.body",
      },
      {
        icon: Table2,
        titleKey: "whatsNew.releases.1_14_0.items.columnFit.title",
        bodyKey: "whatsNew.releases.1_14_0.items.columnFit.body",
      },
    ],
  },
  {
    version: "1.13.0",
    major: true,
    taglineKey: "whatsNew.releases.1_13_0.tagline",
    highlights: [
      {
        icon: Server,
        titleKey: "whatsNew.releases.1_13_0.items.sqlServer.title",
        bodyKey: "whatsNew.releases.1_13_0.items.sqlServer.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_13_0.items.connectionFootprint.title",
        bodyKey: "whatsNew.releases.1_13_0.items.connectionFootprint.body",
      },
      {
        icon: SlidersHorizontal,
        titleKey: "whatsNew.releases.1_13_0.items.connectionSettings.title",
        bodyKey: "whatsNew.releases.1_13_0.items.connectionSettings.body",
      },
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_13_0.items.listEditor.title",
        bodyKey: "whatsNew.releases.1_13_0.items.listEditor.body",
      },
      {
        icon: Bot,
        titleKey: "whatsNew.releases.1_13_0.items.mcpPools.title",
        bodyKey: "whatsNew.releases.1_13_0.items.mcpPools.body",
      },
    ],
  },
  {
    version: "1.12.1",
    major: true,
    taglineKey: "whatsNew.releases.1_12_1.tagline",
    highlights: [
      {
        icon: Database,
        titleKey: "whatsNew.releases.1_12_1.items.exportImport.title",
        bodyKey: "whatsNew.releases.1_12_1.items.exportImport.body",
      },
      {
        icon: Copy,
        titleKey: "whatsNew.releases.1_12_1.items.bulkUpdate.title",
        bodyKey: "whatsNew.releases.1_12_1.items.bulkUpdate.body",
      },
      {
        icon: Tags,
        titleKey: "whatsNew.releases.1_12_1.items.structureEditor.title",
        bodyKey: "whatsNew.releases.1_12_1.items.structureEditor.body",
      },
      {
        icon: Pencil,
        titleKey: "whatsNew.releases.1_12_1.items.tableRename.title",
        bodyKey: "whatsNew.releases.1_12_1.items.tableRename.body",
      },
    ],
  },
  {
    version: "1.12.0",
    major: true,
    taglineKey: "whatsNew.releases.1_12_0.tagline",
    highlights: [
      {
        icon: Layers,
        titleKey: "whatsNew.releases.1_12_0.items.environments.title",
        bodyKey: "whatsNew.releases.1_12_0.items.environments.body",
      },
      {
        icon: Share2,
        titleKey: "whatsNew.releases.1_12_0.items.sharedOrigins.title",
        bodyKey: "whatsNew.releases.1_12_0.items.sharedOrigins.body",
      },
      {
        icon: FolderTree,
        titleKey: "whatsNew.releases.1_12_0.items.connectionsInTree.title",
        bodyKey: "whatsNew.releases.1_12_0.items.connectionsInTree.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_12_0.items.filterSelected.title",
        bodyKey: "whatsNew.releases.1_12_0.items.filterSelected.body",
      },
      {
        icon: Timer,
        titleKey: "whatsNew.releases.1_12_0.items.queryFeedback.title",
        bodyKey: "whatsNew.releases.1_12_0.items.queryFeedback.body",
      },
      {
        icon: Palette,
        titleKey: "whatsNew.releases.1_12_0.items.neonTheme.title",
        bodyKey: "whatsNew.releases.1_12_0.items.neonTheme.body",
      },
    ],
  },
  {
    version: "1.11.0",
    major: true,
    taglineKey: "whatsNew.releases.1_11_0.tagline",
    highlights: [
      {
        icon: Power,
        titleKey: "whatsNew.releases.1_11_0.items.reconnect.title",
        bodyKey: "whatsNew.releases.1_11_0.items.reconnect.body",
      },
      {
        icon: Gauge,
        titleKey: "whatsNew.releases.1_11_0.items.fastOpen.title",
        bodyKey: "whatsNew.releases.1_11_0.items.fastOpen.body",
      },
      {
        icon: PanelTop,
        titleKey: "whatsNew.releases.1_11_0.items.toolbar.title",
        bodyKey: "whatsNew.releases.1_11_0.items.toolbar.body",
      },
      {
        icon: LayoutList,
        titleKey: "whatsNew.releases.1_11_0.items.mongoList.title",
        bodyKey: "whatsNew.releases.1_11_0.items.mongoList.body",
      },
      {
        icon: ExternalLink,
        titleKey: "whatsNew.releases.1_11_0.items.floatWindow.title",
        bodyKey: "whatsNew.releases.1_11_0.items.floatWindow.body",
      },
    ],
  },
  {
    version: "1.10.0",
    major: true,
    taglineKey: "whatsNew.releases.1_10_0.tagline",
    highlights: [
      {
        icon: Eye,
        titleKey: "whatsNew.releases.1_10_0.items.viewsEditor.title",
        bodyKey: "whatsNew.releases.1_10_0.items.viewsEditor.body",
      },
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_10_0.items.betweenFilter.title",
        bodyKey: "whatsNew.releases.1_10_0.items.betweenFilter.body",
      },
      {
        icon: Keyboard,
        titleKey: "whatsNew.releases.1_10_0.items.shortcuts.title",
        bodyKey: "whatsNew.releases.1_10_0.items.shortcuts.body",
      },
      {
        icon: Copy,
        titleKey: "whatsNew.releases.1_10_0.items.gridQuickActions.title",
        bodyKey: "whatsNew.releases.1_10_0.items.gridQuickActions.body",
      },
    ],
  },
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
      {
        icon: ListFilter,
        titleKey: "whatsNew.releases.1_9_0.items.advancedFilter.title",
        bodyKey: "whatsNew.releases.1_9_0.items.advancedFilter.body",
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

/**
 * Builds the command-palette index out of the live stores.
 *
 * Kept out of `CommandPalette.tsx` so the component is only presentation +
 * keyboard handling: the palette grew from "connections, tables, theme,
 * preferences" to thirteen groups (every individual preference, the docs, open
 * tabs, environments, panels, saved queries, history, …) and a single 600-line
 * `useMemo` inside the view was already the hard part to read.
 *
 * Two rules worth keeping:
 *
 *  - **`enabled` gates the whole build.** The palette is mounted for the app's
 *    entire life but open for seconds; indexing every table of every connected
 *    database on each unrelated store change would be pure waste. When it's
 *    closed this returns a stable empty array.
 *  - **Ids are stable.** They key the MRU list in `useCommandPalette`, so they
 *    are derived from what the entry *is* (`table:<conn>:<schema>.<name>`),
 *    never from its position in the list.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AppWindow,
  BookOpen,
  Braces,
  Cable,
  Columns3,
  Database,
  Eye,
  FileText,
  FolderOpen,
  History,
  Info,
  Keyboard,
  Languages,
  LayoutGrid,
  Layers,
  MessageSquarePlus,
  Palette,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  SquareTerminal,
  Star,
  Table as TableIcon,
  Unplug,
  X,
} from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { usePreferences } from "@/stores/preferences/preferences";
import { useThemeStore } from "@/stores/preferences/theme";
import { useSavedQueries } from "@/stores/query/savedQueries";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import { useFeedbackDialog } from "@/stores/dialogs/feedbackDialog";
import { useWhatsNew } from "@/stores/dialogs/whatsNew";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useUpdateStore } from "@/stores/update";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/components/settings/useSettingsDialog";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { DOCS } from "@/lib/appInfo/docs";
import {
  resolveConnectionLabel,
  tabLeafTitle,
  tableTabTitle,
} from "@/lib/connectionLabel";
import {
  PANELS,
  floatActivePanel,
  isPanelOpen,
  resetLayout,
  togglePanel,
  type PanelId,
} from "@/lib/dockview";
import { refreshTable } from "@/lib/grid/tableRefresh";
import { ACTIONS, formatComboForDisplay, getBinding } from "@/lib/keybindings";
import { api } from "@/lib/tauri";
import { SETTINGS_INDEX } from "@/lib/commandPalette/settingsRegistry";
import type { PaletteCommand } from "@/lib/commandPalette/types";
import type { AppLanguage, TabKind } from "@/types";

/** Icon per tab kind, mirroring `TabSwitcher`'s map. */
const TAB_ICON: Record<TabKind, React.ReactNode> = {
  table: <TableIcon className="h-4 w-4" />,
  query: <SquareTerminal className="h-4 w-4" />,
  structure: <Columns3 className="h-4 w-4" />,
  view: <Eye className="h-4 w-4" />,
  security: <Cable className="h-4 w-4" />,
};

/** Icon per Settings section, matching `SettingsDialog`'s rail. */
const SECTION_ICON: Record<SettingsSection, React.ReactNode> = {
  general: <Settings className="h-4 w-4" />,
  editor: <FileText className="h-4 w-4" />,
  grid: <TableIcon className="h-4 w-4" />,
  connections: <Plug className="h-4 w-4" />,
  appearance: <Palette className="h-4 w-4" />,
  shortcuts: <Keyboard className="h-4 w-4" />,
  origins: <FolderOpen className="h-4 w-4" />,
  mcp: <Cable className="h-4 w-4" />,
  about: <Info className="h-4 w-4" />,
};

/** Collapse a SQL body to one searchable, renderable line. */
function oneLine(sql: string, max = 90): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function useCommands(enabled: boolean): PaletteCommand[] {
  const { t } = useTranslation();

  // ── Store slices (primitives / raw references only — gotcha #1) ───────────
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const byConnection = useSchema((s) => s.byConnection);
  const refreshSchema = useSchema((s) => s.refresh);
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeId);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const environments = useEnvironments((s) => s.environments);
  const activeEnvId = useEnvironments((s) => s.activeId);
  const switchEnvironment = useEnvironments((s) => s.switchTo);
  const prefs = usePreferences((s) => s.prefs);
  const updateEditor = usePreferences((s) => s.updateEditor);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const updateUi = usePreferences((s) => s.updateUi);
  const updateConnections = usePreferences((s) => s.updateConnections);
  const customThemes = useThemeStore((s) => s.customThemes);
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const savedQueries = useSavedQueries((s) => s.items);
  const historyEntries = useQueryHistory((s) => s.entries);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const openSettingsAtPref = useSettingsDialog((s) => s.openAtPref);

  return useMemo<PaletteCommand[]>(() => {
    if (!enabled) return [];

    const list: PaletteCommand[] = [];
    const writers = { updateEditor, updateGrid, updateUi, updateConnections };
    const combo = (id: Parameters<typeof getBinding>[1]) =>
      formatComboForDisplay(getBinding(prefs.keybindings, id));
    const activeTab = tabs.find((x) => x.id === activeTabId) ?? null;
    /** Where a new query tab should land: the active connection, or nothing. */
    const queryTarget = selected
      ? useTabs.getState().queryTargetFor(selected)
      : null;

    // ── Actions ──────────────────────────────────────────────────────────────
    if (selected && queryTarget) {
      list.push({
        id: "action:new-query",
        group: "actions",
        label: t("commandPalette.newQuery"),
        detail: resolveConnectionLabel(profiles, queryTarget),
        keywords: "sql editor new query nueva consulta",
        icon: <Plus className="h-4 w-4" />,
        run: () =>
          useTabs.getState().open({
            kind: "query",
            title: t("tabs.queryFileName"),
            connectionId: queryTarget,
            query: "-- write a SQL query and press Ctrl+Enter\n",
          }),
      });
    }

    list.push(
      {
        id: "action:new-connection",
        group: "actions",
        label: t("menu.file.newConnection"),
        keywords: "connection profile server nueva conexión perfil servidor",
        icon: <Plus className="h-4 w-4" />,
        run: () => useConnectionDialog.getState().openNew(),
      },
      {
        id: "action:manage-connections",
        group: "actions",
        label: t("menu.file.manageConnections"),
        keywords: "connections manager edit gestionar conexiones editar",
        icon: <Settings className="h-4 w-4" />,
        run: () => useConnectionDialog.getState().openManage(selected),
      },
      {
        id: "action:import-profiles",
        group: "actions",
        label: t("menu.file.importProfiles"),
        keywords: "import profiles importar perfiles",
        icon: <FolderOpen className="h-4 w-4" />,
        run: () => useConnectionDialog.getState().setImportOpen(true),
      },
      {
        id: "action:export-profiles",
        group: "actions",
        label: t("menu.file.exportProfiles"),
        keywords: "export profiles exportar perfiles",
        icon: <FolderOpen className="h-4 w-4" />,
        run: () => useConnectionDialog.getState().setExportOpen(true),
      },
    );

    if (selected) {
      list.push({
        id: "action:refresh-schema",
        group: "actions",
        label: t("commandPalette.refreshSchema"),
        detail: resolveConnectionLabel(profiles, selected),
        keywords: "refresh reload schema tables recargar esquema",
        icon: <RefreshCw className="h-4 w-4" />,
        run: () => void refreshSchema(selected),
      });
    }
    if (activeTab?.kind === "table") {
      list.push({
        id: "action:refresh-data",
        group: "actions",
        label: t("commandPalette.refreshData"),
        detail: activeTab.title,
        keywords: "refresh reload data rows recargar datos filas",
        icon: <RefreshCw className="h-4 w-4" />,
        combo: combo("refreshData"),
        run: () => {
          if (!refreshTable(activeTab.id)) void refreshSchema(activeTab.connectionId);
        },
      });
    }
    if (activeTab) {
      list.push(
        {
          id: "action:close-tab",
          group: "actions",
          label: t("commandPalette.closeTab"),
          detail: activeTab.title,
          keywords: "close tab cerrar pestaña",
          icon: <X className="h-4 w-4" />,
          run: () => useTabs.getState().close(activeTab.id),
        },
        {
          id: "action:toggle-pin-tab",
          group: "actions",
          label: activeTab.pinned
            ? t("commandPalette.unpinTab")
            : t("commandPalette.pinTab"),
          detail: activeTab.title,
          keywords: "pin unpin tab fijar desfijar pestaña",
          icon: activeTab.pinned ? (
            <PinOff className="h-4 w-4" />
          ) : (
            <Pin className="h-4 w-4" />
          ),
          run: () =>
            useTabs.getState().setPinned(activeTab.id, !activeTab.pinned),
        },
      );
    }
    if (tabs.length > 1) {
      list.push({
        id: "action:close-all-tabs",
        group: "actions",
        label: t("commandPalette.closeAllTabs"),
        keywords: "close all tabs cerrar todas pestañas",
        icon: <X className="h-4 w-4" />,
        run: () => useTabs.getState().closeAll(),
      });
    }
    if (active.size > 0) {
      list.push({
        id: "action:disconnect-all",
        group: "actions",
        label: t("menu.file.disconnectAll"),
        keywords: "disconnect all close pools desconectar todo",
        icon: <Unplug className="h-4 w-4" />,
        run: () => {
          for (const id of Array.from(active)) {
            void disconnect(id).catch((e) => toast.error(String(e)));
          }
        },
      });
    }

    list.push(
      {
        id: "action:new-window",
        group: "actions",
        label: t("menu.window.newWindow"),
        keywords: "window new ventana nueva",
        icon: <AppWindow className="h-4 w-4" />,
        run: () => {
          void api.openNewWindow().catch((e) => toast.error(String(e)));
        },
      },
      {
        id: "action:reset-layout",
        group: "actions",
        label: t("menu.window.resetLayout"),
        keywords: "reset layout panels restablecer disposición paneles",
        icon: <RotateCcw className="h-4 w-4" />,
        run: () => resetLayout(),
      },
    );

    // ── Panels ───────────────────────────────────────────────────────────────
    for (const panel of PANELS) {
      const shown = isPanelOpen(panel.id as PanelId);
      list.push({
        id: `panel:${panel.id}`,
        group: "panels",
        label: t("commandPalette.togglePanel", { name: t(panel.i18nKey) }),
        keywords: `panel view toggle panel vista ${panel.id}`,
        icon: <PanelsTopLeft className="h-4 w-4" />,
        badge: shown
          ? t("commandPalette.settings.on")
          : t("commandPalette.settings.off"),
        current: shown,
        run: () => togglePanel(panel.id as PanelId),
      });
    }
    list.push({
      id: "panel:float-active",
      group: "panels",
      label: t("menu.view.floatActivePanel"),
      keywords: "float panel window flotante panel",
      icon: <LayoutGrid className="h-4 w-4" />,
      run: () => floatActivePanel(),
    });

    // ── Settings: the dialog's sections, then every individual preference ────
    list.push({
      id: "settings:open",
      group: "settings",
      label: t("commandPalette.openPreferences"),
      keywords: "preferences settings options preferencias ajustes opciones",
      icon: <Settings className="h-4 w-4" />,
      combo: combo("openSettings"),
      run: () => openSettings(),
    });
    for (const section of Object.keys(SECTION_ICON) as SettingsSection[]) {
      list.push({
        id: `settings:section:${section}`,
        group: "settings",
        label: t("commandPalette.openSection", {
          name: t(`settings.sections.${section}.label`),
        }),
        detail: t(`settings.sections.${section}.desc`),
        keywords: `preferences settings section preferencias ajustes ${section}`,
        icon: SECTION_ICON[section],
        run: () => openSettings(section),
      });
    }
    for (const entry of SETTINGS_INDEX) {
      const value = entry.value?.(prefs);
      const badge = value?.raw ?? (value?.i18nKey ? t(value.i18nKey) : undefined);
      list.push({
        id: `setting:${entry.prefId}`,
        group: "settings",
        label: t(entry.labelKey),
        detail: t(`settings.sections.${entry.section}.label`),
        keywords: `${entry.keywords ?? ""} ${entry.descKey ? t(entry.descKey) : ""}`,
        icon: SECTION_ICON[entry.section],
        badge,
        run: () => openSettingsAtPref(entry.section, entry.prefId),
        alt: entry.toggle
          ? {
              hintKey: "commandPalette.hintToggle",
              // Stays open so a mis-toggle is one more Alt+Enter away and the
              // badge visibly flips under the cursor.
              keepOpen: true,
              run: () =>
                entry.toggle?.(usePreferences.getState().prefs, writers),
            }
          : undefined,
      });
    }
    for (const action of ACTIONS) {
      list.push({
        id: `setting:keybinding.${action.id}`,
        group: "settings",
        label: t("commandPalette.shortcutFor", { name: t(action.labelKey) }),
        detail: t("settings.sections.shortcuts.label"),
        keywords: "shortcut keybinding hotkey atajo tecla combinación",
        icon: <Keyboard className="h-4 w-4" />,
        badge: formatComboForDisplay(getBinding(prefs.keybindings, action.id)),
        run: () => openSettingsAtPref("shortcuts", `keybinding.${action.id}`),
      });
    }

    // ── Appearance: app themes + UI language ─────────────────────────────────
    for (const th of [...BUILT_IN_THEMES, ...customThemes]) {
      list.push({
        id: `theme:${th.id}`,
        group: "appearance",
        label: t("commandPalette.theme", { name: th.name }),
        keywords: `theme colours tema colores ${th.mode} ${th.id}`,
        icon: <Palette className="h-4 w-4" />,
        badge: t(
          th.mode === "light"
            ? "settings.appearance.modeLight"
            : "settings.appearance.modeDark",
        ),
        current: th.id === themeId,
        run: () => setThemeId(th.id),
      });
    }
    for (const lng of ["en", "es"] as AppLanguage[]) {
      if (lng === prefs.ui.language) continue;
      list.push({
        id: `lang:${lng}`,
        group: "appearance",
        label: t("commandPalette.language", {
          name: t(`commandPalette.language_${lng}`),
        }),
        keywords: "language idioma locale",
        icon: <Languages className="h-4 w-4" />,
        run: () => updateUi({ language: lng }),
      });
    }

    // ── Open tabs ────────────────────────────────────────────────────────────
    for (const tab of tabs) {
      list.push({
        id: `tab:${tab.id}`,
        group: "tabs",
        label: tabLeafTitle(profiles, tab),
        detail: resolveConnectionLabel(profiles, tab.connectionId),
        keywords: `tab ${tab.title} ${tab.kind} pestaña`,
        icon: TAB_ICON[tab.kind],
        current: tab.id === activeTabId,
        run: () => {
          useTabs.getState().setActive(tab.id);
          setSelected(tab.connectionId);
        },
        alt: {
          hintKey: "commandPalette.hintCloseTab",
          run: () => useTabs.getState().close(tab.id),
        },
      });
    }

    // ── Connections ──────────────────────────────────────────────────────────
    for (const p of profiles) {
      const isLive = active.has(p.id);
      list.push({
        id: `conn:${p.id}`,
        group: "connections",
        label: isLive
          ? t("commandPalette.switchTo", { name: p.name })
          : t("commandPalette.connect", { name: p.name }),
        detail: [p.driver, p.database || p.host].filter(Boolean).join(" · "),
        keywords: `${p.name} ${p.driver} ${p.database ?? ""} ${p.host ?? ""} ${p.group ?? ""}`,
        icon: isLive ? (
          <Database className="h-4 w-4" />
        ) : (
          <Plug className="h-4 w-4" />
        ),
        current: p.id === selected,
        run: () => {
          if (isLive) {
            setSelected(p.id);
            return;
          }
          void (async () => {
            try {
              await connect(p.id);
              await refreshSchema(p.id);
              setSelected(p.id);
            } catch (e) {
              toast.error(String(e));
            }
          })();
        },
        alt: isLive
          ? {
              hintKey: "commandPalette.hintDisconnect",
              run: () => {
                void disconnect(p.id).catch((e) => toast.error(String(e)));
              },
            }
          : undefined,
      });
    }

    // ── Environments ─────────────────────────────────────────────────────────
    if (environments.length > 1) {
      for (const env of environments) {
        list.push({
          id: `env:${env.id}`,
          group: "environments",
          label: t("commandPalette.switchEnvironment", {
            name: environmentLabel(env, t("environments.defaultName")),
          }),
          keywords: "environment workspace entorno espacio",
          icon: <Layers className="h-4 w-4" />,
          current: env.id === activeEnvId,
          run: () => {
            if (env.id === activeEnvId) return;
            void switchEnvironment(env.id).catch((e) =>
              toast.error(t("environments.switchFailed", { error: String(e) })),
            );
          },
        });
      }
    }

    // ── Databases of every live connection ───────────────────────────────────
    for (const p of profiles) {
      if (!active.has(p.id)) continue;
      const dbs = byConnection[p.id]?.databases ?? [];
      // A single-database profile browses its own database directly; the
      // per-database views only exist for server-wide connections.
      if (dbs.length < 2) continue;
      for (const db of dbs) {
        list.push({
          id: `db:${p.id}:${db.name}`,
          group: "databases",
          label: db.name,
          detail: p.name,
          keywords: `database schema base de datos esquema ${p.name}`,
          icon: <Database className="h-4 w-4" />,
          run: () => {
            void (async () => {
              try {
                const childId = await openTrackedDatabaseView(p.id, db.name);
                await refreshSchema(childId);
                setSelected(p.id);
              } catch (e) {
                toast.error(String(e));
              }
            })();
          },
        });
      }
    }

    // ── Tables / views / collections, across every loaded connection ─────────
    for (const [connectionId, schema] of Object.entries(byConnection)) {
      if (!schema.tables?.length) continue;
      const connLabel = resolveConnectionLabel(profiles, connectionId);
      for (const tbl of schema.tables) {
        const qualified = tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name;
        list.push({
          id: `table:${connectionId}:${qualified}`,
          group: "schema",
          label: qualified,
          detail: connLabel,
          keywords: `${tbl.kind} table view collection tabla vista colección ${connLabel}`,
          icon:
            tbl.kind === "view" ? (
              <Eye className="h-4 w-4" />
            ) : (
              <TableIcon className="h-4 w-4" />
            ),
          run: () => {
            useTabs.getState().open({
              kind: "table",
              title: tableTabTitle(profiles, connectionId, tbl.name),
              connectionId,
              schema: tbl.schema,
              table: tbl.name,
            });
            setSelected(connectionId);
          },
        });
      }
    }

    // ── Saved queries + history ──────────────────────────────────────────────
    const openSql = (sql: string, title: string, connectionId: string) => {
      useTabs.getState().open({ kind: "query", title, connectionId, query: sql });
      setSelected(connectionId);
    };
    if (queryTarget) {
      for (const q of savedQueries) {
        // A query saved against a connection that's since been removed still
        // opens — against the active one — rather than disappearing.
        const target =
          q.connectionId && profiles.some((p) => p.id === q.connectionId)
            ? q.connectionId
            : queryTarget;
        list.push({
          id: `saved:${q.id}`,
          group: "saved",
          label: q.name,
          detail: q.description?.trim() || oneLine(q.sql, 70),
          keywords: `saved query ${q.tags.join(" ")} ${oneLine(q.sql, 200)} guardada`,
          icon: <Star className="h-4 w-4" />,
          run: () => openSql(q.sql, q.name, target),
        });
      }
      for (const h of historyEntries.slice(0, 20)) {
        const target = profiles.some((p) => p.id === h.connectionId)
          ? h.connectionId
          : queryTarget;
        list.push({
          id: `history:${h.id}`,
          group: "history",
          label: oneLine(h.sql),
          detail: resolveConnectionLabel(profiles, h.connectionId),
          keywords: `history recent query historial reciente ${oneLine(h.sql, 200)}`,
          icon: <History className="h-4 w-4" />,
          run: () => openSql(h.sql, t("tabs.queryFileName"), target),
        });
      }
    }

    // ── Help & documentation ─────────────────────────────────────────────────
    list.push({
      id: "help:docs",
      group: "help",
      label: t("docs.menuEntry"),
      detail: t("docs.subtitle"),
      keywords: "docs documentation guide help documentación guía ayuda",
      icon: <BookOpen className="h-4 w-4" />,
      run: () => useDocsDialog.getState().openTo(),
    });
    for (const doc of DOCS) {
      list.push({
        id: `help:doc:${doc.id}`,
        group: "help",
        label: t(doc.titleKey),
        detail: t(doc.descriptionKey),
        keywords: `docs documentation documentación ${doc.id}`,
        icon: <BookOpen className="h-4 w-4" />,
        run: () => useDocsDialog.getState().openTo(doc.id),
      });
    }
    list.push(
      {
        id: "help:whats-new",
        group: "help",
        label: t("whatsNew.menuEntry"),
        keywords: "release notes changelog novedades cambios versión",
        icon: <Sparkles className="h-4 w-4" />,
        run: () => useWhatsNew.getState().openLatest(),
      },
      {
        id: "help:feedback",
        group: "help",
        label: t("feedback.menuEntry"),
        detail: t("feedback.description"),
        keywords: "bug feature issue report github error sugerencia incidencia",
        icon: <MessageSquarePlus className="h-4 w-4" />,
        run: () => useFeedbackDialog.getState().openWith(),
      },
      {
        id: "help:check-updates",
        group: "help",
        label: t("commandPalette.checkUpdates"),
        keywords: "update upgrade version actualizar actualización versión",
        icon: <RefreshCw className="h-4 w-4" />,
        run: () => {
          void useUpdateStore.getState().checkManually();
        },
      },
      {
        id: "help:about",
        group: "help",
        label: t("menu.help.about"),
        keywords: "about version paths acerca de versión rutas",
        icon: <Info className="h-4 w-4" />,
        run: () => openSettings("about"),
      },
      {
        id: "help:mcp",
        group: "help",
        label: t("commandPalette.openSection", {
          name: t("settings.sections.mcp.label"),
        }),
        detail: t("settings.sections.mcp.desc"),
        keywords: "mcp ai connector claude cursor conector",
        icon: <Braces className="h-4 w-4" />,
        run: () => openSettings("mcp"),
      },
    );

    return list;
  }, [
    enabled,
    t,
    profiles,
    active,
    connect,
    disconnect,
    byConnection,
    refreshSchema,
    tabs,
    activeTabId,
    selected,
    setSelected,
    environments,
    activeEnvId,
    switchEnvironment,
    prefs,
    updateEditor,
    updateGrid,
    updateUi,
    updateConnections,
    customThemes,
    themeId,
    setThemeId,
    savedQueries,
    historyEntries,
    openSettings,
    openSettingsAtPref,
  ]);
}

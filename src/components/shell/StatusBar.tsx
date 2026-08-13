/**
 * Bottom status bar. Left side: a connections dropdown (see
 * `StatusConnections`) plus the active tab's selection count, if any (query
 * tabs have their own run stats — timer, rows, history — inside the query
 * editor itself, see `QueryEditorTab`, rather than duplicated here). Right
 * side: encoding, the connected server version, a clickable query-history
 * popover, and quick density / theme toggles.
 *
 * Everything here subscribes to reference-stable store values and derives
 * scalars locally, per the Zustand selector rule in CLAUDE.md.
 */

import { useTranslation } from "react-i18next";
import { History, Moon, Rows3, SquareTerminal, Sun, Trash2 } from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabs } from "@/stores/session/tabs";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { useGridSelection } from "@/stores/grid/gridSelection";
import { usePreferences, selectGridPrefs } from "@/stores/preferences/preferences";
import { useThemeStore, selectActiveTheme } from "@/stores/preferences/theme";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useUi } from "@/stores/session/ui";
import { StatusConnections } from "@/components/connection/StatusConnections";
import { EnvironmentSwitcher } from "@/components/connection/EnvironmentSwitcher";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Thin vertical divider between status bar sections. */
function Sep() {
  return <span className="text-muted-foreground/30">|</span>;
}

/** Row-height presets driving the grid "density" quick toggle. */
const DENSITY_PRESETS: { key: string; labelKey: string; rowHeight: number }[] = [
  { key: "compact", labelKey: "statusBar.densityCompact", rowHeight: 20 },
  { key: "cosy", labelKey: "statusBar.densityCosy", rowHeight: 26 },
  { key: "comfortable", labelKey: "statusBar.densityComfortable", rowHeight: 32 },
];

export function StatusBar() {
  const { t } = useTranslation();
  const versions = useConnections((s) => s.versions);

  // .find() returns a stable reference to an existing tab object.
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const activeId = useTabs((s) => s.activeId);

  const historyCount = useQueryHistory((s) => s.entries.length);

  // Selection for the active tab (table tabs report; query tabs don't).
  const selection = useGridSelection((s) =>
    activeId ? s.byTab[activeId] : undefined,
  );

  const serverVersion = activeTab ? versions[activeTab.connectionId] : undefined;

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-card/60 px-2 text-[11px] text-muted-foreground">
      {/* Left — connections + selection stats */}
      <div className="flex items-center gap-2">
        <EnvironmentSwitcher />
        <Sep />
        <StatusConnections />

        {selection && selection.count > 0 && (
          <>
            <Sep />
            <span className="tabular-nums text-foreground">
              {t("statusBar.selected", { count: selection.count })}
            </span>
          </>
        )}
      </div>

      {/* Right — encoding · version · history · density · theme */}
      <div className="flex items-center gap-2">
        <SimpleTooltip label={t("statusBar.commandPaletteTooltip")} side="top">
          <button
            type="button"
            onClick={() => useCommandPalette.getState().toggle()}
            className="rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("statusBar.commandPaletteHint")}
          </button>
        </SimpleTooltip>
        <Sep />
        <span>{t("statusBar.encoding")}</span>
        {serverVersion && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="max-w-[12rem] truncate">{serverVersion}</span>
          </>
        )}
        <span className="text-muted-foreground/30">·</span>
        <HistoryMenu count={historyCount} />
        <Sep />
        <DensityMenu />
        <ConsoleToggle />
        <ThemeToggle />
      </div>
    </div>
  );
}

/** Clickable query-history popover. */
function HistoryMenu({ count }: { count: number }) {
  const { t } = useTranslation();
  const entries = useQueryHistory((s) => s.entries);
  const clear = useQueryHistory((s) => s.clear);
  const active = useConnections((s) => s.active);
  const setSelected = useUi((s) => s.setSelectedConnectionId);

  function openEntry(connectionId: string, sql: string) {
    if (active.has(connectionId)) {
      // Open a fresh query tab prefilled with the SQL on its connection.
      useTabs.getState().open({
        kind: "query",
        title: t("tabs.queryFileName"),
        connectionId,
        query: sql,
      });
      setSelected(connectionId);
    } else {
      // The connection isn't live — fall back to copying the SQL.
      void navigator.clipboard.writeText(sql);
    }
  }

  return (
    <DropdownMenu>
      <SimpleTooltip label={t("statusBar.recentQueries")} side="top">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <History className="h-3 w-3" />
            {t("statusBar.history")} {count}
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent side="top" align="end" className="w-96">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("statusBar.recentQueries")}
        </div>
        {entries.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("statusBar.noHistory")}
          </div>
        ) : (
          <>
            <div className="max-h-72 overflow-auto">
              {entries.slice(0, 15).map((e) => (
                <DropdownMenuItem
                  key={e.id}
                  onSelect={() => openEntry(e.connectionId, e.sql)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="line-clamp-2 w-full font-mono text-[11px] text-foreground">
                    {e.sql}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {e.error
                      ? e.error
                      : `${e.rowsAffected} ${t("statusBar.rows")} · ${e.elapsedMs} ${t("statusBar.ms")}`}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => clear()}
              className="gap-2 text-xs text-muted-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("statusBar.clearHistory")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Grid row-density quick toggle (reuses the persisted `gridPrefs.rowHeight`). */
function DensityMenu() {
  const { t } = useTranslation();
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);

  return (
    <DropdownMenu>
      <SimpleTooltip label={t("statusBar.density")} side="top">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Rows3 className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent side="top" align="end" className="w-40">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("statusBar.density")}
        </div>
        {DENSITY_PRESETS.map((d) => (
          <DropdownMenuItem
            key={d.key}
            onSelect={() => updateGrid({ rowHeight: d.rowHeight })}
            className={cn(
              "text-xs",
              rowHeight === d.rowHeight && "font-semibold text-brand",
            )}
          >
            {t(d.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Reopens the console dock once it's been collapsed from its own header
 *  (`ConsoleDock`) — the VSCode "toggle terminal" pattern, since collapsing
 *  it there leaves no other affordance to bring it back. */
function ConsoleToggle() {
  const { t } = useTranslation();
  const consoleOpen = useSessionPanelLayout((s) => s.consoleOpen);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  return (
    <SimpleTooltip
      label={
        consoleOpen ? t("shell.console.collapse") : t("shell.console.expand")
      }
      side="top"
    >
      <button
        type="button"
        onClick={toggleConsole}
        aria-pressed={consoleOpen}
        className={cn(
          "flex items-center rounded-sm p-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          consoleOpen && "text-foreground",
        )}
      >
        <SquareTerminal className="h-3 w-3" />
      </button>
    </SimpleTooltip>
  );
}

/** Light/dark quick toggle, mirroring the header button. */
function ThemeToggle() {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => selectActiveTheme(s).mode);
  const setMode = useThemeStore((s) => s.setActiveMode);
  return (
    <SimpleTooltip label={t("statusBar.toggleTheme")} side="top">
      <button
        type="button"
        onClick={() => setMode(mode === "dark" ? "light" : "dark")}
        className="flex items-center rounded-sm p-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        {mode === "dark" ? (
          <Sun className="h-3 w-3" />
        ) : (
          <Moon className="h-3 w-3" />
        )}
      </button>
    </SimpleTooltip>
  );
}

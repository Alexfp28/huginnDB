/**
 * Bottom status bar. Left side: a connections dropdown (see
 * `StatusConnections`) plus live query/selection stats for the active tab and
 * a read-only marker. Right side: encoding, the connected server version, a
 * clickable query-history popover, and quick density / theme toggles.
 *
 * Everything here subscribes to reference-stable store values and derives
 * scalars locally, per the Zustand selector rule in CLAUDE.md.
 */

import { useTranslation } from "react-i18next";
import { History, Moon, Rows3, Sun, Trash2 } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useTabs } from "@/stores/tabs";
import { useQueryHistory } from "@/stores/queryHistory";
import { useGridSelection } from "@/stores/gridSelection";
import { usePreferences, selectGridPrefs } from "@/stores/preferences";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { useUi } from "@/stores/ui";
import { StatusConnections } from "@/components/StatusConnections";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
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

  const stats = activeTab?.lastQueryStats;
  const serverVersion = activeTab ? versions[activeTab.connectionId] : undefined;
  // Query-result tabs are read-only (no PK-anchored editing); table tabs edit.
  const readOnly = activeTab?.kind === "query";

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-card/60 px-2 text-[11px] text-muted-foreground">
      {/* Left — connections + query/selection stats */}
      <div className="flex items-center gap-2">
        <StatusConnections />

        {selection && selection.count > 0 ? (
          <>
            <Sep />
            <span className="text-foreground">
              {t("statusBar.selected", { count: selection.count })}
            </span>
          </>
        ) : (
          stats && (
            <>
              <Sep />
              <span>
                {stats.rows.toLocaleString()} {t("statusBar.rows")}
              </span>
              <Sep />
              <span>
                {t("statusBar.executedIn")} {stats.elapsed_ms}{" "}
                {t("statusBar.ms")}
              </span>
            </>
          )
        )}

        {readOnly && (
          <>
            <Sep />
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {t("statusBar.readOnly")}
            </span>
          </>
        )}
      </div>

      {/* Right — encoding · version · history · density · theme */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            import("@/components/CommandPalette").then((m) =>
              m.useCommandPalette.getState().toggle(),
            );
          }}
          title={t("statusBar.commandPaletteTooltip")}
          className="rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {t("statusBar.commandPaletteHint")}
        </button>
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
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          title={t("statusBar.recentQueries")}
        >
          <History className="h-3 w-3" />
          {t("statusBar.history")} {count}
        </button>
      </DropdownMenuTrigger>
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
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          title={t("statusBar.density")}
        >
          <Rows3 className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
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

/** Light/dark quick toggle, mirroring the header button. */
function ThemeToggle() {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => selectActiveTheme(s).mode);
  const setMode = useThemeStore((s) => s.setActiveMode);
  return (
    <button
      type="button"
      onClick={() => setMode(mode === "dark" ? "light" : "dark")}
      title={t("statusBar.toggleTheme")}
      className="flex items-center rounded-sm p-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      {mode === "dark" ? (
        <Sun className="h-3 w-3" />
      ) : (
        <Moon className="h-3 w-3" />
      )}
    </button>
  );
}

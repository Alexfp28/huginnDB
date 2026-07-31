/**
 * Global command palette (Ctrl/Cmd+K). A keyboard-first launcher for the
 * actions that otherwise live behind menus: switch / connect a database, open
 * a table from the active connection's schema, start a query, switch theme or
 * language, open Preferences.
 *
 * Built on the Radix Dialog primitive directly (rather than the styled
 * `DialogContent`, which bakes in a close button that would overlap the search
 * field) plus a filtered list — no new dependency. Open state lives in a tiny
 * store so both the `window` keydown listener and the Monaco-scoped command in
 * `QueryEditorTab` can toggle it (Monaco swallows Ctrl+K inside its focus area;
 * see gotcha #9 in CLAUDE.md).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Database,
  Languages,
  Palette,
  Plug,
  Plus,
  Search,
  Settings,
  Table as TableIcon,
} from "lucide-react";
import { useConnections } from "@/stores/connections";
import { tableTabTitle } from "@/lib/connectionLabel";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { usePreferences } from "@/stores/preferences";
import { useThemeStore } from "@/stores/theme";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { cn } from "@/lib/utils";

interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Shared so the window listener and the Monaco command both reach it. */
export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

interface Command {
  id: string;
  group: string;
  label: string;
  /** Extra text matched by the fuzzy-ish filter but not displayed. */
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Store slices the commands are built from.
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const connect = useConnections((s) => s.connect);
  const refreshSchema = useSchema((s) => s.refresh);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const tables = useSchema((s) =>
    selected ? s.byConnection[selected]?.tables : undefined,
  );
  const customThemes = useThemeStore((s) => s.customThemes);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const language = usePreferences((s) => s.prefs.ui.language);
  const updateUi = usePreferences((s) => s.updateUi);
  const openSettings = useSettingsDialog((s) => s.openAt);

  // Reset transient UI each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    // Connections — switch if live, otherwise connect.
    for (const p of profiles) {
      const isActive = active.has(p.id);
      list.push({
        id: `conn:${p.id}`,
        group: t("commandPalette.groupConnections"),
        label: isActive
          ? t("commandPalette.switchTo", { name: p.name })
          : t("commandPalette.connect", { name: p.name }),
        keywords: `${p.name} ${p.driver} ${p.database}`,
        icon: isActive ? (
          <Database className="h-4 w-4" />
        ) : (
          <Plug className="h-4 w-4" />
        ),
        run: () => {
          if (isActive) {
            setSelected(p.id);
          } else {
            void (async () => {
              try {
                await connect(p.id);
                await refreshSchema(p.id);
                setSelected(p.id);
              } catch (e) {
                toast.error(String(e));
              }
            })();
          }
        },
      });
    }

    // Tables of the active connection.
    if (selected && tables) {
      for (const tbl of tables) {
        list.push({
          id: `table:${tbl.schema}.${tbl.name}`,
          group: t("commandPalette.groupTables"),
          label: tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name,
          keywords: "table view open",
          icon: <TableIcon className="h-4 w-4" />,
          run: () => {
            useTabs.getState().open({
              kind: "table",
              title: tableTabTitle(profiles, selected, tbl.name),
              connectionId: selected,
              schema: tbl.schema,
              table: tbl.name,
            });
            setSelected(selected);
          },
        });
      }
    }

    // Actions.
    if (selected) {
      list.push({
        id: "action:new-query",
        group: t("commandPalette.groupActions"),
        label: t("commandPalette.newQuery"),
        icon: <Plus className="h-4 w-4" />,
        run: () => {
          useTabs.getState().open({
            kind: "query",
            title: t("tabs.queryFileName"),
            connectionId: selected,
            query: "-- write a SQL query and press Ctrl+Enter\n",
          });
        },
      });
    }
    list.push({
      id: "action:preferences",
      group: t("commandPalette.groupActions"),
      label: t("commandPalette.openPreferences"),
      icon: <Settings className="h-4 w-4" />,
      run: () => openSettings(),
    });

    // Appearance — themes.
    for (const th of [...BUILT_IN_THEMES, ...customThemes]) {
      list.push({
        id: `theme:${th.id}`,
        group: t("commandPalette.groupAppearance"),
        label: t("commandPalette.theme", { name: th.name }),
        keywords: `theme ${th.mode}`,
        icon: <Palette className="h-4 w-4" />,
        run: () => setThemeId(th.id),
      });
    }
    // Appearance — language.
    for (const lng of ["en", "es"] as const) {
      if (lng === language) continue;
      list.push({
        id: `lang:${lng}`,
        group: t("commandPalette.groupAppearance"),
        label: t("commandPalette.language", {
          name: t(`commandPalette.language_${lng}`),
        }),
        keywords: "language idioma locale",
        icon: <Languages className="h-4 w-4" />,
        run: () => updateUi({ language: lng }),
      });
    }

    return list;
  }, [
    profiles,
    active,
    selected,
    tables,
    customThemes,
    language,
    connect,
    refreshSchema,
    setSelected,
    setThemeId,
    updateUi,
    openSettings,
    t,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? commands.filter((c) =>
          `${c.label} ${c.group} ${c.keywords ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : commands;
    return matches.slice(0, 60);
  }, [commands, query]);

  // Keep the highlight within bounds as the result set shrinks.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  function runAt(index: number) {
    const cmd = filtered[index];
    if (!cmd) return;
    cmd.run();
    setOpen(false);
  }

  // Keep the highlighted row in view during arrow-key navigation — without
  // this the selection can scroll off-screen in a long result set.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Per-group counts for the section-header badges.
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of filtered) m.set(c.group, (m.get(c.group) ?? 0) + 1);
    return m;
  }, [filtered]);

  // Group consecutive items by their `group` label for section headers.
  let lastGroup: string | null = null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(highlight);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("commandPalette.title")}
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("commandPalette.placeholder")}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
                <Search className="h-5 w-5 opacity-40" />
                {t("commandPalette.noResults")}
              </div>
            ) : (
              filtered.map((cmd, i) => {
                const showHeader = cmd.group !== lastGroup;
                lastGroup = cmd.group;
                const activeRow = i === highlight;
                return (
                  <div key={cmd.id}>
                    {showHeader && (
                      <div className="flex items-center justify-between px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <span>{cmd.group}</span>
                        <span className="tabular-nums text-muted-foreground/60">
                          {groupCounts.get(cmd.group)}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      data-index={i}
                      onClick={() => runAt(i)}
                      onMouseMove={() => setHighlight(i)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
                        activeRow
                          ? "bg-accent text-accent-foreground shadow-[inset_2px_0_0_hsl(var(--brand))]"
                          : "text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0",
                          activeRow ? "text-brand" : "text-muted-foreground",
                        )}
                      >
                        {cmd.icon}
                      </span>
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {activeRow && (
                        <kbd className="ml-auto shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
                          ↵
                        </kbd>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer legend — reinforces the keyboard-first identity. */}
          <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                ↑↓
              </kbd>
              {t("commandPalette.hintNavigate")}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                ↵
              </kbd>
              {t("commandPalette.hintRun")}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                esc
              </kbd>
              {t("commandPalette.hintClose")}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Open-tabs quick switcher (Ctrl/Cmd+P). A keyboard-first overlay listing
 * *currently open* tabs across every connection — the answer to "I have so
 * many tabs open I can't tell what's there / jump to one". Distinct from the
 * command palette (Ctrl+K), which opens *new* things from the schema; this
 * only ever navigates between tabs that already exist.
 *
 * Tabs are grouped: pinned first (so they never get lost), then one section
 * per `connection · database`. Enter jumps to the highlighted tab (and points
 * the workspace at its connection); the trailing buttons pin/unpin and close a
 * tab inline without leaving the list; Delete closes the highlighted tab.
 *
 * Built on the Radix Dialog primitive directly (same reasoning as
 * `CommandPalette`) with a plain substring filter — no new dependency.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import {
  Eye,
  Hammer,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  SquareTerminal,
  Table as TableIcon,
  X,
} from "lucide-react";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { resolveConnectionLabel } from "@/lib/connectionLabel";
import { cn } from "@/lib/utils";
import type { AppTab, TabKind } from "@/types";

interface TabSwitcherState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Shared so the window listener and the Monaco-scoped command both reach it. */
export const useTabSwitcher = create<TabSwitcherState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

const KIND_ICON: Record<TabKind, React.ReactNode> = {
  table: <TableIcon className="h-4 w-4" />,
  query: <SquareTerminal className="h-4 w-4" />,
  structure: <Hammer className="h-4 w-4" />,
  view: <Eye className="h-4 w-4" />,
  security: <ShieldCheck className="h-4 w-4" />,
};

interface Entry {
  tab: AppTab;
  group: string;
  connLabel: string;
  subtitle: string;
}

export function TabSwitcher() {
  const { t } = useTranslation();
  const open = useTabSwitcher((s) => s.open);
  const setOpen = useTabSwitcher((s) => s.setOpen);

  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const profiles = useConnections((s) => s.profiles);
  const setSelected = useUi((s) => s.setSelectedConnectionId);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const pinnedLabel = t("tabSwitcher.pinned");

  // Build the grouped, ordered entry list: pinned first (one section), then a
  // section per connection · database in first-appearance order.
  const entries = useMemo<Entry[]>(() => {
    const labelFor = (cid: string) => resolveConnectionLabel(profiles, cid);
    const toEntry = (tab: AppTab, group: string): Entry => {
      const connLabel = labelFor(tab.connectionId);
      const subtitle =
        tab.kind === "table"
          ? `${tab.schema ? `${tab.schema}.` : ""}${tab.table ?? ""} · ${connLabel}`
          : connLabel;
      return { tab, group, connLabel, subtitle };
    };

    const pinned = tabs.filter((x) => x.pinned).map((x) => toEntry(x, pinnedLabel));

    const rest: Entry[] = [];
    const seen = new Set<string>();
    for (const x of tabs) {
      if (x.pinned) continue;
      const label = labelFor(x.connectionId);
      if (!seen.has(label)) {
        seen.add(label);
        // Append every non-pinned tab of this connection contiguously.
        for (const y of tabs) {
          if (!y.pinned && labelFor(y.connectionId) === label) {
            rest.push(toEntry(y, label));
          }
        }
      }
    }
    return [...pinned, ...rest];
  }, [tabs, profiles, pinnedLabel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.tab.title} ${e.subtitle} ${e.connLabel}`.toLowerCase().includes(q),
    );
  }, [entries, query]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function jump(tab: AppTab) {
    useTabs.getState().setActive(tab.id);
    setSelected(tab.connectionId);
    setOpen(false);
  }

  function closeTab(id: string) {
    useTabs.getState().close(id);
    // Closing the last open tab leaves nothing to switch to.
    if (useTabs.getState().tabs.length === 0) setOpen(false);
  }

  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.group, (m.get(e.group) ?? 0) + 1);
    return m;
  }, [filtered]);

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
              const e0 = filtered[highlight];
              if (e0) jump(e0.tab);
            } else if (e.key === "Delete") {
              e.preventDefault();
              const e0 = filtered[highlight];
              if (e0) closeTab(e0.tab.id);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("tabSwitcher.title")}
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("tabSwitcher.placeholder")}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
                <Search className="h-5 w-5 opacity-40" />
                {tabs.length === 0
                  ? t("tabSwitcher.noneOpen")
                  : t("tabSwitcher.noResults")}
              </div>
            ) : (
              filtered.map((e, i) => {
                const showHeader = e.group !== lastGroup;
                lastGroup = e.group;
                const activeRow = i === highlight;
                const isCurrent = e.tab.id === activeId;
                return (
                  <div key={e.tab.id}>
                    {showHeader && (
                      <div className="flex items-center justify-between px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <span className="truncate">{e.group}</span>
                        <span className="tabular-nums text-muted-foreground/60">
                          {groupCounts.get(e.group)}
                        </span>
                      </div>
                    )}
                    <div
                      data-index={i}
                      onMouseMove={() => setHighlight(i)}
                      className={cn(
                        "group/row flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                        activeRow
                          ? "bg-accent text-accent-foreground shadow-[inset_2px_0_0_hsl(var(--brand))]"
                          : "text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => jump(e.tab)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                      >
                        <span
                          className={cn(
                            "shrink-0",
                            activeRow ? "text-brand" : "text-muted-foreground",
                          )}
                        >
                          {KIND_ICON[e.tab.kind]}
                        </span>
                        {e.tab.color && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: e.tab.color }}
                          />
                        )}
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5 truncate">
                            <span className="truncate">{e.tab.title}</span>
                            {isCurrent && (
                              <span className="shrink-0 rounded bg-brand/15 px-1 text-3xs font-medium uppercase tracking-wide text-brand">
                                {t("tabSwitcher.current")}
                              </span>
                            )}
                          </span>
                          <span className="truncate text-2xs text-muted-foreground">
                            {e.subtitle}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        title={
                          e.tab.pinned
                            ? t("tabSwitcher.unpin")
                            : t("tabSwitcher.pin")
                        }
                        onClick={() =>
                          useTabs.getState().setPinned(e.tab.id, !e.tab.pinned)
                        }
                        className={cn(
                          "shrink-0 rounded-sm p-1 transition-colors hover:bg-accent hover:text-foreground",
                          e.tab.pinned
                            ? "text-brand"
                            : "text-muted-foreground/60 opacity-0 group-hover/row:opacity-100",
                        )}
                      >
                        {e.tab.pinned ? (
                          <PinOff className="h-3.5 w-3.5" />
                        ) : (
                          <Pin className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        title={t("tabSwitcher.close")}
                        onClick={() => closeTab(e.tab.id)}
                        className="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-colors hover:bg-destructive/15 hover:text-destructive group-hover/row:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                ↑↓
              </kbd>
              {t("tabSwitcher.hintNavigate")}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                ↵
              </kbd>
              {t("tabSwitcher.hintJump")}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                del
              </kbd>
              {t("tabSwitcher.hintClose")}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

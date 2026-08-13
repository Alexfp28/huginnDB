/**
 * Global command palette (Ctrl/Cmd+K) — the keyboard-first launcher for
 * everything that otherwise lives behind a menu, a dialog or a tree.
 *
 * What it indexes lives in `lib/commandPalette/useCommands.tsx`; this file is
 * the surface: the input with its mode chip, the fuzzy-ranked grouped list, and
 * the key handling. Three things are worth knowing before editing it:
 *
 *  - **Modes.** A leading `>` `@` `#` `?` `:` narrows the search to one kind of
 *    entry (see `MODES` in `lib/commandPalette/types.ts`), VS Code style, so a
 *    connection with thousands of tables can't bury the actions. No prefix
 *    searches everything.
 *  - **Ranking, not filtering.** Results are scored (`lib/commandPalette/fuzzy`)
 *    and the matched characters are emphasised in the row. Groups are ordered by
 *    their best-scoring member while a query is active, so section headers stay
 *    coherent instead of interleaving.
 *  - **Alt+Enter is a real second action**, per entry: flip a boolean preference
 *    in place (the palette stays open, the value badge updates), disconnect a
 *    live connection, close a tab. The footer shows the hint for the highlighted
 *    row only, so it never advertises an action that isn't there.
 *
 * Built on the Radix Dialog primitive directly (rather than the styled
 * `DialogContent`, which bakes in a close button that would overlap the search
 * field). Open state + the persisted MRU list live in
 * `stores/dialogs/commandPalette.ts` so the `window` keydown listener, the
 * Monaco-scoped commands (gotcha #9) and the status bar all reach the same
 * instance.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Command as CommandIcon, Search } from "lucide-react";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useCommands } from "@/lib/commandPalette/useCommands";
import {
  fuzzyMatchFields,
  highlightChunks,
  type MatchRange,
} from "@/lib/commandPalette/fuzzy";
import {
  ALL_MODE,
  GROUP_ORDER,
  MODES,
  groupRank,
  modeIncludes,
  parseQuery,
  type PaletteCommand,
  type PaletteGroup,
} from "@/lib/commandPalette/types";
import { cn } from "@/lib/utils";

/** Entries shown per group when nothing has been typed, in the catch-all mode.
 *  A mode is already a narrow slice, so it shows everything instead. */
const PREVIEW_PER_GROUP = 6;
/** Hard cap on rendered rows. The list isn't virtualised, and a mode with an
 *  empty query can front a five-figure table index — typing narrows it far
 *  faster than scrolling would. */
const MAX_ROWS = 120;
/** Recently-used entries floated to the top of an empty query. */
const MAX_RECENT = 5;

interface Scored {
  cmd: PaletteCommand;
  score: number;
  ranges: MatchRange[];
}

interface Section {
  group: PaletteGroup;
  labelKey: string;
  items: Scored[];
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const initialQuery = useCommandPalette((s) => s.initialQuery);
  const recent = useCommandPalette((s) => s.recent);
  const remember = useCommandPalette((s) => s.remember);

  const [raw, setRaw] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useCommands(open);
  const { mode, query } = parseQuery(raw);

  // Reset transient UI each time the palette opens, honouring a mode the caller
  // asked for (`openWith("#")`).
  useEffect(() => {
    if (open) {
      setRaw(initialQuery);
      setHighlight(0);
    }
  }, [open, initialQuery]);

  const groupLabel = useMemo(() => {
    const m = new Map<PaletteGroup, string>();
    for (const g of GROUP_ORDER) m.set(g.id, t(g.labelKey));
    return m;
  }, [t]);

  /**
   * Score and group the index. With a query, groups are ordered by their best
   * hit and rows within a group by score; without one, declaration order wins
   * and each group is previewed (catch-all mode) or listed in full (a mode).
   */
  const sections = useMemo<Section[]>(() => {
    const inMode = commands.filter((c) => modeIncludes(mode, c.group));

    const buckets = new Map<PaletteGroup, Scored[]>();
    const push = (group: PaletteGroup, item: Scored) => {
      const bucket = buckets.get(group);
      if (bucket) bucket.push(item);
      else buckets.set(group, [item]);
    };

    if (!query) {
      if (mode === ALL_MODE && recent.length > 0) {
        const byId = new Map(inMode.map((c) => [c.id, c]));
        for (const id of recent) {
          const cmd = byId.get(id);
          if (!cmd) continue; // stale id — connection gone, tab closed
          const bucket = buckets.get("recent");
          if ((bucket?.length ?? 0) >= MAX_RECENT) break;
          push("recent", { cmd, score: 0, ranges: [] });
        }
      }
      const recentIds = new Set(
        (buckets.get("recent") ?? []).map((s) => s.cmd.id),
      );
      const limit = mode === ALL_MODE ? PREVIEW_PER_GROUP : Number.POSITIVE_INFINITY;
      for (const cmd of inMode) {
        if (recentIds.has(cmd.id)) continue;
        if ((buckets.get(cmd.group)?.length ?? 0) >= limit) continue;
        push(cmd.group, { cmd, score: 0, ranges: [] });
      }
    } else {
      for (const cmd of inMode) {
        const hit = fuzzyMatchFields(query, cmd.label, [
          cmd.keywords ?? "",
          cmd.detail ?? "",
          cmd.badge ?? "",
          groupLabel.get(cmd.group) ?? "",
        ]);
        if (!hit) continue;
        push(cmd.group, { cmd, score: hit.score, ranges: hit.ranges });
      }
      for (const bucket of buckets.values()) {
        bucket.sort((a, b) => b.score - a.score);
      }
    }

    const out: Section[] = [];
    for (const [group, items] of buckets) {
      out.push({
        group,
        labelKey: GROUP_ORDER.find((g) => g.id === group)?.labelKey ?? group,
        items,
      });
    }
    out.sort((a, b) => {
      if (query) {
        // "recent" never carries a score, so it only leads an empty query.
        const best = (s: Section) => s.items[0]?.score ?? 0;
        const delta = best(b) - best(a);
        if (delta !== 0) return delta;
      }
      return groupRank(a.group) - groupRank(b.group);
    });

    // Trim to the row cap without dropping a whole group silently mid-render.
    let budget = MAX_ROWS;
    const capped: Section[] = [];
    for (const section of out) {
      if (budget <= 0) break;
      capped.push({ ...section, items: section.items.slice(0, budget) });
      budget -= section.items.length;
    }
    return capped;
  }, [commands, mode, query, recent, groupLabel]);

  /** Flat row order for keyboard navigation. */
  const rows = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Keep the highlight within bounds as the result set shrinks.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Keep the highlighted row in view during arrow-key navigation.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, rows.length]);

  const current = rows[highlight]?.cmd ?? null;

  function runAt(index: number) {
    const cmd = rows[index]?.cmd;
    if (!cmd) return;
    remember(cmd.id);
    cmd.run();
    if (!cmd.keepOpen) setOpen(false);
  }

  function runAltAt(index: number) {
    const cmd = rows[index]?.cmd;
    if (!cmd?.alt) return;
    cmd.alt.run();
    if (cmd.alt.keepOpen) return;
    // A `keepOpen` action is deliberately NOT remembered: the MRU list reorders
    // the empty-query view, which would slide the row out from under the cursor
    // mid-toggle.
    remember(cmd.id);
    setOpen(false);
  }

  /** Switch mode from the hint chips without losing the typed text. */
  function applyMode(prefix: string) {
    setRaw(prefix ? `${prefix}${query}` : query);
    setHighlight(0);
    inputRef.current?.focus();
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[12%] z-50 w-full max-w-2xl -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (rows.length ? (h + 1) % rows.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) =>
                rows.length ? (h - 1 + rows.length) % rows.length : 0,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (e.altKey) runAltAt(highlight);
              else runAt(highlight);
            } else if (e.key === "Tab") {
              // Cycle through the modes: a discoverable way in for anyone who
              // never reads the sigils under the input.
              e.preventDefault();
              const order = [ALL_MODE, ...MODES];
              const at = order.findIndex((m) => m.prefix === mode.prefix);
              const next = order[(at + (e.shiftKey ? -1 + order.length : 1)) % order.length]!;
              applyMode(next.prefix);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("commandPalette.title")}
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {mode !== ALL_MODE && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-brand/15 px-1.5 py-0.5 text-2xs font-medium text-brand">
                <span className="font-mono">{mode.prefix}</span>
                {t(mode.labelKey)}
              </span>
            )}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              ref={inputRef}
              autoFocus
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setHighlight(0);
              }}
              placeholder={t("commandPalette.placeholder")}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {rows.length > 0 && (
              <span className="shrink-0 tabular-nums text-2xs text-muted-foreground/70">
                {rows.length}
              </span>
            )}
          </div>

          {/* Mode discovery: the sigils, clickable, only while the field is
              empty so they never compete with results. */}
          {!raw && (
            <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
              <CommandIcon className="mr-0.5 h-3 w-3 text-muted-foreground/60" />
              {MODES.map((m) => (
                <button
                  key={m.prefix}
                  type="button"
                  onClick={() => applyMode(m.prefix)}
                  className="flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-3xs text-muted-foreground transition-colors hover:border-brand/60 hover:text-foreground"
                >
                  <span className="font-mono text-brand">{m.prefix}</span>
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          )}

          <div ref={listRef} className="max-h-[26rem] overflow-y-auto p-1">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-muted-foreground">
                <Search className="h-5 w-5 opacity-40" />
                {t("commandPalette.noResults")}
                <span className="text-2xs text-muted-foreground/70">
                  {t("commandPalette.noResultsHint")}
                </span>
              </div>
            ) : (
              (() => {
                // Running index across sections so the flat keyboard order and
                // the rendered rows agree.
                let index = -1;
                return sections.map((section) => (
                  <div key={section.group}>
                    <div className="flex items-center justify-between px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <span>{t(section.labelKey)}</span>
                      <span className="tabular-nums text-muted-foreground/60">
                        {section.items.length}
                      </span>
                    </div>
                    {section.items.map(({ cmd, ranges }) => {
                      index += 1;
                      const i = index;
                      const activeRow = i === highlight;
                      return (
                        <button
                          key={cmd.id}
                          type="button"
                          data-index={i}
                          onClick={(e) => (e.altKey ? runAltAt(i) : runAt(i))}
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
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex items-center gap-1.5 truncate">
                              <span className="truncate">
                                {highlightChunks(cmd.label, ranges).map(
                                  (chunk, ci) => (
                                    <span
                                      key={ci}
                                      className={
                                        chunk.match
                                          ? "font-semibold text-brand"
                                          : undefined
                                      }
                                    >
                                      {chunk.text}
                                    </span>
                                  ),
                                )}
                              </span>
                              {cmd.current && (
                                <span className="shrink-0 rounded bg-brand/15 px-1 text-3xs font-medium uppercase tracking-wide text-brand">
                                  {t("commandPalette.current")}
                                </span>
                              )}
                            </span>
                            {cmd.detail && (
                              <span className="truncate text-2xs text-muted-foreground">
                                {cmd.detail}
                              </span>
                            )}
                          </span>
                          {cmd.badge && (
                            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                              {cmd.badge}
                            </span>
                          )}
                          {cmd.combo && (
                            <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
                              {cmd.combo}
                            </kbd>
                          )}
                          {activeRow && (
                            <kbd className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground">
                              ↵
                            </kbd>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>

          {/* Footer legend — reinforces the keyboard-first identity. The alt
              hint is per-row, so it only appears when there is one. */}
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
            {current?.alt && (
              <span className="flex items-center gap-1 text-brand">
                <kbd className="rounded border border-brand/40 bg-brand/10 px-1 font-mono leading-none">
                  alt+↵
                </kbd>
                {t(current.alt.hintKey)}
              </span>
            )}
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1 font-mono leading-none">
                tab
              </kbd>
              {t("commandPalette.hintMode")}
            </span>
            <span className="ml-auto flex items-center gap-1">
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

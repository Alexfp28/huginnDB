/**
 * Theme picker + per-colour editor — moved verbatim from the old
 * `SettingsDialog`. Built-in themes are read-only; editing one forks it
 * into a new custom theme.
 *
 * Below the theme editor sits the **data view** group: how a browsed table or
 * collection is laid out (the classic column grid, or the one-line-per-field
 * list view) plus the list view's own gutters. Those live here, rather than
 * under "Data grid", because they answer "what does this look like" — the same
 * question the theme editor answers — not "how does the grid behave". On disk
 * they are ordinary `gridPrefs` fields; only their home in the UI is here.
 *
 * Themes still live in localStorage (loaded synchronously before the React
 * tree mounts, which avoids a flash of the default theme). The on-disk
 * preferences blob does not own theme state.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Copy, Download, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useThemeStore, selectActiveTheme } from "@/stores/preferences/theme";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import {
  BUILT_IN_THEMES,
  COLOR_GROUPS,
  COLOR_KEYS,
  type ThemeColors,
} from "@/lib/themes";
import {
  parseThemeFile,
  serializeTheme,
  themeFileName,
  ThemeImportError,
} from "@/lib/themeTransfer";
import { api } from "@/lib/tauri";
import type { GridPrefs } from "@/types";
import { PrefRow } from "./PrefRow";

// Label lookup for COLOR_GROUPS' keys — COLOR_KEYS stays the single source
// of truth for labels, this just indexes it by key for the grouped editor.
const COLOR_LABELS = Object.fromEntries(
  COLOR_KEYS.map(({ key, label }) => [key, label]),
) as Record<keyof ThemeColors, string>;

export function AppearanceSection() {
  const customThemes = useThemeStore((s) => s.customThemes);
  const active = useThemeStore(selectActiveTheme);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const updateColor = useThemeStore((s) => s.updateActiveColor);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const duplicate = useThemeStore((s) => s.duplicateAsCustom);
  const deleteCustom = useThemeStore((s) => s.deleteCustom);
  const upsertCustom = useThemeStore((s) => s.upsertCustom);
  const [newName, setNewName] = useState("");
  const { t } = useTranslation();

  const themes = useMemo(
    () => [...BUILT_IN_THEMES, ...customThemes],
    [customThemes],
  );

  function handleDuplicate() {
    const name = newName.trim() || `${active.name} copy`;
    duplicate(active.id, name);
    setNewName("");
  }

  /** Export the active theme (built-in or custom) to a JSON file the user
   *  picks the destination for — a starting point to hand to someone else,
   *  or a backup of a custom theme before editing it further. */
  async function handleExportTheme() {
    try {
      const destPath = await saveFileDialog({
        defaultPath: themeFileName(active),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!destPath) return;
      await api.writeTextFile(destPath, serializeTheme(active));
      toast.success(t("settings.appearance.exportSuccess", { path: destPath }));
    } catch (e) {
      toast.error(String(e));
    }
  }

  /** Import a theme file as a new custom theme (always a fresh id — see
   *  `parseThemeFile`) and switch to it immediately, same as duplicating one. */
  async function handleImportTheme() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("settings.appearance.importTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const raw = await api.readTextFile(picked);
      const theme = parseThemeFile(raw);
      upsertCustom(theme);
      setThemeId(theme.id);
      toast.success(t("settings.appearance.importSuccess", { name: theme.name }));
    } catch (e) {
      if (e instanceof ThemeImportError) {
        toast.error(t(`settings.appearance.importError.${e.message}`));
      } else {
        toast.error(String(e));
      }
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr] gap-3">
        <aside className="overflow-y-auto rounded-md border border-border bg-card/40">
          <div className="sticky top-0 flex items-center justify-between gap-1 bg-card/60 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
            {t("settings.appearance.themes")}
            <button
              type="button"
              onClick={() => void handleImportTheme()}
              title={t("settings.appearance.importTitle")}
              className="rounded p-1 normal-case text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Upload className="h-3 w-3" />
            </button>
          </div>
          {themes.map((theme) => (
            <button
              key={theme.id}
              onClick={() => setThemeId(theme.id)}
              className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-sm ${
                theme.id === active.id
                  ? "border-primary bg-accent/40"
                  : "border-transparent hover:bg-accent/30"
              }`}
            >
              <ThemeSwatch colors={theme.colors} />
              <span className="flex-1 truncate">{theme.name}</span>
              <span className="text-[9px] uppercase text-muted-foreground">
                {theme.builtin
                  ? t("settings.appearance.builtin")
                  : t("settings.appearance.custom")}
              </span>
            </button>
          ))}
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-card/30 px-4 py-2">
            <div className="flex-1">
              <div className="text-sm font-medium">{active.name}</div>
              <div className="text-[11px] text-muted-foreground">
                {active.builtin
                  ? t("settings.appearance.builtinInfo")
                  : t("settings.appearance.customInfo")}
              </div>
            </div>
            <Select
              value={active.mode}
              onValueChange={(v) => setMode(v as "light" | "dark")}
            >
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">
                  {t("settings.appearance.modeDark")}
                </SelectItem>
                <SelectItem value="light">
                  {t("settings.appearance.modeLight")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleExportTheme()}
              title={t("settings.appearance.exportTooltip")}
            >
              <Download className="h-4 w-4" />
            </Button>
            {!active.builtin && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteCustom(active.id)}
                title={t("settings.appearance.deleteTooltip")}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="flex items-end gap-2 border-b border-border px-4 py-2">
            <div className="flex-1">
              <Label className="mb-1">
                {t("settings.appearance.duplicateLabel")}
              </Label>
              <Input
                placeholder={`${active.name} copy`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <Button size="sm" variant="outline" onClick={handleDuplicate}>
              <Copy className="mr-1 h-3 w-3" /> {t("common.duplicate")}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <ThemePreview colors={active.colors} />
            <div className="mt-5 flex flex-col gap-5">
              {COLOR_GROUPS.map((group) => (
                <section key={group.title}>
                  <div className="mb-2 border-b border-border/60 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {group.keys.map((key) => (
                      <ColorRow
                        key={key}
                        label={COLOR_LABELS[key]}
                        value={active.colors[key]}
                        onChange={(v) => updateColor(key, v)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </main>
      </div>

      <DataViewGroup />
    </div>
  );
}

/**
 * "Data view": the list view's own gutters (always global preferences, not
 * per-relation) plus `documentViewMode` — which, since #131, is only the
 * *default* row layout for a newly opened table/collection tab. Each tab
 * remembers its own choice afterwards (`TableDataTab`'s local
 * `documentViewMode` state, persisted per tab via `viewState`), independent of
 * this setting and of other tabs/windows — the toolbar toggle in the data tab
 * no longer writes here. The three list options are disabled while the table
 * layout is selected: they describe a surface that isn't on screen, and
 * greying them says so better than letting them look effective.
 */
function DataViewGroup() {
  const grid = usePreferences(selectGridPrefs);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const { t } = useTranslation();
  const listActive = grid.documentViewMode === "list";
  return (
    <section className="shrink-0 rounded-md border border-border px-4 pb-1">
      <div className="border-b border-border/60 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("settings.appearance.dataView.title")}
      </div>
      <PrefRow
        label={t("settings.appearance.dataView.mode.label")}
        prefId="grid.documentViewMode"
        description={t("settings.appearance.dataView.mode.desc")}
      >
        <Select
          value={grid.documentViewMode}
          onValueChange={(v) =>
            updateGrid({ documentViewMode: v as GridPrefs["documentViewMode"] })
          }
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="table" className="text-xs">
              {t("settings.appearance.dataView.mode.table")}
            </SelectItem>
            <SelectItem value="list" className="text-xs">
              {t("settings.appearance.dataView.mode.list")}
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow
        label={t("settings.appearance.dataView.expandNested.label")}
        prefId="grid.listExpandNested"
        description={t("settings.appearance.dataView.expandNested.desc")}
      >
        <Switch
          checked={grid.listExpandNested}
          disabled={!listActive}
          onCheckedChange={(v) => updateGrid({ listExpandNested: v })}
        />
      </PrefRow>
      <PrefRow
        label={t("settings.appearance.dataView.showTypes.label")}
        prefId="grid.listShowTypes"
        description={t("settings.appearance.dataView.showTypes.desc")}
      >
        <Switch
          checked={grid.listShowTypes}
          disabled={!listActive}
          onCheckedChange={(v) => updateGrid({ listShowTypes: v })}
        />
      </PrefRow>
      <PrefRow
        label={t("settings.appearance.dataView.lineNumbers.label")}
        prefId="grid.listLineNumbers"
        description={t("settings.appearance.dataView.lineNumbers.desc")}
      >
        <Switch
          checked={grid.listLineNumbers}
          disabled={!listActive}
          onCheckedChange={(v) => updateGrid({ listLineNumbers: v })}
        />
      </PrefRow>
    </section>
  );
}

/**
 * Small per-theme indicator in the theme list. Split in half by the theme's
 * own `background` (so a dark theme reads as a dark chip and a light theme
 * as a light one — the mode is visible at a glance) and `brand` (so themes
 * sharing a mode still stay distinguishable by their accent colour).
 *
 * Previously this rendered `colors.primary` alone, which is the *inverse*
 * grayscale tone in the two default themes (a near-white button colour for
 * the dark theme, a near-black one for the light theme) — so the dark theme
 * showed a white dot and the light theme a black one, backwards from what
 * the list item's own mode would suggest.
 */
function ThemeSwatch({ colors }: { colors: ThemeColors }) {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-full border border-border"
      style={{
        background: `conic-gradient(${colors.brand} 0deg 180deg, ${colors.background} 180deg 360deg)`,
      }}
    />
  );
}

/**
 * A small mock of the app chrome painted with the theme's own colours, so the
 * user can read a theme at a glance before committing to it. Colours are
 * arbitrary hex from the theme, so they're applied via inline `style` rather
 * than Tailwind tokens (which would only reflect the *active* theme's CSS
 * variables). Deliberately a static still-life — not a live editor.
 */
function ThemePreview({ colors }: { colors: ThemeColors }) {
  const { t } = useTranslation();
  const swatches: { key: keyof ThemeColors; label: string }[] = [
    { key: "background", label: "bg" },
    { key: "card", label: "card" },
    { key: "primary", label: "primary" },
    { key: "accent", label: "accent" },
    { key: "border", label: "border" },
    { key: "destructive", label: "error" },
  ];
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("settings.appearance.preview")}
      </div>
      <div
        className="overflow-hidden rounded-md border"
        style={{ background: colors.background, borderColor: colors.border }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 border-b px-3 py-1.5"
          style={{ background: colors.card, borderColor: colors.border }}
        >
          <span
            className="text-xs font-medium"
            style={{ color: colors.cardForeground }}
          >
            HuginnDB
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: colors.accent, color: colors.accentForeground }}
          >
            public
          </span>
          <button
            className="ml-auto rounded px-2 py-0.5 text-[10px] font-medium"
            style={{ background: colors.primary, color: colors.primaryForeground }}
          >
            Run
          </button>
        </div>
        {/* Body */}
        <div className="flex gap-3 px-3 py-2">
          <div className="flex-1">
            <div className="text-xs" style={{ color: colors.foreground }}>
              SELECT * FROM users;
            </div>
            <div
              className="mt-0.5 text-[11px]"
              style={{ color: colors.mutedForeground }}
            >
              42 rows · 8 ms
            </div>
          </div>
          <span
            className="self-start rounded px-1.5 py-0.5 text-[10px]"
            style={{
              background: colors.destructive,
              color: colors.destructiveForeground,
            }}
          >
            error
          </span>
        </div>
      </div>
      {/* Swatch strip */}
      <div className="mt-2 flex flex-wrap gap-2">
        {swatches.map((s) => (
          <div key={s.key} className="flex items-center gap-1">
            <span
              className="h-4 w-4 rounded border"
              style={{ background: colors[s.key], borderColor: colors.border }}
            />
            <span className="text-[10px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="flex-1 text-xs">{label}</Label>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-input bg-transparent"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-24 font-mono text-[11px]"
      />
    </div>
  );
}

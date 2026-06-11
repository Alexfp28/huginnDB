/**
 * Theme picker + per-colour editor — moved verbatim from the old
 * `SettingsDialog`. Built-in themes are read-only; editing one forks it
 * into a new custom theme.
 *
 * Themes still live in localStorage (loaded synchronously before the React
 * tree mounts, which avoids a flash of the default theme). The on-disk
 * preferences blob does not own theme state.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
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
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { BUILT_IN_THEMES, COLOR_KEYS, type ThemeColors } from "@/lib/themes";

export function AppearanceSection() {
  const customThemes = useThemeStore((s) => s.customThemes);
  const active = useThemeStore(selectActiveTheme);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const updateColor = useThemeStore((s) => s.updateActiveColor);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const duplicate = useThemeStore((s) => s.duplicateAsCustom);
  const deleteCustom = useThemeStore((s) => s.deleteCustom);
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

  return (
    <div className="grid h-full grid-cols-[180px_1fr] gap-3">
      <aside className="overflow-y-auto rounded-md border border-border bg-card/40">
        <div className="sticky top-0 bg-card/60 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
          {t("settings.appearance.themes")}
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
            <span
              className="h-3 w-3 rounded-full border border-border"
              style={{ background: theme.colors.primary }}
            />
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
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
            {COLOR_KEYS.map(({ key, label }) => (
              <ColorRow
                key={key}
                label={label}
                value={active.colors[key]}
                onChange={(v) => updateColor(key as keyof ThemeColors, v)}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
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

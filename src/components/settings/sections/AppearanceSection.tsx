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

        <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto p-4">
          {COLOR_KEYS.map(({ key, label }) => (
            <ColorRow
              key={key}
              label={label}
              value={active.colors[key]}
              onChange={(v) => updateColor(key as keyof ThemeColors, v)}
            />
          ))}
        </div>
      </main>
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

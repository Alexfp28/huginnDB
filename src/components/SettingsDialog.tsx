import { useMemo, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const customThemes = useThemeStore((s) => s.customThemes);
  const active = useThemeStore(selectActiveTheme);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const updateColor = useThemeStore((s) => s.updateActiveColor);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const duplicate = useThemeStore((s) => s.duplicateAsCustom);
  const deleteCustom = useThemeStore((s) => s.deleteCustom);
  const [newName, setNewName] = useState("");

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-3 overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Themes are stored locally in your browser storage. Built-in themes
            are read-only; edits auto-fork into a new custom theme.
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 grid-cols-[200px_1fr] overflow-hidden border-t border-border">
          <aside className="overflow-y-auto border-r border-border bg-card/40">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Themes
            </div>
            {themes.map((t) => (
              <button
                key={t.id}
                onClick={() => setThemeId(t.id)}
                className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-sm ${
                  t.id === active.id
                    ? "border-primary bg-accent/40"
                    : "border-transparent hover:bg-accent/30"
                }`}
              >
                <span
                  className="h-3 w-3 rounded-full border border-border"
                  style={{ background: t.colors.primary }}
                />
                <span className="flex-1 truncate">{t.name}</span>
                <span className="text-[9px] uppercase text-muted-foreground">
                  {t.builtin ? "built-in" : "custom"}
                </span>
              </button>
            ))}
          </aside>

          <main className="flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border bg-card/30 px-4 py-2">
              <div className="flex-1">
                <div className="text-sm font-medium">{active.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {active.builtin
                    ? "Built-in theme — edits will fork into a new custom theme."
                    : "Custom theme — changes apply live."}
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
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
              {!active.builtin && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteCustom(active.id)}
                  title="Delete custom theme"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>

            <div className="flex items-end gap-2 border-b border-border px-4 py-2">
              <div className="flex-1">
                <Label className="mb-1">Duplicate as custom</Label>
                <Input
                  placeholder={`${active.name} copy`}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <Button size="sm" variant="outline" onClick={handleDuplicate}>
                <Copy className="mr-1 h-3 w-3" /> Duplicate
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
      </DialogContent>
    </Dialog>
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

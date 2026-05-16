/**
 * Central preferences dialog.
 *
 * Two-pane layout: a left navigation rail with the section list and a
 * right pane that renders the active section. Open/close + active section
 * live in `useSettingsDialog` so any component can request the dialog
 * (FileMenu, ThemeMenu, ViewMenu, Ctrl/Cmd+, hotkey, the topbar button)
 * without prop-drilling through App.
 *
 * Controls inside each section read from / write to `usePreferences` (or
 * `useThemeStore` for Appearance) directly — there is no local form state
 * and no Save button. Changes apply live; the preferences store debounces
 * the disk write 400 ms downstream.
 *
 * The legacy single-prop signature `(open, onOpenChange)` is preserved for
 * App.tsx, which still owns its own local boolean while the rest of the
 * codebase migrates to `useSettingsDialog.openAt(...)`.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Cog,
  FileText,
  Keyboard,
  Palette,
  Sparkles,
  Table2,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/components/settings/useSettingsDialog";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { EditorSection } from "@/components/settings/sections/EditorSection";
import { GridSection } from "@/components/settings/sections/GridSection";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";
import { ShortcutsSection } from "@/components/settings/sections/ShortcutsSection";
import { AboutSection } from "@/components/settings/sections/AboutSection";

interface Props {
  /** Optional controlled-mode signature kept for backwards compatibility. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const SECTIONS: {
  id: SettingsSection;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "general", icon: Cog },
  { id: "editor", icon: FileText },
  { id: "grid", icon: Table2 },
  { id: "appearance", icon: Palette },
  { id: "shortcuts", icon: Keyboard },
  { id: "about", icon: Info },
];

export function SettingsDialog({ open, onOpenChange }: Props) {
  const storeOpen = useSettingsDialog((s) => s.open);
  const setStoreOpen = useSettingsDialog((s) => s.setOpen);
  const section = useSettingsDialog((s) => s.section);
  const setSection = useSettingsDialog((s) => s.setSection);
  const { t } = useTranslation();

  // Keep the controlled prop (from App.tsx's existing button) in sync with
  // the central store so either entry point opens / closes the same UI.
  useEffect(() => {
    if (open !== undefined && open !== storeOpen) setStoreOpen(open);
  }, [open, storeOpen, setStoreOpen]);

  const isOpen = open ?? storeOpen;

  const handleOpenChange = (next: boolean) => {
    setStoreOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[82vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {t("settings.description")}{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
              Ctrl/Cmd + ,
            </kbd>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 grid-cols-[200px_1fr] overflow-hidden">
          <aside className="overflow-y-auto border-r border-border bg-card/40 py-1">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = s.id === section;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={`flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left ${
                    active
                      ? "border-primary bg-accent/40"
                      : "border-transparent hover:bg-accent/30"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex flex-1 flex-col leading-tight">
                    <span className="text-sm">
                      {t(`settings.sections.${s.id}.label`)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {t(`settings.sections.${s.id}.desc`)}
                    </span>
                  </div>
                </button>
              );
            })}
          </aside>

          <main className="overflow-y-auto px-5 py-4">
            {section === "general" && <GeneralSection />}
            {section === "editor" && <EditorSection />}
            {section === "grid" && <GridSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "about" && <AboutSection />}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

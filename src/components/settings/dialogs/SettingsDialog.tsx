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
  Activity,
  Bell,
  Bot,
  Cable,
  Network,
  Cog,
  FolderSync,
  FileJson,
  FileText,
  Keyboard,
  Palette,
  ShieldCheck,
  Sparkles,
  Table2,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/components/settings/useSettingsDialog";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { EditorSection } from "@/components/settings/sections/EditorSection";
import { GridSection } from "@/components/settings/sections/GridSection";
import { NotificationsSection } from "@/components/settings/sections/NotificationsSection";
import { ConnectionsSection } from "@/components/settings/sections/ConnectionsSection";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";
import { ShortcutsSection } from "@/components/settings/sections/ShortcutsSection";
import { McpSection } from "@/components/settings/sections/McpSection";
import { PulseSection } from "@/components/settings/sections/PulseSection";
import { AiSection } from "@/components/settings/sections/AiSection";
import { PolicySection } from "@/components/settings/sections/PolicySection";
import { JsonSchemasSection } from "@/components/settings/sections/JsonSchemasSection";
import { OriginsSection } from "@/components/settings/sections/OriginsSection";
import { AboutSection } from "@/components/settings/sections/AboutSection";
import { Kbd } from "@/components/ui/kbd";
import { NavRailItem } from "@/components/ui/nav-rail";
import { useShortcutLabel } from "@/lib/keybindings";

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
  { id: "notifications", icon: Bell },
  { id: "connections", icon: Network },
  { id: "appearance", icon: Palette },
  { id: "shortcuts", icon: Keyboard },
  // Grouped with Origins rather than with Editor: both are user *content*
  // shared across machines, not knobs on how the app looks or behaves.
  { id: "jsonSchemas", icon: FileJson },
  { id: "origins", icon: FolderSync },
  { id: "mcp", icon: Cable },
  { id: "pulse", icon: Activity },
  // After Pulse and MCP rather than next to the editor knobs: all three are
  // about what HuginnDB is allowed to reach and what leaves the machine, which
  // is the question a user comes to this rail with.
  { id: "ai", icon: Bot },
  // Last of that group: it is not a knob but the answer to "who decided
  // what the AI may reach here?" when an organization manages the machine.
  { id: "policy", icon: ShieldCheck },
  { id: "about", icon: Info },
];

export function SettingsDialog({ open, onOpenChange }: Props) {
  const openSettingsShortcut = useShortcutLabel("openSettings");
  const storeOpen = useSettingsDialog((s) => s.open);
  const setStoreOpen = useSettingsDialog((s) => s.setOpen);
  const section = useSettingsDialog((s) => s.section);
  const setSection = useSettingsDialog((s) => s.setSection);
  const showUpdateDot = useUpdateStore(selectUpdateNotificationVisible);
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
      <DialogContent tier="workbench" className="flex h-[85vh] max-w-6xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="text-2xs">
            {t("settings.description")}{" "}
            {/* Read from the catalogue, not written out: this line used to say
                `Ctrl/Cmd + ,` regardless of what the user had rebound it to. */}
            <Kbd className="px-1 py-0.5 text-3xs">
              {openSettingsShortcut ?? t("settings.shortcuts.unassigned")}
            </Kbd>
            .
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid grid-cols-[200px_1fr]">
          <aside className="overflow-y-auto border-r border-border bg-card/40 py-1">
            {SECTIONS.map((s) => (
              <NavRailItem
                key={s.id}
                icon={s.icon}
                active={s.id === section}
                label={t(`settings.sections.${s.id}.label`)}
                description={t(`settings.sections.${s.id}.desc`)}
                badge={
                  s.id === "about" && showUpdateDot ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-background"
                    />
                  ) : undefined
                }
                onClick={() => setSection(s.id)}
              />
            ))}
          </aside>

          <main className="overflow-y-auto px-5 py-4">
            {section === "general" && <GeneralSection />}
            {section === "editor" && <EditorSection />}
            {section === "grid" && <GridSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "connections" && <ConnectionsSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "jsonSchemas" && <JsonSchemasSection />}
            {section === "origins" && <OriginsSection />}
            {section === "mcp" && <McpSection />}
            {section === "pulse" && <PulseSection />}
            {section === "ai" && <AiSection />}
            {section === "policy" && <PolicySection />}
            {section === "about" && <AboutSection />}
          </main>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

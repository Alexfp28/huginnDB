/**
 * Top-bar "View" dropdown — toggles UI display preferences (schema
 * metric) and exposes panel-level actions (show/hide Schema, Saved,
 * Console). Panel state lives in `panelLayout.ts`, a plain Zustand store
 * — no dockview API involved for these three since the outer shell
 * redesign (see that store's header comment).
 */

import { ChevronDown, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { usePreferences } from "@/stores/preferences/preferences";
import { ShortcutHint } from "@/components/menus/ShortcutHint";
import type { SchemaTableMetric } from "@/types";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";

const METRIC_OPTIONS: { value: SchemaTableMetric; i18nKey: string }[] = [
  { value: "none", i18nKey: "menu.view.metricHide" },
  { value: "row-count", i18nKey: "menu.view.metricRowCount" },
  { value: "size", i18nKey: "menu.view.metricSize" },
];

export function ViewMenu() {
  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);
  const updateUi = usePreferences((s) => s.updateUi);
  const setMetric = (m: SchemaTableMetric) =>
    updateUi({ schemaTableMetric: m });
  const openSettings = useSettingsDialog((s) => s.openAt);
  const { t } = useTranslation();

  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const rightPanel = useSessionPanelLayout((s) => s.rightPanel);
  const consoleOpen = useSessionPanelLayout((s) => s.consoleOpen);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const selectRightPanel = useSessionPanelLayout((s) => s.selectRightPanel);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
        >
          <Eye className="h-3.5 w-3.5" />
          {t("menu.view.label")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("menu.view.sectionPanels")}
        </div>
        <DropdownMenuCheckboxItem
          checked={schemaOpen}
          onSelect={(e) => {
            e.preventDefault();
            toggleSchema();
          }}
        >
          {t("panels.schema")}
          <ShortcutHint action="togglePanelSchema" />
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={rightPanel === "saved"}
          onSelect={(e) => {
            e.preventDefault();
            selectRightPanel("saved");
          }}
        >
          {t("panels.saved")}
          <ShortcutHint action="togglePanelSaved" />
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={consoleOpen}
          onSelect={(e) => {
            e.preventDefault();
            toggleConsole();
          }}
        >
          {t("panels.console")}
          <ShortcutHint action="togglePanelConsole" />
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("menu.view.sectionSchemaTree")}
        </div>
        {METRIC_OPTIONS.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={metric === opt.value}
            onSelect={(e) => {
              e.preventDefault();
              setMetric(opt.value);
            }}
          >
            {t(opt.i18nKey)}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            openSettings("grid");
          }}
        >
          {t("menu.view.preferences")}
          <ShortcutHint action="openSettings" />
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] leading-snug text-muted-foreground/70">
          {t("menu.view.help")}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

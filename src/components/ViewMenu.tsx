/**
 * Top-bar "View" dropdown — toggles UI display preferences (schema
 * metric) and exposes panel-level actions (show/hide each dockview
 * panel, float the active panel). New display preferences should land
 * here so persistence stays centralised in `useViewPrefs`; panel-level
 * actions stay derived from the dockview API.
 */

import { useEffect, useState } from "react";
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
import { usePreferences } from "@/stores/preferences";
import type { SchemaTableMetric } from "@/types";
import {
  PANELS,
  type PanelId,
  floatActivePanel,
  isPanelOpen,
  onDockviewApiReady,
  togglePanel,
} from "@/lib/dockview";
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
  const [, setTick] = useState(0);
  const { t } = useTranslation();

  // Bump local state on every dockview layout change so the panel
  // checkboxes reflect the current state even when the user closes a
  // panel via the tab's X button. `onDockviewApiReady` handles the
  // case where the menu mounts before App.tsx registers the API.
  useEffect(() => {
    let layoutSub: { dispose: () => void } | null = null;
    const unsubReady = onDockviewApiReady((api) => {
      layoutSub = api.onDidLayoutChange(() => setTick((n) => n + 1));
    });
    return () => {
      unsubReady();
      layoutSub?.dispose();
    };
  }, []);

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
        {PANELS.map((p) => (
          <DropdownMenuCheckboxItem
            key={p.id}
            checked={isPanelOpen(p.id as PanelId)}
            onSelect={(e) => {
              e.preventDefault();
              togglePanel(p.id as PanelId);
            }}
          >
            {t(p.i18nKey)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            floatActivePanel();
          }}
        >
          {t("menu.view.floatActivePanel")}
        </DropdownMenuItem>

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
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] leading-snug text-muted-foreground/70">
          {t("menu.view.help")}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

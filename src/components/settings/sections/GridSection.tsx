/**
 * Data-grid preferences — row height, page size, NULL rendering, plus the
 * schema-tree metric (previously surfaced only via the View menu).
 */

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  usePreferences,
  selectGridPrefs,
  selectUiPrefs,
} from "@/stores/preferences";
import type { SchemaTableMetric } from "@/types";
import { PrefRow } from "./PrefRow";

const METRIC_KEYS: Record<SchemaTableMetric, string> = {
  none: "menu.view.metricHide",
  "row-count": "menu.view.metricRowCount",
  size: "menu.view.metricSize",
};

export function GridSection() {
  const grid = usePreferences(selectGridPrefs);
  const ui = usePreferences(selectUiPrefs);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const updateUi = usePreferences((s) => s.updateUi);
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
      <PrefRow
        label={t("settings.grid.defaultPageSize")}
        htmlFor="prefs-grid-page-size"
      >
        <Input
          id="prefs-grid-page-size"
          type="number"
          min={10}
          max={5000}
          value={grid.defaultPageSize}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              updateGrid({ defaultPageSize: n });
            }
          }}
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.grid.rowHeight")}
        htmlFor="prefs-grid-row-height"
      >
        <Input
          id="prefs-grid-row-height"
          type="number"
          min={18}
          max={64}
          value={grid.rowHeight}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) updateGrid({ rowHeight: n });
          }}
          className="h-8 w-20 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.grid.nullDisplay.label")}
        description={t("settings.grid.nullDisplay.desc")}
        htmlFor="prefs-grid-null-display"
      >
        <Input
          id="prefs-grid-null-display"
          value={grid.nullDisplay}
          onChange={(e) => updateGrid({ nullDisplay: e.target.value })}
          className="h-8 w-32 font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.grid.zebraStripes.label")}
        description={t("settings.grid.zebraStripes.desc")}
      >
        <Switch
          checked={grid.zebraStripes}
          onCheckedChange={(v) => updateGrid({ zebraStripes: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.grid.stickyHeader.label")}
        description={t("settings.grid.stickyHeader.desc")}
      >
        <Switch
          checked={grid.stickyHeader}
          onCheckedChange={(v) => updateGrid({ stickyHeader: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.grid.schemaMetric.label")}
        description={t("settings.grid.schemaMetric.desc")}
      >
        <Select
          value={ui.schemaTableMetric}
          onValueChange={(v) =>
            updateUi({ schemaTableMetric: v as SchemaTableMetric })
          }
        >
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(METRIC_KEYS) as SchemaTableMetric[]).map((k) => (
              <SelectItem key={k} value={k} className="text-xs">
                {t(METRIC_KEYS[k])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PrefRow>
    </div>
  );
}

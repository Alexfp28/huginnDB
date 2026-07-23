/**
 * General preferences — global UI behaviour that doesn't fit under Editor
 * or Grid. Reads/writes live against `usePreferences`; no local form state.
 *
 * Also hosts the language selector. Changing the language updates
 * `prefs.ui.language` which `App.tsx` forwards to i18next via the
 * `setLanguage` bridge.
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
import { usePreferences, selectUiPrefs } from "@/stores/preferences";
import type {
  AppLanguage,
  CellEditorMode,
  ConnectionGroupExpandMode,
  Driver,
} from "@/types";
import { PrefRow } from "./PrefRow";

/** Sentinel for the "not configured / ask each time" default-driver option,
 *  since a Radix Select item can't carry a `null` value. */
const DRIVER_ASK = "ask";

export function GeneralSection() {
  const ui = usePreferences(selectUiPrefs);
  const updateUi = usePreferences((s) => s.updateUi);
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
      <PrefRow
        label={t("common.language")}
        description={t("common.languageDescription")}
      >
        <Select
          value={ui.language}
          onValueChange={(v) => updateUi({ language: v as AppLanguage })}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en" className="text-xs">
              {t("common.languageEnglish")}
            </SelectItem>
            <SelectItem value="es" className="text-xs">
              {t("common.languageSpanish")}
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.general.defaultDriver.label")}
        description={t("settings.general.defaultDriver.desc")}
      >
        <Select
          value={ui.defaultDriver ?? DRIVER_ASK}
          onValueChange={(v) =>
            updateUi({
              defaultDriver: v === DRIVER_ASK ? null : (v as Driver),
            })
          }
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DRIVER_ASK} className="text-xs">
              {t("settings.general.defaultDriver.ask")}
            </SelectItem>
            <SelectItem value="postgres" className="text-xs">
              PostgreSQL
            </SelectItem>
            <SelectItem value="mysql" className="text-xs">
              MySQL
            </SelectItem>
            <SelectItem value="sqlite" className="text-xs">
              SQLite
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.general.confirmDestructive.label")}
        description={t("settings.general.confirmDestructive.desc")}
      >
        <Switch
          checked={ui.confirmDestructive}
          onCheckedChange={(v) => updateUi({ confirmDestructive: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.general.restoreTabs.label")}
        description={t("settings.general.restoreTabs.desc")}
      >
        <Switch
          checked={ui.restoreTabsOnOpen}
          onCheckedChange={(v) => updateUi({ restoreTabsOnOpen: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.general.reconnectOnLaunch.label")}
        description={t("settings.general.reconnectOnLaunch.desc")}
      >
        <Switch
          checked={ui.reconnectOnLaunch}
          onCheckedChange={(v) => updateUi({ reconnectOnLaunch: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.general.cellEditorMode.label")}
        description={t("settings.general.cellEditorMode.desc")}
      >
        <Select
          value={ui.cellEditorMode}
          onValueChange={(v) => updateUi({ cellEditorMode: v as CellEditorMode })}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="modal" className="text-xs">
              {t("settings.general.cellEditorMode.modal")}
            </SelectItem>
            <SelectItem value="side" className="text-xs">
              {t("settings.general.cellEditorMode.side")}
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.general.connectionGroupExpandMode.label")}
        description={t("settings.general.connectionGroupExpandMode.desc")}
      >
        <Select
          value={ui.connectionGroupExpandMode}
          onValueChange={(v) =>
            updateUi({
              connectionGroupExpandMode: v as ConnectionGroupExpandMode,
            })
          }
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="expanded" className="text-xs">
              {t("settings.general.connectionGroupExpandMode.expanded")}
            </SelectItem>
            <SelectItem value="collapsed" className="text-xs">
              {t("settings.general.connectionGroupExpandMode.collapsed")}
            </SelectItem>
            <SelectItem value="remember" className="text-xs">
              {t("settings.general.connectionGroupExpandMode.remember")}
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.general.queryHistoryLimit.label")}
        description={t("settings.general.queryHistoryLimit.desc")}
        htmlFor="prefs-history-limit"
      >
        <Input
          id="prefs-history-limit"
          type="number"
          min={10}
          max={1000}
          value={ui.queryHistoryLimit}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              updateUi({ queryHistoryLimit: n });
            }
          }}
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>
    </div>
  );
}

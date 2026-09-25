/**
 * What the Preferences rail's search box shows in place of the active section:
 * every setting (and section) matching the query, grouped by section, each one
 * a button that jumps to the real row.
 *
 * It lists and navigates; it never renders the controls themselves. A second,
 * search-only copy of each control is exactly the kind of duplicate that drifts
 * — the row the user lands on is the one place a setting is edited, and the
 * jump reuses the command palette's `openAtPref` path so it scrolls and flashes
 * the same way.
 */

import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CONTROL_FOCUS_TIGHT, MICRO_HEADING } from "@/components/ui/styles";
import { TreeRow } from "@/components/ui/tree-row";
import type { SettingsSection } from "@/components/settings/useSettingsDialog";
import type { SettingEntry } from "@/lib/commandPalette/settingsRegistry";
import { usePreferences } from "@/stores/preferences/preferences";
import { cn } from "@/lib/utils";

export interface SectionHit {
  id: SettingsSection;
  icon: React.ComponentType<{ className?: string }>;
}

interface Props {
  sections: SectionHit[];
  settings: SettingEntry[];
  /** Section order to group `settings` in — the rail's own order. */
  order: SettingsSection[];
  onPickSection: (section: SettingsSection) => void;
  onPickSetting: (entry: SettingEntry) => void;
}

/** `TreeRow` supplies the full-width, hover-tinted row; this lays it out as a
 *  result (label block left, value right) and gives it a focus ring. */
const RESULT_ROW = cn(
  "items-start justify-between gap-4 border-b border-border/60 px-4 py-2.5 text-left transition-colors last:border-b-0",
  CONTROL_FOCUS_TIGHT,
  "focus-visible:ring-inset",
);

export function SettingsSearchResults({
  sections,
  settings,
  order,
  onPickSection,
  onPickSetting,
}: Props) {
  const { t } = useTranslation();
  const prefs = usePreferences((s) => s.prefs);

  if (sections.length === 0 && settings.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        {t("settings.search.empty")}
      </p>
    );
  }

  const bySection = order
    .map((id) => [id, settings.filter((e) => e.section === id)] as const)
    .filter(([, entries]) => entries.length > 0);

  return (
    <div className="space-y-5">
      {sections.length > 0 && (
        <section className="space-y-2">
          <h3 className={cn(MICRO_HEADING, "px-0.5")}>{t("settings.search.sections")}</h3>
          <div className="overflow-hidden rounded-lg border border-border bg-card/40">
            {sections.map(({ id, icon: Icon }) => (
              <TreeRow
                key={id}
                className={cn(RESULT_ROW, "items-center")}
                onClick={() => onPickSection(id)}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {t(`settings.sections.${id}.label`)}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {t(`settings.sections.${id}.desc`)}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </TreeRow>
            ))}
          </div>
        </section>
      )}

      {bySection.map(([section, entries]) => (
        <section key={section} className="space-y-2">
          <h3 className={cn(MICRO_HEADING, "px-0.5")}>
            {t(`settings.sections.${section}.label`)}
          </h3>
          <div className="overflow-hidden rounded-lg border border-border bg-card/40">
            {entries.map((entry) => {
              const value = entry.value?.(prefs);
              const badge = value?.raw ?? (value?.i18nKey ? t(value.i18nKey) : undefined);
              return (
                <TreeRow
                  key={entry.prefId}
                  className={RESULT_ROW}
                  onClick={() => onPickSetting(entry)}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(entry.labelKey)}</span>
                    {entry.descKey && (
                      <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">
                        {t(entry.descKey)}
                      </span>
                    )}
                  </span>
                  {badge && (
                    <Badge mono className="mt-0.5 max-w-48 truncate">
                      {badge}
                    </Badge>
                  )}
                </TreeRow>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

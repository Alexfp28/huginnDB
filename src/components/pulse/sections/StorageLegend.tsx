/**
 * What the three colours in a storage bar mean. Shared by both densities, so
 * the dock and the window can never label the same bar differently.
 */

import { useTranslation } from "react-i18next";

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}

export function StorageLegend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-3xs text-muted-foreground">
      <Swatch color="var(--brand)" label={t("pulse.storage.data")} />
      <Swatch color="var(--fk)" label={t("pulse.storage.indexes")} />
      <Swatch color="var(--warning)" label={t("pulse.storage.free")} />
    </div>
  );
}

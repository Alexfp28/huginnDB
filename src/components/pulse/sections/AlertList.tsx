/**
 * The derived alerts, shared by both Pulse densities.
 *
 * Severity is carried in the stripe rather than in the wording, so the list
 * can be scanned without reading it — the one thing a panel glanced at from
 * across a desk has to get right.
 */

import { useTranslation } from "react-i18next";
import type { PulseAlert } from "@/lib/pulse/alerts";
import { cn } from "@/lib/utils";

export function AlertList({ alerts }: { alerts: readonly PulseAlert[] }) {
  const { t } = useTranslation();

  if (alerts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("pulse.noAlerts")}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {alerts.map((alert) => (
        <div key={alert.code} className="flex items-start gap-2">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 w-[3px] shrink-0 self-stretch rounded-full",
              alert.level === "critical" ? "bg-destructive" : "bg-warning",
            )}
          />
          <span className="text-xs leading-snug text-foreground">
            {t(`pulse.alert.${alert.code}`, alert.params)}
          </span>
        </div>
      ))}
    </div>
  );
}

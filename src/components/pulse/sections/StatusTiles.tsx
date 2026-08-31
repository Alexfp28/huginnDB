/**
 * The four vital signs, shared by both Pulse densities.
 *
 * `columns` is the only difference between the dock's two-up grid and the
 * window's four-across row — the figures, the units and the "no reading"
 * dashes have to be identical, and duplicating them was how the two surfaces
 * would eventually disagree about what a tile means.
 */

import { useTranslation } from "react-i18next";
import { Sparkline } from "@/components/pulse/charts/Sparkline";
import type { PulseView } from "@/lib/pulse/usePulseView";
import { cn, formatCount } from "@/lib/utils";

function Tile({
  label,
  value,
  suffix,
  series,
  color,
  large,
}: {
  label: string;
  value: string;
  suffix?: string;
  series: readonly (number | null)[];
  color: string;
  large: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card px-2 pb-1 pt-1.5">
      <div className="truncate text-3xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "font-mono font-semibold tabular-nums leading-tight",
          large ? "text-2xl" : "text-base",
        )}
      >
        {value}
        {suffix && (
          <span className="ml-0.5 text-2xs font-medium text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      <Sparkline
        values={series}
        color={color}
        className={cn("mt-0.5 w-full", large ? "h-8" : "h-4")}
      />
    </div>
  );
}

export function StatusTiles({
  view,
  columns,
}: {
  view: PulseView;
  columns: 2 | 4;
}) {
  const { t } = useTranslation();
  const large = columns === 4;

  return (
    <div
      className={cn("grid gap-1.5", columns === 2 ? "grid-cols-2" : "grid-cols-4")}
    >
      <Tile
        label={t("pulse.metric.queriesPerSecond")}
        value={
          view.queriesPerSecond === null
            ? "—"
            : formatCount(Math.round(view.queriesPerSecond))
        }
        series={view.queriesSeries}
        color="var(--brand)"
        large={large}
      />
      <Tile
        label={t("pulse.metric.connections")}
        value={view.connections === null ? "—" : formatCount(view.connections)}
        suffix={
          view.connectionsMax ? `/ ${formatCount(view.connectionsMax)}` : undefined
        }
        series={view.connectionsSeries}
        color="var(--fk)"
        large={large}
      />
      <Tile
        label={t("pulse.metric.running")}
        value={view.running === null ? "—" : formatCount(view.running)}
        series={view.runningSeries}
        color="var(--warning)"
        large={large}
      />
      <Tile
        label={t("pulse.metric.cacheHit")}
        // An idle interval has no hit ratio; "—" is the honest reading, where
        // 0 % would look like a server in trouble.
        value={view.cacheHit === null ? "—" : (view.cacheHit * 100).toFixed(1)}
        suffix={view.cacheHit === null ? undefined : "%"}
        series={[]}
        color="var(--success)"
        large={large}
      />
    </div>
  );
}

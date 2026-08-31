/**
 * Pulse in the right dock — the compact density.
 *
 * What fits in ~320px is the answer to "is this server all right?": four
 * tiles, the alerts, and nothing else. Everything that needs a table (the top
 * queries and their plans, the session list, index usage) belongs to the
 * expanded window and is reached from here, never crammed in — three rows of a
 * lock chain is a misleading answer, not a small one.
 *
 * The panel does not own its clock. `usePulseLive` runs one interval per
 * connection in a store, so having this open next to the expanded window costs
 * one probe, not two.
 */

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Lock, LockOpen, ServerCog } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Sparkline } from "@/components/pulse/charts/Sparkline";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { deriveAlerts, type PulseAlert } from "@/lib/pulse/alerts";
import { cacheHitRatio, latestOf, seriesFor, valueIn } from "@/lib/pulse/rates";
import { usePulseLive } from "@/lib/pulse/usePulseLive";
import { parentConnectionId } from "@/lib/connectionLabel";
import { cn, formatCount } from "@/lib/utils";
import { NO_SAMPLES, usePulse } from "@/stores/session/pulse";
import { useUi } from "@/stores/session/ui";

/** A driver Pulse cannot read yet answers with this, and the panel says so
 *  rather than showing a column of zeroes. Matched on the error the backend's
 *  `AppError::UnsupportedDriver` serialises to. */
function isUnsupported(error: string | undefined): boolean {
  return !!error && /unsupported driver/i.test(error);
}

interface TileProps {
  label: string;
  value: string;
  suffix?: string;
  series: readonly (number | null)[];
  color: string;
}

function Tile({ label, value, suffix, series, color }: TileProps) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card px-2 pb-1 pt-1.5">
      <div className="truncate text-3xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-base font-semibold tabular-nums leading-tight">
        {value}
        {suffix && (
          <span className="ml-0.5 text-2xs font-medium text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      <Sparkline values={series} color={color} className="mt-0.5 h-4 w-full" />
    </div>
  );
}

function AlertRow({ alert }: { alert: PulseAlert }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
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
  );
}

export function PulsePanel({ active }: { active: boolean }) {
  const { t } = useTranslation();

  const selected = useUi((s) => s.selectedConnectionId);
  const pinned = usePulse((s) => s.pinnedConnectionId);
  const setPinned = usePulse((s) => s.setPinned);

  // `selectedConnectionId` is always a profile id, but a pin could have been
  // set from anywhere; fold both through `parentConnectionId` so a synthetic
  // `<parent>::db::<name>` view can never become the thing being measured —
  // server health is a property of the server, not of one database on it.
  const raw = pinned ?? selected;
  const connectionId = raw ? parentConnectionId(raw) : null;

  usePulseLive(connectionId, active);

  const samples = usePulse((s) =>
    connectionId ? (s.samples[connectionId] ?? NO_SAMPLES) : NO_SAMPLES,
  );
  const error = usePulse((s) => (connectionId ? s.errors[connectionId] : undefined));

  // Derived arrays must be memoized, never returned from a selector (gotcha #1).
  const view = useMemo(() => {
    const latest = samples[samples.length - 1];
    return {
      latest,
      alerts: deriveAlerts(samples),
      queries: seriesFor(samples, "queries"),
      connections: seriesFor(samples, "connections_active"),
      running: seriesFor(samples, "connections_running"),
      hit: cacheHitRatio(samples),
      max: latest ? valueIn(latest, "connections_max") : undefined,
    };
  }, [samples]);

  if (!connectionId) {
    return (
      <PanelFrame pinned={false} onTogglePin={() => {}} subtitle="">
        <EmptyState icon={Activity} title={t("pulse.noConnection")} />
      </PanelFrame>
    );
  }

  const togglePin = () => setPinned(pinned ? null : connectionId);
  const { latest } = view;
  const subtitle = latest
    ? `${latest.driver} ${latest.serverVersion}`.trim()
    : t("pulse.following");

  if (isUnsupported(error) && !latest) {
    return (
      <PanelFrame pinned={!!pinned} onTogglePin={togglePin} subtitle="">
        <EmptyState
          icon={ServerCog}
          title={t("pulse.unsupported.title")}
          hint={t("pulse.unsupported.hint")}
        />
      </PanelFrame>
    );
  }

  if (!latest) {
    return (
      <PanelFrame pinned={!!pinned} onTogglePin={togglePin} subtitle={subtitle}>
        <EmptyState
          icon={Activity}
          title={error ? t("pulse.failed") : t("pulse.collecting")}
          hint={error}
        />
      </PanelFrame>
    );
  }

  const qps = latestOf(view.queries);
  const conns = latestOf(view.connections);
  const running = latestOf(view.running);

  return (
    <PanelFrame pinned={!!pinned} onTogglePin={togglePin} subtitle={subtitle}>
      <div className="flex flex-col gap-3 overflow-y-auto p-2">
        <section className="grid grid-cols-2 gap-1.5">
          <Tile
            label={t("pulse.metric.queriesPerSecond")}
            value={qps === null ? "—" : formatCount(Math.round(qps))}
            series={view.queries}
            color="var(--brand)"
          />
          <Tile
            label={t("pulse.metric.connections")}
            value={conns === null ? "—" : formatCount(conns)}
            suffix={view.max ? `/ ${formatCount(view.max)}` : undefined}
            series={view.connections}
            color="var(--fk)"
          />
          <Tile
            label={t("pulse.metric.running")}
            value={running === null ? "—" : formatCount(running)}
            series={view.running}
            color="var(--warning)"
          />
          <Tile
            label={t("pulse.metric.cacheHit")}
            // An idle interval has no hit ratio; "—" is the honest reading,
            // where 0 % would look like a server in trouble.
            value={view.hit === null ? "—" : (view.hit * 100).toFixed(1)}
            suffix={view.hit === null ? undefined : "%"}
            series={[]}
            color="var(--success)"
          />
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 text-3xs uppercase tracking-wider text-muted-foreground">
            {t("pulse.section.alerts")}
            {view.alerts.length > 0 && (
              <span className="rounded-full bg-warning/20 px-1.5 font-mono text-3xs text-warning">
                {view.alerts.length}
              </span>
            )}
          </h3>
          {view.alerts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pulse.noAlerts")}</p>
          ) : (
            view.alerts.map((a) => <AlertRow key={a.code} alert={a} />)
          )}
        </section>
      </div>
    </PanelFrame>
  );
}

/** Header + body chrome, shared by every state so the pin control stays put
 *  while the body swaps between "collecting", "not supported" and the tiles. */
function PanelFrame({
  pinned,
  onTogglePin,
  subtitle,
  children,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  subtitle: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const PinIcon = pinned ? Lock : LockOpen;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Activity className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span className="truncate text-xs font-semibold">{t("pulse.title")}</span>
        {subtitle && (
          <span className="truncate font-mono text-3xs text-muted-foreground">
            {subtitle}
          </span>
        )}
        <SimpleTooltip
          side="left"
          label={pinned ? t("pulse.unpin") : t("pulse.pin")}
        >
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            className={cn(
              "ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              "transition-colors hover:bg-accent/60 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              pinned && "bg-accent/70 text-brand",
            )}
          >
            <PinIcon className="h-3.5 w-3.5" />
          </button>
        </SimpleTooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

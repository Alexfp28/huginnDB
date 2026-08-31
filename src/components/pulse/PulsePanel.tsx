/**
 * Pulse in the right dock — the compact density.
 *
 * Four sections stacked down the panel's full height: the live tiles, the
 * alerts derived from them, the statements the server has spent its time on,
 * and where the disk went. Each one shows the top few and stops there; the
 * expanded window is where the full tables live, because three rows of a lock
 * chain or an index list is a misleading answer rather than a small one.
 *
 * The panel owns neither of its clocks. `usePulseLive` runs one five-second
 * interval per connection in a store and `usePulseDetail` one fifteen-minute
 * one, so having this open next to the expanded window costs one probe, not
 * two.
 */

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Lock, LockOpen, RefreshCw, ServerCog } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Sparkline } from "@/components/pulse/charts/Sparkline";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { deriveAlerts, type PulseAlert } from "@/lib/pulse/alerts";
import { cacheHitRatio, latestOf, seriesFor, valueIn } from "@/lib/pulse/rates";
import { usePulseLive } from "@/lib/pulse/usePulseLive";
import { usePulseDetail } from "@/lib/pulse/usePulseDetail";
import { parentConnectionId } from "@/lib/connectionLabel";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { NO_SAMPLES, usePulse } from "@/stores/session/pulse";
import { useUi } from "@/stores/session/ui";
import type { PulseStorageItem, PulseTopQuery } from "@/types";

/** How many rows of each on-demand read fit here. The backend returns twenty;
 *  the rest are the expanded window's to show. */
const COMPACT_ROWS = 3;

/** A driver Pulse cannot read yet answers with this, and the panel says so
 *  rather than showing a column of zeroes. Matched on the error the backend's
 *  `AppError::UnsupportedDriver` serialises to. */
function isUnsupported(error: string | undefined): boolean {
  return !!error && /unsupported driver/i.test(error);
}

function Section({
  title,
  badge,
  badgeTone,
  children,
}: {
  title: string;
  badge?: string;
  badgeTone?: "warn";
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0">
      <h3 className="flex items-center gap-2 text-3xs uppercase tracking-wider text-muted-foreground">
        {title}
        {badge && (
          <span
            className={cn(
              "ml-auto rounded-full px-1.5 font-mono text-3xs normal-case tracking-normal",
              badgeTone === "warn"
                ? "bg-warning/20 text-warning"
                : "bg-accent text-foreground",
            )}
          >
            {badge}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  suffix,
  series,
  color,
}: {
  label: string;
  value: string;
  suffix?: string;
  series: readonly (number | null)[];
  color: string;
}) {
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

function QueryRow({ query }: { query: PulseTopQuery }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground"
          title={query.digest}
        >
          {query.digest}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-2xs tabular-nums",
            // A full scan is the reason a statement is worth looking at even
            // when its average looks harmless, so it is what colours the row.
            query.fullScans > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {query.avgMs < 1 ? "<1" : Math.round(query.avgMs)} ms
        </span>
      </div>
      <div className="truncate text-3xs text-muted-foreground">
        {t("pulse.slowest.meta", {
          count: formatCount(query.count),
          examined: formatCount(query.rowsExamined),
        })}
        {query.fullScans > 0 && ` · ${t("pulse.slowest.noIndex")}`}
      </div>
    </div>
  );
}

function StorageRow({ item, max }: { item: PulseStorageItem; max: number }) {
  const total = item.dataBytes + item.indexBytes + item.freeBytes;
  const share = max > 0 ? total / max : 0;
  const pct = (n: number) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%");

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs" title={item.name}>
          {item.name}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {formatBytes(total)}
        </span>
      </div>
      {/* Scaled against the largest relation, so the bars read as a ranking
          rather than each one filling its own row. */}
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-accent">
        <div className="flex h-full" style={{ width: `${(share * 100).toFixed(1)}%` }}>
          <span style={{ width: pct(item.dataBytes), background: "var(--brand)" }} />
          <span style={{ width: pct(item.indexBytes), background: "var(--fk)" }} />
          <span style={{ width: pct(item.freeBytes), background: "var(--warning)" }} />
        </div>
      </div>
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
  const { refresh } = usePulseDetail(connectionId, active);

  const samples = usePulse((s) =>
    connectionId ? (s.samples[connectionId] ?? NO_SAMPLES) : NO_SAMPLES,
  );
  const error = usePulse((s) => (connectionId ? s.errors[connectionId] : undefined));
  const queries = usePulse((s) => (connectionId ? s.topQueries[connectionId] : undefined));
  const storage = usePulse((s) => (connectionId ? s.storage[connectionId] : undefined));

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

  const storageTotal = useMemo(
    () =>
      (storage?.items ?? []).reduce(
        (sum, i) => sum + i.dataBytes + i.indexBytes + i.freeBytes,
        0,
      ),
    [storage],
  );

  if (!connectionId) {
    return (
      <PanelFrame pinned={false} onTogglePin={() => {}} onRefresh={null} subtitle="">
        <EmptyState icon={Activity} title={t("pulse.noConnection")} />
      </PanelFrame>
    );
  }

  const togglePin = () => setPinned(pinned ? null : connectionId);
  const { latest } = view;

  if (isUnsupported(error) && !latest) {
    return (
      <PanelFrame
        pinned={!!pinned}
        onTogglePin={togglePin}
        onRefresh={null}
        subtitle=""
      >
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
      <PanelFrame
        pinned={!!pinned}
        onTogglePin={togglePin}
        onRefresh={null}
        subtitle={t("pulse.following")}
      >
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
  const topQueries = (queries?.items ?? []).slice(0, COMPACT_ROWS);
  const topStorage = (storage?.items ?? []).slice(0, COMPACT_ROWS);
  const storageMax = topStorage.length
    ? Math.max(
        ...topStorage.map((i) => i.dataBytes + i.indexBytes + i.freeBytes),
      )
    : 0;

  return (
    <PanelFrame
      pinned={!!pinned}
      onTogglePin={togglePin}
      onRefresh={refresh}
      subtitle={`${latest.driver} ${latest.serverVersion}`.trim()}
    >
      <div className="flex h-full flex-col overflow-y-auto">
        <Section title={t("pulse.section.status")}>
          <div className="grid grid-cols-2 gap-1.5">
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
          </div>
        </Section>

        <Section
          title={t("pulse.section.alerts")}
          badge={view.alerts.length ? String(view.alerts.length) : undefined}
          badgeTone="warn"
        >
          {view.alerts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pulse.noAlerts")}</p>
          ) : (
            view.alerts.map((a) => <AlertRow key={a.code} alert={a} />)
          )}
        </Section>

        <Section
          title={t("pulse.section.slowest")}
          badge={
            queries?.items.length
              ? t("pulse.showingOf", {
                  shown: topQueries.length,
                  total: queries.items.length,
                })
              : undefined
          }
        >
          {topQueries.length > 0 ? (
            topQueries.map((q) => <QueryRow key={q.digest} query={q} />)
          ) : (
            <p className="text-xs text-muted-foreground">
              {queries?.error
                ? t("pulse.slowest.unavailable")
                : queries
                  ? t("pulse.slowest.empty")
                  : t("pulse.loading")}
            </p>
          )}
        </Section>

        <Section
          title={t("pulse.section.storage")}
          badge={storageTotal > 0 ? formatBytes(storageTotal) : undefined}
        >
          {topStorage.length > 0 ? (
            <>
              {topStorage.map((i) => (
                <StorageRow key={`${i.schema}.${i.name}`} item={i} max={storageMax} />
              ))}
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-3xs text-muted-foreground">
                <Legend color="var(--brand)" label={t("pulse.storage.data")} />
                <Legend color="var(--fk)" label={t("pulse.storage.indexes")} />
                <Legend color="var(--warning)" label={t("pulse.storage.free")} />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {storage?.error
                ? t("pulse.storage.unavailable")
                : storage
                  ? t("pulse.storage.empty")
                  : t("pulse.loading")}
            </p>
          )}
        </Section>
      </div>
    </PanelFrame>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className="h-2 w-2 rounded-[2px]"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/** Header + body chrome, shared by every state so the pin control stays put
 *  while the body swaps between "collecting", "not supported" and the sections. */
function PanelFrame({
  pinned,
  onTogglePin,
  onRefresh,
  subtitle,
  children,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  /** `null` while there is nothing to refresh, so the button is absent rather
   *  than present and inert. */
  onRefresh: (() => void) | null;
  subtitle: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const PinIcon = pinned ? Lock : LockOpen;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Activity className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-xs font-semibold">{t("pulse.title")}</span>
        {subtitle && (
          <span className="truncate font-mono text-3xs text-muted-foreground">
            {subtitle}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {onRefresh && (
            <SimpleTooltip side="left" label={t("pulse.refresh")}>
              <button
                type="button"
                onClick={onRefresh}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </SimpleTooltip>
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
                "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
                "transition-colors hover:bg-accent/60 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                pinned && "bg-accent/70 text-brand",
              )}
            >
              <PinIcon className="h-3.5 w-3.5" />
            </button>
          </SimpleTooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

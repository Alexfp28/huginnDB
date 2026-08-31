/**
 * Pulse in the right dock — the compact density.
 *
 * Four sections down the panel's full height: the live tiles, the alerts
 * derived from them, the statements the server has spent its time on, and
 * where the disk went. Each shows the top few and stops; the expanded window
 * (the ⤢ button) is where the full tables live, because three rows of a lock
 * chain or an index list is a misleading answer rather than a small one.
 *
 * The panel owns neither of its clocks. `usePulseLive` runs one five-second
 * interval per connection in a store and `usePulseDetail` one fifteen-minute
 * one, so having this open next to the expanded window costs one probe, not
 * two.
 */

import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Lock,
  LockOpen,
  Maximize2,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { AlertList } from "@/components/pulse/sections/AlertList";
import { StatusTiles } from "@/components/pulse/sections/StatusTiles";
import { StorageLegend } from "@/components/pulse/sections/StorageLegend";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePulseLive } from "@/lib/pulse/usePulseLive";
import { usePulseDetail } from "@/lib/pulse/usePulseDetail";
import { isUnsupported, usePulseView } from "@/lib/pulse/usePulseView";
import { parentConnectionId, resolveConnectionLabel } from "@/lib/connectionLabel";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { usePulse } from "@/stores/session/pulse";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";
import type { PulseStorageItem, PulseTopQuery } from "@/types";

/**
 * Why this engine has no statement statistics. Each answer names something the
 * user can act on, which is the whole reason the neutral "not available" line
 * is not the end of the message.
 */
export function slowestHint(driver: string, t: (k: string) => string): string {
  if (driver === "mongodb") return t("pulse.slowest.hintMongo");
  if (driver === "mysql") return t("pulse.slowest.hintMysql");
  return "";
}

/** How many rows of each on-demand read fit here. The backend returns twenty;
 *  the rest are the expanded window's to show. */
const COMPACT_ROWS = 3;

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
  const profiles = useConnections((s) => s.profiles);

  // `selectedConnectionId` is always a profile id, but a pin could have been
  // set from anywhere; fold both through `parentConnectionId` so a synthetic
  // `<parent>::db::<name>` view can never become the thing being measured —
  // server health is a property of the server, not of one database on it.
  const raw = pinned ?? selected;
  const connectionId = raw ? parentConnectionId(raw) : null;

  usePulseLive(connectionId, active);
  const { refresh } = usePulseDetail(connectionId, active);
  const view = usePulseView(connectionId);

  function expand() {
    if (!connectionId) return;
    const label = resolveConnectionLabel(profiles, connectionId);
    void api
      .openPulseWindow(connectionId, `${t("pulse.title")} · ${label}`)
      .catch((e) => notify.error(String(e)));
  }

  if (!connectionId) {
    return (
      <PanelFrame
        pinned={false}
        onTogglePin={() => {}}
        onRefresh={null}
        onExpand={null}
        subtitle=""
      >
        <EmptyState icon={Activity} title={t("pulse.noConnection")} />
      </PanelFrame>
    );
  }

  const togglePin = () => setPinned(pinned ? null : connectionId);
  const { latest } = view;

  if (isUnsupported(view.error) && !latest) {
    return (
      <PanelFrame
        pinned={!!pinned}
        onTogglePin={togglePin}
        onRefresh={null}
        onExpand={null}
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
        onExpand={null}
        subtitle={t("pulse.following")}
      >
        <EmptyState
          icon={Activity}
          title={view.error ? t("pulse.failed") : t("pulse.collecting")}
          hint={view.error}
        />
      </PanelFrame>
    );
  }

  const topQueries = (view.topQueries?.items ?? []).slice(0, COMPACT_ROWS);
  const topStorage = (view.storage?.items ?? []).slice(0, COMPACT_ROWS);
  const storageMax = topStorage.length
    ? Math.max(...topStorage.map((i) => i.dataBytes + i.indexBytes + i.freeBytes))
    : 0;

  return (
    <PanelFrame
      pinned={!!pinned}
      onTogglePin={togglePin}
      onRefresh={refresh}
      onExpand={expand}
      subtitle={`${latest.driver} ${latest.serverVersion}`.trim()}
    >
      <div className="flex h-full flex-col overflow-y-auto">
        <Section title={t("pulse.section.status")}>
          <StatusTiles view={view} columns={2} />
        </Section>

        <Section
          title={t("pulse.section.alerts")}
          badge={view.alerts.length ? String(view.alerts.length) : undefined}
          badgeTone="warn"
        >
          <AlertList alerts={view.alerts} />
        </Section>

        <Section
          title={t("pulse.section.slowest")}
          badge={
            view.topQueries?.items.length
              ? t("pulse.showingOf", {
                  shown: topQueries.length,
                  total: view.topQueries.items.length,
                })
              : undefined
          }
        >
          {topQueries.length > 0 ? (
            topQueries.map((q) => <QueryRow key={q.digest} query={q} />)
          ) : (
            <p className="text-xs text-muted-foreground">
              {view.topQueries?.error
                ? `${t("pulse.slowest.unavailable")} ${slowestHint(latest.driver, t)}`
                : view.topQueries
                  ? t("pulse.slowest.empty")
                  : t("pulse.loading")}
            </p>
          )}
        </Section>

        <Section
          title={t("pulse.section.storage")}
          badge={
            view.storageTotalBytes > 0
              ? formatBytes(view.storageTotalBytes)
              : undefined
          }
        >
          {topStorage.length > 0 ? (
            <>
              {topStorage.map((i) => (
                <StorageRow key={`${i.schema}.${i.name}`} item={i} max={storageMax} />
              ))}
              <StorageLegend />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {view.storage?.error
                ? t("pulse.storage.unavailable")
                : view.storage
                  ? t("pulse.storage.empty")
                  : t("pulse.loading")}
            </p>
          )}
        </Section>
      </div>
    </PanelFrame>
  );
}

/** Header + body chrome, shared by every state so the controls stay put while
 *  the body swaps between "collecting", "not supported" and the sections. */
function PanelFrame({
  pinned,
  onTogglePin,
  onRefresh,
  onExpand,
  subtitle,
  children,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  /** `null` while there is nothing to refresh or expand, so the button is
   *  absent rather than present and inert. */
  onRefresh: (() => void) | null;
  onExpand: (() => void) | null;
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
            <HeaderButton label={t("pulse.refresh")} onClick={onRefresh}>
              <RefreshCw className="h-3.5 w-3.5" />
            </HeaderButton>
          )}
          {onExpand && (
            <HeaderButton label={t("pulse.expand")} onClick={onExpand}>
              <Maximize2 className="h-3.5 w-3.5" />
            </HeaderButton>
          )}
          <HeaderButton
            label={pinned ? t("pulse.unpin") : t("pulse.pin")}
            onClick={onTogglePin}
            pressed={pinned}
          >
            <PinIcon className="h-3.5 w-3.5" />
          </HeaderButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <SimpleTooltip side="left" label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        aria-label={label}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground",
          "transition-colors hover:bg-accent/60 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          pressed && "bg-accent/70 text-brand",
        )}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

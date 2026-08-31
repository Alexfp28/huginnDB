/**
 * Root rendered instead of `<App />` in a Pulse window (see `main.tsx`) — a
 * bare native window measuring exactly one connection, with a rail of views
 * down the left.
 *
 * Deliberately not a detached *tab* window: Pulse is context, not a document,
 * so it has no `TabKind`, nothing in `useTabs`, and nothing in the persisted
 * tab state. What it needs carried across is one connection id, which
 * `open_pulse_window` stashes and this drains on boot — the pool it measures
 * is already open in the shared backend `AppState`, so nothing reconnects here.
 *
 * Ephemeral by design, the same secondary-window pattern gotcha #8 describes:
 * nothing here writes shared state, and closing the window is the whole story.
 * The dock panel keeps working while this is open, and the two share one clock
 * because the live series lives in a store rather than in either component.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  HardDrive,
  ListOrdered,
  Loader2,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionErrorBoundary } from "@/components/connection/ConnectionErrorBoundary";
import { SandboxRibbon } from "@/components/shell/SandboxRibbon";
import { NotificationOverflowPill } from "@/components/shell/NotificationOverflowPill";
import { EmptyState } from "@/components/common/EmptyState";
import { AlertList } from "@/components/pulse/sections/AlertList";
import { StatusTiles } from "@/components/pulse/sections/StatusTiles";
import { StorageLegend } from "@/components/pulse/sections/StorageLegend";
import { slowestHint } from "@/lib/pulse/hints";
import { usePulseLive } from "@/lib/pulse/usePulseLive";
import { usePulseDetail } from "@/lib/pulse/usePulseDetail";
import { isUnsupported, usePulseView, type PulseView } from "@/lib/pulse/usePulseView";
import { setLanguage } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import {
  selectNotificationPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { useThemeStore, selectActiveMode } from "@/stores/preferences/theme";
import type { PulseTopQuery } from "@/types";

/** The views this window can show today. Sessions, indexes and the history
 *  retrospective join the list as their reads land; a rail entry with nothing
 *  behind it would be worse than an absent one. */
type ViewId = "status" | "queries" | "storage";

const VIEWS: { id: ViewId; icon: LucideIcon; labelKey: string }[] = [
  { id: "status", icon: Activity, labelKey: "pulse.section.status" },
  { id: "queries", icon: ListOrdered, labelKey: "pulse.section.slowest" },
  { id: "storage", icon: HardDrive, labelKey: "pulse.section.storage" },
];

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold">{title}</h2>
        {hint && (
          <span className="ml-auto font-mono text-3xs text-muted-foreground">
            {hint}
          </span>
        )}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function StatusView({ view }: { view: PulseView }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <StatusTiles view={view} columns={4} />
      <Panel
        title={t("pulse.section.alerts")}
        hint={
          view.alerts.length
            ? String(view.alerts.length)
            : t("pulse.noAlerts")
        }
      >
        <AlertList alerts={view.alerts} />
      </Panel>
    </div>
  );
}

/** One digest's fetched (or in-flight, or failed) plan, keyed by `sample` —
 *  the same string is what `pulseExplain` is called with, so it doubles as
 *  the cache key without needing a second identifier per row. */
interface ExplainState {
  loading: boolean;
  raw?: unknown;
  error?: string;
}

function ExplainPanel({ state }: { state: ExplainState }) {
  const { t } = useTranslation();
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("pulse.explain.loading")}
      </div>
    );
  }
  if (state.error) {
    return (
      <p className="px-3 py-3 text-xs text-destructive">
        {t("pulse.explain.error")} {state.error}
      </p>
    );
  }
  return (
    <pre className="max-h-80 overflow-auto px-3 py-3 font-mono text-3xs leading-relaxed">
      {JSON.stringify(state.raw, null, 2)}
    </pre>
  );
}

function QueriesView({
  view,
  connectionId,
}: {
  view: PulseView;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const items = view.topQueries?.items ?? [];

  const [openDigest, setOpenDigest] = useState<string | null>(null);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});

  const toggleExplain = useCallback(
    (query: PulseTopQuery) => {
      if (openDigest === query.digest) {
        setOpenDigest(null);
        return;
      }
      setOpenDigest(query.digest);
      if (!query.sample || explains[query.digest]) return;
      setExplains((s) => ({ ...s, [query.digest]: { loading: true } }));
      void api
        .pulseExplain(connectionId, query.sample)
        .then((plan) =>
          setExplains((s) => ({
            ...s,
            [query.digest]: { loading: false, raw: plan.raw },
          })),
        )
        .catch((e) =>
          setExplains((s) => ({
            ...s,
            [query.digest]: { loading: false, error: String(e) },
          })),
        );
    },
    [openDigest, explains, connectionId],
  );

  if (items.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={
          view.topQueries?.error
            ? t("pulse.slowest.unavailable")
            : view.topQueries
              ? t("pulse.slowest.empty")
              : t("pulse.loading")
        }
        hint={
          view.topQueries?.error && view.latest
            ? slowestHint(view.latest.driver, t)
            : undefined
        }
      />
    );
  }

  return (
    <Panel
      title={t("pulse.section.slowest")}
      hint={t("pulse.showingOf", { shown: items.length, total: items.length })}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-3xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.statement")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.runs")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.avg")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.max")}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                {t("pulse.table.examinedSent")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.signal")}
              </th>
              <th className="px-2 py-1.5 text-left font-medium">
                {t("pulse.table.plan")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((q) => {
              const open = openDigest === q.digest;
              return (
                <Fragment key={q.digest}>
                  <tr className="border-b border-border last:border-b-0">
                    <td className="max-w-[46ch] px-2 py-1.5 align-top">
                      {/* `line-clamp` sets `display: -webkit-box`, so the digest
                          needs its own block and the schema its own line below. */}
                      <div className="line-clamp-2 font-mono text-2xs" title={q.digest}>
                        {q.digest}
                      </div>
                      {q.schema && (
                        <div className="font-mono text-3xs text-muted-foreground">
                          {q.schema}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatCount(q.count)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {q.avgMs < 1 ? "<1" : Math.round(q.avgMs)} ms
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {q.maxMs < 1 ? "<1" : Math.round(q.maxMs)} ms
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {formatCount(q.rowsExamined)} / {formatCount(q.rowsSent)}
                    </td>
                    <td className="px-2 py-1.5">
                      {q.fullScans > 0 ? (
                        <span className="rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive">
                          {t("pulse.slowest.noIndexCount", {
                            count: formatCount(q.fullScans),
                          })}
                        </span>
                      ) : (
                        <span className="font-mono text-3xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        disabled={!q.sample}
                        onClick={() => toggleExplain(q)}
                        title={q.sample ? undefined : t("pulse.explain.unavailable")}
                        aria-expanded={open}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-3xs",
                          "text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                        )}
                      >
                        <ChevronRight
                          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
                        />
                        {t("pulse.table.plan")}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border last:border-b-0">
                      <td colSpan={7} className="bg-accent/20 p-0">
                        <ExplainPanel
                          state={explains[q.digest] ?? { loading: true }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function StorageView({ view }: { view: PulseView }) {
  const { t } = useTranslation();
  const items = view.storage?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title={
          view.storage?.error
            ? t("pulse.storage.unavailable")
            : view.storage
              ? t("pulse.storage.empty")
              : t("pulse.loading")
        }
      />
    );
  }

  const max = Math.max(
    ...items.map((i) => i.dataBytes + i.indexBytes + i.freeBytes),
  );

  return (
    <Panel
      title={t("pulse.section.storage")}
      hint={formatBytes(view.storageTotalBytes)}
    >
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const total = item.dataBytes + item.indexBytes + item.freeBytes;
          const pct = (n: number) =>
            total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
          return (
            <div
              key={`${item.schema}.${item.name}`}
              className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3"
            >
              <span className="truncate font-mono text-2xs" title={item.name}>
                {item.name}
              </span>
              <span className="flex h-4 overflow-hidden rounded-sm bg-accent">
                <span
                  className="flex h-full"
                  style={{ width: `${((total / max) * 100).toFixed(1)}%` }}
                >
                  <span
                    style={{ width: pct(item.dataBytes), background: "var(--brand)" }}
                  />
                  <span
                    style={{ width: pct(item.indexBytes), background: "var(--fk)" }}
                  />
                  <span
                    style={{ width: pct(item.freeBytes), background: "var(--warning)" }}
                  />
                </span>
              </span>
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {formatBytes(total)}
              </span>
            </div>
          );
        })}
        <StorageLegend />
      </div>
    </Panel>
  );
}

function PulseBody({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const [viewId, setViewId] = useState<ViewId>("status");

  // This window exists to show Pulse, so it is always the active surface —
  // `usePulseLive` still stands down while the window is minimised.
  usePulseLive(connectionId, true);
  const { refresh } = usePulseDetail(connectionId, true);
  const view = usePulseView(connectionId);

  if (isUnsupported(view.error) && !view.latest) {
    return (
      <EmptyState
        icon={ServerCog}
        title={t("pulse.unsupported.title")}
        hint={t("pulse.unsupported.hint")}
      />
    );
  }

  if (!view.latest) {
    return (
      <EmptyState
        icon={Activity}
        title={view.error ? t("pulse.failed") : t("pulse.collecting")}
        hint={view.error}
      />
    );
  }

  return (
    <div className="grid h-full grid-cols-[168px_1fr] overflow-hidden">
      <nav
        aria-label={t("pulse.title")}
        className="flex flex-col gap-0.5 border-r border-border bg-card p-2"
      >
        <p className="px-2 pb-2 pt-1 text-3xs uppercase tracking-wider text-muted-foreground">
          {t("pulse.title")}
        </p>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setViewId(v.id)}
            aria-current={viewId === v.id}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
              "transition-colors hover:bg-accent/60 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              viewId === v.id
                ? "bg-accent font-semibold text-foreground"
                : "text-muted-foreground",
            )}
          >
            <v.icon
              className={cn("h-3.5 w-3.5", viewId === v.id && "text-brand")}
            />
            {t(v.labelKey)}
            {v.id === "status" && view.alerts.length > 0 && (
              <span className="ml-auto rounded-full bg-warning/20 px-1.5 font-mono text-3xs text-warning">
                {view.alerts.length}
              </span>
            )}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-2">
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("pulse.refresh")}
          </button>
          <p className="px-2 pb-1 font-mono text-3xs leading-relaxed text-muted-foreground">
            {view.latest.driver} {view.latest.serverVersion}
          </p>
        </div>
      </nav>

      <div className="min-w-0 overflow-y-auto p-3">
        {viewId === "status" && <StatusView view={view} />}
        {viewId === "queries" && <QueriesView view={view} connectionId={connectionId} />}
        {viewId === "storage" && <StorageView view={view} />}
      </div>
    </div>
  );
}

export function PulseWindow() {
  const { t } = useTranslation();
  const [connectionId, setConnectionId] = useState<string | null | undefined>(
    undefined,
  );
  const themeMode = useThemeStore(selectActiveMode);
  const notificationPrefs = usePreferences(selectNotificationPrefs);
  const language = usePreferences((s) => s.prefs.ui.language);

  // Minimal bootstrap, mirroring `DetachedTabWindow`: enough state for the
  // views to run standalone, without the main window's launch-restore flow.
  //
  // `takePulseWindowIntent` REMOVES the intent from the backend map, so it
  // must run exactly once. Under `<React.StrictMode>` (main.tsx) this effect
  // mounts, unmounts and remounts in dev — a second call finds nothing and
  // resolves `null`, and with no guard that second `setConnectionId` always
  // wins, painting the "lost its connection" state even though the first
  // call already had the real id. Same idiom as `App.tsx`'s
  // `launchRestoreDone` and `useCliIntents`' `cliArgsHandled`.
  const intentHandled = useRef(false);
  useEffect(() => {
    if (intentHandled.current) return;
    intentHandled.current = true;
    void useAppFlavor.getState().load();
    void usePreferences.getState().hydrate();
    void useConnections.getState().refresh();
    void api
      .takePulseWindowIntent(getCurrentWindow().label)
      .then((id) => setConnectionId(id ?? null));
  }, []);

  useEffect(() => {
    setLanguage(language);
  }, [language]);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <SandboxRibbon />
        <div className="min-h-0 flex-1">
          {connectionId === undefined ? null : connectionId === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("pulse.windowUnavailable")}
            </div>
          ) : (
            <ConnectionErrorBoundary resetKey={connectionId}>
              <PulseBody connectionId={connectionId} />
            </ConnectionErrorBoundary>
          )}
        </div>
        <Toaster
          position={notificationPrefs.position}
          visibleToasts={notificationPrefs.maxVisible}
          expand={notificationPrefs.expandOnHover}
          gap={10}
          offset={{ bottom: 32, top: 12, left: 16, right: 16 }}
          theme={themeMode === "dark" ? "dark" : "light"}
        />
        <NotificationOverflowPill />
      </div>
    </TooltipProvider>
  );
}

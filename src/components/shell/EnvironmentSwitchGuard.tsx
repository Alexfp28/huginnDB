/**
 * Seals a region of the shell off while the session is being rebuilt for
 * another environment.
 *
 * `switchTo` is not a pointer move: it flushes the outgoing tab state, empties
 * `useTabs`, clears `selectedConnectionId`, then closes every live pool **one
 * at a time** — each a round trip, and one *per database* through a tunnel or a
 * pooler — before `restoreSession` reconnects the incoming set in parallel and
 * replays the saved layout. For that whole window the store is deliberately
 * half-torn-down, and until this component existed the schema tree and the tab
 * area stayed fully interactive on top of it: a click could open a pool
 * belonging to the environment being *left* while its siblings were being
 * dropped, or aim a `list_tables` at a pool mid-teardown and leave a stale
 * "not connected" error over a connection that ends up perfectly healthy.
 *
 * One component, mounted at two seams (`AppShell`'s schema panel and its centre
 * column) rather than a `disabled` threaded through the tree — the rule from
 * gotcha #61: transition state is decided at a shared seam, not re-derived at
 * every call site. `EnvironmentRail` stays outside it on purpose; it already
 * models the same transition itself (that is what `switchingTo` was built for)
 * and it is the one surface that must stay legible while the swap runs.
 *
 * Two mechanisms, because neither is enough alone:
 *
 *  - the overlay is a real pointer target (not `pointer-events-none` like
 *    `DataGrid`'s stale-data veil, whose whole point is the opposite) so the
 *    mouse cannot reach what is underneath;
 *  - `inert` on the content wrapper takes the subtree out of the focus order,
 *    which is what actually stops the keyboard. The tree carries its own
 *    `onKeyDown` and a `data-kb-scope="tree"` container, so a focused row would
 *    otherwise keep resolving bindings straight through the veil; with `inert`
 *    the active element is no longer inside that scope and `scopesAt` stops
 *    matching it, without the dispatcher (gotcha #53) needing to know this
 *    state exists at all.
 *
 * The overlay is a *sibling* of the inert wrapper, never a child — inerting the
 * curtain along with the content would hide its own spinner from assistive
 * tech and make it unhittable.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import {
  environmentLabel,
  useEnvironments,
} from "@/stores/session/environments";
import { cn } from "@/lib/utils";

export function EnvironmentSwitchGuard({
  className,
  contentClassName,
  children,
}: {
  /** Classes for the positioning context. Layout classes the parent needs to
   *  see (`flex-1`, `min-w-0`, …) belong here. */
  className?: string;
  /** Classes for the inert-able wrapper the children actually live in. */
  contentClassName?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // Primitives and raw references only (gotcha #1) — the label is derived in a
  // memo rather than returned from a selector.
  const switchingTo = useEnvironments((s) => s.switchingTo);
  const environments = useEnvironments((s) => s.environments);
  const busy = switchingTo !== null;

  const name = useMemo(() => {
    if (switchingTo === null) return "";
    const env = environments.find((e) => e.id === switchingTo);
    return env ? environmentLabel(env, t("environments.defaultName")) : "";
  }, [switchingTo, environments, t]);

  // `inert` is a DOM property, not a React 18 prop, so it is set through a ref.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (el) el.inert = busy;
  }, [busy]);

  return (
    <div className={cn("relative", className)} aria-busy={busy || undefined}>
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
      {busy && (
        <div
          className="absolute inset-0 z-30 flex cursor-progress items-center justify-center gap-2 bg-background/60 px-4 text-center text-xs text-muted-foreground backdrop-blur-[1px]"
          role="status"
          aria-live="polite"
        >
          <Spinner size="lg" className="text-brand" />
          <span className="truncate">
            {t("environments.switching", { name })}
          </span>
        </div>
      )}
    </div>
  );
}

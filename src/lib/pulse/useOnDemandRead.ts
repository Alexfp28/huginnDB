/**
 * Fetch-once, manual-refresh read for a Pulse rail view with no useful
 * "stale but fine" window of its own — a live snapshot (sessions) or a
 * ranking that already piggybacks on a read Pulse caches elsewhere (index
 * usage rides `storage`'s footprint ordering on the backend).
 *
 * Deliberately not polled, unlike `usePulseDetail`'s reads: staying open on
 * one of these views must not cost anything beyond the one request that
 * opened it. A snapshot of *who is connected right now* going stale while the
 * tab sits open is expected, not a bug — the refresh button is the fix, not
 * a timer.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface OnDemandState<T> {
  items: T[];
  loading: boolean;
  error?: string;
}

export function useOnDemandRead<T>(
  connectionId: string,
  fetcher: (connectionId: string) => Promise<T[]>,
): OnDemandState<T> & { refresh: () => void } {
  const [state, setState] = useState<OnDemandState<T>>({ items: [], loading: true });
  // The fetcher closes over nothing that changes per render in practice (it is
  // one of the `api.pulse*` functions), but reading it through a ref keeps
  // `load` — and therefore the mount effect below — from being redefined
  // every render if a caller ever passes an inline arrow function.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    void fetcherRef
      .current(connectionId)
      .then((items) => setState({ items, loading: false }))
      .catch((e) =>
        setState((s) => ({ items: s.items, loading: false, error: String(e) })),
      );
  }, [connectionId]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, refresh: load };
}

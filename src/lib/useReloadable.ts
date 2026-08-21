/**
 * `loading` / `error` / `reload` for an editor tab that seeds itself from the
 * backend.
 *
 * The structure, view and aggregation editors each ran the same shape:
 *
 *     const [loading, setLoading] = useState(mode === "edit");
 *     const [loadError, setLoadError] = useState<string | null>(null);
 *     const reload = useCallback(async () => {
 *       if (mode !== "edit" || !target) return;
 *       setLoading(true);
 *       try { …fetch, then several setStates…; setLoadError(null); }
 *       catch (e) { setLoadError(String(e)); }
 *       finally { setLoading(false); }
 *     }, [deps]);
 *     useEffect(() => { void reload(); }, [reload]);
 *
 * `load` does its own `setState` calls rather than returning data, which is
 * deliberate: these are *editable forms* seeded from a fetch, so each one
 * unpacks the response into several independent fields the user then edits.
 * A `{ data }`-returning hook would force every caller to add an effect that
 * copies `data` into that state, which is more machinery than it removes.
 *
 * Pass `null` for `load` when there is nothing to fetch — a "create" tab rather
 * than an "edit" one. That is also what makes `loading` start `false` there, so
 * a new-table tab does not open on a spinner.
 *
 * `load` must be memoised (`useCallback`) with exactly the dependencies that
 * should trigger a re-fetch: its identity is the effect's dependency, which is
 * how the three callers already worked.
 */

import { useCallback, useEffect, useState } from "react";

export interface Reloadable {
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useReloadable(load: (() => Promise<void>) | null): Reloadable {
  const [loading, setLoading] = useState(load !== null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!load) return;
    setLoading(true);
    try {
      await load();
      // Cleared on success only, not before the fetch: a reload that fails
      // again should not blank the message the user is reading in between.
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, error, reload };
}

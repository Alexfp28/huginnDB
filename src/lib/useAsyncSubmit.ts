/**
 * The submit half of a modal: one in-flight flag and one error string.
 *
 * Ten dialogs had this written out by hand, always identically —
 * `setSubmitting(true); setError(null); try { … } catch (e) { setError(String(e));
 * setSubmitting(false); }` — and the asymmetry in that last line is the part
 * worth keeping in one place: on *success* `submitting` is deliberately left
 * true. The success path always closes or replaces the dialog, so clearing the
 * flag first would re-enable the buttons for the frame or two before the unmount
 * lands, which is a double-submit window on actions like `DROP TABLE`.
 *
 * Takes no task at construction so a dialog with two actions (commit vs. clear
 * an override, say) can share one flag and one error slot, which is what those
 * dialogs actually want: either action in flight disables both buttons.
 *
 * Validation stays at the call site — `if (!name.trim()) return;` belongs with
 * the field, before anything is marked in flight.
 */

import { useCallback, useState } from "react";

export interface AsyncSubmit {
  /** True from the moment a task starts until it fails (never on success). */
  submitting: boolean;
  /** The last failure, stringified for display, or `null`. */
  error: string | null;
  /** Run `task`, clearing any previous error first. */
  run: (task: () => Promise<void>) => void;
  /** Drop a displayed error without running anything. */
  clearError: () => void;
}

export function useAsyncSubmit(): AsyncSubmit {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((task: () => Promise<void>) => {
    setSubmitting(true);
    setError(null);
    void task().catch((e: unknown) => {
      setError(String(e));
      setSubmitting(false);
    });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { submitting, error, run, clearError };
}

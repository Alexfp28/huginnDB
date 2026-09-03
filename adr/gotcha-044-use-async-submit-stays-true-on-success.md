# Gotcha #044: useAsyncSubmit deliberately keeps submitting true after success

**Fecha:** 2026-09-03

Every success closes or replaces the dialog, so clearing the flag first would re-enable buttons for the frames before unmount — a double-submit window on a destructive action. It shares one flag and error slot across a dialog's two actions.

## Detail

**A dialog's submit half is `useAsyncSubmit`, and it keeps `submitting` true after a success.** Ten modals hand-rolled `setSubmitting(true); setError(null); try { … } catch { setError(String(e)); setSubmitting(false) }`, and the missing `setSubmitting(false)` on the success path is deliberate, not an oversight: every success closes or replaces the dialog, so clearing the flag first re-enables the buttons for the frames before the unmount lands — a double-submit window on a `DROP TABLE`. The hook takes no task at construction so a dialog with two actions (commit vs. clear an override) shares one flag and one error slot; validation (`if (!name.trim()) return;`) stays at the call site. Its natural partner is `ConfirmDialog`'s `error`/`children`/`confirmingLabel` slots — a failed destructive action has to say why *in* the dialog, which stays open, so a toast is the wrong surface there.

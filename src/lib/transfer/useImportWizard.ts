/**
 * The multi-step import wizard shared by the profile and environment importers.
 *
 * Both dialogs ran the same machine — nine `useState`s, the same four
 * transitions, the same `doImport` down to its comment, the same reset — and
 * differed only in which two `api` calls they made, whether a "review" step
 * comes first, and which store to refresh afterwards. Around 110 lines each,
 * once. The one time they *did* drift, the conflict default came out unsafe in
 * the copy nobody re-read (it defaulted to "rename", silently duplicating every
 * referenced profile on a straight export-then-reimport). Owning that default
 * here is the point of the hook, not a side effect of it.
 *
 * `ImportJsonSchemasDialog` deliberately does **not** use this. It has no
 * passphrase step and no progress event, its review step comes *after*
 * conflicts, and it reports errors through toasts rather than inline state — a
 * different shape that would cost more in optionality than it saves.
 *
 * While the dialog is open, `ImportProgressBar` inside it is the right
 * surface for progress — a toast saying the same thing next to it would be
 * noise. But nothing here stops the user closing the dialog (the X, Escape,
 * a click outside — none of them are disabled during `loading`) while the
 * backend is still grinding through PBKDF2 for the rest of the file, and
 * until now that left the import running in total silence: `handleClose`
 * resets the wizard's own state immediately, so by the time the promise
 * resolves there was nothing left on screen to update. `doImportInFlightRef`
 * plus the two effects below hand the in-flight import off to a
 * `notify.progress()` card the moment the dialog closes out from under it,
 * and resolve that card into success/error once the promise actually
 * settles — the only case that needs a toast at all.
 */

import { useEffect, useRef, useState } from "react";

import { pickJsonFile } from "@/lib/dialogs";
import {
  withImportProgress,
  type ImportProgress,
} from "@/lib/bridges/import-progress-bridge";
import { notify, type ProgressHandle } from "@/lib/notify";
import i18n from "@/lib/i18n";
import type { ConflictAction, ConflictResolution } from "@/types";

/** The steps in order. "review" is skipped unless the caller asks for it. */
export type ImportStep = "pick" | "review" | "passphrase" | "conflicts" | "done";

/** The shape both analyses share — all the machine needs to route. */
export interface ImportAnalysisLike {
  encrypted: boolean;
  conflicts: { id: string }[];
}

export interface ImportWizardConfig<A extends ImportAnalysisLike, R> {
  /** Title for the native file picker. */
  pickTitle: string;
  analyze: (path: string) => Promise<A>;
  run: (
    path: string,
    passphrase: string | undefined,
    resolutions: ConflictResolution[],
  ) => Promise<R>;
  /**
   * Show a "review" step between picking the file and everything else.
   *
   * The environment importer needs it: one file can describe several
   * environments, so the user is told what is about to be created before any of
   * it happens. The profile importer has nothing to review and goes straight
   * through — including straight to the import when the file is unencrypted and
   * conflict-free.
   */
  reviewStep?: boolean;
  /** Refresh whatever store the import invalidated. */
  afterImport?: () => Promise<void>;
  /** Whether the dialog is currently visible — passed straight through from
   *  the dialog's own `open` prop. Closing it while an import is in flight is
   *  what triggers the `notify.progress()` handoff. */
  open: boolean;
  /** Notification title for that handoff — typically the dialog's own title. */
  notifyTitle: string;
  /** Success copy for the resolved notification, once the import finishes. */
  notifySuccess: (result: R) => string;
}

export interface ImportWizard<A, R> {
  step: ImportStep;
  filePath: string;
  analysis: A | null;
  passphrase: string;
  setPassphrase: (v: string) => void;
  resolutions: Record<string, ConflictAction>;
  result: R | null;
  loading: boolean;
  error: string | null;
  progress: ImportProgress | null;
  pickFile: () => Promise<void>;
  reviewNext: () => void;
  passphraseNext: () => Promise<void>;
  conflictsNext: () => Promise<void>;
  setResolution: (id: string, action: ConflictAction) => void;
  setAllResolutions: (action: ConflictAction) => void;
  /** Reset every field. Call from the dialog's own close handler. */
  reset: () => void;
}

/**
 * The default for a conflict the user leaves untouched.
 *
 * A conflict is matched by id (`detect_conflicts` on the Rust side), so it is
 * never a coincidence — it is definitionally the same connection already
 * present. "Rename" as a default silently duplicated every profile under a
 * fresh id with a " (imported)" suffix on a straight export-then-reimport of
 * one's own data, which is the single most common reason to reach this screen.
 * "Skip" is idempotent; Overwrite and Rename stay one click away. The Rust
 * fallback in `apply_profile_imports` agrees, and its
 * `an_unresolved_conflict_defaults_to_skip_not_rename` test pins it.
 */
const DEFAULT_ACTION: ConflictAction = "skip";

export function useImportWizard<A extends ImportAnalysisLike, R>(
  cfg: ImportWizardConfig<A, R>,
): ImportWizard<A, R> {
  const [step, setStep] = useState<ImportStep>("pick");
  const [filePath, setFilePath] = useState("");
  const [analysis, setAnalysis] = useState<A | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, ConflictAction>>(
    {},
  );
  const [result, setResult] = useState<R | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  // Distinct from `loading`, which also brackets the much shorter `analyze`
  // call in `pickFile` — the handoff below only cares about the long-running
  // decrypt/import, not a quick file-metadata read.
  const doImportInFlightRef = useRef(false);
  const progressHandleRef = useRef<ProgressHandle | null>(null);
  const wasOpenRef = useRef(cfg.open);

  async function doImport(
    path: string,
    pp: string | undefined,
    resolved: ConflictResolution[],
  ) {
    setLoading(true);
    setError(null);
    doImportInFlightRef.current = true;
    try {
      const r = await withImportProgress(setProgress, () =>
        cfg.run(path, pp, resolved),
      );
      setResult(r);
      setStep("done");
      await cfg.afterImport?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      doImportInFlightRef.current = false;
    }
  }

  // The dialog just closed (X / Escape / outside click — `handleClose` in
  // both dialogs resets step/progress/error synchronously, but never touches
  // `loading`) while the import is still running. Hand it off to a
  // notification so the outcome isn't lost.
  useEffect(() => {
    const justClosed = wasOpenRef.current && !cfg.open;
    wasOpenRef.current = cfg.open;
    if (justClosed && doImportInFlightRef.current && !progressHandleRef.current) {
      progressHandleRef.current = notify.progress(cfg.notifyTitle, {
        formatProgress: (p) =>
          i18n.t("transfer.import.progress", { done: p.done, total: p.total }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.open]);

  // Feed it live numbers while it runs.
  useEffect(() => {
    if (progress) progressHandleRef.current?.update(progress);
  }, [progress]);

  // Resolve it once the promise actually settles — success/error, whichever
  // it was, is what belongs in history, never the progress itself.
  useEffect(() => {
    const handle = progressHandleRef.current;
    if (!handle || loading) return;
    progressHandleRef.current = null;
    if (error) {
      handle.error(cfg.notifyTitle, { description: error });
    } else if (result) {
      handle.success(cfg.notifySuccess(result));
    } else {
      // Reset ran before the promise settled — nothing meaningful to show.
      handle.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /** Where to go once the analysis (or the review step) is behind us. */
  async function advance(path: string, info: A) {
    if (info.encrypted) {
      setStep("passphrase");
    } else if (info.conflicts.length > 0) {
      setStep("conflicts");
    } else {
      await doImport(path, undefined, []);
    }
  }

  async function pickFile() {
    const picked = await pickJsonFile(cfg.pickTitle);
    if (!picked) return;
    setFilePath(picked);
    setError(null);
    setLoading(true);
    try {
      const info = await cfg.analyze(picked);
      setAnalysis(info);
      setResolutions(
        Object.fromEntries(info.conflicts.map((c) => [c.id, DEFAULT_ACTION])),
      );
      if (cfg.reviewStep) {
        setStep("review");
      } else {
        await advance(picked, info);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function reviewNext() {
    if (!analysis) return;
    void advance(filePath, analysis);
  }

  async function passphraseNext() {
    if (!analysis || !filePath) return;
    if (analysis.conflicts.length > 0) {
      setStep("conflicts");
    } else {
      await doImport(filePath, passphrase, []);
    }
  }

  async function conflictsNext() {
    if (!analysis || !filePath) return;
    const resolved: ConflictResolution[] = analysis.conflicts.map((c) => ({
      id: c.id,
      action: resolutions[c.id] ?? DEFAULT_ACTION,
    }));
    await doImport(
      filePath,
      analysis.encrypted ? passphrase : undefined,
      resolved,
    );
  }

  function setResolution(id: string, action: ConflictAction) {
    setResolutions((prev) => ({ ...prev, [id]: action }));
  }

  function setAllResolutions(action: ConflictAction) {
    if (!analysis) return;
    setResolutions(
      Object.fromEntries(analysis.conflicts.map((c) => [c.id, action])),
    );
  }

  function reset() {
    setStep("pick");
    setFilePath("");
    setAnalysis(null);
    setPassphrase("");
    setResolutions({});
    setResult(null);
    setError(null);
    setProgress(null);
  }

  return {
    step,
    filePath,
    analysis,
    passphrase,
    setPassphrase,
    resolutions,
    result,
    loading,
    error,
    progress,
    pickFile,
    reviewNext,
    passphraseNext,
    conflictsNext,
    setResolution,
    setAllResolutions,
    reset,
  };
}

/**
 * Multi-step dialog for importing connection profiles from a JSON file.
 *
 * Steps:
 *  1. "pick"      — file picker + quick analysis
 *  2. "passphrase"— only if the file has encrypted secrets
 *  3. "conflicts" — resolve conflicts with existing profiles
 *  4. "done"      — result summary
 *
 * The machine itself lives in `lib/transfer/useImportWizard` — shared with
 * `ImportEnvironmentDialog`, which ran an identical one. What is left here is
 * this importer's two `api` calls and its own copy for each step.
 */

import { useTranslation } from "react-i18next";
import { Upload, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/common/PasswordInput";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { ProgressBar } from "@/components/common/ProgressBar";
import { ConflictResolutionStep } from "./ConflictResolutionStep";
import { useImportWizard } from "@/lib/transfer/useImportWizard";
import type { ImportAnalysis, ImportResult } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportProfilesDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const refresh = useConnections((s) => s.refresh);

  const w = useImportWizard<ImportAnalysis, ImportResult>({
    pickTitle: t("transfer.import.pickTitle"),
    analyze: api.analyzeImportFile,
    run: api.importProfiles,
    afterImport: refresh,
    open,
    notifyTitle: t("transfer.import.title"),
    notifySuccess: () => t("transfer.import.done"),
  });
  const {
    step,
    analysis,
    passphrase,
    setPassphrase,
    resolutions,
    result,
    loading,
    error,
    progress,
  } = w;

  function handleClose() {
    w.reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Upload className="h-4 w-4" />
            {t("transfer.import.title")}
          </DialogTitle>
        </DialogHeader>

        {progress && (
          <ProgressBar
            done={progress.done}
            total={progress.total}
            label={t("transfer.import.progress", {
              done: progress.done,
              total: progress.total,
            })}
          />
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step: pick */}
        {/* ---------------------------------------------------------------- */}
        {step === "pick" && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.import.pickDescription")}
            </p>
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/40 px-3 py-2 text-[11px] text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={w.pickFile} disabled={loading}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("transfer.import.browse")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step: passphrase */}
        {/* ---------------------------------------------------------------- */}
        {step === "passphrase" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("transfer.import.passphraseRequired")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-passphrase" className="text-xs">
                {t("transfer.import.passphrase")}
              </Label>
              <PasswordInput
                id="import-passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && passphrase.length > 0)
                    void w.passphraseNext();
                }}
                placeholder={t("transfer.import.passphrasePlaceholder")}
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <DialogActions
              size="sm"
              onCancel={handleClose}
              cancelLabel={t("common.cancel")}
              confirmLabel={t("common.continue")}
              onConfirm={w.passphraseNext}
              confirming={loading}
              confirmDisabled={passphrase.length === 0}
            />
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step: conflicts */}
        {/* ---------------------------------------------------------------- */}
        {step === "conflicts" && analysis && (
          <div className="space-y-4 py-2">
            <ConflictResolutionStep
              conflicts={analysis.conflicts}
              resolutions={resolutions}
              onResolve={w.setResolution}
              onResolveAll={w.setAllResolutions}
              error={error}
            />
            <DialogActions
              size="sm"
              onCancel={handleClose}
              cancelLabel={t("common.cancel")}
              confirmLabel={t("transfer.import.importButton", {
                count: analysis.total,
              })}
              onConfirm={w.conflictsNext}
              confirming={loading}
            />
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step: done */}
        {/* ---------------------------------------------------------------- */}
        {step === "done" && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t("transfer.import.done")}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {t("transfer.import.summaryImported", {
                  count: result.imported.length,
                })}
              </p>
              {result.skipped.length > 0 && (
                <p>
                  {t("transfer.import.summarySkipped", {
                    count: result.skipped.length,
                  })}
                </p>
              )}
              {result.renamed.length > 0 && (
                <p>
                  {t("transfer.import.summaryRenamed", {
                    count: result.renamed.length,
                  })}
                </p>
              )}
            </div>
            {result.needs_password.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/40 px-3 py-2 text-2xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("transfer.import.needsPassword", {
                  count: result.needs_password.length,
                })}
              </div>
            )}
            <DialogFooter>
              <Button size="sm" onClick={handleClose}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

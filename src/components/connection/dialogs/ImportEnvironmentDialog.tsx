/**
 * Multi-step dialog for importing an environment export — mirrors
 * `ImportProfilesDialog`'s steps, with three differences: a "review" step
 * lists every environment the file contains (a file can bundle more than
 * one, see `ExportEnvironmentDialog`), the "done" step reports how many
 * shared origins were registered per environment, and importing always
 * creates **new** environments rather than touching anything already
 * configured.
 *
 * Steps:
 *  1. "pick"       — file picker + quick analysis
 *  2. "review"     — which environments (and how many connections/origins
 *                    each) are about to be created
 *  3. "passphrase" — only if the file has encrypted secrets
 *  4. "conflicts"  — resolve conflicts with existing connection profiles
 *  5. "done"       — result summary
 *
 * The machine is `lib/transfer/useImportWizard`, shared with
 * `ImportProfilesDialog`; `reviewStep` is what inserts step 2.
 */

import { useTranslation } from "react-i18next";
import { Upload, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { useEnvironments } from "@/stores/session/environments";
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
import type {
  EnvironmentImportAnalysis,
  EnvironmentImportResult,
} from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportEnvironmentDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const switchTo = useEnvironments((s) => s.switchTo);

  const w = useImportWizard<EnvironmentImportAnalysis, EnvironmentImportResult>(
    {
      pickTitle: t("transfer.importEnvironment.pickTitle"),
      analyze: api.analyzeEnvironmentImport,
      run: api.importEnvironment,
      reviewStep: true,
      afterImport: () => useEnvironments.getState().load(),
      open,
      notifyTitle: t("transfer.importEnvironment.title"),
      notifySuccess: (result) =>
        t("transfer.importEnvironment.done", {
          count: result.environments.length,
        }),
    },
  );
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
            {t("transfer.importEnvironment.title")}
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

        {/* Step: pick */}
        {step === "pick" && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.importEnvironment.pickDescription")}
            </p>
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/40 px-3 py-2 text-2xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={w.pickFile}
                disabled={loading}
                icon={Upload}
              >
                {t("transfer.import.browse")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: review */}
        {step === "review" && analysis && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.importEnvironment.reviewDescription", {
                count: analysis.environments.length,
              })}
            </p>
            <div className="divide-y divide-border rounded-md border border-border max-h-56 overflow-y-auto">
              {analysis.environments.map((env, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="truncate text-xs font-medium">
                    {env.name || t("environments.defaultName")}
                  </span>
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {t("transfer.importEnvironment.reviewCounts", {
                      connections: env.connectionCount,
                      origins: env.origins.length,
                    })}
                  </span>
                </div>
              ))}
            </div>
            {error && <p className="text-2xs text-destructive">{error}</p>}
            <DialogActions
              size="sm"
              onCancel={handleClose}
              cancelLabel={t("common.cancel")}
              confirmLabel={t("common.continue")}
              onConfirm={w.reviewNext}
              confirming={loading}
            />
          </div>
        )}

        {/* Step: passphrase */}
        {step === "passphrase" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-2xs text-muted-foreground">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("transfer.import.passphraseRequired")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-env-passphrase" className="text-xs">
                {t("transfer.import.passphrase")}
              </Label>
              <PasswordInput
                id="import-env-passphrase"
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
            {error && <p className="text-2xs text-destructive">{error}</p>}
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

        {/* Step: conflicts */}
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
              confirmLabel={t("transfer.importEnvironment.importButton", {
                count: analysis.environments.length,
              })}
              onConfirm={w.conflictsNext}
              confirming={loading}
            />
          </div>
        )}

        {/* Step: done */}
        {step === "done" && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t("transfer.importEnvironment.done", {
                count: result.environments.length,
              })}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              {result.environments.map((env) => (
                <p key={env.environmentId}>
                  {t("transfer.importEnvironment.doneEntry", {
                    name: env.name || t("environments.defaultName"),
                    origins: env.originIds.length,
                  })}
                </p>
              ))}
              <p>
                {t("transfer.import.summaryImported", {
                  count: result.profiles.imported.length,
                })}
              </p>
              {result.profiles.skipped.length > 0 && (
                <p>
                  {t("transfer.import.summarySkipped", {
                    count: result.profiles.skipped.length,
                  })}
                </p>
              )}
              {result.profiles.renamed.length > 0 && (
                <p>
                  {t("transfer.import.summaryRenamed", {
                    count: result.profiles.renamed.length,
                  })}
                </p>
              )}
              {result.json_schemas && (
                <p className="text-muted-foreground">
                  {t("transfer.importEnvironment.doneSchemas", {
                    schemas:
                      result.json_schemas.imported.length +
                      result.json_schemas.overwritten.length +
                      result.json_schemas.renamed.length,
                    bindings: result.json_schemas.bindings_imported,
                  })}
                </p>
              )}
            </div>
            {result.profiles.needs_password.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/40 px-3 py-2 text-2xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("transfer.import.needsPassword", {
                  count: result.profiles.needs_password.length,
                })}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.close")}
              </Button>
              {result.environments.length === 1 && (
                <Button
                  size="sm"
                  onClick={() => {
                    void switchTo(result.environments[0].environmentId);
                    handleClose();
                  }}
                >
                  {t("transfer.importEnvironment.switchNow")}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

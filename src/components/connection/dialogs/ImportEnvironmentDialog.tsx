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
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { useEnvironments } from "@/stores/session/environments";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type {
  ConflictAction,
  ConflictResolution,
  EnvironmentImportAnalysis,
  EnvironmentImportResult,
} from "@/types";

type Step = "pick" | "review" | "passphrase" | "conflicts" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportEnvironmentDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const switchTo = useEnvironments((s) => s.switchTo);

  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState("");
  const [analysis, setAnalysis] = useState<EnvironmentImportAnalysis | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, ConflictAction>>({});
  const [result, setResult] = useState<EnvironmentImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickFile() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("transfer.importEnvironment.pickTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      setFilePath(picked);
      setError(null);
      setLoading(true);
      try {
        const info = await api.analyzeEnvironmentImport(picked);
        setAnalysis(info);
        const defaults: Record<string, ConflictAction> = {};
        for (const c of info.conflicts) {
          defaults[c.id] = "rename";
        }
        setResolutions(defaults);
        setStep("review");
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    } catch {
      // Dialog cancelled.
    }
  }

  function handleReviewNext() {
    if (!analysis) return;
    if (analysis.encrypted) {
      setStep("passphrase");
    } else if (analysis.conflicts.length > 0) {
      setStep("conflicts");
    } else {
      void doImport(filePath, undefined, []);
    }
  }

  async function handlePassphraseNext() {
    if (!analysis || !filePath) return;
    if (analysis.conflicts.length > 0) {
      setStep("conflicts");
    } else {
      await doImport(filePath, passphrase, []);
    }
  }

  async function handleConflictsNext() {
    if (!analysis || !filePath) return;
    const resolved: ConflictResolution[] = analysis.conflicts.map((c) => ({
      id: c.id,
      action: resolutions[c.id] ?? "rename",
    }));
    await doImport(filePath, analysis.encrypted ? passphrase : undefined, resolved);
  }

  async function doImport(path: string, pp: string | undefined, resolved: ConflictResolution[]) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.importEnvironment(path, pp, resolved);
      setResult(r);
      setStep("done");
      await useEnvironments.getState().load();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setStep("pick");
    setFilePath("");
    setAnalysis(null);
    setPassphrase("");
    setResolutions({});
    setResult(null);
    setError(null);
    onOpenChange(false);
  }

  function setResolution(id: string, action: ConflictAction) {
    setResolutions((prev) => ({ ...prev, [id]: action }));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Upload className="h-4 w-4" />
            {t("transfer.importEnvironment.title")}
          </DialogTitle>
        </DialogHeader>

        {/* Step: pick */}
        {step === "pick" && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.importEnvironment.pickDescription")}
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
              <Button size="sm" onClick={handlePickFile} disabled={loading}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
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
                <div key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-xs font-medium">
                    {env.name || t("environments.defaultName")}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("transfer.importEnvironment.reviewCounts", {
                      connections: env.connectionCount,
                      origins: env.origins.length,
                    })}
                  </span>
                </div>
              ))}
            </div>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleReviewNext} disabled={loading}>
                {t("common.continue")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: passphrase */}
        {step === "passphrase" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
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
                  if (e.key === "Enter" && passphrase.length > 0) void handlePassphraseNext();
                }}
                placeholder={t("transfer.import.passphrasePlaceholder")}
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handlePassphraseNext}
                disabled={passphrase.length === 0 || loading}
              >
                {t("common.continue")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: conflicts */}
        {step === "conflicts" && analysis && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.import.conflictsDescription", {
                count: analysis.conflicts.length,
              })}
            </p>
            <div className="divide-y divide-border rounded-md border border-border max-h-56 overflow-y-auto">
              {analysis.conflicts.map((c) => (
                <div key={c.id} className="px-3 py-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium">{c.incoming_name}</span>
                    {c.incoming_name !== c.existing_name && (
                      <span className="text-[10px] text-muted-foreground">
                        {t("transfer.import.existingAs", { name: c.existing_name })}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    {(["rename", "overwrite", "skip"] as ConflictAction[]).map((action) => (
                      <button
                        key={action}
                        onClick={() => setResolution(c.id, action)}
                        className={
                          "rounded px-2 py-0.5 text-[10px] uppercase font-medium transition-colors " +
                          (resolutions[c.id] === action
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80")
                        }
                      >
                        {t(`transfer.import.action.${action}`)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleConflictsNext} disabled={loading}>
                {t("transfer.importEnvironment.importButton", {
                  count: analysis.environments.length,
                })}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: done */}
        {step === "done" && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t("transfer.importEnvironment.done", { count: result.environments.length })}
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
              <p>{t("transfer.import.summaryImported", { count: result.profiles.imported.length })}</p>
              {result.profiles.skipped.length > 0 && (
                <p>{t("transfer.import.summarySkipped", { count: result.profiles.skipped.length })}</p>
              )}
              {result.profiles.renamed.length > 0 && (
                <p>{t("transfer.import.summaryRenamed", { count: result.profiles.renamed.length })}</p>
              )}
            </div>
            {result.profiles.needs_password.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/40 px-3 py-2 text-2xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("transfer.import.needsPassword", { count: result.profiles.needs_password.length })}
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

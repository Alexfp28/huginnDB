/**
 * Multi-step dialog for importing connection profiles from a JSON file.
 *
 * Steps:
 *  1. "pick"      — file picker + quick analysis
 *  2. "passphrase"— only if the file has encrypted secrets
 *  3. "conflicts" — resolve conflicts with existing profiles
 *  4. "done"      — result summary
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ConflictAction, ConflictResolution, ImportAnalysis, ImportResult } from "@/types";

type Step = "pick" | "passphrase" | "conflicts" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportProfilesDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const refresh = useConnections((s) => s.refresh);

  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, ConflictAction>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickFile() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("transfer.import.pickTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      setFilePath(picked);
      setError(null);
      setLoading(true);
      try {
        const info = await api.analyzeImportFile(picked);
        setAnalysis(info);
        // Pre-fill resolutions: conflicts default to "rename".
        const defaults: Record<string, ConflictAction> = {};
        for (const c of info.conflicts) {
          defaults[c.id] = "rename";
        }
        setResolutions(defaults);
        setStep(info.encrypted ? "passphrase" : info.conflicts.length > 0 ? "conflicts" : "pick");
        // If no conflicts and not encrypted, go straight to import.
        if (!info.encrypted && info.conflicts.length === 0) {
          await doImport(picked, undefined, []);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    } catch {
      // Dialog cancelled.
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
      const r = await api.importProfiles(path, pp, resolved);
      setResult(r);
      setStep("done");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    // Reset state on close.
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
            {t("transfer.import.title")}
          </DialogTitle>
        </DialogHeader>

        {/* ---------------------------------------------------------------- */}
        {/* Step: pick */}
        {/* ---------------------------------------------------------------- */}
        {step === "pick" && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.import.pickDescription")}
            </p>
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-[11px] text-destructive">
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
              <Input
                id="import-passphrase"
                type="password"
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
            {error && (
              <p className="text-[11px] text-destructive">{error}</p>
            )}
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

        {/* ---------------------------------------------------------------- */}
        {/* Step: conflicts */}
        {/* ---------------------------------------------------------------- */}
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
            {error && (
              <p className="text-[11px] text-destructive">{error}</p>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleConflictsNext} disabled={loading}>
                {t("transfer.import.importButton", { count: analysis.total })}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Step: done */}
        {/* ---------------------------------------------------------------- */}
        {step === "done" && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-500">
              <CheckCircle2 className="h-4 w-4" />
              {t("transfer.import.done")}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {t("transfer.import.summaryImported", { count: result.imported.length })}
              </p>
              {result.skipped.length > 0 && (
                <p>{t("transfer.import.summarySkipped", { count: result.skipped.length })}</p>
              )}
              {result.renamed.length > 0 && (
                <p>{t("transfer.import.summaryRenamed", { count: result.renamed.length })}</p>
              )}
            </div>
            {result.needs_password.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
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

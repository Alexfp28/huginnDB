/**
 * Import a JSON Schema export.
 *
 * A four-step machine — `pick → review → conflicts → done` — mirroring
 * `ImportEnvironmentDialog` minus its `passphrase` step, since a schema export is
 * never encrypted.
 *
 * The review step exists to state one thing before anything is written: how many
 * bindings will land switched off. A binding pinned to a connection names a uuid
 * minted on the machine that wrote the file, so on any other machine it cannot
 * match. The backend keeps that id and disables the rule rather than widening it
 * to "any connection" (which would change what the rule means) or dropping it
 * (which would lose the intent silently) — so the honest thing here is to say the
 * number up front rather than bury it in the result.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { notify } from "@/lib/notify";

import { api } from "@/lib/tauri";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { Button } from "@/components/ui/button";
import { pickJsonFile } from "@/lib/dialogs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ConflictAction,
  JsonSchemaImportAnalysis,
  JsonSchemaImportResult,
} from "@/types";

type Step = "pick" | "review" | "conflicts" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportJsonSchemasDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const reload = useJsonSchemas((s) => s.reload);

  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<JsonSchemaImportAnalysis | null>(
    null,
  );
  const [actions, setActions] = useState<Record<string, ConflictAction>>({});
  const [result, setResult] = useState<JsonSchemaImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("pick");
    setFilePath(null);
    setAnalysis(null);
    setActions({});
    setResult(null);
  }

  async function pick() {
    const picked = await pickJsonFile(
      t("transfer.importJsonSchemas.pickTitle"),
    );
    if (!picked) return;
    setBusy(true);
    try {
      const found = await api.analyzeJsonSchemaImport(picked);
      setFilePath(picked);
      setAnalysis(found);
      // Default every conflict to "skip", matching `ImportProfilesDialog`.
      //
      // The detection axis differs — schema conflicts match on *name*, profiles on
      // *id* — but the failure mode is identical and it is the common one:
      // re-importing your own export with "rename" accumulates `x (imported)`,
      // `x (2)`, … on every round trip. The conflicts step is still shown, so a
      // genuinely different schema is one click from Rename or Overwrite.
      setActions(
        Object.fromEntries(
          found.conflicts.map((c) => [c.id, "skip" as ConflictAction]),
        ),
      );
      setStep(found.conflicts.length > 0 ? "conflicts" : "review");
    } catch (e) {
      notify.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!filePath) return;
    setBusy(true);
    try {
      const outcome = await api.importJsonSchemas(
        filePath,
        Object.entries(actions).map(([id, action]) => ({ id, action })),
      );
      setResult(outcome);
      await reload();
      setStep("done");
    } catch (e) {
      notify.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("transfer.importJsonSchemas.title")}</DialogTitle>
          <DialogDescription>
            {step === "pick"
              ? t("transfer.importJsonSchemas.pickDescription")
              : analysis
                ? t("transfer.importJsonSchemas.reviewDescription", {
                    schemas: analysis.total_schemas,
                    bindings: analysis.total_bindings,
                  })
                : ""}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" && (
          <div className="space-y-3">
            <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] text-primary">
              {t("transfer.importJsonSchemas.pickNote")}
            </p>
            <Button
              variant="outline"
              onClick={() => void pick()}
              disabled={busy}
            >
              <Upload className="mr-1 h-3.5 w-3.5" />
              {t("transfer.importJsonSchemas.pickTitle")}
            </Button>
          </div>
        )}

        {step === "conflicts" && analysis && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("transfer.import.conflictsDescription")}
            </p>
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-2">
              {analysis.conflicts.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {c.existing_name}
                  </span>
                  <NativeSelect
                    value={actions[c.id] ?? "skip"}
                    onChange={(e) =>
                      setActions((prev) => ({
                        ...prev,
                        [c.id]: e.target.value as ConflictAction,
                      }))
                    }
                    size="xs"
                  >
                    <option value="skip">
                      {t("transfer.import.action.skip")}
                    </option>
                    <option value="rename">
                      {t("transfer.import.action.rename")}
                    </option>
                    <option value="overwrite">
                      {t("transfer.import.action.overwrite")}
                    </option>
                  </NativeSelect>
                </div>
              ))}
            </div>
          </div>
        )}

        {(step === "review" || step === "conflicts") &&
          analysis &&
          analysis.bindings_unresolvable > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              {t("transfer.importJsonSchemas.unresolvedWarning", {
                count: analysis.bindings_unresolvable,
              })}
            </p>
          )}

        {step === "done" && result && (
          <div className="space-y-1 text-xs">
            <p>
              {t("transfer.importJsonSchemas.done", {
                count:
                  result.imported.length +
                  result.overwritten.length +
                  result.renamed.length,
              })}
            </p>
            <p className="text-muted-foreground">
              {t("transfer.importJsonSchemas.doneBindings", {
                imported: result.bindings_imported,
                disabled: result.bindings_disabled,
              })}
            </p>
          </div>
        )}

        <DialogFooter>
          {step === "done" ? (
            <Button
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void run()}
                disabled={!filePath || busy || step === "pick"}
              >
                {t("transfer.importJsonSchemas.importButton")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

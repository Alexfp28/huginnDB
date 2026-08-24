/**
 * "Export pipeline" — the current pipeline as something to paste elsewhere.
 *
 * Three formats, and the third is the reason this isn't a generic
 * language-picker: `db.createView(…)` is the shape a pipeline takes when it
 * stops being an exploration and becomes part of a deployment script, which is
 * exactly what someone building a view here goes on to need.
 *
 * What is exported is the **normalised** pipeline the backend produced — the
 * enabled stages, re-rendered from BSON — not the working text. So a disabled
 * stage never leaks into a snippet, and what you paste is what would run.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { exportPipeline, type ExportFormat } from "@/lib/mongo/pipeline";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Normalised pipeline text (the array literal), or `null` while it is being
   *  produced / when the pipeline doesn't parse. */
  pipelineText: string | null;
  error?: string | null;
  source: string;
  viewName?: string;
}

export function ExportPipelineDialog({
  open,
  onOpenChange,
  pipelineText,
  error,
  source,
  viewName,
}: Props) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>("shell");
  const [copied, setCopied] = useState(false);

  const snippet =
    pipelineText != null
      ? exportPipeline(format, pipelineText, source, viewName)
      : "";

  function copy() {
    void navigator.clipboard.writeText(snippet);
    setCopied(true);
    notify.success(t("aggregation.export.copied"));
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("aggregation.export.title")}</DialogTitle>
          <DialogDescription>
            {t("aggregation.export.description")}
          </DialogDescription>
        </DialogHeader>

        <Segmented
          value={format}
          onValueChange={setFormat}
          size="sm"
          aria-label={t("aggregation.export.title")}
          options={[
            { value: "shell", label: t("aggregation.export.shell") },
            { value: "json", label: t("aggregation.export.json") },
            { value: "createView", label: t("aggregation.export.createView") },
          ]}
        />

        {error ? (
          <div className="rounded-md bg-destructive/10 p-3 font-mono text-[11px] text-destructive">
            {error}
          </div>
        ) : (
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {snippet || t("aggregation.export.pending")}
          </pre>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={copy} disabled={!snippet}>
            {copied ? (
              <Check className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Copy className="mr-2 h-3.5 w-3.5" />
            )}
            {t("aggregation.export.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

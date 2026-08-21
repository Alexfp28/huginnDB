/**
 * Export selected JSON Schemas to a file.
 *
 * The same checklist shape as `ExportProfilesDialog`, minus the whole passphrase
 * block: a schema carries no secret and no keychain material, so the export is
 * never encrypted and there is nothing for a passphrase to protect.
 *
 * The file itself is written by Rust, which also owns the native save dialog —
 * the same split `exportProfiles` and `exportEnvironments` use, where the
 * frontend calls the command and gets back the path that was written.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/tauri";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isExportCancelled } from "@/lib/db/driver";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  /** Schema ids to pre-check, or `null` for "everything". */
  preselect: string[] | null;
  onClose: () => void;
}

export function ExportJsonSchemasDialog({ open, preselect, onClose }: Props) {
  const { t } = useTranslation();
  const schemas = useJsonSchemas((s) => s.schemas);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeBindings, setIncludeBindings] = useState(true);
  const [busy, setBusy] = useState(false);

  // Re-seed only when the dialog opens, so a click on a checkbox is not undone by
  // the next render (same deliberate dependency list as
  // `ExportEnvironmentDialog`).
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(preselect ?? schemas.map((s) => s.id)));
    setIncludeBindings(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function run() {
    setBusy(true);
    try {
      const path = await api.exportJsonSchemas([...selected], includeBindings);
      toast.success(t("transfer.export.success", { path }));
      onClose();
    } catch (e) {
      // "export cancelled" is the user closing the native dialog, not a failure.
      const message = String(e);
      if (!isExportCancelled(message)) toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("transfer.exportJsonSchemas.title")}</DialogTitle>
          <DialogDescription>
            {t("transfer.exportJsonSchemas.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("jsonSchemas.library.bindingCount", { count: selected.size })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSelected(
                  selected.size === schemas.length
                    ? new Set()
                    : new Set(schemas.map((s) => s.id)),
                )
              }
            >
              {selected.size === schemas.length
                ? t("transfer.export.deselectAll")
                : t("transfer.export.selectAll")}
            </Button>
          </div>

          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {schemas.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs hover:bg-accent/40"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <span className="truncate">{s.name}</span>
              </label>
            ))}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">
                {t("transfer.exportJsonSchemas.includeBindings")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("transfer.exportJsonSchemas.includeBindingsHint")}
              </p>
            </div>
            <Switch
              checked={includeBindings}
              onCheckedChange={setIncludeBindings}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void run()} disabled={selected.size === 0 || busy}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {t("transfer.exportJsonSchemas.exportButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

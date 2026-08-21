/**
 * Dialog for exporting connection profiles to a JSON file.
 *
 * The user can pick which profiles to export, and optionally include
 * encrypted passwords. When passwords are included, a passphrase (with
 * confirmation) is required.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useMultiSelect } from "@/lib/useMultiSelect";
import {
  PassphraseFields,
  passphraseAccepted,
} from "@/components/common/PassphraseFields";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportProfilesDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);

  const allIds = useMemo(() => profiles.map((p) => p.id), [profiles]);
  const { selected, allSelected, toggle, toggleAll, reseed } =
    useMultiSelect(allIds);
  const [includePasswords, setIncludePasswords] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const canExport =
    selected.size > 0 &&
    (!includePasswords || passphraseAccepted(passphrase, passphraseConfirm));

  async function handleExport() {
    if (!canExport) return;
    setLoading(true);
    try {
      const ids: string[] = Array.from(selected);
      const path = await api.exportProfiles(
        allSelected ? null : ids,
        includePasswords,
        includePasswords ? passphrase : undefined,
      );
      toast.success(t("transfer.export.success", { path }));
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      reseed();
      setIncludePasswords(false);
      setPassphrase("");
      setPassphraseConfirm("");
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" />
            {t("transfer.export.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Profile selection list */}
          <div className="space-y-1">
            <div className="flex items-center justify-between pb-1">
              <Label className="text-xs text-muted-foreground">
                {t("transfer.export.profiles")}
              </Label>
              <button
                onClick={toggleAll}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                {allSelected
                  ? t("transfer.export.deselectAll")
                  : t("transfer.export.selectAll")}
              </button>
            </div>
            <div className="rounded-md border border-border divide-y divide-border max-h-48 overflow-y-auto">
              {profiles.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-3.5 w-3.5 rounded accent-primary"
                  />
                  <span className="flex-1 truncate text-xs">{p.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {p.driver}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Include passwords toggle */}
          <div className="flex items-center gap-3">
            <Switch
              id="include-passwords"
              checked={includePasswords}
              onCheckedChange={setIncludePasswords}
            />
            <Label htmlFor="include-passwords" className="cursor-pointer text-xs">
              {t("transfer.export.includePasswords")}
            </Label>
          </div>

          {includePasswords && (
            <PassphraseFields
              passphrase={passphrase}
              confirm={passphraseConfirm}
              onPassphraseChange={setPassphrase}
              onConfirmChange={setPassphraseConfirm}
              idPrefix="export-profiles"
            />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={!canExport || loading}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {loading
              ? t("transfer.export.exporting")
              : t("transfer.export.exportButton", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog for exporting one environment — its cosmetics, the connection
 * profiles it references, and its registered shared origins — to a JSON
 * file. Triggered from `EnvironmentSwitcher`'s per-row menu, so unlike
 * `ExportProfilesDialog` there's no profile picker: the backend resolves
 * which profiles belong to the environment (see
 * `referenced_profile_ids` in `src-tauri/src/commands/prefs.rs`).
 *
 * Tabs, layout and launch state are never included — see the module doc in
 * `src-tauri/src/transfer.rs` for why.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/tauri";
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  /** `null` closes the dialog. */
  environmentId: string | null;
  onClose: () => void;
}

export function ExportEnvironmentDialog({ environmentId, onClose }: Props) {
  const { t } = useTranslation();
  const environments = useEnvironments((s) => s.environments);
  const [includePasswords, setIncludePasswords] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const env = environments.find((e) => e.id === environmentId) ?? null;
  const defaultName = t("environments.defaultName");

  const passphraseError =
    includePasswords && passphrase.length > 0 && passphrase !== passphraseConfirm
      ? t("transfer.export.passphraseMismatch")
      : null;

  const canExport =
    !!env && (!includePasswords || (passphrase.length >= 8 && passphrase === passphraseConfirm));

  async function handleExport() {
    if (!env || !canExport) return;
    setLoading(true);
    try {
      const path = await api.exportEnvironment(
        env.id,
        includePasswords,
        includePasswords ? passphrase : undefined,
      );
      toast.success(t("transfer.export.success", { path }));
      handleOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      setIncludePasswords(false);
      setPassphrase("");
      setPassphraseConfirm("");
      onClose();
    }
  }

  return (
    <Dialog open={!!env} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" />
            {t("transfer.exportEnvironment.title", {
              name: env ? environmentLabel(env, defaultName) : "",
            })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            {t("transfer.exportEnvironment.description")}
          </p>

          {/* Include passwords toggle */}
          <div className="flex items-center gap-3">
            <Switch
              id="export-env-include-passwords"
              checked={includePasswords}
              onCheckedChange={setIncludePasswords}
            />
            <Label htmlFor="export-env-include-passwords" className="cursor-pointer text-xs">
              {t("transfer.export.includePasswords")}
            </Label>
          </div>

          {/* Security warning + passphrase fields */}
          {includePasswords && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/40 px-3 py-2 text-2xs text-warning">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("transfer.export.securityWarning")}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="export-env-passphrase" className="text-xs">
                  {t("transfer.export.passphrase")}
                </Label>
                <PasswordInput
                  id="export-env-passphrase"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={t("transfer.export.passphrasePlaceholder")}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="export-env-passphrase-confirm" className="text-xs">
                  {t("transfer.export.passphraseConfirm")}
                </Label>
                <PasswordInput
                  id="export-env-passphrase-confirm"
                  value={passphraseConfirm}
                  onChange={(e) => setPassphraseConfirm(e.target.value)}
                  placeholder={t("transfer.export.passphraseConfirmPlaceholder")}
                  className="h-8 text-xs"
                />
                {passphraseError && (
                  <p className="text-[11px] text-destructive">{passphraseError}</p>
                )}
              </div>
            </div>
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
          <Button size="sm" onClick={handleExport} disabled={!canExport || loading}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {loading ? t("transfer.export.exporting") : t("transfer.exportEnvironment.exportButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog for exporting one or more environments — each one's cosmetics and
 * registered shared origins, plus a single deduplicated pool of the
 * connection profiles any of them reference — to a single JSON file.
 *
 * Reachable from two places (see `stores/dialogs/environmentTransfer.ts`):
 * File → "Export environments…" (opens with every environment checked, like
 * `ExportProfilesDialog`'s profile picker) and a per-row shortcut in
 * `EnvironmentSwitcher` (opens pre-checking just that one row). Both funnel
 * into this same checklist so a user who started from one row can still
 * widen the selection before exporting.
 *
 * Tabs, layout and launch state are never included — see the module doc in
 * `src-tauri/src/transfer.rs` for why.
 */

import { useEffect, useState } from "react";
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
  open: boolean;
  /** Environment ids to pre-check when the dialog opens. `null`/omitted
   *  pre-checks every environment. */
  preselect: string[] | null;
  onClose: () => void;
}

export function ExportEnvironmentDialog({ open, preselect, onClose }: Props) {
  const { t } = useTranslation();
  const environments = useEnvironments((s) => s.environments);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includePasswords, setIncludePasswords] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const defaultName = t("environments.defaultName");

  // Re-seed the checklist every time the dialog opens, from whatever the
  // trigger asked to pre-select (or everything, for the File-menu entry).
  useEffect(() => {
    if (!open) return;
    setSelected(
      new Set(preselect && preselect.length > 0 ? preselect : environments.map((e) => e.id)),
    );
    // Only re-seed on open, not on every `environments` change — a live
    // switcher update mid-dialog shouldn't reset the user's picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselect]);

  function toggleAll() {
    if (selected.size === environments.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(environments.map((e) => e.id)));
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const passphraseError =
    includePasswords && passphrase.length > 0 && passphrase !== passphraseConfirm
      ? t("transfer.export.passphraseMismatch")
      : null;

  const canExport =
    selected.size > 0 &&
    (!includePasswords || (passphrase.length >= 8 && passphrase === passphraseConfirm));

  async function handleExport() {
    if (!canExport) return;
    setLoading(true);
    try {
      const path = await api.exportEnvironments(
        Array.from(selected),
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" />
            {t("transfer.exportEnvironment.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            {t("transfer.exportEnvironment.description")}
          </p>

          {/* Environment selection list */}
          <div className="space-y-1">
            <div className="flex items-center justify-between pb-1">
              <Label className="text-xs text-muted-foreground">
                {t("transfer.exportEnvironment.environments")}
              </Label>
              <button
                onClick={toggleAll}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                {selected.size === environments.length
                  ? t("transfer.export.deselectAll")
                  : t("transfer.export.selectAll")}
              </button>
            </div>
            <div className="rounded-md border border-border divide-y divide-border max-h-48 overflow-y-auto">
              {environments.map((env) => (
                <label
                  key={env.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(env.id)}
                    onChange={() => toggle(env.id)}
                    className="h-3.5 w-3.5 rounded accent-primary"
                  />
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: env.color || "hsl(var(--muted-foreground))" }}
                  />
                  <span className="flex-1 truncate text-xs">
                    {environmentLabel(env, defaultName)}
                  </span>
                </label>
              ))}
            </div>
          </div>

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
            {loading
              ? t("transfer.export.exporting")
              : t("transfer.exportEnvironment.exportButton", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

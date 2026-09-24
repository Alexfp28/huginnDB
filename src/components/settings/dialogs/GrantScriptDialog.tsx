/**
 * Settings → Policy → "Generate grants": the database permissions a policy
 * role needs on one server, as a script for an administrator to review and
 * run (managed policy phase 3, `policy_generate_grants`). HuginnDB never runs
 * it — the dialog says so, and offers only Copy and Save.
 *
 * The connection is the administrator's own and has to be connected: the
 * backend reads its catalog to expand the rules' patterns into the relations
 * that exist, so the grants can name them.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, KeyRound } from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { copyToClipboard } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import type { GrantScript, PolicyStatus } from "@/types";

export function GrantScriptDialog({
  open,
  onOpenChange,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: PolicyStatus;
}) {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const [role, setRole] = useState(status.role ?? status.roles[0]?.name ?? "");
  // Connected, top-level, and a server with users: the only connections a
  // script can be generated against.
  const candidates = useMemo(
    () =>
      profiles.filter((p) => active.has(p.id) && p.driver !== "sqlite"),
    [profiles, active],
  );
  const [connectionId, setConnectionId] = useState(candidates[0]?.id ?? "");
  const [result, setResult] = useState<GrantScript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.policyGenerateGrants(connectionId, role));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    await copyToClipboard(result.script);
    notify.success(t("settings.policy.grants.copied"));
  }

  async function saveToFile() {
    if (!result) return;
    const js = result.language === "javascript";
    try {
      const path = await saveFileDialog({
        defaultPath: `${result.roleName}.${js ? "js" : "sql"}`,
        filters: [
          js
            ? { name: "JavaScript", extensions: ["js"] }
            : { name: "SQL", extensions: ["sql"] },
        ],
      });
      if (!path) return;
      await api.writeTextFile(path, result.script);
      notify.file(t("notifications.fileSaved.grants"), { path });
    } catch (e) {
      notify.error(String(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="panel" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("settings.policy.grants.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.policy.grants.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("settings.policy.grants.role")}
            </span>
            <NativeSelect
              size="xs"
              aria-label={t("settings.policy.grants.role")}
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setResult(null);
              }}
            >
              {status.roles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.members.length > 0
                    ? t("settings.policy.grants.roleOption", {
                        role: r.name,
                        count: r.members.length,
                      })
                    : r.name}
                </option>
              ))}
            </NativeSelect>
            <span className="text-muted-foreground">
              {t("settings.policy.grants.connection")}
            </span>
            <NativeSelect
              size="xs"
              aria-label={t("settings.policy.grants.connection")}
              value={connectionId}
              disabled={candidates.length === 0}
              onChange={(e) => {
                setConnectionId(e.target.value);
                setResult(null);
              }}
            >
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
            <Button
              size="xs"
              icon={KeyRound}
              loading={busy}
              disabled={!role || !connectionId}
              onClick={() => void generate()}
            >
              {t("settings.policy.grants.generate")}
            </Button>
          </div>
          {candidates.length === 0 && (
            <p className="text-2xs text-muted-foreground">
              {t("settings.policy.grants.noConnection")}
            </p>
          )}
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 font-mono text-2xs text-destructive">
              {error}
            </div>
          )}
          {result && (
            <>
              {result.warnings.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed">
                {result.script}
              </pre>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button
            variant="outline"
            icon={Download}
            disabled={!result}
            onClick={() => void saveToFile()}
          >
            {t("settings.policy.grants.save")}
          </Button>
          <Button icon={Copy} disabled={!result} onClick={() => void copy()}>
            {t("settings.policy.grants.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

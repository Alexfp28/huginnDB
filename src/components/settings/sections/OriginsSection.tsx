/**
 * Settings → Origins: register the shared files HuginnDB pulls connections
 * from (#108), and sync them on demand.
 *
 * Global, unlike most of what touches `tab_state.json`: an origin describes a
 * server-side resource, not a Producción/Staging axis, and what it produces
 * (profiles, whole mirrored environments) is already global — see
 * `commands::origins`'s module doc for why. So this section, unlike its
 * neighbours, is the same regardless of which environment is active.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FolderSync, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { useOriginSync } from "@/stores/sync/originSync";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { VanishedEnvironmentNotice } from "@/components/common/VanishedEnvironmentNotice";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import type { Origin } from "@/types";

export function OriginsSection() {
  const { t } = useTranslation();
  const syncing = useOriginSync((s) => s.syncing);
  const errors = useOriginSync((s) => s.errors);
  const syncAll = useOriginSync((s) => s.syncAll);
  const vanished = useOriginSync((s) => s.vanished);
  const vanishedEnvironments = useOriginSync((s) => s.vanishedEnvironments);
  const noticeOriginRemoved = useOriginSync((s) => s.noticeOriginRemoved);
  const adoptAllVanished = useOriginSync((s) => s.adoptAllVanished);
  const retireAllVanished = useOriginSync((s) => s.retireAllVanished);
  const profiles = useConnections((s) => s.profiles);
  const environments = useEnvironments((s) => s.environments);

  // Derive the id list here rather than in the selector: `Object.keys` returns a
  // fresh array on every call and would re-render forever (gotcha #1).
  const vanishedIds = useMemo(() => Object.keys(vanished), [vanished]);
  const vanishedEnvironmentIds = useMemo(
    () => Object.keys(vanishedEnvironments),
    [vanishedEnvironments],
  );

  const [origins, setOrigins] = useState<Origin[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", path: "", passphrase: "" });
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Origin | null>(null);
  const [removing, setRemoving] = useState(false);
  const [bulkAdopting, setBulkAdopting] = useState(false);
  const [bulkRetireOpen, setBulkRetireOpen] = useState(false);
  const [bulkRetiring, setBulkRetiring] = useState(false);

  // How many connections/environments will be flagged as orphaned if this
  // origin goes — shown in the confirm dialog so "what it published stays"
  // isn't an abstract warning.
  const affectedConnectionCount = useMemo(
    () =>
      pendingRemove
        ? profiles.filter((p) => p.origin_id === pendingRemove.id).length
        : 0,
    [profiles, pendingRemove],
  );
  const affectedEnvironmentCount = useMemo(
    () =>
      pendingRemove
        ? environments.filter((e) => e.originId === pendingRemove.id).length
        : 0,
    [environments, pendingRemove],
  );

  async function reload() {
    try {
      setOrigins(await api.listOrigins());
    } catch {
      // A failure here means the environment couldn't be read; the sync
      // surfaces that far more visibly than an empty list would.
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function performRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      // Raise the vanished-notice *before* the origin is gone: once removed
      // it drops out of `listOrigins()`, and `syncAll()` — the only other
      // place that populates `vanished` — has nothing left to iterate to
      // ever report these as orphaned.
      noticeOriginRemoved(pendingRemove);
      await api.removeOrigin(pendingRemove.id);
      await reload();
      setPendingRemove(null);
    } finally {
      setRemoving(false);
    }
  }

  async function performBulkAdopt() {
    setBulkAdopting(true);
    try {
      await adoptAllVanished();
    } finally {
      setBulkAdopting(false);
    }
  }

  async function performBulkRetire() {
    setBulkRetiring(true);
    try {
      await retireAllVanished();
      setBulkRetireOpen(false);
    } finally {
      setBulkRetiring(false);
    }
  }

  async function submit() {
    if (!draft.path.trim()) return;
    setBusy(true);
    try {
      await api.addOrigin({
        name: draft.name.trim() || draft.path,
        path: draft.path.trim(),
        // Empty means "not encrypted" — nothing is written to the keychain.
        passphrase: draft.passphrase || null,
      });
      setDraft({ name: "", path: "", passphrase: "" });
      setAdding(false);
      await reload();
      // Pull immediately: registering an origin and seeing nothing happen reads
      // as broken, and this is the one moment the user is definitely watching.
      await syncAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t("origins.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("origins.description")}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void syncAll()}
          // Not gated on `origins.length`: `syncAll` also runs the orphan
          // reconciliation sweep (`reconcileOrphans`), which is useful even
          // with zero origins left — e.g. right after removing the last one,
          // before its connections' vanished notice has had a chance to run.
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t("origins.syncNow")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("origins.add")}
        </Button>
      </div>

      {origins.length === 0 && !adding && (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {t("origins.empty")}
        </div>
      )}

      {origins.length > 0 && (
        <div className="divide-y divide-border/60 rounded-md border border-border">
          {origins.map((o) => (
            <div key={o.id} className="flex items-start gap-3 p-3">
              <FolderSync className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{o.name}</div>
                {/* The path is the identifying detail when two origins share a
                    name, and it's what the user checks when a sync fails, so it
                    stays visible rather than living in a tooltip. */}
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {o.path}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {o.lastSyncedAt
                    ? t("origins.lastSynced", {
                        when: new Date(o.lastSyncedAt).toLocaleString(),
                      })
                    : t("origins.neverSynced")}
                </div>
                {errors[o.id] && (
                  <div className="mt-1 break-words text-[11px] text-destructive">
                    {errors[o.id]}
                  </div>
                )}
              </div>
              <button
                className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                title={t("origins.remove")}
                onClick={() => setPendingRemove(o)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The reliable surface for a notice: a vanished connection that isn't
          open never renders a schema tree, so the tree banner alone would leave
          it unresolvable. */}
      {vanishedIds.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("origins.vanished.pending")}
            </h4>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={bulkAdopting || bulkRetiring}
                onClick={() => void performBulkAdopt()}
              >
                {bulkAdopting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t("origins.vanished.keepAll")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={bulkAdopting || bulkRetiring}
                onClick={() => setBulkRetireOpen(true)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t("origins.vanished.retireAll")}
              </Button>
            </div>
          </div>
          {vanishedIds.map((id) => (
            <VanishedOriginNotice
              key={id}
              profileId={id}
              showConnection
              className="mx-0 mt-2"
            />
          ))}
        </div>
      )}

      {vanishedEnvironmentIds.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("origins.vanishedEnvironments.pending")}
          </h4>
          {vanishedEnvironmentIds.map((id) => (
            <VanishedEnvironmentNotice
              key={id}
              environmentId={id}
              className="mx-0 mt-2"
            />
          ))}
        </div>
      )}

      {adding && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            autoFocus
            placeholder={t("origins.pathPlaceholder")}
            value={draft.path}
            onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))}
          />
          <Input
            placeholder={t("origins.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <PasswordInput
            placeholder={t("origins.passphrasePlaceholder")}
            value={draft.passphrase}
            onChange={(e) =>
              setDraft((d) => ({ ...d, passphrase: e.target.value }))
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {t("origins.passphraseHint")}
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={busy || !draft.path.trim()} onClick={() => void submit()}>
              {busy ? t("origins.adding") : t("common.save")}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title={t("origins.removeConfirmTitle", { name: pendingRemove?.name ?? "" })}
        description={
          <div className="space-y-1">
            <p>{t("origins.removeConfirmPassphraseNote")}</p>
            {affectedConnectionCount === 0 && affectedEnvironmentCount === 0 && (
              <p>{t("origins.removeConfirmNothingNote")}</p>
            )}
            {affectedConnectionCount > 0 && (
              <p>
                {t("origins.removeConfirmConnectionsNote", {
                  count: affectedConnectionCount,
                })}
              </p>
            )}
            {affectedEnvironmentCount > 0 && (
              <p>
                {t("origins.removeConfirmEnvironmentsNote", {
                  count: affectedEnvironmentCount,
                })}
              </p>
            )}
          </div>
        }
        confirmLabel={t("origins.remove")}
        confirming={removing}
        onConfirm={() => void performRemove()}
      />

      <ConfirmDialog
        open={bulkRetireOpen}
        onOpenChange={(open) => !open && setBulkRetireOpen(false)}
        title={t("origins.vanished.retireAllConfirmTitle", {
          count: vanishedIds.length,
        })}
        description={<p>{t("origins.vanished.retireAllConfirm")}</p>}
        confirmLabel={t("origins.vanished.retireAll")}
        confirming={bulkRetiring}
        onConfirm={() => void performBulkRetire()}
      />
    </div>
  );
}

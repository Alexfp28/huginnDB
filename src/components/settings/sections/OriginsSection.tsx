/**
 * Settings → Origins: register the shared files this environment pulls
 * connections from (#108), and sync them on demand.
 *
 * Scoped to the **active environment**, like everything that touches
 * `tab_state.json`. The heading says so, because otherwise "why did my origins
 * disappear" has a confusing answer (you switched environment).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderSync, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { useOriginSync } from "@/stores/sync/originSync";
import { VanishedOriginNotice } from "@/components/common/VanishedOriginNotice";
import { confirmIrreversible } from "@/lib/confirmDestructive";
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

  // Derive the id list here rather than in the selector: `Object.keys` returns a
  // fresh array on every call and would re-render forever (gotcha #1).
  const vanishedIds = useMemo(() => Object.keys(vanished), [vanished]);

  const [origins, setOrigins] = useState<Origin[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", path: "", passphrase: "" });
  const [busy, setBusy] = useState(false);

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
          disabled={syncing || origins.length === 0}
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
                onClick={() => {
                  // Irreversible: the stored passphrase goes with it. The
                  // imported connections deliberately stay — see `remove_origin`.
                  if (confirmIrreversible(t("origins.removeConfirm", { name: o.name }))) {
                    void api.removeOrigin(o.id).then(reload);
                  }
                }}
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
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("origins.vanished.pending")}
          </h4>
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
    </div>
  );
}

/**
 * The shared-origin document editor (#155).
 *
 * A full-screen surface, mounted as a **sibling** of `SettingsDialog` rather
 * than inside it: opening it closes Settings (`useOriginEditor.open`), so there
 * is never a dialog trapping focus on top of another one.
 *
 * The draft lives here, in local state, and that is the feature's first
 * invariant: it is a *document* being composed, never this machine's own state.
 * Nothing in this tree reads from or writes to `profiles.json`,
 * `tab_state.json` or `json_schemas.json` — the local profile list and schema
 * library are read only to offer rows to copy *into* the document, and saving
 * changes nothing locally.
 *
 * Two behaviours are worth knowing before editing this file.
 *
 * **`pristine` is kept for the whole session.** A `keep` secret slot carries
 * ciphertext this editor cannot reproduce (it has no passphrase and no
 * plaintext), so switching a connection away from `keep` and back has to
 * *restore* the envelope rather than rebuild it. Losing it would silently
 * re-encrypt that connection on the next save and charge every consumer ~600 000
 * PBKDF2 rounds for a click that was meant to be reversible.
 *
 * **A save can come back as a conflict.** Somebody else publishing while this
 * was open is not an error: the backend re-hashes the file, refuses, and hands
 * back the newer document. The editor goes "stale" and offers to reload, showing
 * what moved, instead of overwriting a colleague.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cable, FileJson, Layers, Send } from "lucide-react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/tauri";
import {
  withPublishProgress,
  type PublishProgress,
} from "@/lib/bridges/origin-progress-bridge";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { useConnections } from "@/stores/session/connections";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { useOrigins } from "@/stores/sync/origins";
import { useOriginSync } from "@/stores/sync/originSync";
import { OriginEditorHeader } from "@/components/origins/OriginEditorHeader";
import { PublishConfirmDialog } from "@/components/origins/dialogs/PublishConfirmDialog";
import { ConnectionsPane } from "@/components/origins/sections/ConnectionsPane";
import { EnvironmentsPane } from "@/components/origins/sections/EnvironmentsPane";
import { SchemasPane } from "@/components/origins/sections/SchemasPane";
import {
  PublishPane,
  passphraseReady,
  type PassphraseState,
} from "@/components/origins/sections/PublishPane";
import type {
  OriginDocument,
  OriginDraft,
  OriginDraftEnvironment,
  OriginPublishImpact,
} from "@/types";

const PANES = [
  { id: "connections", icon: Cable },
  { id: "environments", icon: Layers },
  { id: "schemas", icon: FileJson },
  { id: "publish", icon: Send },
] as const;

type PaneId = (typeof PANES)[number]["id"];

const NO_PASSPHRASE: PassphraseState = {
  value: "",
  confirm: "",
  rotateFrom: "",
  rotating: false,
};

export function OriginEditorOverlay() {
  const { t } = useTranslation();
  const originId = useOriginEditor((s) => s.originId);
  const close = useOriginEditor((s) => s.close);
  const loadOrigins = useOrigins((s) => s.load);
  const syncAllOrigins = useOriginSync((s) => s.syncAll);
  const profiles = useConnections((s) => s.profiles);
  const library = useJsonSchemas((s) => s.schemas);
  const bindings = useJsonSchemas((s) => s.bindings);

  const [doc, setDoc] = useState<OriginDocument | null>(null);
  // This machine's environments, offered as bundles to copy in. Fetched once
  // per opened document rather than read from `useEnvironments`, because
  // membership has to be resolved by the same helper the export uses — the
  // frontend store holds no `launch` state for an environment it is not in.
  const [localEnvironments, setLocalEnvironments] = useState<
    OriginDraftEnvironment[]
  >([]);
  const [draft, setDraft] = useState<OriginDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pane, setPane] = useState<PaneId>("connections");
  const [impact, setImpact] = useState<OriginPublishImpact | null>(null);
  const [passphrase, setPassphrase] = useState<PassphraseState>(NO_PASSPHRASE);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<PublishProgress | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const open = !!originId;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await api.openOriginDocument(id);
      setDoc(loaded);
      // Best effort: not being able to list them costs the import dropdown,
      // not the document.
      api
        .listPublishableEnvironments()
        .then(setLocalEnvironments)
        .catch(() => setLocalEnvironments([]));
      setDraft(loaded.draft);
      setStale(false);
      setImpact(null);
      setPassphrase(NO_PASSPHRASE);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!originId) {
      setDoc(null);
      setDraft(null);
      setPane("connections");
      return;
    }
    void load(originId);
  }, [originId, load]);

  // `doc.draft` is the pristine copy: the only place a `keep` envelope lives,
  // and what Discard resets to. See the module doc.
  const pristine = doc?.draft ?? null;

  const dirty = useMemo(() => {
    if (!draft || !pristine) return false;
    return JSON.stringify(draft) !== JSON.stringify(pristine);
  }, [draft, pristine]);

  const readOnly =
    !doc || doc.role !== "publisher" || !doc.writable.writable || loading;

  // A slot that has to be encrypted at save time is the only thing that makes
  // the passphrase mandatory; a document of verbatim envelopes needs none.
  const passphraseNeeded = useMemo(
    () => !!draft?.connections.some((c) => c.secret.kind === "fromKeychain"),
    [draft],
  );

  // Debounced because it is an IPC round trip that re-reads the file; cheap
  // because it neither decrypts nor writes. Same 400 ms the structure and view
  // editors use.
  const refreshImpact = useCallback(() => {
    if (!originId || !draft) return;
    void api
      .previewOriginPublish(originId, draft)
      .then(setImpact)
      .catch(() => setImpact(null));
  }, [originId, draft]);
  useDebouncedPreview(draft, refreshImpact);

  function performSave() {
    if (!originId || !draft || !doc) return;
    setSaving(true);
    setSaveError(null);
    // The bar only appears if the backend has something slow to report —
    // resolving a secret from the keychain, or re-keying one during a rotation.
    // A publish of verbatim envelopes emits nothing and finishes on the
    // button's spinner alone.
    void withPublishProgress(setProgress, () =>
      api.saveOriginDocument({
        originId,
        draft,
        base: doc.base,
        passphrase: passphrase.value || null,
        rotateFrom: passphrase.rotating ? passphrase.rotateFrom : null,
      }),
    )
      .then(async (outcome) => {
        if (outcome.status === "conflict") {
          // Not an error: their revision is newer than ours. Show the document
          // as it now stands and let the user decide, rather than overwriting.
          setDoc(outcome.document);
          setStale(true);
          setConfirming(false);
          return;
        }
        setConfirming(false);
        // Re-read what was just written rather than re-anchoring on the draft
        // in hand, and the reason is invariant 3. A slot the backend resolved
        // from the keychain is still spelled `fromKeychain` in *this* draft:
        // keeping it would re-encrypt that password on the very next save —
        // fresh salt, fresh nonce — and charge every consumer ~600 000 PBKDF2
        // rounds for it, because somebody renamed an environment afterwards.
        // Reloading turns every published secret back into a verbatim `keep`,
        // which is what it now is on disk, and brings the new base hash with
        // it.
        await load(originId);
        // The registry caches `maintainer`; the backend's event refreshes it
        // too, but awaiting it keeps the Settings row in step with the header.
        await loadOrigins();
        // Publishing never touches local state on its own (invariant 1 in
        // this module's doc) — without this, the publisher's own machine
        // wouldn't see a newly-added connection turn origin-linked, or a
        // removed one turn `vanished`, until the next launch or a manual
        // "Sync now". Same entry point that button uses; every registered
        // origin gets swept, not just this one, but a 4-hourly-interval sync
        // is cheap enough that doing it here costs nothing extra.
        await syncAllOrigins();
      })
      .catch((e: unknown) => setSaveError(String(e)))
      .finally(() => setSaving(false));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="flex h-[92vh] max-w-[min(1400px,95vw)] flex-col gap-0 overflow-hidden p-0">
        {loading && !doc ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="lg" className="text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-destructive">
            {loadError}
          </div>
        ) : doc && draft ? (
          <>
            <OriginEditorHeader
              doc={doc}
              readOnly={readOnly}
              dirty={dirty}
              stale={stale}
              revision={doc.base.revision}
              saving={saving}
              onSave={() => {
                setSaveError(null);
                // A missing passphrase is not something to discover inside the
                // confirmation, where the only thing to do about it is cancel.
                // Send the user to the pane that has the fields instead; it is
                // the one that can explain what is wanted.
                if (!passphraseReady(passphrase, passphraseNeeded)) {
                  setPane("publish");
                  return;
                }
                setConfirming(true);
              }}
              onDiscard={() => {
                setDraft(doc.draft);
                setPassphrase(NO_PASSPHRASE);
              }}
              onReload={() => void load(doc.originId)}
            />

            <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] overflow-hidden">
              <aside className="overflow-y-auto border-r border-border bg-card/40 py-1">
                {PANES.map((p) => {
                  const Icon = p.icon;
                  const active = p.id === pane;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setPane(p.id)}
                      className={cn(
                        "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left",
                        active
                          ? "border-primary bg-accent/40"
                          : "border-transparent hover:bg-accent",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="flex flex-1 flex-col leading-tight">
                        <span className="text-sm">
                          {t(`originEditor.panes.${p.id}.label`)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {t(`originEditor.panes.${p.id}.desc`)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </aside>

              <main className="flex min-h-0 flex-col overflow-hidden px-5 py-4">
                {pane === "connections" && pristine && (
                  <ConnectionsPane
                    draft={draft}
                    pristine={pristine}
                    profiles={profiles}
                    readOnly={readOnly}
                    onChange={setDraft}
                  />
                )}
                {pane === "environments" && (
                  <EnvironmentsPane
                    draft={draft}
                    local={localEnvironments}
                    profiles={profiles}
                    readOnly={readOnly}
                    onChange={setDraft}
                  />
                )}
                {pane === "schemas" && (
                  <SchemasPane
                    draft={draft}
                    library={library}
                    bindings={bindings}
                    readOnly={readOnly}
                    onChange={setDraft}
                  />
                )}
                {pane === "publish" && (
                  <PublishPane
                    draft={draft}
                    impact={impact}
                    passphrase={passphrase}
                    passphraseNeeded={passphraseNeeded}
                    hasStoredPassphrase={doc.hasPassphrase}
                    readOnly={readOnly}
                    onChange={setDraft}
                    onPassphraseChange={setPassphrase}
                  />
                )}
              </main>
            </div>

            <PublishConfirmDialog
              open={confirming}
              onOpenChange={(next) => !next && setConfirming(false)}
              impact={impact}
              path={doc.path}
              revision={doc.base.revision + 1}
              saving={saving}
              progress={progress}
              error={saveError}
              onConfirm={performSave}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

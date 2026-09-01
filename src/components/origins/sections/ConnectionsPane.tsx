/**
 * Which connections the document publishes, and how each one's password travels.
 *
 * Two columns, because the two sides are genuinely different collections: the
 * left is `profiles.json` on *this* machine, the right is the document. Nothing
 * here reads or writes the left one — moving a row across copies the profile
 * into the draft (keeping its id, which is what lets a publisher consume their
 * own origin without duplicating every server) and moving it back drops it from
 * the draft only.
 *
 * The secret control is the part worth reading twice. Its three states are not
 * cosmetic:
 *
 * * **keep** — the envelope exactly as it came out of the file. Free for every
 *   consumer, because `already_landed` recognises the ciphertext they have
 *   already decrypted. Only offered for a connection the file already carried a
 *   secret for; there is nothing to keep otherwise.
 * * **from keychain** — resolved and encrypted at save time. Always a fresh salt
 *   and nonce, so every consumer re-derives that slot's key (~600 000 PBKDF2
 *   rounds each) on their next sync.
 * * **clear** — publish nothing; the consumer is asked for the password.
 *
 * Leaving `keep` is therefore a cost, and returning to it has to be possible —
 * which is why the pristine draft is passed in: `keep` is restored from it
 * rather than reconstructed, because the envelope cannot be rebuilt from
 * anything the editor holds.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Lock, Unlock } from "lucide-react";

import { DriverBadge } from "@/components/common/DriverBadge";
import {
  TransferList,
  type TransferItem,
} from "@/components/origins/TransferList";
import type {
  ConnectionProfile,
  OriginDraft,
  OriginDraftConnection,
  OriginSecretSlot,
} from "@/types";

/** The order the control cycles through, longest first. `keep` is only in it
 *  when the pristine document actually has an envelope to go back to. */
function cycle(
  current: OriginSecretSlot["kind"],
  canKeep: boolean,
): OriginSecretSlot["kind"] {
  const states: OriginSecretSlot["kind"][] = canKeep
    ? ["keep", "fromKeychain", "clear"]
    : ["fromKeychain", "clear"];
  const index = states.indexOf(current);
  return states[(index + 1) % states.length];
}

const SLOT_ICON = {
  keep: Lock,
  fromKeychain: KeyRound,
  clear: Unlock,
} as const;

export function ConnectionsPane({
  draft,
  pristine,
  profiles,
  readOnly,
  onChange,
}: {
  draft: OriginDraft;
  /** The document as it was loaded — the only place a `keep` envelope exists. */
  pristine: OriginDraft;
  /** This machine's own profiles, for the left column. */
  profiles: ConnectionProfile[];
  readOnly: boolean;
  onChange: (next: OriginDraft) => void;
}) {
  const { t } = useTranslation();

  const inDocument = useMemo(
    () => new Set(draft.connections.map((c) => c.id)),
    [draft.connections],
  );
  const byId = useMemo(() => {
    const map = new Map<string, OriginDraftConnection>();
    for (const c of draft.connections) map.set(c.id, c);
    return map;
  }, [draft.connections]);
  const localById = useMemo(() => {
    const map = new Map<string, ConnectionProfile>();
    for (const p of profiles) map.set(p.id, p);
    return map;
  }, [profiles]);
  const pristineById = useMemo(() => {
    const map = new Map<string, OriginSecretSlot>();
    for (const c of pristine.connections) map.set(c.id, c.secret);
    return map;
  }, [pristine.connections]);

  /** Which environments list a connection — the chips on a right-hand row. */
  const environmentsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const env of draft.environments) {
      for (const id of env.connectionIds) {
        map.set(id, [
          ...(map.get(id) ?? []),
          env.name || t("environments.defaultName"),
        ]);
      }
    }
    return map;
  }, [draft.environments, t]);

  const left: TransferItem[] = useMemo(
    () =>
      profiles
        .filter((p) => !inDocument.has(p.id) && !p.ephemeral)
        .map((p) => ({
          id: p.id,
          haystack:
            `${p.name} ${p.host} ${p.database} ${p.group ?? ""}`.toLowerCase(),
        })),
    [profiles, inDocument],
  );

  // Loose connections first: they are the ones most likely to be an oversight,
  // and `membership().unassigned` is what the publish preview will call them.
  const right: TransferItem[] = useMemo(() => {
    const items = draft.connections.map((c) => ({
      id: c.id,
      haystack: `${c.name} ${c.host} ${c.database}`.toLowerCase(),
      loose: !environmentsOf.has(c.id),
    }));
    return [
      ...items.filter((i) => i.loose),
      ...items.filter((i) => !i.loose),
    ].map(({ id, haystack }) => ({ id, haystack }));
  }, [draft.connections, environmentsOf]);

  function add(ids: string[]) {
    if (readOnly) return;
    const additions = ids
      .map((id) => localById.get(id))
      .filter((p): p is ConnectionProfile => !!p)
      .map((p) => ({
        ...p,
        // A connection added from this machine defaults to publishing its
        // password: it is what the publisher almost always means, and the
        // control right next to it says so and can be switched to `clear`
        // before the first save. The alternative default ships a connection
        // nobody can open.
        secret: (pristineById.get(p.id) ?? {
          kind: "fromKeychain",
        }) as OriginSecretSlot,
      }));
    onChange({ ...draft, connections: [...draft.connections, ...additions] });
  }

  function remove(ids: string[]) {
    if (readOnly) return;
    const dropped = new Set(ids);
    onChange({
      ...draft,
      connections: draft.connections.filter((c) => !dropped.has(c.id)),
      // Drop the membership too. Leaving it behind is representable (the
      // consumer ignores a stale `visibleConnections` entry) and the preview
      // reports it as dangling, but a removal the user asked for should not
      // need a second cleanup step.
      environments: draft.environments.map((env) => ({
        ...env,
        connectionIds: env.connectionIds.filter((id) => !dropped.has(id)),
      })),
    });
  }

  function cycleSecret(id: string) {
    if (readOnly) return;
    onChange({
      ...draft,
      connections: draft.connections.map((c) => {
        if (c.id !== id) return c;
        const canKeep = pristineById.get(id)?.kind === "keep";
        const next = cycle(c.secret.kind, canKeep);
        if (next === "keep") {
          // Restored, never rebuilt: the envelope is ciphertext this editor
          // cannot produce without the passphrase.
          const original = pristineById.get(id);
          return original ? { ...c, secret: original } : c;
        }
        return { ...c, secret: { kind: next } as OriginSecretSlot };
      }),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">
        {t("originEditor.connections.hint")}
      </p>
      <TransferList
        leftTitle={t("originEditor.connections.local")}
        rightTitle={t("originEditor.connections.inFile")}
        left={left}
        right={right}
        onAdd={add}
        onRemove={remove}
        leftEmpty={t("originEditor.connections.localEmpty")}
        rightEmpty={t("originEditor.connections.inFileEmpty")}
        renderLeft={(id) => {
          const p = localById.get(id);
          if (!p) return null;
          return (
            <div className="flex min-w-0 items-center gap-2">
              <DriverBadge driver={p.driver} />
              <span className="truncate text-xs">{p.name}</span>
              {p.group && (
                <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                  {p.group}
                </span>
              )}
            </div>
          );
        }}
        renderRight={(id) => {
          const c = byId.get(id);
          if (!c) return null;
          const envs = environmentsOf.get(id);
          const Icon = SLOT_ICON[c.secret.kind];
          return (
            <div className="flex min-w-0 items-center gap-2">
              <DriverBadge driver={c.driver} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{c.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {envs?.length
                    ? envs.join(" · ")
                    : t("originEditor.connections.unassigned")}
                </div>
              </div>
              <button
                type="button"
                disabled={readOnly}
                title={t(`originEditor.secret.${c.secret.kind}`)}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={(e) => {
                  // The row is a <label>: without this the click also toggles
                  // the checkbox it wraps.
                  e.preventDefault();
                  e.stopPropagation();
                  cycleSecret(id);
                }}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {(["keep", "fromKeychain", "clear"] as const).map((kind) => {
          const Icon = SLOT_ICON[kind];
          return (
            <span key={kind} className="inline-flex items-center gap-1">
              <Icon className="h-3 w-3" />
              {t(`originEditor.secret.${kind}`)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

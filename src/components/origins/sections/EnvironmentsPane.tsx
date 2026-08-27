/**
 * The environments the document publishes: cosmetics on the left, membership on
 * the right.
 *
 * `sourceEnvironmentId` is the one field with no input. It is the identity
 * `sync_origin` matches a bundle against its local mirror with
 * (`Environment.origin_source_id`), so an environment that came out of the file
 * keeps the id it arrived with, for as long as it exists. Regenerating one makes
 * every consumer see that environment *disappear* and a different one arrive —
 * losing the tabs, layout and filters they had in it — which is why a new id is
 * minted in exactly one place here: creating an environment that never existed.
 *
 * Membership writes `connectionIds`, which the consumer's sync resolves into
 * that mirror's `launch.visible_connections`. It is a *filter*, not ownership:
 * every profile in the file lands in the consumer's global pool either way, so a
 * connection in no environment is loose, not excluded.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { DriverBadge } from "@/components/common/DriverBadge";
import type {
  ConnectionProfile,
  OriginDraft,
  OriginDraftConnection,
  OriginDraftEnvironment,
} from "@/types";

export function EnvironmentsPane({
  draft,
  local,
  profiles,
  readOnly,
  onChange,
}: {
  draft: OriginDraft;
  /** This machine's own environments, as bundles ready to be copied in. */
  local: OriginDraftEnvironment[];
  /** This machine's profiles, so importing an environment can bring the
   *  connections it references along with it. */
  profiles: ConnectionProfile[];
  readOnly: boolean;
  onChange: (next: OriginDraft) => void;
}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(
    draft.environments[0]?.sourceEnvironmentId ?? null,
  );

  const active = useMemo(
    () =>
      draft.environments.find((e) => e.sourceEnvironmentId === activeId) ?? null,
    [draft.environments, activeId],
  );

  function patch(id: string, changes: Partial<OriginDraftEnvironment>) {
    if (readOnly) return;
    onChange({
      ...draft,
      environments: draft.environments.map((e) =>
        e.sourceEnvironmentId === id ? { ...e, ...changes } : e,
      ),
    });
  }

  /** This machine's environments the document does not already carry. */
  const importable = useMemo(() => {
    const present = new Set(
      draft.environments.map((e) => e.sourceEnvironmentId),
    );
    return local.filter((e) => !present.has(e.sourceEnvironmentId));
  }, [local, draft.environments]);

  /**
   * Copy one of this machine's environments into the document, with the
   * connections it references.
   *
   * Two details are load-bearing. Its `sourceEnvironmentId` is the local
   * `Environment.id` the backend stamped, **not** a fresh uuid — that id is
   * what a consumer's sync will match this bundle by from now on, so minting
   * one here would make re-importing the same environment publish a second,
   * unrelated one. And the connections come across too: an environment whose
   * membership names ids the document does not carry is published as a filter
   * over nothing.
   */
  function importEnvironment(env: OriginDraftEnvironment) {
    if (readOnly) return;
    const present = new Set(draft.connections.map((c) => c.id));
    const additions: OriginDraftConnection[] = env.connectionIds
      .filter((id) => !present.has(id))
      .map((id) => profiles.find((p) => p.id === id))
      .filter((p): p is ConnectionProfile => !!p)
      .map((p) => ({ ...p, secret: { kind: "fromKeychain" } }));
    onChange({
      ...draft,
      environments: [...draft.environments, env],
      connections: [...draft.connections, ...additions],
    });
    setActiveId(env.sourceEnvironmentId);
  }

  function addEnvironment() {
    if (readOnly) return;
    // The only place an id is minted. See the module doc: doing this to an
    // existing environment is a disappearance for every consumer.
    const sourceEnvironmentId = crypto.randomUUID();
    onChange({
      ...draft,
      environments: [
        ...draft.environments,
        {
          sourceEnvironmentId,
          name: "",
          color: null,
          icon: null,
          themeId: null,
          connectionIds: [],
          origins: [],
        },
      ],
    });
    setActiveId(sourceEnvironmentId);
  }

  function removeEnvironment(id: string) {
    if (readOnly) return;
    onChange({
      ...draft,
      environments: draft.environments.filter(
        (e) => e.sourceEnvironmentId !== id,
      ),
    });
    if (activeId === id) setActiveId(null);
  }

  function toggleMember(id: string, connectionId: string) {
    const env = draft.environments.find((e) => e.sourceEnvironmentId === id);
    if (!env) return;
    const has = env.connectionIds.includes(connectionId);
    patch(id, {
      connectionIds: has
        ? env.connectionIds.filter((c) => c !== connectionId)
        : [...env.connectionIds, connectionId],
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {t("originEditor.environments.hint")}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || importable.length === 0}
                title={
                  importable.length === 0
                    ? t("originEditor.environments.importNone")
                    : undefined
                }
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("originEditor.environments.import")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {importable.map((env) => (
                <DropdownMenuItem
                  key={env.sourceEnvironmentId}
                  onSelect={() => importEnvironment(env)}
                >
                  <span
                    aria-hidden
                    className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-border"
                    style={{ background: env.color ?? "transparent" }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {env.name || t("environments.defaultName")}
                  </span>
                  <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                    {t("originEditor.environments.importCount", {
                      count: env.connectionIds.length,
                    })}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly}
            onClick={addEnvironment}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("originEditor.environments.add")}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-2">
        <div className="min-h-0 overflow-y-auto rounded-md border border-border">
          {draft.environments.length === 0 ? (
            <p className="p-3 text-center text-[11px] text-muted-foreground">
              {importable.length > 0
                ? t("originEditor.environments.emptyWithLocal")
                : t("originEditor.environments.empty")}
            </p>
          ) : (
            draft.environments.map((env) => {
              const selected = env.sourceEnvironmentId === activeId;
              return (
                <button
                  key={env.sourceEnvironmentId}
                  onClick={() => setActiveId(env.sourceEnvironmentId)}
                  className={`flex w-full items-center gap-2 border-l-2 px-2.5 py-2 text-left ${
                    selected
                      ? "border-primary bg-accent/40"
                      : "border-transparent hover:bg-accent/30"
                  }`}
                >
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-border"
                    style={{ background: env.color ?? "transparent" }}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {env.name || t("environments.defaultName")}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {env.connectionIds.length}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="min-h-0 overflow-y-auto rounded-md border border-border p-3">
          {!active ? (
            <p className="text-center text-[11px] text-muted-foreground">
              {t("originEditor.environments.pick")}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">
                    {t("originEditor.environments.name")}
                  </span>
                  <Input
                    className="mt-1 h-8 text-xs"
                    disabled={readOnly}
                    placeholder={t("environments.defaultName")}
                    value={active.name}
                    onChange={(e) =>
                      patch(active.sourceEnvironmentId, {
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={readOnly}
                  onClick={() => removeEnvironment(active.sourceEnvironmentId)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("originEditor.environments.remove")}
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">
                    {t("originEditor.environments.color")}
                  </span>
                  <Input
                    className="mt-1 h-8 text-xs"
                    disabled={readOnly}
                    placeholder="#2563eb"
                    value={active.color ?? ""}
                    onChange={(e) =>
                      patch(active.sourceEnvironmentId, {
                        color: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">
                    {t("originEditor.environments.icon")}
                  </span>
                  <Input
                    className="mt-1 h-8 text-xs"
                    disabled={readOnly}
                    value={active.icon ?? ""}
                    onChange={(e) =>
                      patch(active.sourceEnvironmentId, {
                        icon: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">
                    {t("originEditor.environments.theme")}
                  </span>
                  <Input
                    className="mt-1 h-8 text-xs"
                    disabled={readOnly}
                    value={active.themeId ?? ""}
                    onChange={(e) =>
                      patch(active.sourceEnvironmentId, {
                        themeId: e.target.value || null,
                      })
                    }
                  />
                </label>
              </div>
              {/* Stored opaquely by the backend, exactly like a local
                  environment's: a theme id the consumer does not have falls
                  back to their default rather than failing. */}
              <p className="text-[10px] text-muted-foreground">
                {t("originEditor.environments.cosmeticsHint")}
              </p>

              <div>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold">
                    {t("originEditor.environments.members")}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {t("originEditor.environments.membersHint")}
                  </span>
                </div>
                {draft.connections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground">
                    {t("originEditor.environments.noConnections")}
                  </p>
                ) : (
                  <div className="divide-y divide-border/60 rounded-md border border-border">
                    {draft.connections.map((c) => (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-accent/30"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0 rounded accent-primary"
                          disabled={readOnly}
                          checked={active.connectionIds.includes(c.id)}
                          onChange={() =>
                            toggleMember(active.sourceEnvironmentId, c.id)
                          }
                        />
                        <DriverBadge driver={c.driver} />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {c.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

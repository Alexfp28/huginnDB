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
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DriverBadge } from "@/components/common/DriverBadge";
import type { OriginDraft, OriginDraftEnvironment } from "@/types";

export function EnvironmentsPane({
  draft,
  readOnly,
  onChange,
}: {
  draft: OriginDraft;
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

      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-2">
        <div className="min-h-0 overflow-y-auto rounded-md border border-border">
          {draft.environments.length === 0 ? (
            <p className="p-3 text-center text-[11px] text-muted-foreground">
              {t("originEditor.environments.empty")}
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

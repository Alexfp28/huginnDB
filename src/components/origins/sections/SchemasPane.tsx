/**
 * The JSON Schema library slice the document carries, and the bindings that go
 * with it.
 *
 * Schemas are **global**, not owned by an environment (`crate::json_schemas`),
 * so this is not part of an environment's portable identity the way its
 * connections are — it rides along so one file can set a whole machine up. That
 * is also why the checklist is over the local library rather than a transfer
 * list: there is no "which environment does this belong to" question to answer.
 *
 * Bindings follow their schema. A binding whose schema is unticked would arrive
 * pointing at nothing, so they are grouped under it and travel together — with
 * the exception the pane has to say out loud: a binding pinned to a
 * `connectionId` the document does not carry lands **disabled** on every
 * consumer, because widening it to a wildcard would change what the rule means
 * and dropping it would lose the intent with no way to notice.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

import type { JsonSchemaBinding, JsonSchemaEntry, OriginDraft } from "@/types";

/** How a binding reads in one line: the axes it pins, most specific first. */
function bindingLabel(b: JsonSchemaBinding): string {
  return [b.dbSchema, b.table, b.column].filter(Boolean).join(" · ");
}

export function SchemasPane({
  draft,
  library,
  bindings,
  readOnly,
  onChange,
}: {
  draft: OriginDraft;
  /** This machine's schema library. */
  library: JsonSchemaEntry[];
  /** This machine's bindings. */
  bindings: JsonSchemaBinding[];
  readOnly: boolean;
  onChange: (next: OriginDraft) => void;
}) {
  const { t } = useTranslation();

  // The union of what is local and what the document already carries: a schema
  // published by somebody else is editable here even if this machine never
  // imported it, and it must not silently vanish because it is missing from the
  // local library.
  const all = useMemo(() => {
    const map = new Map<string, JsonSchemaEntry>();
    for (const s of library) map.set(s.id, s);
    for (const s of draft.schemas) if (!map.has(s.id)) map.set(s.id, s);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [library, draft.schemas]);

  const included = useMemo(
    () => new Set(draft.schemas.map((s) => s.id)),
    [draft.schemas],
  );
  const documentConnections = useMemo(
    () => new Set(draft.connections.map((c) => c.id)),
    [draft.connections],
  );

  /** Every binding that could travel with a schema: the local ones plus the
   *  document's own, deduplicated by id. */
  const bindingsOf = useMemo(() => {
    const map = new Map<string, JsonSchemaBinding[]>();
    const seen = new Set<string>();
    for (const b of [...bindings, ...draft.bindings]) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      map.set(b.schemaId, [...(map.get(b.schemaId) ?? []), b]);
    }
    return map;
  }, [bindings, draft.bindings]);

  function toggle(schema: JsonSchemaEntry) {
    if (readOnly) return;
    if (included.has(schema.id)) {
      onChange({
        ...draft,
        schemas: draft.schemas.filter((s) => s.id !== schema.id),
        // A binding without its schema resolves to nothing, so it leaves with
        // it rather than being published as a dangling rule.
        bindings: draft.bindings.filter((b) => b.schemaId !== schema.id),
      });
      return;
    }
    onChange({
      ...draft,
      schemas: [...draft.schemas, schema],
      bindings: [...draft.bindings, ...(bindingsOf.get(schema.id) ?? [])],
    });
  }

  function toggleBinding(binding: JsonSchemaBinding) {
    if (readOnly) return;
    const present = draft.bindings.some((b) => b.id === binding.id);
    onChange({
      ...draft,
      bindings: present
        ? draft.bindings.filter((b) => b.id !== binding.id)
        : [...draft.bindings, binding],
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">
        {t("originEditor.schemas.hint")}
      </p>
      {all.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {t("originEditor.schemas.empty")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
          {all.map((schema) => {
            const on = included.has(schema.id);
            const rules = bindingsOf.get(schema.id) ?? [];
            return (
              <div key={schema.id} className="p-2.5">
                <label className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    disabled={readOnly}
                    checked={on}
                    onChange={() => toggle(schema)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{schema.name}</div>
                    {schema.description && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {schema.description}
                      </div>
                    )}
                  </div>
                </label>

                {on && rules.length > 0 && (
                  <div className="ml-6 mt-1.5 space-y-1">
                    {rules.map((b) => {
                      const orphaned =
                        !!b.connectionId &&
                        !documentConnections.has(b.connectionId);
                      return (
                        <label
                          key={b.id}
                          className="flex cursor-pointer items-center gap-2"
                        >
                          <Checkbox
                            size="xs"
                            disabled={readOnly}
                            checked={draft.bindings.some((x) => x.id === b.id)}
                            onChange={() => toggleBinding(b)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                            {bindingLabel(b)}
                          </span>
                          {orphaned && (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500"
                              title={t("originEditor.schemas.pinnedWarning")}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              {t("originEditor.schemas.pinned")}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

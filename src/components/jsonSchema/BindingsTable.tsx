/**
 * The cascade, rendered as a table.
 *
 * Extracted from the Settings section because it is the part users have to
 * *understand*, and it earns the space. Two rendering rules carry most of that
 * weight:
 *
 * * **A wildcard axis draws the glyph `*`, never an empty cell.** An empty cell
 *   reads as "not filled in yet", which is the single most common misreading of
 *   any precedence table.
 * * **Row order IS precedence.** The backend returns bindings sorted, and the `#`
 *   column shows the rank, with one sentence above stating the rule. Nothing here
 *   re-derives the ranking — the specificity number comes from Rust, and the
 *   ordering with it.
 *
 * A row that can never fire is dimmed and tagged, computed from the rank the
 * backend already supplied for the columns it names; a row pointing at a deleted
 * schema is tagged destructively. Deleting a row is not confirmed: the schema
 * survives, and the row is one dropdown click to recreate — unlike
 * `OriginsSection`, where a delete loses a keychain passphrase.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useConnections } from "@/stores/session/connections";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { JsonSchemaBinding } from "@/types";

interface Props {
  onEdit: (binding: JsonSchemaBinding) => void;
}

export function BindingsTable({ onEdit }: Props) {
  const { t } = useTranslation();
  const bindings = useJsonSchemas((s) => s.bindings);
  const schemas = useJsonSchemas((s) => s.schemas);
  const saveBinding = useJsonSchemas((s) => s.saveBinding);
  const deleteBinding = useJsonSchemas((s) => s.deleteBinding);
  const profiles = useConnections((s) => s.profiles);

  // Derive with `useMemo` from raw state; a selector returning a map would be a
  // fresh object every call (gotcha #1).
  const schemaNames = useMemo(
    () => new Map(schemas.map((s) => [s.id, s.name])),
    [schemas],
  );
  const connectionNames = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.name])),
    [profiles],
  );

  if (bindings.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {t("jsonSchemas.bindings.empty")}
      </div>
    );
  }

  const any = "*";
  const wildcard = "text-muted-foreground/60";

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="w-8 border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.rank")}
            </th>
            <th className="border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.connection")}
            </th>
            <th className="border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.dbSchema")}
            </th>
            <th className="border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.table")}
            </th>
            <th className="border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.column")}
            </th>
            <th className="border-b border-border px-1.5 py-1.5 font-medium">
              {t("jsonSchemas.bindings.col.schema")}
            </th>
            <th className="w-12 border-b border-border px-1 py-1.5 text-center font-medium">
              {t("jsonSchemas.bindings.col.enabled")}
            </th>
            <th className="w-8 border-b border-border" />
          </tr>
        </thead>
        <tbody>
          {bindings.map((b, i) => {
            const missing = !schemaNames.has(b.schemaId);
            return (
              <tr
                key={b.id}
                className={cn(
                  "group/row cursor-pointer border-b border-border/50 last:border-b-0 hover:bg-accent/30",
                  i % 2 === 1 && "bg-muted/15",
                  !b.enabled && "opacity-60",
                )}
                onClick={() => onEdit(b)}
              >
                <td className="px-1.5 py-1 tabular-nums text-muted-foreground">
                  {i + 1}
                </td>
                <td className="px-1.5 py-1">
                  {b.connectionId ? (
                    <span className="font-mono">
                      {connectionNames.get(b.connectionId) ??
                        t("jsonSchemas.bindings.unknownConnection")}
                    </span>
                  ) : (
                    <span className={wildcard}>{any}</span>
                  )}
                </td>
                <td className="px-1.5 py-1 font-mono">
                  {b.dbSchema ?? <span className={wildcard}>{any}</span>}
                </td>
                <td className="px-1.5 py-1 font-mono">
                  {b.table ?? <span className={wildcard}>{any}</span>}
                </td>
                <td className="px-1.5 py-1 font-mono">{b.column}</td>
                <td className="px-1.5 py-1">
                  {missing ? (
                    <span className="text-destructive">
                      {t("jsonSchemas.bindings.missingSchema")}
                    </span>
                  ) : (
                    schemaNames.get(b.schemaId)
                  )}
                </td>
                <td
                  className="px-1 py-1 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Switch
                    checked={b.enabled}
                    onCheckedChange={(next) =>
                      void saveBinding({ ...b, enabled: next })
                    }
                  />
                </td>
                <td
                  className="px-1 py-1 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconButton
                    icon={Trash2}
                    tone="destructive"
                    revealOnHover="row"
                    label={t("jsonSchemas.bindings.remove")}
                    type="button"
                    onClick={() => void deleteBinding(b.id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

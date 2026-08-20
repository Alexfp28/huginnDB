/**
 * Inline editor for one binding's four axes.
 *
 * Same shape as the draft row in `OriginsSection`: it expands under the table
 * rather than opening a dialog, so the rule stays visible next to the ones it
 * competes with.
 *
 * The connection axis is a `<select>` over saved profiles rather than a text
 * field, because it is a uuid — nobody types one, and a typo would produce a rule
 * that silently never matches. The other three are free text, since the point of
 * a wildcard rule is to name tables and columns that may not exist yet.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { useConnections } from "@/stores/session/connections";
import type { JsonSchemaBinding } from "@/types";

interface Props {
  binding: JsonSchemaBinding;
  onClose: () => void;
}

export function BindingScopeFields({ binding, onClose }: Props) {
  const { t } = useTranslation();
  const schemas = useJsonSchemas((s) => s.schemas);
  const saveBinding = useJsonSchemas((s) => s.saveBinding);
  const profiles = useConnections((s) => s.profiles);
  const [draft, setDraft] = useState<JsonSchemaBinding>(binding);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when a different row is opened, not on every render.
  useEffect(() => {
    setDraft(binding);
    setError(null);
  }, [binding.id]);

  async function save() {
    try {
      await saveBinding(draft);
      onClose();
    } catch (e) {
      setError(String(e));
      toast.error(t("jsonSchemas.bindings.saveError", { message: String(e) }));
    }
  }

  const anyLabel = t("jsonSchemas.scope.dbSchemaAny");

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">
            {t("jsonSchemas.bindings.col.schema")}
          </Label>
          <select
            value={draft.schemaId}
            onChange={(e) => setDraft({ ...draft, schemaId: e.target.value })}
            className="h-7 w-full rounded-sm border border-input bg-background px-1.5 text-xs"
          >
            {schemas.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">{t("jsonSchemas.scope.connection")}</Label>
          <select
            value={draft.connectionId ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, connectionId: e.target.value || null })
            }
            className="h-7 w-full rounded-sm border border-input bg-background px-1.5 text-xs"
          >
            <option value="">{t("jsonSchemas.scope.connectionAny")}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">{t("jsonSchemas.scope.dbSchema")}</Label>
          <Input
            value={draft.dbSchema ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, dbSchema: e.target.value || null })
            }
            placeholder={anyLabel}
            className="h-7 font-mono text-xs"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">{t("jsonSchemas.scope.table")}</Label>
          <Input
            value={draft.table ?? ""}
            onChange={(e) => setDraft({ ...draft, table: e.target.value || null })}
            placeholder={t("jsonSchemas.scope.tablePlaceholder")}
            className="h-7 font-mono text-xs"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-[11px]">{t("jsonSchemas.scope.column")}</Label>
          <Input
            value={draft.column}
            onChange={(e) => setDraft({ ...draft, column: e.target.value })}
            placeholder={t("jsonSchemas.scope.columnPlaceholder")}
            className="h-7 font-mono text-xs"
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("jsonSchemas.scope.globHint")}
      </p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!draft.column.trim()}>
          {t("common.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

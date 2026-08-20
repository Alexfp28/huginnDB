/**
 * "Create a schema from this value" — the onboarding path for the whole feature.
 *
 * Asking someone to write a JSON Schema by hand has an adoption rate near zero,
 * so the fastest route from nothing to something useful is: open a cell, draft a
 * schema from the value already on screen, name it, and have it linked before the
 * dialog closes. Everything after that is refinement in Settings.
 *
 * The preview is a `<pre>`, not a second Monaco. This dialog can be a sibling of
 * a Monaco-hosting dialog, and stacking two editors with two focus traps buys
 * nothing here: the draft is a starting point, and the place to shape it is the
 * Settings editor, which the hint says.
 *
 * Inference itself runs in Rust (`json_schemas::infer`) — pure, combinatorial,
 * and covered by `cargo test`, which is the only test runner this repo has.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import { useJsonSchemas, draftBinding } from "@/stores/jsonSchemas";
import type { CellBindingContext } from "@/stores/grid/cellEditor";
import type { JsonSchemaInferResult } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The buffer to draft from. */
  value: string;
  binding: CellBindingContext;
  /** Pre-rendered scope, so the "link it now" line names where it will apply. */
  scopeLabel: string;
}

/** `widgets.configuration` → `widgets-configuration`, as a starting name. */
function suggestName(binding: CellBindingContext): string {
  const base = [binding.table, binding.column].filter(Boolean).join(".");
  return (base || "schema")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function InferSchemaDialog({
  open,
  onOpenChange,
  value,
  binding,
  scopeLabel,
}: Props) {
  const { t } = useTranslation();
  const saveSchema = useJsonSchemas((s) => s.saveSchema);
  const saveBinding = useJsonSchemas((s) => s.saveBinding);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [linkNow, setLinkNow] = useState(true);
  const [closedObjects, setClosedObjects] = useState(false);
  const [draft, setDraft] = useState<JsonSchemaInferResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(value) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [value]);

  // Re-seed on open only, and re-draft when the one knob changes.
  useEffect(() => {
    if (!open) return;
    setName(suggestName(binding));
    setDescription("");
    setLinkNow(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !parsed.ok) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    void api
      .inferJsonSchema([parsed.value], closedObjects)
      .then((result) => {
        if (!cancelled) setDraft(result);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, parsed, closedObjects]);

  async function create() {
    if (!draft || !name.trim()) return;
    setSaving(true);
    try {
      const saved = await saveSchema({
        name: name.trim(),
        description: description.trim() || null,
        body: draft.body,
        source: "inferred",
      });
      if (linkNow) {
        await saveBinding(
          draftBinding(
            saved.id,
            binding.connectionId,
            binding.dbSchema,
            binding.table,
            binding.column,
          ),
        );
        toast.success(
          t("jsonSchemas.toast.bound", { name: saved.name, scope: scopeLabel }),
        );
      } else {
        toast.success(t("jsonSchemas.toast.created", { name: saved.name }));
      }
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("jsonSchemas.infer.title")}</DialogTitle>
          <DialogDescription>
            {t("jsonSchemas.infer.description")}
          </DialogDescription>
        </DialogHeader>

        {!parsed.ok ? (
          <p className="text-sm text-destructive">
            {t("jsonSchemas.infer.notJson")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="infer-name">{t("jsonSchemas.infer.name")}</Label>
              <Input
                id="infer-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("jsonSchemas.infer.namePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="infer-desc">
                {t("jsonSchemas.detail.descriptionPlaceholder")}
              </Label>
              <Input
                id="infer-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {t("jsonSchemas.infer.strict")}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t("jsonSchemas.infer.strictHint")}
                </p>
              </div>
              <Switch
                checked={closedObjects}
                onCheckedChange={setClosedObjects}
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("jsonSchemas.infer.preview")}
              </p>
              <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-snug">
                {draft?.body ?? "…"}
              </pre>
              {draft &&
                (draft.stats.truncatedArrays || draft.stats.truncatedDepth) && (
                  <p className="text-[11px] text-warning">
                    {t("jsonSchemas.infer.truncated")}
                  </p>
                )}
              {draft && draft.stats.mixedPaths.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("jsonSchemas.infer.mixed", {
                    paths: draft.stats.mixedPaths.join(", "),
                  })}
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={linkNow}
                onChange={(e) => setLinkNow(e.target.checked)}
              />
              <span className="font-mono">
                {t("jsonSchemas.infer.linkAlso", { scope: scopeLabel })}
              </span>
            </label>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void create()}
            disabled={!parsed.ok || !draft || !name.trim() || saving}
          >
            {t("jsonSchemas.infer.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

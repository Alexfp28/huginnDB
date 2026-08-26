/**
 * The editor's title bar: what document this is, who may write it, and the two
 * verbs.
 *
 * The role pill is the honest one. It reports the *effective* answer, not the
 * registered intention: an origin the user marked as one they publish still
 * reads read-only when the OS refused the write probe, because that is what will
 * happen when they press Save. Discovering it at the last step, after composing
 * a revision, is the failure this pill exists to prevent.
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle, Eye, Loader2, PencilLine, RotateCcw, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OriginDocument } from "@/types";

export function OriginEditorHeader({
  doc,
  readOnly,
  dirty,
  stale,
  revision,
  saving,
  onSave,
  onDiscard,
  onReload,
  onClose,
}: {
  doc: OriginDocument;
  /** The effective answer: role *and* the OS's own verdict. */
  readOnly: boolean;
  dirty: boolean;
  /** Somebody else published while this was open. */
  stale: boolean;
  revision: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const RoleIcon = readOnly ? Eye : PencilLine;

  return (
    <header className="flex items-start gap-3 border-b border-border px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold">{doc.name}</h2>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
              readOnly
                ? "bg-muted text-muted-foreground"
                : "bg-primary/10 text-primary"
            }`}
            title={
              doc.role === "publisher" && !doc.writable.writable
                ? (doc.writable.reason ?? undefined)
                : undefined
            }
          >
            <RoleIcon className="h-3 w-3" />
            {readOnly
              ? t("originEditor.role.readOnly")
              : t("originEditor.role.publisher")}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("originEditor.revision", { revision })}
          </span>
          {dirty && !readOnly && (
            <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-500">
              {t("originEditor.unsaved")}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {doc.path}
        </div>
        {doc.role === "publisher" && !doc.writable.writable && (
          <div className="mt-1 flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="break-words">
              {t("originEditor.notWritable", {
                reason: doc.writable.reason ?? "",
              })}
            </span>
          </div>
        )}
        {stale && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-destructive">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{t("originEditor.stale")}</span>
            <button className="underline" onClick={onReload}>
              {t("originEditor.reload")}
            </button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || saving}
            onClick={onDiscard}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t("originEditor.discard")}
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" disabled={!dirty || saving || stale} onClick={onSave}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("originEditor.save")}
          </Button>
        )}
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

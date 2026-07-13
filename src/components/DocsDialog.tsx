/**
 * Documentation viewer — Help → Documentation. A two-pane dialog: bundled doc
 * titles on the left, the selected doc's rendered markdown (with its
 * last-updated date) on the right. Content comes from the curated registry in
 * `lib/docs.ts`; rendering from the dependency-free `Markdown` component.
 *
 * Controlled by `useDocsDialog`. The active doc defaults to the first entry
 * when none is explicitly selected.
 */

import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DOCS, getDoc } from "@/lib/docs";
import { useDocsDialog } from "@/stores/docsDialog";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

function formatDate(iso: string | null, lang: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DocsDialog() {
  const { t, i18n } = useTranslation();
  const open = useDocsDialog((s) => s.open);
  const activeId = useDocsDialog((s) => s.activeId);
  const setOpen = useDocsDialog((s) => s.setOpen);
  const setActive = useDocsDialog((s) => s.setActive);

  const active = (activeId && getDoc(activeId)) || DOCS[0];
  const activeDate = active ? formatDate(active.updated, i18n.language) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-w-4xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
              <BookOpen className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t("docs.title")}</DialogTitle>
              <DialogDescription>{t("docs.subtitle")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex h-[70vh] min-h-0">
          {/* Sidebar: doc titles */}
          <nav className="w-56 shrink-0 overflow-y-auto border-r p-2">
            {DOCS.map((doc) => {
              const selected = doc.id === active?.id;
              const date = formatDate(doc.updated, i18n.language);
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setActive(doc.id)}
                  className={cn(
                    "mb-0.5 w-full rounded-md px-2.5 py-2 text-left transition-colors",
                    selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <div className="text-sm font-medium">
                    {t(doc.titleKey)}
                  </div>
                  {date && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("docs.updated", { date })}
                    </div>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Preview */}
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
            {active ? (
              <>
                {activeDate && (
                  <div className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t("docs.updated", { date: activeDate })}
                  </div>
                )}
                <Markdown source={active.body} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("docs.empty")}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

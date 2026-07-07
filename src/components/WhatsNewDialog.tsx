/**
 * Post-update "What's new" presentation — a curated, iconified highlights
 * dialog that pops on the first launch after updating to a `major` release
 * (see `stores/whatsNew.ts` + `lib/releaseNotes.ts`). It's the punchy
 * counterpart to the exhaustive changelog in Settings → About
 * (`PatchNotesCard`), not a replacement for it.
 *
 * Controlled entirely by `useWhatsNew`: the dialog is open whenever
 * `openVersion` is set, and closing (button, Esc, overlay, X) routes through
 * `dismiss`, which marks that version seen so it won't reappear.
 */

import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWhatsNew } from "@/stores/whatsNew";
import { getReleaseNote } from "@/lib/releaseNotes";
import { api } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const CHANGELOG_URL =
  "https://github.com/Alexfp28/huginnDB/blob/main/CHANGELOG.md";

export function WhatsNewDialog() {
  const { t } = useTranslation();
  const openVersion = useWhatsNew((s) => s.openVersion);
  const dismiss = useWhatsNew((s) => s.dismiss);

  const note = openVersion ? getReleaseNote(openVersion) : null;

  return (
    <Dialog
      open={note !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {note && (
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <DialogTitle>{t("whatsNew.title")}</DialogTitle>
                <div className="text-xs font-medium text-muted-foreground">
                  {t("whatsNew.versionLabel", { version: note.version })}
                </div>
              </div>
            </div>
            <DialogDescription className="pt-1">
              {t(note.taglineKey)}
            </DialogDescription>
          </DialogHeader>

          <ul className="-mx-1 max-h-[55vh] space-y-1 overflow-y-auto px-1">
            {note.highlights.map((h) => {
              const Icon = h.icon;
              return (
                <li
                  key={h.titleKey}
                  className="flex items-start gap-3 rounded-md p-2 transition-colors hover:bg-accent/50"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {t(h.titleKey)}
                    </div>
                    <div className="text-xs leading-relaxed text-muted-foreground">
                      {t(h.bodyKey)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <DialogFooter className="items-center sm:justify-between">
            <button
              type="button"
              onClick={() => void api.openUrl(CHANGELOG_URL)}
              className="text-xs text-brand hover:underline"
            >
              {t("whatsNew.viewChangelog")}
            </button>
            <Button size="sm" onClick={dismiss}>
              {t("whatsNew.gotIt")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * In-app issue reporter. Lets the user file a **bug** or a **feature request**
 * to the project's GitHub tracker without leaving HuginnDB.
 *
 * Delivery is handled in Rust (`commands::feedback`): with a stored GitHub PAT
 * the issue is created via the API and we link to it; without one we open a
 * pre-filled `issues/new` page in the browser. The PAT is stored in the OS
 * keychain — configurable from the collapsible section at the bottom.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Bug, Lightbulb, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/tauri";
import { useFeedbackDialog } from "@/stores/feedbackDialog";
import type { Diagnostics, FeedbackKind } from "@/types";
import { cn } from "@/lib/utils";

/** Render the optional diagnostics markdown block appended to the body. */
function diagnosticsBlock(d: Diagnostics): string {
  return [
    "",
    "---",
    "_Diagnostics_",
    `- HuginnDB: ${d.app_version}`,
    `- OS: ${d.os} (${d.arch})`,
  ].join("\n");
}

export function FeedbackDialog() {
  const { t } = useTranslation();
  const open = useFeedbackDialog((s) => s.open);
  const prefill = useFeedbackDialog((s) => s.prefill);
  const setOpen = useFeedbackDialog((s) => s.setOpen);

  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // PAT configuration (collapsible).
  const [hasPat, setHasPat] = useState(false);
  const [showPatField, setShowPatField] = useState(false);
  const [patInput, setPatInput] = useState("");

  // (Re)initialise whenever the dialog opens. Pull the prefill (if any) and
  // refresh whether a token is configured so the submit hint is accurate.
  useEffect(() => {
    if (!open) return;
    setKind(prefill?.kind ?? "bug");
    setTitle(prefill?.title ?? "");
    setDescription(prefill?.description ?? "");
    setIncludeDiagnostics(true);
    setShowPatField(false);
    setPatInput("");
    void api.hasGithubPat().then(setHasPat).catch(() => setHasPat(false));
  }, [open, prefill]);

  async function handleSavePat() {
    try {
      await api.setGithubPat(patInput);
      setHasPat(patInput.trim().length > 0);
      setShowPatField(false);
      setPatInput("");
      toast.success(t("feedback.patSaved"));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleClearPat() {
    try {
      await api.clearGithubPat();
      setHasPat(false);
      toast.success(t("feedback.patCleared"));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleSubmit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      let body = description.trim();
      if (includeDiagnostics) {
        const diag = await api.getDiagnostics();
        body = `${body}\n${diagnosticsBlock(diag)}`;
      }
      const outcome = await api.submitIssue({ kind, title: title.trim(), body });
      if (outcome.created) {
        toast.success(t("feedback.created"), {
          action: {
            label: t("feedback.viewIssue"),
            onClick: () => window.open(outcome.url, "_blank", "noreferrer"),
          },
        });
      } else {
        // No token: open the pre-filled new-issue page for manual submission.
        window.open(outcome.url, "_blank", "noreferrer");
        toast.info(t("feedback.openedBrowser"));
      }
      setOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const kinds: { id: FeedbackKind; label: string; icon: typeof Bug }[] = [
    { id: "bug", label: t("feedback.kindBug"), icon: Bug },
    { id: "feature", label: t("feedback.kindFeature"), icon: Lightbulb },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("feedback.title")}</DialogTitle>
          <DialogDescription>{t("feedback.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Kind toggle */}
          <div className="grid grid-cols-2 gap-2">
            {kinds.map((k) => {
              const Icon = k.icon;
              const selected = kind === k.id;
              return (
                <Button
                  key={k.id}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  className="justify-start gap-2"
                  onClick={() => setKind(k.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {k.label}
                </Button>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feedback-title">{t("feedback.titleLabel")}</Label>
            <Input
              id="feedback-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("feedback.titlePlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feedback-desc">{t("feedback.descLabel")}</Label>
            <textarea
              id="feedback-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder={t("feedback.descPlaceholder")}
              className={cn(
                "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "resize-y",
              )}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={includeDiagnostics}
              onCheckedChange={setIncludeDiagnostics}
            />
            {t("feedback.includeDiagnostics")}
          </label>

          {/* PAT configuration */}
          <div className="rounded-md border border-border bg-card/40 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="h-3.5 w-3.5" />
                {hasPat ? t("feedback.patConfigured") : t("feedback.patNone")}
              </span>
              <div className="flex gap-1">
                {hasPat && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={handleClearPat}
                  >
                    {t("feedback.patClear")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setShowPatField((v) => !v)}
                >
                  {hasPat ? t("feedback.patChange") : t("feedback.patAdd")}
                </Button>
              </div>
            </div>
            {showPatField && (
              <div className="mt-2 flex gap-2">
                <Input
                  type="password"
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  placeholder="ghp_…"
                  className="h-7 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-7"
                  onClick={handleSavePat}
                  disabled={!patInput.trim()}
                >
                  {t("feedback.patSave")}
                </Button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {hasPat ? t("feedback.hintApi") : t("feedback.hintBrowser")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || submitting}>
            {hasPat ? t("feedback.submit") : t("feedback.openBrowser")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

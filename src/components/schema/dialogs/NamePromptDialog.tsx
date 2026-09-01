/**
 * "Type a name, then run something" — the shape four of the explorer's dialogs
 * are: rename a table, rename a view, create a database, create a collection.
 *
 * All four had the same forty-five lines of JSX (autofocused input, Enter
 * submits, inline error above the footer, a submit button that swaps its label
 * while in flight and disables on an empty or unchanged value) and differed only
 * in their strings, their one API call, and — for the rename case — an extra
 * control below the input. So the shape lives here and those become the props.
 *
 * The async half is `useAsyncSubmit`'s, including its deliberate "stay busy
 * after a success" (see that hook): each caller's `onSubmit` ends by closing or
 * refreshing, and re-enabling the button in the frames before that lands is a
 * double-submit window.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";

export function NamePromptDialog({
  title,
  description,
  placeholder,
  initialValue = "",
  submitLabel,
  submittingLabel,
  formatError,
  canSubmit,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description: string;
  placeholder: string;
  /** Prefilled value — the current name, for a rename. */
  initialValue?: string;
  submitLabel: string;
  /** Shown on the submit button while the action is in flight. */
  submittingLabel: string;
  /** Wraps the raw failure in the caller's own "could not do X: …" string. */
  formatError: (message: string) => string;
  /**
   * Extra condition beyond "not empty". A rename adds "…and actually different
   * from the current name", which the caller knows and this does not.
   */
  canSubmit?: (trimmed: string) => boolean;
  onSubmit: (trimmed: string) => Promise<void>;
  onClose: () => void;
  /** Controls between the input and the error line (the move-to-database
   *  selector). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const { submitting, error, run } = useAsyncSubmit();

  const trimmed = value.trim();
  const allowed = trimmed.length > 0 && (canSubmit?.(trimmed) ?? true);

  const submit = () => {
    if (!allowed) return;
    run(() => onSubmit(trimmed));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {children}
        {error && (
          <div className="text-xs text-destructive">{formatError(error)}</div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting || !allowed}>
            {submitting ? submittingLabel : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

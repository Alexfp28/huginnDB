/**
 * Shared single-line cell input used both by the inline INSERT draft row
 * and by inline cell editing (double-click on an existing cell).
 *
 * It renders a monospace text field plus two optional affordances:
 * - a "∅" button that forces the cell to NULL (shown when `nullable`);
 * - a "expand" button that escalates to the full Monaco editor (shown when
 *   `onExpand` is provided).
 *
 * Commit / cancel wiring is opt-in: when `onCommit` / `onCancel` are given the
 * field commits on Enter and on blur, and cancels on Esc. The draft row leaves
 * them undefined because it owns keyboard / blur handling at the row level.
 *
 * Both auxiliary buttons call `preventDefault` on mousedown so clicking them
 * never blurs the input first — which would otherwise trigger a premature
 * commit in inline-edit mode.
 */

import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Braces, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface CellInputProps {
  /** Current value; `null` renders a "NULL" placeholder. */
  value: string | null;
  /** When true, render the "∅" set-NULL button. */
  nullable?: boolean;
  /** Highlight the "∅" button as the active NULL state. */
  nullActive?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string | null) => void;
  /** Commit on Enter / blur (inline single-cell mode only). */
  onCommit?: () => void;
  /** Cancel on Esc (inline single-cell mode only). */
  onCancel?: () => void;
  /** Render an expand button that escalates to the modal editor. */
  onExpand?: () => void;
  /** Tooltip for the expand button. */
  expandTitle?: string;
  /**
   * The column has a JSON Schema attached, so the expand button says so.
   *
   * This is the discoverability path for anyone who never opens the heavy
   * editor: a one-line `<input>` cannot offer completion or validation, so the
   * only hint that the schema exists is that escalating is worth it. Double-click
   * behaviour is unchanged (gotcha #12) — this swaps an icon, nothing more.
   */
  schemaBound?: boolean;
}

export const CellInput = forwardRef<HTMLInputElement, CellInputProps>(
  function CellInput(
    {
      value,
      nullable,
      nullActive,
      disabled,
      autoFocus,
      onChange,
      onCommit,
      onCancel,
      onExpand,
      expandTitle,
      schemaBound,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const wired = Boolean(onCommit || onCancel);
    return (
      <div className="flex items-center gap-1">
        <input
          ref={ref}
          autoFocus={autoFocus}
          className="h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1.5 font-mono text-xs focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
          placeholder={value === null ? "NULL" : ""}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            wired
              ? (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommit?.();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel?.();
                  }
                }
              : undefined
          }
          onBlur={onCommit ? () => onCommit() : undefined}
        />
        {onExpand && (
          <button
            type="button"
            tabIndex={-1}
            title={expandTitle}
            disabled={disabled}
            // `sticky`, not just flow position, so a wide column doesn't
            // push this button off the right edge of the scroll container
            // — the input itself stretches to the cell's full (possibly
            // very wide) width, and without this the button was only
            // reachable by scrolling that specific cell all the way over.
            // Opaque background because `sticky` promotes it to its own
            // compositing layer, which would otherwise let the input
            // underneath show through while scrolling.
            className={
              schemaBound
                ? "sticky right-1 z-[1] shrink-0 rounded-sm bg-background px-1 text-brand hover:text-brand/80"
                : "sticky right-1 z-[1] shrink-0 rounded-sm bg-background px-1 text-muted-foreground/80 hover:text-foreground"
            }
            // Keep focus on the input so blur-commit doesn't fire before we
            // hand the current value off to the modal editor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onExpand}
          >
            {schemaBound ? (
              <Braces className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </button>
        )}
        {nullable && (
          <button
            type="button"
            tabIndex={-1}
            title={t("cellEditor.setNull")}
            disabled={disabled}
            className={cn(
              "shrink-0 rounded-sm px-1 text-3xs",
              nullActive
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground/50 hover:text-foreground",
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(null)}
          >
            ∅
          </button>
        )}
      </div>
    );
  },
);

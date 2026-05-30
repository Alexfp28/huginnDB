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
import { Maximize2 } from "lucide-react";

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
    },
    ref,
  ) {
    const wired = Boolean(onCommit || onCancel);
    return (
      <div className="flex items-center gap-1">
        <input
          ref={ref}
          autoFocus={autoFocus}
          className="h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
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
            className="shrink-0 rounded px-1 text-muted-foreground/50 hover:text-foreground"
            // Keep focus on the input so blur-commit doesn't fire before we
            // hand the current value off to the modal editor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onExpand}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        )}
        {nullable && (
          <button
            type="button"
            tabIndex={-1}
            title="Set NULL"
            disabled={disabled}
            className={`shrink-0 rounded px-1 text-[10px] ${
              nullActive
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground/50 hover:text-foreground"
            }`}
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

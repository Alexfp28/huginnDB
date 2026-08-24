/**
 * The centred search overlay shared by the command palette and the tab
 * switcher: dimmed backdrop, a floating card, a screen-reader-only title, and a
 * search row with an autofocused input.
 *
 * Both had a byte-identical overlay, the same animation classes, the same input
 * markup and the same `sr-only` title, differing only in width, vertical offset
 * and placeholder — so the shell is here and the differences are props.
 *
 * Keyboard handling stays with the caller (`onKeyDown` on the card): each
 * overlay owns its own Enter/Delete/Tab semantics. Arrow keys and the highlight
 * belong to `useListNavigation`.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";

export function OverlayPalette({
  open,
  onOpenChange,
  title,
  className,
  onKeyDown,
  query,
  onQueryChange,
  placeholder,
  inputRef,
  inputLeading,
  inputTrailing,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name; rendered `sr-only`, since the input carries the visuals. */
  title: string;
  /** Width and vertical offset, e.g. `"max-w-2xl top-[12%]"`. */
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement>;
  /** Between the magnifier and the input — the palette's mode chip. */
  inputLeading?: ReactNode;
  /** After the input — the palette's result count. */
  inputTrailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 z-50 w-full -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className,
          )}
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {inputLeading}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={placeholder}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {inputTrailing}
          </div>

          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

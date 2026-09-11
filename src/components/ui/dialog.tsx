import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS } from "@/components/ui/styles";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Opaque hex `--scrim` run through the same alpha the utility picks
      // per mode: one alpha cannot both dim a light page and darken an
      // already-dark one. See the token's docblock in `lib/themes.ts`.
      "fixed inset-0 z-50 bg-scrim/35 backdrop-blur-sm dark:bg-scrim/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    {/* Centring lives on this layer, not on the content's own `transform`:
        `tailwindcss-animate`'s `enter` keyframe writes `transform:
        translate3d(...) scale3d(...)`, which *replaces* a transform-based
        centring during the 200ms it runs — every dialog used to enter from
        the viewport's top-left corner. Aligning a flex container instead
        leaves `transform` free for the animation, lets a dialog taller than
        the viewport scroll instead of clipping at both edges, and turns each
        tier's geometry into an alignment rather than translate arithmetic.
        `pointer-events-none` here (the content below opts back in) is what
        keeps the outside click landing on the overlay instead of this
        layer. */}
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-2">
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // Modal scales from centre on enter (zoom), not a bare fade — and
          // rides the shared elevation scale instead of a flat shadow, so
          // dialogs read as raised rather than stock-shadcn flat.
          //
          // `[&>*]:min-w-0` is load-bearing, not tidying. This is a grid, and a
          // grid item defaults to `min-width: auto`, so a child too wide to fit
          // widens the implicit column *past* `max-w-*` instead of shrinking —
          // and because every other item stretches to that column, one overwide
          // child drags all its siblings out over the dialog's own border. A
          // footer of four `whitespace-nowrap` buttons did exactly that. Zeroing
          // the minimum makes the offending child shrink instead.
          //
          // `max-w-md`, not shadcn's `max-w-lg`: of the 31 call sites that used
          // to override this, 15 passed `max-w-md` and only 3 wanted the `lg`
          // default. The default was simply mis-chosen for a dense desktop tool,
          // so correcting it deleted 15 `className`s — and made a `size` variant
          // on Dialog unnecessary, since the remaining widths are all one-offs
          // (`2xl`, `4xl`, `6xl`, viewport-relative) that read fine as explicit
          // overrides. `tailwind-merge` lets those win, `className` being last.
          //
          // `rounded-lg` with no `sm:` prefix: shadcn's default left dialogs
          // with no radius at all below the 640px breakpoint.
          "pointer-events-auto grid w-full max-w-md gap-4 rounded-lg border bg-card p-6 shadow-elevation-4 duration-200 [&>*]:min-w-0 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98]",
          className,
        )}
        {...props}
      >
        {children}
        {/* Proper close affordance: a padded button with a hover background,
            rather than a bare low-opacity glyph with no hit area. */}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none",
            CONTROL_FOCUS,
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
));
DialogHeader.displayName = "DialogHeader";

/**
 * `flex-wrap` + `gap-2` rather than `space-x-2`: buttons are
 * `whitespace-nowrap`, so a row of them that outgrows the dialog used to push
 * the grid column wide instead of wrapping (see `DialogContent`). The two go
 * together — `space-x-*` only adds a left margin, so a wrapped second row
 * would sit flush against the first.
 *
 * `gap-2` renders identically to `space-x-2` for a row that does not wrap, so
 * this changes nothing for the footers that already fit.
 */
const DialogFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-wrap justify-end gap-2", className)}
    {...props}
  />
));
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};

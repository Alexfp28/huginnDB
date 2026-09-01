import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

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
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
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
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Modal stays centred and scales from centre on enter (zoom), not a
        // bare fade — and rides the shared elevation scale instead of a flat
        // shadow, so dialogs read as raised rather than stock-shadcn flat.
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
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 border bg-card p-6 shadow-elevation-4 duration-200 [&>*]:min-w-0 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] sm:rounded-lg",
        className,
      )}
      {...props}
    >
      {children}
      {/* Proper close affordance: a padded button with a hover background,
          rather than a bare low-opacity glyph with no hit area. */}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
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
const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-wrap justify-end gap-2", className)}
    {...props}
  />
);
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

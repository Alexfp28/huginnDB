import * as React from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuPortal = ContextMenuPrimitive.Portal;

/**
 * Trigger for a nested submenu. Visually mirrors `ContextMenuItem` so the
 * row keeps the same height and padding, plus a trailing chevron hinting
 * at the expansion. Used by "Copy as ▸ JSON / SQL INSERT / SQL UPDATE".
 */
const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-3 w-3 opacity-60" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

/**
 * Floating panel rendered next to its `ContextMenuSubTrigger`. Inherits
 * the same chrome as `ContextMenuContent` for visual consistency.
 */
const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      "z-50 max-h-[var(--radix-popper-available-height)] min-w-[10rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
      className,
    )}
    {...props}
  />
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        // Same capped-height + scroll treatment as `DropdownMenuContent` (see
        // the note there): a long menu must scroll rather than be clipped.
        "z-50 max-h-[var(--radix-popper-available-height)] min-w-[10rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

/**
 * A `ContextMenuItem` with a leading icon, for the common case of a single
 * label + action. Exists so every context menu in the app (grid, connection
 * tree, database tree, table tree) composes the same icon+label+action shape
 * instead of each call site hand-rolling its own `<Icon className="mr-2 …" />`
 * + label pair (which is how `TabbedArea`'s Pin/PinOff item used to do it).
 */
const ContextMenuAction = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  {
    icon: LucideIcon;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    /** Red styling for irreversible actions (drop, delete, …). */
    destructive?: boolean;
    shortcut?: string;
  }
>(({ icon: Icon, label, onSelect, disabled, destructive, shortcut }, ref) => (
  <ContextMenuItem
    ref={ref}
    disabled={disabled}
    onSelect={onSelect}
    className={cn(
      destructive &&
        "text-destructive focus:bg-destructive/10 focus:text-destructive",
    )}
  >
    <Icon className="mr-2 h-3.5 w-3.5 shrink-0" />
    <span className="truncate">{label}</span>
    {shortcut && <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>}
  </ContextMenuItem>
));
ContextMenuAction.displayName = "ContextMenuAction";

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn(
      "ml-auto text-[10px] tracking-widest text-muted-foreground",
      className,
    )}
    {...props}
  />
);
ContextMenuShortcut.displayName = "ContextMenuShortcut";

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuAction,
  ContextMenuLabel,
  ContextMenuGroup,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuPortal,
};

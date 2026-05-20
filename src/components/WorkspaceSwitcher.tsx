/**
 * Topbar control for switching, creating, renaming, recolouring,
 * reordering and deleting workspaces.
 *
 * A workspace bundles the tabs the user had open while it was focused.
 * Switching one swaps which tabs the UI shows — see
 * [[useWorkspaces.switchTo]] for the flush + reload dance.
 *
 * The dropdown is built on Radix's [[DropdownMenu]] so it behaves like
 * the rest of the app's menus (outside-click dismissal, focus
 * trapping). Inside, the list is sortable via `@dnd-kit` and each row
 * exposes inline actions for rename, recolour, change icon, and
 * delete. Creating a new workspace opens a tiny dialog with name +
 * colour + icon pickers.
 *
 * Implementation notes:
 *
 *  - The dropdown DOES NOT close when the user picks a colour or icon
 *    inside it. We use `onSelect={(e) => e.preventDefault()}` on the
 *    custom rows so Radix doesn't dismiss the menu mid-edit.
 *  - dnd-kit needs each draggable to opt-in to a non-pointer activation
 *    constraint so a quick click still counts as "open this workspace"
 *    instead of starting a phantom drag.
 *  - The colour and icon catalogues are intentionally tiny. Users who
 *    care about hyper-customisation can ask later; today we want the
 *    feature to be discoverable without overwhelming.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  Check,
  ChevronDown,
  Code2,
  Database,
  Home,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
  ShoppingCart,
  Sparkles,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/stores/workspaces";
import type { WorkspaceMeta } from "@/types";

/**
 * Curated palette for the colour-dot picker. Eight options is enough to
 * differentiate a handful of workspaces visually without overwhelming
 * the user with a colour wheel. Hex values are tuned to read well on
 * both the dark and light themes.
 */
const COLOR_SWATCHES: ReadonlyArray<string> = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // amber
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
];

/**
 * Icon catalogue. Picked to suggest common workspace metaphors —
 * project/work, personal/home, an environment (server/db), an idea
 * shelf, etc. Keys must round-trip through the backend's free-form
 * string field, so we hard-code them to lowercase, hyphenated names.
 */
const ICON_CATALOGUE: ReadonlyArray<{ key: string; Icon: LucideIcon }> = [
  { key: "briefcase", Icon: Briefcase },
  { key: "home", Icon: Home },
  { key: "code", Icon: Code2 },
  { key: "database", Icon: Database },
  { key: "server", Icon: Server },
  { key: "layers", Icon: Layers },
  { key: "star", Icon: Star },
  { key: "sparkles", Icon: Sparkles },
  { key: "shopping-cart", Icon: ShoppingCart },
];

/** Resolve an icon key to its component, falling back to `Layers`. */
function iconFor(key: string | null | undefined): LucideIcon {
  if (!key) return Layers;
  return ICON_CATALOGUE.find((i) => i.key === key)?.Icon ?? Layers;
}

export function WorkspaceSwitcher() {
  const { t: _t } = useTranslation();
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const loaded = useWorkspaces((s) => s.loaded);
  const hydrate = useWorkspaces((s) => s.hydrate);
  const switchTo = useWorkspaces((s) => s.switchTo);
  const reorder = useWorkspaces((s) => s.reorder);
  const updateAppearance = useWorkspaces((s) => s.updateAppearance);
  const deleteWs = useWorkspaces((s) => s.delete);

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMeta | null>(null);

  // One-shot hydrate. Idempotent inside the store so StrictMode's
  // double-invoke in dev doesn't cause two backend round-trips.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const sortedWorkspaces = useMemo(
    // Defensive sort — the backend already returns them ordered, but
    // local reorders apply optimistically and we want the rendered
    // list to track `order` regardless of insertion order in the array.
    () => workspaces.slice().sort((a, b) => a.order - b.order),
    [workspaces],
  );

  const active = useMemo(
    () =>
      activeId
        ? sortedWorkspaces.find((w) => w.id === activeId) ?? sortedWorkspaces[0]
        : sortedWorkspaces[0],
    [activeId, sortedWorkspaces],
  );

  // PointerSensor with a small distance threshold so clicking a row
  // (to switch workspace) doesn't trigger a phantom drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active: dragged, over } = event;
    if (!over || dragged.id === over.id) return;
    const oldIndex = sortedWorkspaces.findIndex((w) => w.id === dragged.id);
    const newIndex = sortedWorkspaces.findIndex((w) => w.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(sortedWorkspaces, oldIndex, newIndex);
    void reorder(next.map((w) => w.id));
  }

  if (!loaded || !active) {
    // Render nothing until we know what workspace to label the trigger
    // with — prevents a one-frame flash of "no workspaces" placeholder.
    return null;
  }

  const ActiveIcon = iconFor(active.icon);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent"
            title="Switch workspace"
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: active.color ?? "#64748b" }}
            />
            <ActiveIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="max-w-[10rem] truncate">{active.name}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground/70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Workspaces
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={sortedWorkspaces.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="max-h-80 overflow-y-auto py-0.5">
                {sortedWorkspaces.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    workspace={w}
                    active={w.id === active.id}
                    onSwitch={() => void switchTo(w.id)}
                    onRename={() => setRenameTarget(w)}
                    onDelete={() => setDeleteTarget(w)}
                    onChangeColor={(color) =>
                      void updateAppearance(w.id, color, w.icon)
                    }
                    onChangeIcon={(icon) =>
                      void updateAppearance(w.id, w.color, icon)
                    }
                    canDelete={sortedWorkspaces.length > 1}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setCreateOpen(true);
            }}
            className="gap-2 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkspaceFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
      />
      {renameTarget && (
        <WorkspaceFormDialog
          open={!!renameTarget}
          onOpenChange={(o) => !o && setRenameTarget(null)}
          mode="rename"
          target={renameTarget}
        />
      )}
      {deleteTarget && (
        <DeleteWorkspaceDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deleteWs(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One row inside the dropdown. Sortable + clickable + inline-actionable.
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: WorkspaceMeta;
  active: boolean;
  canDelete: boolean;
  onSwitch: () => void;
  onRename: () => void;
  onDelete: () => void;
  onChangeColor: (color: string | null) => void;
  onChangeIcon: (icon: string | null) => void;
}

function WorkspaceRow({
  workspace,
  active,
  canDelete,
  onSwitch,
  onRename,
  onDelete,
  onChangeColor,
  onChangeIcon,
}: WorkspaceRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: workspace.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const Icon = iconFor(workspace.icon);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs",
        active ? "bg-accent/60" : "hover:bg-accent/30",
      )}
    >
      {/* Drag handle — full-row dragging would interfere with the row's
          click-to-switch affordance, so we restrict the drag listeners
          to the leading dots. */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground"
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <DragDots />
      </button>
      <button
        className="flex flex-1 items-center gap-1.5 text-left"
        onClick={onSwitch}
      >
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: workspace.color ?? "#64748b" }}
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{workspace.name}</span>
        {active && <Check className="ml-auto h-3 w-3 text-foreground/70" />}
      </button>
      <WorkspaceRowMenu
        workspace={workspace}
        canDelete={canDelete}
        onRename={onRename}
        onDelete={onDelete}
        onChangeColor={onChangeColor}
        onChangeIcon={onChangeIcon}
      />
    </div>
  );
}

/** Six tiny dots arranged 2x3, used as the drag handle. Drawn inline
 *  instead of pulling another lucide icon. */
function DragDots() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden>
      {[0, 4, 8].flatMap((y) =>
        [0, 6].map((x) => (
          <circle key={`${x},${y}`} cx={x + 1} cy={y + 3} r="1" fill="currentColor" />
        )),
      )}
    </svg>
  );
}

/** Inline ⋯ menu with rename / colour / icon / delete actions. */
function WorkspaceRowMenu({
  workspace,
  canDelete,
  onRename,
  onDelete,
  onChangeColor,
  onChangeIcon,
}: {
  workspace: WorkspaceMeta;
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
  onChangeColor: (color: string | null) => void;
  onChangeIcon: (icon: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-foreground"
          title="Workspace settings"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-56 p-1">
        <DropdownMenuItem className="gap-2 text-xs" onSelect={onRename}>
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Color
        </div>
        <div className="flex flex-wrap gap-1.5 px-2 py-1">
          {COLOR_SWATCHES.map((swatch) => {
            const selected = workspace.color === swatch;
            return (
              <button
                key={swatch}
                onClick={() => onChangeColor(swatch)}
                className={cn(
                  "h-4 w-4 rounded-full ring-2 ring-offset-2 ring-offset-popover",
                  selected ? "ring-foreground" : "ring-transparent",
                )}
                style={{ backgroundColor: swatch }}
                title={swatch}
                aria-label={`Set colour ${swatch}`}
              />
            );
          })}
          <button
            onClick={() => onChangeColor(null)}
            className={cn(
              "h-4 w-4 rounded-full border border-dashed border-muted-foreground/50 text-[8px] text-muted-foreground",
              workspace.color === null && "ring-2 ring-foreground",
            )}
            title="No colour"
            aria-label="Clear colour"
          >
            ×
          </button>
        </div>
        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Icon
        </div>
        <div className="grid grid-cols-5 gap-1 px-2 py-1">
          {ICON_CATALOGUE.map(({ key, Icon }) => {
            const selected = workspace.icon === key;
            return (
              <button
                key={key}
                onClick={() => onChangeIcon(key)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-sm",
                  selected ? "bg-accent text-foreground" : "hover:bg-accent/40 text-muted-foreground",
                )}
                title={key}
                aria-label={`Set icon ${key}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 text-xs text-destructive focus:text-destructive"
          disabled={!canDelete}
          onSelect={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Create / rename dialog. Shared because the two flows differ only in the
// initial values and the verb on the submit button.
// ---------------------------------------------------------------------------

interface WorkspaceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "rename";
  /** Required in rename mode; ignored in create mode. */
  target?: WorkspaceMeta;
}

function WorkspaceFormDialog({
  open,
  onOpenChange,
  mode,
  target,
}: WorkspaceFormDialogProps) {
  const create = useWorkspaces((s) => s.create);
  const rename = useWorkspaces((s) => s.rename);

  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset / seed form values whenever the dialog opens.
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    if (mode === "rename" && target) {
      setName(target.name);
      setColor(target.color);
      setIcon(target.icon);
    } else {
      setName("");
      setColor(null);
      setIcon(null);
    }
    setError(null);
    // Defer focus until after the dialog mounts.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, mode, target]);

  async function submit() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "create") {
        await create(name.trim(), color, icon);
      } else if (target) {
        await rename(target.id, name.trim());
      }
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New workspace" : "Rename workspace"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {mode === "create" && (
            <>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Color
                </div>
                <div className="flex flex-wrap gap-2">
                  {COLOR_SWATCHES.map((swatch) => {
                    const selected = color === swatch;
                    return (
                      <button
                        key={swatch}
                        onClick={() => setColor(swatch)}
                        className={cn(
                          "h-5 w-5 rounded-full ring-2 ring-offset-2 ring-offset-background",
                          selected ? "ring-foreground" : "ring-transparent",
                        )}
                        style={{ backgroundColor: swatch }}
                        aria-label={`Pick ${swatch}`}
                      />
                    );
                  })}
                  <button
                    onClick={() => setColor(null)}
                    className={cn(
                      "h-5 w-5 rounded-full border border-dashed border-muted-foreground/50 text-[10px] text-muted-foreground",
                      color === null && "ring-2 ring-foreground",
                    )}
                    aria-label="No colour"
                  >
                    ×
                  </button>
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Icon
                </div>
                <div className="flex flex-wrap gap-1">
                  {ICON_CATALOGUE.map(({ key, Icon }) => {
                    const selected = icon === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setIcon(key)}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-sm",
                          selected
                            ? "bg-accent text-foreground"
                            : "hover:bg-accent/40 text-muted-foreground",
                        )}
                        aria-label={`Pick ${key}`}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Confirm-delete dialog. Separate from the form so the Backspace/Enter
// behaviour is unambiguous (Enter ⇒ confirm delete, no input to type
// into).
// ---------------------------------------------------------------------------

function DeleteWorkspaceDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: WorkspaceMeta;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete workspace?</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          About to delete <span className="font-mono">{target.name}</span> and
          every tab saved inside it. This cannot be undone.
        </p>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={busy}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

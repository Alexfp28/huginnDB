/**
 * Teams-style environment rail — replaces the old lone "Schema" button in
 * the left activity bar. One avatar (initials over its accent colour, see
 * `EnvironmentAvatar`) per environment with its name underneath, plus a
 * trailing "+" to create a new one. This is the left activity bar's only
 * content now: there is no separate generic "Schema" toggle button —
 * clicking the *already active* environment's avatar is what collapses/
 * expands the Schema panel, since a second dedicated button would be
 * redundant with it.
 *
 * Clicking a non-active environment switches to it (`switchTo`, same
 * teardown/reconnect operation `EnvironmentSwitcher` already drives) AND
 * opens the Schema panel if it was closed — one gesture for "I want to work
 * in this environment", per the user's explicit choice over "switch only".
 *
 * Right-clicking an avatar opens the same rename/delete actions
 * `EnvironmentSwitcher`'s dropdown rows offer — the rail is the primary
 * place users now interact with environments, so it needs the same context
 * menu the status-bar switcher already had rather than forcing a trip there
 * for management.
 *
 * Rendered only in the main window, same guard as `EnvironmentSwitcher`
 * (gotcha #8 — environments scope `tab_state.json`, which secondary windows
 * never touch).
 *
 * Reorderable via `@dnd-kit` (vertical sortable list) — drag an avatar to
 * move it, drop to persist through `useEnvironments.reorder`, which already
 * writes optimistically and rolls back on a failed `reorderEnvironments`
 * call. `EnvironmentSwitcher`'s dropdown rows are not draggable; this rail is
 * the one place order can be changed.
 */

import { EnvironmentAvatar } from "@/components/connection/EnvironmentAvatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import {
  environmentLabel,
  useEnvironments,
} from "@/stores/session/environments";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import type { Environment } from "@/types";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface EnvironmentRailProps {
  /** Chrome-level buttons (Theme/Settings) pinned to the bottom, same slot
   *  `ActivityBar`'s own `footer` prop offers. */
  footer?: ReactNode;
}

export function EnvironmentRail({ footer }: EnvironmentRailProps) {
  const { t } = useTranslation();
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const switching = useEnvironments((s) => s.switching);
  const switchTo = useEnvironments((s) => s.switchTo);
  const lastReplicate = useEnvironments((s) => s.lastReplicate);
  const remove = useEnvironments((s) => s.remove);
  const reorder = useEnvironments((s) => s.reorder);
  const openCreate = useEnvironmentEditor((s) => s.openCreate);
  const openEdit = useEnvironmentEditor((s) => s.openEdit);

  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const openSchema = useSessionPanelLayout((s) => s.openSchema);

  const ordered = useMemo(
    () => [...environments].sort((a, b) => a.order - b.order),
    [environments],
  );
  const orderedIds = useMemo(() => ordered.map((e) => e.id), [ordered]);

  const defaultName = t("environments.defaultName");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Secondary "New window" instances don't own an environment — mirrors
  // `EnvironmentSwitcher`'s own guard.
  if (getCurrentWindow().label !== "main") return null;

  function handleClick(envId: string) {
    if (envId === activeId) {
      toggleSchema();
      return;
    }
    openSchema();
    void switchTo(envId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = [...orderedIds];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, String(active.id));
    void reorder(next);
  }

  return (
    <div className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-border py-2">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          {ordered.map((env) => (
            <SortableEnvironmentButton
              key={env.id}
              env={env}
              label={environmentLabel(env, defaultName)}
              isActive={env.id === activeId}
              schemaOpen={schemaOpen}
              switching={switching}
              canDelete={ordered.length > 1}
              onClick={() => handleClick(env.id)}
              onRename={() =>
                openEdit({
                  id: env.id,
                  name: env.name,
                  color: env.color,
                  icon: env.icon,
                  themeId: env.themeId,
                })
              }
              onDelete={() => {
                // Same irreversible-tabs/layout warning as the status-bar
                // switcher's delete action — connections/credentials are
                // untouched, only this environment's session state.
                if (
                  confirmIrreversible(
                    t("environments.deleteConfirm", {
                      name: environmentLabel(env, defaultName),
                    }),
                  )
                ) {
                  void remove(env.id);
                }
              }}
              renameLabel={t("environments.rename")}
              deleteLabel={t("environments.delete")}
            />
          ))}
        </SortableContext>
      </DndContext>
      <SimpleTooltip label={t("environments.create")} side="right">
        <button
          type="button"
          onClick={() => openCreate(lastReplicate)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Plus className="h-[18px] w-[18px]" />
        </button>
      </SimpleTooltip>
      {footer && (
        <div className="mt-auto flex flex-col items-center gap-0.5">
          {footer}
        </div>
      )}
    </div>
  );
}

interface SortableEnvironmentButtonProps {
  env: Environment;
  label: string;
  isActive: boolean;
  schemaOpen: boolean;
  switching: boolean;
  canDelete: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  renameLabel: string;
  deleteLabel: string;
}

function SortableEnvironmentButton({
  env,
  label,
  isActive,
  schemaOpen,
  switching,
  canDelete,
  onClick,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
}: SortableEnvironmentButtonProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: env.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <ContextMenu>
      <SimpleTooltip label={label} side="right">
        <ContextMenuTrigger asChild>
          <button
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            type="button"
            disabled={switching}
            onClick={onClick}
            aria-pressed={isActive && schemaOpen}
            className={cn(
              "group relative flex w-full flex-col items-center gap-1 rounded-md px-1 py-1 transition-colors disabled:opacity-60",
              "hover:bg-foreground/[0.06]",
              isActive && "bg-foreground/[0.08]",
              isDragging && "z-10 opacity-80",
            )}
          >
            {isActive && (
              <span
                aria-hidden
                className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-full"
                style={{
                  backgroundColor: env.color || "hsl(var(--primary))",
                }}
              />
            )}
            {switching && isActive ? (
              <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted">
                <Loader2 className="h-[18px] w-[18px] animate-spin text-muted-foreground" />
              </div>
            ) : (
              <EnvironmentAvatar
                name={label}
                color={env.color}
                icon={env.icon}
                size={36}
              />
            )}
            {/* 11px rather than the 10px this started at: the rail is 72px
                wide, so the label is the one piece of chrome that has to stay
                readable at a glance from the corner of the eye, and 10px sat
                below that on a 1080p display. Tighter tracking keeps roughly
                the same number of glyphs fitting before the truncation, and the
                active row goes medium so "which environment am I in" reads from
                the weight, not only from the background tint. */}
            <span
              className={cn(
                "w-full truncate text-center text-[11px] leading-[1.15] tracking-tight text-muted-foreground",
                isActive && "font-medium text-foreground",
              )}
            >
              {label}
            </span>
          </button>
        </ContextMenuTrigger>
      </SimpleTooltip>
      <ContextMenuContent className="w-48 text-xs">
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {renameLabel}
        </ContextMenuItem>
        {canDelete && (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDelete}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {deleteLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

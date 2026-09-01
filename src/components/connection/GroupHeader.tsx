/**
 * A folder header in `ConnectionsTree`, collapsible.
 *
 * Extracted out of a `function GroupHeader(...)` DEFINED INSIDE
 * `ConnectionsTree`'s own render body and used as JSX (`<GroupHeader
 * name={...} count={...} />`). That is a real bug, not merely a missed
 * optimization: a function declared inside a component body gets a brand
 * new identity every render, and React's reconciler treats a changed
 * element TYPE as "this is a different component" — so every render of
 * `ConnectionsTree` unmounted and remounted every group header, resetting
 * any state inside it (there is none today, but the very first commit to
 * add any — a rename-in-place input, say — would have silently lost focus
 * and state on every unrelated keystroke elsewhere in the tree) and
 * destroying focus if a header itself had it. A component declared at
 * module scope, outside any other component's body, keeps its identity
 * across every render of whatever renders it — which is what makes it
 * memo()-safe in the first place.
 */

import { memo } from "react";
import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";

interface GroupHeaderProps {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: (name: string) => void;
}

export const GroupHeader = memo(function GroupHeader({
  name,
  count,
  collapsed,
  onToggle,
}: GroupHeaderProps) {
  const FolderIcon = collapsed ? Folder : FolderOpen;
  return (
    <button
      type="button"
      onClick={() => onToggle(name)}
      className={cn(
        MICRO_HEADING,
        "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground",
      )}
    >
      {collapsed ? (
        <ChevronRight className="h-3 w-3 shrink-0" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0" />
      )}
      <FolderIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground/60">({count})</span>
    </button>
  );
});

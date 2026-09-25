/**
 * Collapsible "indexes" header within a schema node. Headers only for now — the
 * index list itself lives in the structure editor and, for MongoDB, in the
 * dedicated index manager.
 */

import { ChevronDown, ChevronRight, LayoutList } from "lucide-react";

import { TreeRow } from "@/components/ui/tree-row";

export function IndexesSectionHeader({
  label,
  sectionKey,
  connectionId,
  expanded,
  toggleNode,
}: {
  label: string;
  sectionKey: string;
  connectionId: string;
  expanded: Set<string>;
  toggleNode: (connectionId: string, key: string) => void;
}) {
  const isOpen = expanded.has(sectionKey);
  return (
    <TreeRow
      className="py-1 pl-5"
      aria-expanded={isOpen}
      onClick={() => toggleNode(connectionId, sectionKey)}
    >
      {isOpen ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
      )}
      <LayoutList className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-2xs text-muted-foreground">{label}</span>
    </TreeRow>
  );
}

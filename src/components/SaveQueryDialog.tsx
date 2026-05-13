/**
 * Modal for saving the current SQL query into the library, or editing
 * an existing entry. Tag-list parsing is intentionally trivial (split
 * on commas) so the input stays free-form.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSavedQueries, type SavedQuery } from "@/stores/savedQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sql: string;
  connectionId: string | null;
  existing?: SavedQuery | null;
}

export function SaveQueryDialog({
  open,
  onOpenChange,
  sql,
  connectionId,
  existing,
}: Props) {
  const add = useSavedQueries((s) => s.add);
  const update = useSavedQueries((s) => s.update);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setName(existing.name);
      setDescription(existing.description);
      setTags(existing.tags.join(", "));
    } else {
      setName("");
      setDescription("");
      setTags("");
    }
  }, [open, existing]);

  function handleSave() {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (existing) {
      update(existing.id, { name, description, tags: tagList, sql });
    } else {
      add({
        name: name || "Untitled",
        description,
        tags: tagList,
        sql,
        connectionId,
      });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Update saved query" : "Save query"}
          </DialogTitle>
          <DialogDescription>
            Saved locally to your machine. Available across all connections.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-1">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this query answer?"
            />
          </div>
          <div className="grid gap-1">
            <Label>Tags (comma separated)</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="reporting, billing"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            {existing ? "Update" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

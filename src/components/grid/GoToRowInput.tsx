/**
 * "Go to row" in the table footer — the grid's answer to MongoDB Compass's
 * *Skip*, and the reason the query panel has no Skip/Limit fields of its own.
 *
 * Free Skip and Limit inputs would fight the pager: two controls owning the
 * same offset, and a Limit that silently caps what "next page" can reach. A
 * row number fits the footer's existing vocabulary instead — the range it
 * shows is 1-based rows, and this jumps the range to start where you asked
 * (`offsetForRow` has the clamping rules).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { offsetForRow } from "@/lib/grid/pagination";

export function GoToRowInput({
  total,
  totalEstimated,
  disabled,
  onGo,
}: {
  total: number | null;
  totalEstimated: boolean;
  disabled?: boolean;
  /** Receives the offset that puts the asked-for row at the top. */
  onGo: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const offset = offsetForRow(text, total, totalEstimated);
    if (offset === null) {
      setInvalid(text.trim() !== "");
      return;
    }
    setInvalid(false);
    setText("");
    onGo(offset);
  }

  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      <span>{t("tableData.goToRow")}</span>
      <Input
        size="xs"
        inputMode="numeric"
        className="w-16 tabular-nums"
        aria-invalid={invalid || undefined}
        placeholder="#"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
    </label>
  );
}

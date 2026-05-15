/**
 * Persisted UI display preferences exposed through the top-bar "View" menu.
 *
 * Currently only governs which metric (if any) the schema explorer renders
 * next to each table name. Default mirrors the prior hardcoded behaviour
 * (row count) so existing users see no change after upgrading.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";

/** What to display alongside each table in the schema tree. */
export type SchemaTableMetric = "none" | "row-count" | "size";

interface ViewPrefsState {
  schemaTableMetric: SchemaTableMetric;
  setSchemaTableMetric: (m: SchemaTableMetric) => void;
}

export const useViewPrefs = create<ViewPrefsState>()(
  persist(
    (set) => ({
      schemaTableMetric: "row-count",
      setSchemaTableMetric: (m) => set({ schemaTableMetric: m }),
    }),
    {
      name: STORAGE_KEYS.viewPrefs,
      partialize: (state) => ({ schemaTableMetric: state.schemaTableMetric }),
    },
  ),
);

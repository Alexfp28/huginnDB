/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useImportWizard, type ImportAnalysisLike } from "./useImportWizard";

// The wizard reaches out for exactly two things: the native file picker and the
// import-progress event. Both are Tauri surfaces, stubbed here so the machine
// itself is what is under test.
const picked = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/dialogs", () => ({ pickJsonFile: () => picked() }));
vi.mock("@/lib/bridges/import-progress-bridge", () => ({
  withImportProgress: (
    _on: (p: unknown) => void,
    task: () => Promise<unknown>,
  ) => task(),
}));

function analysis(over: Partial<ImportAnalysisLike> = {}): ImportAnalysisLike {
  return { encrypted: false, conflicts: [], ...over };
}

function setup(cfg: {
  analysis: ImportAnalysisLike;
  reviewStep?: boolean;
  run?: ReturnType<typeof vi.fn>;
}) {
  const run = cfg.run ?? vi.fn().mockResolvedValue({ ok: true });
  const afterImport = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() =>
    useImportWizard({
      pickTitle: "pick",
      analyze: vi.fn().mockResolvedValue(cfg.analysis),
      run,
      reviewStep: cfg.reviewStep,
      afterImport,
    }),
  );
  return { ...hook, run, afterImport };
}

beforeEach(() => {
  picked.mockReset();
  picked.mockResolvedValue("/tmp/export.json");
});

describe("useImportWizard routing", () => {
  it("imports immediately when the file is plain and conflict-free", async () => {
    const { result, run, afterImport } = setup({ analysis: analysis() });
    await act(async () => void (await result.current.pickFile()));
    await waitFor(() => expect(result.current.step).toBe("done"));
    expect(run).toHaveBeenCalledWith("/tmp/export.json", undefined, []);
    expect(afterImport).toHaveBeenCalled();
  });

  it("asks for the passphrase before anything else when encrypted", async () => {
    const { result } = setup({ analysis: analysis({ encrypted: true }) });
    await act(async () => void (await result.current.pickFile()));
    expect(result.current.step).toBe("passphrase");
  });

  it("goes to conflicts when there are some and the file is plain", async () => {
    const { result } = setup({ analysis: analysis({ conflicts: [{ id: "a" }] }) });
    await act(async () => void (await result.current.pickFile()));
    expect(result.current.step).toBe("conflicts");
  });

  // The environment importer inserts a review step because one file can create
  // several environments; the profile importer has nothing to review.
  it("stops at review first when the caller asks for it", async () => {
    const { result } = setup({ analysis: analysis(), reviewStep: true });
    await act(async () => void (await result.current.pickFile()));
    expect(result.current.step).toBe("review");
    act(() => result.current.reviewNext());
    await waitFor(() => expect(result.current.step).toBe("done"));
  });

  it("does nothing when the user cancels the picker", async () => {
    picked.mockResolvedValue(null);
    const { result, run } = setup({ analysis: analysis() });
    await act(async () => void (await result.current.pickFile()));
    expect(result.current.step).toBe("pick");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("useImportWizard conflict resolution", () => {
  // The regression this hook exists to make unrepeatable: a conflict is matched
  // by id, so it is definitionally the same item already present. "Rename" as a
  // default silently duplicated everything on an export-then-reimport, and the
  // environment importer kept doing it for a release after the profile importer
  // was fixed.
  it("defaults every conflict to skip", async () => {
    const { result } = setup({
      analysis: analysis({ conflicts: [{ id: "a" }, { id: "b" }] }),
    });
    await act(async () => void (await result.current.pickFile()));
    expect(result.current.resolutions).toEqual({ a: "skip", b: "skip" });
  });

  it("sends skip for a conflict the user never touched", async () => {
    const { result, run } = setup({
      analysis: analysis({ conflicts: [{ id: "a" }, { id: "b" }] }),
    });
    await act(async () => void (await result.current.pickFile()));
    act(() => result.current.setResolution("a", "overwrite"));
    await act(async () => void (await result.current.conflictsNext()));
    expect(run).toHaveBeenCalledWith("/tmp/export.json", undefined, [
      { id: "a", action: "overwrite" },
      { id: "b", action: "skip" },
    ]);
  });

  it("applies a bulk action to every conflict", async () => {
    const { result } = setup({
      analysis: analysis({ conflicts: [{ id: "a" }, { id: "b" }] }),
    });
    await act(async () => void (await result.current.pickFile()));
    act(() => result.current.setAllResolutions("rename"));
    expect(result.current.resolutions).toEqual({ a: "rename", b: "rename" });
  });

  it("passes the passphrase through only when the file is encrypted", async () => {
    const { result, run } = setup({
      analysis: analysis({ encrypted: true, conflicts: [{ id: "a" }] }),
    });
    await act(async () => void (await result.current.pickFile()));
    act(() => result.current.setPassphrase("hunter2"));
    await act(async () => void (await result.current.passphraseNext()));
    expect(result.current.step).toBe("conflicts");
    await act(async () => void (await result.current.conflictsNext()));
    expect(run).toHaveBeenCalledWith("/tmp/export.json", "hunter2", [
      { id: "a", action: "skip" },
    ]);
  });
});

describe("useImportWizard failure and reset", () => {
  it("surfaces the error and stays put", async () => {
    const run = vi.fn().mockRejectedValue(new Error("bad passphrase"));
    const { result, afterImport } = setup({ analysis: analysis(), run });
    await act(async () => void (await result.current.pickFile()));
    await waitFor(() => expect(result.current.error).toContain("bad passphrase"));
    expect(result.current.step).not.toBe("done");
    expect(result.current.loading).toBe(false);
    // A failed import must not tell the caller to refresh anything.
    expect(afterImport).not.toHaveBeenCalled();
  });

  it("clears every field on reset", async () => {
    const { result } = setup({
      analysis: analysis({ encrypted: true, conflicts: [{ id: "a" }] }),
    });
    await act(async () => void (await result.current.pickFile()));
    act(() => result.current.setPassphrase("x"));
    act(() => result.current.reset());
    expect(result.current.step).toBe("pick");
    expect(result.current.filePath).toBe("");
    expect(result.current.analysis).toBeNull();
    expect(result.current.passphrase).toBe("");
    expect(result.current.resolutions).toEqual({});
    expect(result.current.error).toBeNull();
  });
});

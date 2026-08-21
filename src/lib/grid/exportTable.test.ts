import { describe, expect, it, vi } from "vitest";

import { runExport } from "./exportTable";

describe("runExport", () => {
  it("announces the written path", async () => {
    const announce = vi.fn();
    const fail = vi.fn();
    await runExport(async () => "/tmp/out.sql", announce, fail);
    expect(announce).toHaveBeenCalledWith("/tmp/out.sql");
    expect(fail).not.toHaveBeenCalled();
  });

  it("stays silent when the user cancels the save dialog", async () => {
    const fail = vi.fn();
    // Rust reports a dismissed dialog as an ordinary Err; telling someone who
    // just cancelled that the export failed would be a lie.
    await runExport(
      async () => {
        throw new Error("export cancelled");
      },
      vi.fn(),
      fail,
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("surfaces any other failure", async () => {
    const fail = vi.fn();
    await runExport(
      async () => {
        throw new Error("permission denied");
      },
      vi.fn(),
      fail,
    );
    expect(fail).toHaveBeenCalledWith("Error: permission denied");
  });
});

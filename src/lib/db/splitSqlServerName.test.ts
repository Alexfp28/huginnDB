import { describe, expect, it } from "vitest";
import { splitSqlServerName } from "./driver";

/**
 * The UI twin of `split_instance` in `src-tauri/src/db/mssql/mod.rs`, which is
 * authoritative (it also serves the CLI and the MCP connector). The Rust side
 * has had tests since it landed; this side had none, so the two could drift
 * without anything failing — and a drift here is not a visible bug, it is the
 * dialog showing the user one split while the connection uses another.
 *
 * These cases mirror the Rust module's, so a change on either side that is not
 * mirrored fails somewhere. The one representational difference: Rust returns
 * `Option<String>` for the instance and this returns `""`.
 */
describe("splitSqlServerName", () => {
  it("accepts the SSMS HOST\\INSTANCE form in either field", () => {
    // Pasted whole into the host field.
    expect(splitSqlServerName("SRV\\INST", "")).toEqual({
      host: "SRV",
      instance: "INST",
    });
    // Pasted whole into the instance field.
    expect(splitSqlServerName("", "SRV\\INST")).toEqual({
      host: "SRV",
      instance: "INST",
    });
    // Already split by hand — the shape the dialog's placeholder asks for.
    expect(splitSqlServerName("SRV", "INST")).toEqual({
      host: "SRV",
      instance: "INST",
    });
  });

  it("lets an explicit instance field win over a suffix on the host", () => {
    expect(splitSqlServerName("SRV\\ONE", "TWO")).toEqual({
      host: "SRV",
      instance: "TWO",
    });
  });

  it("never lets a prefix on the instance field override a resolved host", () => {
    // The host argument is what an SSH tunnel substitutes; a stray prefix in
    // the instance field must not steer the connection away from it.
    expect(splitSqlServerName("127.0.0.1", "OTHER\\INST")).toEqual({
      host: "127.0.0.1",
      instance: "INST",
    });
  });

  it("leaves a blank or default instance blank", () => {
    expect(splitSqlServerName("SRV", "")).toEqual({
      host: "SRV",
      instance: "",
    });
    expect(splitSqlServerName("SRV", "   ")).toEqual({
      host: "SRV",
      instance: "",
    });
    // A trailing backslash is a default instance spelled clumsily, not an
    // instance named "".
    expect(splitSqlServerName("SRV\\", "")).toEqual({
      host: "SRV",
      instance: "",
    });
  });

  it("trims both fields", () => {
    expect(splitSqlServerName("  SRV  ", " INST ")).toEqual({
      host: "SRV",
      instance: "INST",
    });
  });

  it("is idempotent, so a blur handler can re-run it on its own output", () => {
    const once = splitSqlServerName("SRV\\INST", "");
    expect(splitSqlServerName(once.host, once.instance)).toEqual(once);
  });
});

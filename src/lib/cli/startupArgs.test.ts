/**
 * These exist because the failure mode is an IPC deserialize error at runtime
 * that `tsc` cannot see: `StartupArgs.connect_by_id` is a bare `bool` in Rust,
 * and serde only fills a missing key for `Option` fields. The mirror-image
 * test lives beside the struct in `src-tauri/src/state.rs`.
 */

import { describe, expect, it } from "vitest";
import { emptyStartupArgs, profileIntent } from "./startupArgs";

/** Every key the Rust struct declares. */
const FIELDS = [
  "connect_profile",
  "connect_by_id",
  "adhoc_host",
  "adhoc_port",
  "adhoc_database",
  "adhoc_username",
  "adhoc_driver",
  "adhoc_connection_string",
  "adhoc_auth_source",
  "adhoc_name",
  "adhoc_password",
];

describe("emptyStartupArgs", () => {
  it("sets all eleven fields", () => {
    expect(Object.keys(emptyStartupArgs()).sort()).toEqual([...FIELDS].sort());
  });

  it("carries no connection intent", () => {
    const args = emptyStartupArgs();
    expect(args.connect_profile).toBeNull();
    expect(args.connect_by_id).toBe(false);
  });
});

describe("profileIntent", () => {
  it("sets all eleven fields, so the payload deserializes", () => {
    // The one that matters. `connect_by_id` is not an `Option` on the Rust
    // side, so omitting it fails the whole deserialize and the new window
    // boots with no intent at all.
    expect(Object.keys(profileIntent("abc")).sort()).toEqual([...FIELDS].sort());
  });

  it("resolves the profile by id, never by name", () => {
    // Display names are not unique; resolving by name could open a different
    // server than the row the user right-clicked.
    const args = profileIntent("7f3c-uuid");
    expect(args.connect_profile).toBe("7f3c-uuid");
    expect(args.connect_by_id).toBe(true);
  });

  it("carries no password and no ad-hoc parameters", () => {
    const args = profileIntent("abc");
    expect(args.adhoc_password).toBeNull();
    expect(args.adhoc_host).toBeNull();
    expect(args.adhoc_connection_string).toBeNull();
  });
});

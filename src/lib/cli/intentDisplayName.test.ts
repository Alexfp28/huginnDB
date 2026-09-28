import { describe, expect, it } from "vitest";
import { intentDisplayName } from "@/lib/cli/useCliIntents";
import type { ConnectionProfile, StartupArgs } from "@/types";

const args = (patch: Partial<StartupArgs>) => patch as StartupArgs;
const profiles = [
  { id: "62a5d650-23a7", name: "Tencer | MySQL" },
] as ConnectionProfile[];

describe("intentDisplayName", () => {
  it("names a --connect-profile-id launch by its profile, not its id", () => {
    // The taskbar Jump List launches this way, so the id is what arrives.
    expect(
      intentDisplayName(
        args({ connect_profile: "62a5d650-23a7", connect_by_id: true }),
        profiles,
      ),
    ).toBe("Tencer | MySQL");
  });

  it("falls back to the raw id when no profile has it", () => {
    expect(
      intentDisplayName(
        args({ connect_profile: "gone", connect_by_id: true }),
        profiles,
      ),
    ).toBe("gone");
  });

  it("keeps a --connect-profile name as given", () => {
    expect(
      intentDisplayName(args({ connect_profile: "62a5d650-23a7" }), profiles),
    ).toBe("62a5d650-23a7");
  });
});

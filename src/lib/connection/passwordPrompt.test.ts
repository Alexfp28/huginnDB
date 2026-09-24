/**
 * Where a password typed into the prompt goes decides whether it survives the
 * next origin sync, so it is pinned here: the person's own user (or a
 * connection of their own) is a plain keychain write, a shared connection on
 * the published user is the password override — a keychain write there would
 * be overwritten four times a day.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile, PersonalCredentials } from "@/types";

const api = vi.hoisted(() => ({
  personalCredentials: vi.fn<(id: string) => Promise<PersonalCredentials>>(),
  setSecretOverride: vi.fn(async (_args: unknown) => ({})),
  rememberPassword: vi.fn(async (_id: string, _pw: string) => {}),
}));
vi.mock("@/lib/tauri", () => ({ api }));

import { askForPassword, rememberAskedPassword } from "./passwordPrompt";
import { usePasswordRequest } from "@/stores/dialogs/passwordRequest";

const shared = {
  id: "erp",
  name: "ERP",
  username: "erp_app",
  origin_id: "o1",
} as unknown as ConnectionProfile;

beforeEach(() => {
  vi.clearAllMocks();
  usePasswordRequest.setState({ current: null });
});

describe("askForPassword", () => {
  it("asks for the person's own user when one is in force", async () => {
    api.personalCredentials.mockResolvedValue({
      username: "alopez",
      source: "policy",
      publishedUsername: "erp_app",
      hasPassword: false,
    });
    const asked = askForPassword(shared);
    await vi.waitFor(() => expect(usePasswordRequest.getState().current).not.toBeNull());
    expect(usePasswordRequest.getState().current?.username).toBe("alopez");
    usePasswordRequest.getState().resolve({ password: "pw", remember: true });
    expect(await asked).toEqual({ password: "pw", remember: true, personal: true });
  });

  it("answers null when the prompt is dismissed", async () => {
    api.personalCredentials.mockRejectedValue(new Error("gone"));
    const asked = askForPassword(shared);
    await vi.waitFor(() => expect(usePasswordRequest.getState().current).not.toBeNull());
    // Falls back to the connection's own user when the backend cannot say.
    expect(usePasswordRequest.getState().current?.username).toBe("erp_app");
    usePasswordRequest.getState().resolve(null);
    expect(await asked).toBeNull();
  });
});

describe("rememberAskedPassword", () => {
  it("keeps a shared connection's password as an override", async () => {
    await rememberAskedPassword(shared, { password: "pw", remember: true, personal: false });
    expect(api.setSecretOverride).toHaveBeenCalledWith({ profileId: "erp", password: "pw" });
    expect(api.rememberPassword).not.toHaveBeenCalled();
  });

  it("stores a personal user's password under their own account", async () => {
    await rememberAskedPassword(shared, { password: "pw", remember: true, personal: true });
    expect(api.rememberPassword).toHaveBeenCalledWith("erp", "pw");
    expect(api.setSecretOverride).not.toHaveBeenCalled();
  });

  it("stores nothing when asked not to", async () => {
    await rememberAskedPassword(shared, { password: "pw", remember: false, personal: true });
    expect(api.rememberPassword).not.toHaveBeenCalled();
    expect(api.setSecretOverride).not.toHaveBeenCalled();
  });
});

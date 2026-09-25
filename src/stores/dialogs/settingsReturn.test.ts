/**
 * The full-screen editors opened from Settings (shared origins, managed
 * policy) are siblings of Settings, never stacked on it. They put Settings
 * aside on the way in and give it back on the way out, and only when it was
 * Settings they were opened from.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { usePolicyEditor } from "@/stores/dialogs/policyEditor";
import type { PolicyStatus } from "@/types";

const settings = () => useSettingsDialog.getState();
const status = { user: "alopez", state: "unmanaged" } as unknown as PolicyStatus;

beforeEach(() => {
  useSettingsDialog.setState({ open: false, section: "general", suspendedAt: null });
  useOriginEditor.setState({ originId: null, returnTo: null });
  usePolicyEditor.setState({ status: null });
});

describe("suspend / resume", () => {
  it("brings Settings back on the section it left", () => {
    settings().openAt("policy");
    settings().suspend();
    expect(settings().open).toBe(false);
    settings().resume();
    expect(settings()).toMatchObject({ open: true, section: "policy", suspendedAt: null });
  });

  it("does nothing when Settings was not open", () => {
    settings().suspend();
    settings().resume();
    expect(settings().open).toBe(false);
  });

  it("forgets the way back once Settings is opened or closed explicitly", () => {
    settings().openAt("origins");
    settings().suspend();
    settings().setOpen(false);
    settings().resume();
    expect(settings().open).toBe(false);
  });
});

describe("the editors", () => {
  it("return to Settings → Origins from the origin editor, saved or not", () => {
    settings().openAt("origins");
    useOriginEditor.getState().open("o1");
    expect(settings().open).toBe(false);
    useOriginEditor.getState().close();
    expect(settings()).toMatchObject({ open: true, section: "origins" });
  });

  it("leave Settings closed when the editor was reached from elsewhere", () => {
    // e.g. the "edit at origin" banner of a connection.
    useOriginEditor.getState().open("o1");
    useOriginEditor.getState().close();
    expect(settings().open).toBe(false);
  });

  it("return to Settings → Policy from the policy editor", () => {
    settings().openAt("policy");
    usePolicyEditor.getState().open(status);
    expect(settings().open).toBe(false);
    expect(usePolicyEditor.getState().status).toBe(status);
    usePolicyEditor.getState().close();
    expect(usePolicyEditor.getState().status).toBeNull();
    expect(settings()).toMatchObject({ open: true, section: "policy" });
  });
});

/**
 * @vitest-environment jsdom
 *
 * Settings → Policy renders what `policy_status` reports, for each state a
 * machine can be in. The panel is read-only, so the tests are about what a
 * user is *told*: who they are, which role, what each connection allows, and
 * — the case that matters most — that a broken policy blocks the AI.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { PolicySection } from "./PolicySection";
import type { PolicyStatus } from "@/types";

const policyStatus = vi.fn<() => Promise<PolicyStatus>>();

vi.mock("@/lib/tauri", () => ({
  api: { policyStatus: () => policyStatus() },
}));

afterEach(() => {
  cleanup();
  policyStatus.mockReset();
});

function status(over: Partial<PolicyStatus> = {}): PolicyStatus {
  return {
    state: "active",
    source: "\\\\srv\\it\\huginn.json (named by C:\\Program Files\\HuginnDB\\managed-policy.json)",
    error: null,
    warnings: [],
    user: "ana",
    role: "sales",
    unmanagedConnections: "deny",
    connections: [
      {
        id: "erp",
        name: "ERP",
        unmatched: false,
        leftAlone: false,
        rules: [
          {
            databases: ["billing"],
            allow: ["invoices", "v_invoice_*"],
            deny: ["v_invoice_cards"],
            human: ["select", "insert", "update"],
            ai: ["select"],
            freeSql: false,
          },
        ],
      },
      { id: "hr", name: "HR", unmatched: true, leftAlone: false, rules: [] },
    ],
    ...over,
  };
}

describe("PolicySection", () => {
  it("shows the account, the role and what each connection allows", async () => {
    policyStatus.mockResolvedValue(status());
    render(<PolicySection />);

    expect(await screen.findByText("sales")).toBeTruthy();
    expect(screen.getByText("ana")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/1 with rules · 1 without/)).toBeTruthy();
    // One line per connection until it is opened.
    expect(screen.getByText("AI: select · free SQL: no")).toBeTruthy();
    expect(screen.queryByText("invoices, v_invoice_*")).toBeNull();

    fireEvent.click(screen.getByText("ERP"));
    expect(screen.getByText("billing")).toBeTruthy();
    expect(screen.getByText("invoices, v_invoice_*")).toBeTruthy();
    expect(screen.getByText("v_invoice_cards")).toBeTruthy();
    // What the AI gets and what the person gets, told apart.
    expect(screen.getByText("select")).toBeTruthy();
    expect(screen.getByText("select, insert, update")).toBeTruthy();
    expect(screen.getByText(/^disabled/)).toBeTruthy();
    // And the panel is honest about phase 1.
    expect(screen.getByText(/applies the policy to the AI only/)).toBeTruthy();
  });

  it("opens on the connections a rule names, the rest one click away", async () => {
    policyStatus.mockResolvedValue(status());
    render(<PolicySection />);

    expect(await screen.findByText("ERP")).toBeTruthy();
    expect(screen.queryByText("HR")).toBeNull();

    fireEvent.click(screen.getByText("Without (1)"));
    expect(screen.getByText("HR")).toBeTruthy();
    // Under `deny`, a connection no rule names is out of the AI's reach.
    expect(screen.getByText("no rule — blocked for the AI")).toBeTruthy();
    expect(screen.queryByText("ERP")).toBeNull();
  });

  it("stays usable with many connections", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      name: `Client ${String(i).padStart(2, "0")}`,
      unmatched: i >= 3,
      leftAlone: false,
      rules:
        i < 3
          ? [
              {
                databases: null,
                allow: null,
                deny: [],
                human: ["select"],
                ai: ["select"],
                freeSql: true,
              },
            ]
          : [],
    }));
    policyStatus.mockResolvedValue(status({ connections: many }));
    render(<PolicySection />);

    expect(
      await screen.findByText("25 connections · 3 with rules · 22 without"),
    ).toBeTruthy();
    // Only the three a rule names are listed to begin with.
    expect(screen.getAllByText(/^Client /)).toHaveLength(3);

    fireEvent.click(screen.getByText("All"));
    expect(screen.getAllByText(/^Client /)).toHaveLength(25);

    fireEvent.change(screen.getByPlaceholderText("Filter connections"), {
      target: { value: "client 2" },
    });
    // "Client 20" … "Client 24", matched without regard to case.
    expect(screen.getAllByText(/^Client /)).toHaveLength(5);

    fireEvent.change(screen.getByPlaceholderText("Filter connections"), {
      target: { value: "nothing like it" },
    });
    expect(screen.getByText("No connection matches.")).toBeTruthy();
  });

  it("says a broken policy blocks the AI, and why", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "broken",
        error: "the policy is not valid: unknown field `relatons`",
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Could not be applied")).toBeTruthy();
    expect(screen.getByText(/the AI is blocked on every connection/)).toBeTruthy();
    expect(screen.getByText(/unknown field `relatons`/)).toBeTruthy();
    // Nothing about connections is shown when there is no policy in force.
    expect(screen.queryByText("ERP")).toBeNull();
  });

  it("explains an unmanaged machine instead of showing an empty table", async () => {
    policyStatus.mockResolvedValue(
      status({
        state: "unmanaged",
        source: null,
        role: null,
        unmanagedConnections: null,
        connections: [],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Not managed")).toBeTruthy();
    expect(screen.getByText(/HKLM\\SOFTWARE\\Policies\\HuginnDB/)).toBeTruthy();
  });

  it("surfaces the warnings a valid policy carries", async () => {
    policyStatus.mockResolvedValue(
      status({
        warnings: [
          'role "sales", rule 1: `ai` grants something `human` does not; the AI never gets more than the person, so the extra is ignored',
        ],
      }),
    );
    render(<PolicySection />);

    expect(await screen.findByText("Warnings")).toBeTruthy();
    expect(screen.getByText(/the extra is ignored/)).toBeTruthy();
  });
});

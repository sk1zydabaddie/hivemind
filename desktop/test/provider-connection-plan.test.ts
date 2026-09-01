import { describe, expect, test } from "vitest";

import {
  initialProviderSelection,
  planProviderConnections,
  providerCanBeSelectedForProof
} from "../src/components/workspace/setup-screen";
import {
  providerIsConnected,
  providerStanding
} from "../src/components/workspace/provider-list";
import type {
  CatalogueModelView,
  CatalogueProvider,
  RoleRecommendation
} from "../src/lib/workspace-actions";

const providers: CatalogueProvider[] = [
  {
    id: "codex-cli",
    label: "Codex",
    subscription: "ChatGPT",
    status: "supported",
    caveat: null,
    pins_model: true,
    connectable: true,
    authentication: { experience: "browser", detail: "Provider-owned sign-in" },
    checked_here: false
  },
  {
    id: "claude",
    label: "Claude Code",
    subscription: "Claude",
    status: "unverified",
    caveat: "Probe it",
    pins_model: false,
    connectable: true,
    authentication: { experience: "browser", detail: "Provider-owned sign-in" },
    checked_here: false
  }
];

const models: CatalogueModelView[] = [
  {
    agent_id: "codex-terra",
    provider_id: "codex-cli",
    slug: "gpt-5.6-terra",
    label: "Terra",
    routing_tier: "standard",
    context_window: 272000,
    price: null,
    price_stale: null,
    price_age_days: null
  },
  {
    agent_id: "claude-code",
    provider_id: "claude",
    slug: null,
    label: "Whatever the harness chooses",
    routing_tier: "standard",
    context_window: 200000,
    price: null,
    price_stale: null,
    price_age_days: null
  }
];

const recommendations: RoleRecommendation[] = [
  { role: "planner", agent_id: "codex-terra", why: "test", reviewed: "2026-08-17" }
];

describe("provider connection planning", () => {
  test("a CLI-reported sign-in replaces the login action without claiming a capability check", () => {
    const codex = providers[0]!;
    expect(providerIsConnected(codex, "signed_in")).toBe(true);
    expect(providerStanding(codex, "signed_in")).toBe("Signed in");
    expect(providerIsConnected(codex, "signed_out")).toBe(false);
    expect(providerStanding({ ...codex, checked_here: true }, "unknown")).toBe("Checked here");
  });

  test("every selected runnable provider receives a real probe", () => {
    const plan = planProviderConnections({
      chosen: new Set(["codex-cli", "claude"]),
      providers,
      models,
      recommendations,
      remainingRoles: ["planner", "manager", "worker"]
    });
    expect(new Set(plan.map((entry) => entry.providerId))).toEqual(
      new Set(["codex-cli", "claude"])
    );
    expect(plan.filter((entry) => entry.providerId === "claude")).toEqual([
      { role: "worker", agentId: "claude-code", providerId: "claude" }
    ]);
  });

  test("no provider is preselected for a paid check", () => {
    expect([...initialProviderSelection()]).toEqual([]);
  });

  test("an installed signed-out provider asks for sign-in instead of offering a paid proof", () => {
    const grok = { ...providers[1]!, id: "grok", label: "Grok Build" };
    expect(providerCanBeSelectedForProof(grok, {
      provider_id: "grok",
      status: "signed_out",
      installed: true,
      detail: "The CLI reports no active sign-in"
    })).toBe(false);
    expect(providerIsConnected(grok, "signed_out")).toBe(false);
    expect(providerStanding(grok, "signed_out")).toBe("Not signed in");
    expect(providerCanBeSelectedForProof(grok, {
      provider_id: "grok",
      status: "missing",
      installed: false,
      detail: "Missing"
    })).toBe(false);
  });
});

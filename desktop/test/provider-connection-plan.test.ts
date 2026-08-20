import { describe, expect, test } from "vitest";

import { planProviderConnections } from "../src/components/workspace/setup-screen";
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
  },
  {
    id: "kimi",
    label: "Kimi Code",
    subscription: "Kimi",
    status: "unverified",
    caveat: "No invocation",
    pins_model: false,
    connectable: false,
    authentication: { experience: "device_code", detail: "Provider-owned sign-in" },
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
  },
  {
    agent_id: "kimi-code",
    provider_id: "kimi",
    slug: null,
    label: "Whatever the harness chooses",
    routing_tier: "standard",
    context_window: 256000,
    price: null,
    price_stale: null,
    price_age_days: null
  }
];

const recommendations: RoleRecommendation[] = [
  { role: "planner", agent_id: "codex-terra", why: "test", reviewed: "2026-08-17" }
];

describe("provider connection planning", () => {
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

  test("an unavailable provider never becomes a dead probe action", () => {
    const plan = planProviderConnections({
      chosen: new Set(["kimi"]),
      providers,
      models,
      recommendations,
      remainingRoles: ["planner", "manager", "worker"]
    });
    expect(plan).toEqual([]);
  });
});

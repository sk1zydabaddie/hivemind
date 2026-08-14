import { describe, expect, test } from "vitest";

import replayData from "../tools/replay-data.json";
import { buildUsagePanel, formatTokens } from "../src/lib/provider-usage";
import {
  applyEventMessage,
  createBoardProjection,
  type BoardProjection
} from "../src/lib/projection";
import type { InspectedAdapter, WorkspaceInspection } from "../src/lib/workspace-actions";

/**
 * The rule this whole panel exists for: a provider whose spending cannot be
 * read is marked unreadable, never drawn as a confident zero.
 *
 * Three days were lost to an exhausted quota with no visibility. A meter that
 * says "0" when it means "I cannot see" would lose the next three.
 */

function adapter(overrides: Partial<InspectedAdapter> = {}): InspectedAdapter {
  return {
    role: "worker",
    installed: true,
    tool: "worker",
    agent_id: "codex-terra",
    model: "gpt-5.6-terra",
    capabilities_stale: null,
    account: null,
    routing_tier: "standard",
    problems: [],
    connected_at: "2026-08-12T10:00:00.000Z",
    capabilities: [
      {
        id: "reports_usage",
        label: "Reports what it spent",
        status: "verified",
        evidence: "observation",
        requested: "codex-jsonl",
        reported: "40,951 tokens",
        detail: "",
        required: true
      }
    ],
    ...overrides
  };
}

function projectionWith(observations: Array<[string, number]>): BoardProjection {
  return {
    ...createBoardProjection(),
    routingObservations: observations.map(([provider, tokens], index) => ({
      ts: `2026-08-12T10:0${index}:00.000Z`,
      task_id: "T-001",
      provider,
      routing_task_type: "cli",
      effective_tokens: tokens,
      accounting_source: "provider_reported",
      wall_time_ms: 1000
    }))
  };
}

describe("what each provider spent", () => {
  test("a verified reader is measured and its tokens are the trail's own", () => {
    const panel = buildUsagePanel(null, projectionWith([["worker", 40_000], ["worker", 2_951]]), [
      adapter()
    ]);
    expect(panel.providers[0]!.standing).toBe("measured");
    expect(panel.providers[0]!.tokens).toBe(42_951);
    expect(panel.providers[0]!.observations).toBe(2);
    expect(panel.providers[0]!.caveat).toBeNull();
  });

  test("a provider whose usage cannot be read is UNREADABLE, not zero", () => {
    /* The whole point. `reports_usage` unverified means no figure here would be
       true, so the surface must say that rather than draw a bar at nought. */
    const panel = buildUsagePanel(
      null,
      projectionWith([]),
      [
        adapter({
          capabilities: [
            {
              id: "reports_usage",
              label: "Reports what it spent",
              status: "unverified",
              evidence: "absent",
              requested: null,
              reported: null,
              detail: "",
              required: true
            }
          ]
        })
      ]
    );
    expect(panel.providers[0]!.standing).toBe("unreadable");
    expect(panel.providers[0]!.caveat).toMatch(/no figure here would be true/u);
    expect(panel.providers[0]!.caveat).toMatch(/provider's own page/u);
  });

  test("an agent installed before any probe says so, rather than claiming nothing was spent", () => {
    const panel = buildUsagePanel(null, projectionWith([]), [
      adapter({ connected_at: null, capabilities: [] })
    ]);
    expect(panel.providers[0]!.standing).toBe("unchecked");
    expect(panel.providers[0]!.caveat).toMatch(/Reconnect it/u);
  });

  test("work attributed to no connected provider is reported, not absorbed", () => {
    /* A total that quietly swallows work nobody can attribute is precisely the
       number that hides a problem. */
    const panel = buildUsagePanel(
      null,
      projectionWith([["worker", 1000], ["some-other-tool", 9000]]),
      [adapter()]
    );
    expect(panel.providers[0]!.tokens).toBe(1000);
    expect(panel.unattributedTokens).toBe(9000);
  });

  test("matches the name the trail actually uses, not just the role", () => {
    /* The textkit trail records `provider: "codex-terra"` -- the agent, not the
       role -- so matching on the role alone left the whole run unattributed
       and the agent reading zero. The real value is pinned here. */
    const panel = buildUsagePanel(null, projectionWith([["codex-terra", 106_792]]), [adapter()]);
    expect(panel.providers[0]!.tokens).toBe(106_792);
    expect(panel.unattributedTokens).toBe(0);
  });

  test("an adapter that is not installed is not a provider", () => {
    const panel = buildUsagePanel(null, projectionWith([]), [
      adapter({ installed: false, tool: null })
    ]);
    expect(panel.providers).toEqual([]);
  });
});

describe("the session's own ledger", () => {
  test("comes from Core's spend record, never from summing events", () => {
    /* Two different questions. The per-provider figure answers "who spent it";
       the session figure answers "what does the ceiling see", and only Core's
       ledger can answer the second. */
    const inspection = {
      spend: {
        session_id: "s",
        calls: 5,
        effective_tokens: 622_600,
        reserved_tokens: 0,
        committed_tokens: 622_600,
        run_ceiling_tokens: 2_500_000,
        session_ceiling_tokens: 2_500_000,
        near_session_ceiling: false
      }
    } as unknown as WorkspaceInspection;

    const panel = buildUsagePanel(inspection, projectionWith([["worker", 10]]), [adapter()]);
    expect(panel.session).toEqual({
      calls: 5,
      tokens: 622_600,
      runCeiling: 2_500_000,
      sessionCeiling: 2_500_000,
      nearCeiling: false
    });
    /* Deliberately different from the provider sum: they measure different
       things and reconciling them silently would hide a gap. */
    expect(panel.providers[0]!.tokens).toBe(10);
  });

  test("quota is shown only when the provider actually said something", () => {
    expect(buildUsagePanel(null, projectionWith([]), []).quota).toBeNull();
  });
});

describe("against a real replayed run", () => {
  test("attributes the textkit run's tokens to the provider that did the work", () => {
    const scenario = (replayData as {
      scenarios: Array<{
        id: string;
        events?: unknown[];
        inspection?: WorkspaceInspection | null;
      }>;
    }).scenarios.find((entry) => entry.id === "e2e-textkit-parallel-run")!;

    /* Replayed through the real reducer rather than read from a stored
       projection, because the scenario has none -- the harness builds it the
       same way the app does. So this exercises the path that actually runs. */
    let projection = createBoardProjection();
    for (const event of scenario.events ?? []) {
      projection = applyEventMessage(projection, {
        kind: "event",
        source: "replay",
        event
      } as never);
    }

    /* The trail really does carry routing observations, which is what makes
       per-provider attribution possible at all. If this ever returns nothing,
       the panel has no source and should say so rather than draw zeroes. */
    expect(projection.routingObservations.length).toBeGreaterThan(0);

    const panel = buildUsagePanel(scenario.inspection ?? null, projection, [adapter()]);
    const total = projection.routingObservations.reduce(
      (sum, entry) => sum + (entry.effective_tokens ?? 0),
      0
    );
    expect(panel.providers[0]!.tokens + panel.unattributedTokens).toBe(total);
  });
});

describe("reading a figure", () => {
  test("never rounds a number up into a larger one", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2K");
    expect(formatTokens(40_951)).toBe("41K");
    expect(formatTokens(622_600)).toBe("623K");
    expect(formatTokens(3_532_577)).toBe("3.53M");
  });
});

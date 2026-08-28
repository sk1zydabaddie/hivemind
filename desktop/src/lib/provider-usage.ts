import type { BoardProjection } from "./projection";
import type { InspectedAdapter, WorkspaceInspection } from "./workspace-actions";

/**
 * What each connected provider has spent, and whether that number can be
 * believed.
 *
 * This exists because three days were lost to an exhausted Codex quota with no
 * visibility. The fix is not a prettier meter — it is a meter that refuses to
 * draw itself when the number behind it is not trustworthy.
 *
 * Everything here is derived from `routing.observed`, a durable event that
 * records which provider did a task and what it cost. That is presentation of
 * the trail, not a second opinion about it: the client sums events the daemon
 * wrote and never estimates a figure of its own.
 *
 * The honesty rule, and the whole point:
 *
 * > A provider whose `reports_usage` capability is not `verified` has its
 * > figure marked **unreadable**, not drawn small. A confident bar built on an
 * > unverifiable number is how the next three days get lost.
 */

export type UsageStanding =
  /** The probe confirmed this agent reports what it spends. */
  | "measured"
  /** Connected, but nothing here can read what it spends. */
  | "unreadable"
  /** Installed before any probe ran, so nothing about it was checked. */
  | "unchecked";

export interface ProviderUsage {
  /** The role a person chose it for: planner, manager, worker. */
  role: string;
  /** The agent as the catalogue names it, where a probe recorded one. */
  agentId: string | null;
  model: string | null;
  standing: UsageStanding;
  /** Tokens attributed to this provider by `routing.observed`. */
  tokens: number;
  /** How many task-level observations that figure is made of. */
  observations: number;
  /** When it was connected, or null if it was never probed. */
  connectedAt: string | null;
  /** One sentence for the person, in place of a number that cannot be trusted. */
  caveat: string | null;
}

export interface UsagePanel {
  providers: ProviderUsage[];
  /** This run's spend, from Core's own ledger rather than from events. */
  session: {
    calls: number;
    tokens: number;
    runCeiling: number;
    sessionCeiling: number;
    nearCeiling: boolean;
  } | null;
  /** Quota state as the provider last reported it, where it reported one. */
  quota: {
    provider: string | null;
    plan: string | null;
    at: string | null;
    windows: Array<{
      name: string;
      usedPercent: number;
      windowMinutes: number | null;
      resetsAt: string | null;
    }>;
  } | null;
  /**
   * Tokens the trail attributes to no connected provider. Reported rather than
   * folded into a total, because a number that quietly absorbs work nobody can
   * attribute is exactly the number that hides a problem.
   */
  unattributedTokens: number;
}

const USAGE_CAPABILITY = "reports_usage";

export function buildUsagePanel(
  inspection: WorkspaceInspection | null,
  projection: BoardProjection,
  adapters: InspectedAdapter[]
): UsagePanel {
  const byProvider = new Map<string, { tokens: number; observations: number }>();
  for (const observation of projection.routingObservations) {
    const key = observation.provider;
    const current = byProvider.get(key) ?? { tokens: 0, observations: 0 };
    current.tokens += observation.effective_tokens ?? 0;
    current.observations += 1;
    byProvider.set(key, current);
  }

  const providers: ProviderUsage[] = [];
  const claimed = new Set<string>();
  for (const adapter of adapters) {
    if (!adapter.installed) continue;
    /* `routing.observed` names the provider by whatever the profile is called,
       and that is not always the role. On the textkit trail it reads
       `codex-terra` -- the agent -- while the adapter's tool is `worker`. So
       both names are tried, and both are claimed, or a run's whole spend lands
       in "unattributed" while the agent that did it reads zero. Caught by
       looking at the panel rather than by the types, which were happy. */
    const names = [adapter.tool, adapter.agent_id].filter(
      (name): name is string => name !== null
    );
    const observed = names
      .map((name) => byProvider.get(name))
      .find((entry) => entry !== undefined);
    for (const name of names) claimed.add(name);
    const standing = usageStanding(adapter);
    providers.push({
      role: adapter.role,
      agentId: adapter.agent_id,
      model: adapter.model,
      standing,
      tokens: observed?.tokens ?? 0,
      observations: observed?.observations ?? 0,
      connectedAt: adapter.connected_at,
      caveat: caveatFor(standing)
    });
  }

  const unattributed = [...byProvider.entries()]
    .filter(([tool]) => !claimed.has(tool))
    .reduce((total, [, entry]) => total + entry.tokens, 0);

  const spend = inspection?.spend ?? null;
  const quotaEvent = projection.quota.lastEvent;

  return {
    providers,
    session:
      spend === null
        ? null
        : {
            calls: spend.calls,
            tokens: spend.effective_tokens,
            runCeiling: spend.run_ceiling_tokens,
            sessionCeiling: spend.session_ceiling_tokens,
            nearCeiling: spend.near_session_ceiling
          },
    quota:
      projection.quota.source !== "provider" || projection.quota.windows.length === 0
        ? null
        : {
            provider: projection.quota.provider,
            plan: projection.quota.plan,
            at: quotaEvent?.ts ?? null,
            windows: projection.quota.windows
          },
    unattributedTokens: unattributed
  };
}

function usageStanding(adapter: InspectedAdapter): UsageStanding {
  if (adapter.connected_at === null) return "unchecked";
  const entry = adapter.capabilities.find((capability) => capability.id === USAGE_CAPABILITY);
  return entry?.status === "verified" ? "measured" : "unreadable";
}

function caveatFor(standing: UsageStanding): string | null {
  if (standing === "measured") return null;
  if (standing === "unchecked") {
    return "This agent was installed before Hivemind could check it, so nothing here knows whether its spending can be read. Reconnect it to find out.";
  }
  return "This agent does not report what it spends in a way Hivemind can read, so no figure here would be true. Watch your usage on the provider's own page.";
}

/** A token count as a person reads it. Never rounded up into something larger. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

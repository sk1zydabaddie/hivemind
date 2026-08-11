/**
 * What a new project needs before it can reach a first run.
 *
 * These are usability defaults, not a relaxation of any floor. Tier inference
 * still falls back to "high" for anything the globs do not cover, and the
 * provider floor for each tier is unchanged. Without any globs every path fell
 * through to that fallback, so every task was High, and High requires a strong
 * provider -- which made cheaper providers ineligible rather than merely
 * deprioritised. Naming the ordinary paths is what lets the floor apply where
 * it was meant to.
 */

export interface TierGlobs {
  low_globs: string[];
  medium_globs: string[];
  high_globs: string[];
  critical_globs: string[];
}

export function defaultTierGlobs(): TierGlobs {
  return {
    low_globs: ["docs/**", "**/*.md", "**/*.txt"],
    medium_globs: ["src/**", "app/**", "lib/**", "test/**", "tests/**"],
    high_globs: ["package.json", "tsconfig.json", "**/*.config.*"],
    critical_globs: [".github/**", "infra/**", "**/auth/**"]
  };
}

export const TIER_GLOB_KEYS: Array<keyof TierGlobs> = [
  "low_globs",
  "medium_globs",
  "high_globs",
  "critical_globs"
];

/**
 * The two tools the desktop asks Core for BY NAME -- `plan.prepare` sends
 * `tool: "planner"`, `manager.start` sends `tool: "manager"` -- each resolved
 * to .hivemind/adapters/<tool>.profile.json. Without them a first prompt fails
 * on a missing file whose name appears in no screen and no document.
 */
export const ORCHESTRATOR_ADAPTER_TOOLS = ["planner", "manager"] as const;

/**
 * The default worker.
 *
 * The manager proposes `run_worker` without naming a tool, so executing a task
 * depends on routing *finding* a worker. The orchestrator profiles above are
 * scoped out of that search deliberately -- a default has no business
 * outranking a provider an operator configured, and a quota-walled worker must
 * pause rather than reroute onto the planner. That scoping is only safe
 * because a worker-scoped default exists to be found; without it a clean
 * install could plan but never build.
 */
export const DEFAULT_WORKER_TOOL = "worker";

/**
 * Every comparison routing makes -- default, `cheapest`, `strongest` -- ends in
 * `cost_rank` ascending, and a profile that omits it sits at 100. Ranking the
 * default worker far below that makes it the last thing chosen: present so a
 * clean install can build, and beaten by anything an operator configures.
 *
 * A default that can outrank a deliberately configured provider is the same
 * defect as an orchestrator profile winning the worker search. Scoping fixed
 * the second; this fixes the first.
 */
const LAST_RESORT_COST_RANK = 1_000;

export const REQUIRED_ADAPTER_TOOLS = [
  ...ORCHESTRATOR_ADAPTER_TOOLS,
  DEFAULT_WORKER_TOOL
] as const;

/**
 * Every setting this profile depends on is stated. An unstated setting stays
 * whatever the user's own agent configuration last left it, which is how a run
 * silently changes model or sandbox between invocations.
 */
/**
 * What one call actually costs, measured rather than assumed.
 *
 * From the 2026-08-11 first-run walk and the textkit run before it:
 *
 *   worker, gpt-5.6-sol     152,229   the most expensive call a default can make
 *   worker, gpt-5.6-terra  ~120,000
 *   planner                 ~21,000
 *   spec drafting           ~20,000
 *
 * These exist so the ceilings below are derived from them and cannot drift apart
 * silently. `test/first-run-defaults.test.ts` asserts the pairing, not the
 * numbers: a default ceiling must exceed the worst single call a default
 * configuration can make. A ceiling under one worker call is not a budget, it is
 * a trap that fires after the money is spent.
 */
export const MEASURED_WORST_SINGLE_CALL_TOKENS = 152_229;

const CODEX_INVOKE_TAIL = [
  "exec",
  "--model",
  "gpt-5.6-sol",
  "--sandbox",
  "workspace-write",
  "--config",
  'model_reasoning_effort="high"',
  "--ephemeral",
  "--json",
  "-"
];

/**
 * The tier ladder a fresh project needs.
 *
 * Tier globs were already written correctly, so routing computed the right tier
 * for every task -- and then had nowhere to fall, because the only profiles on
 * disk were strong. Every task ran on the flagship regardless of its tier. These
 * two give the floor somewhere to land: Medium work routes to standard, Low work
 * to cheap, and High/Critical still require strong.
 *
 * Worker-scoped on purpose. Orchestrator roles are resolved by name and must
 * never be found by the worker search.
 */
export const DEFAULT_TIER_WORKERS = [
  { tool: "worker-standard", model: "gpt-5.6-terra", tier: "standard", cost: 10 },
  { tool: "worker-cheap", model: "gpt-5.6-luna", tier: "cheap", cost: 4 }
] as const;

export function defaultTierWorkerProfile(
  entry: (typeof DEFAULT_TIER_WORKERS)[number],
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> {
  const tail = CODEX_INVOKE_TAIL.map((argument) =>
    argument === "gpt-5.6-sol" ? entry.model : argument
  );
  return {
    tool: entry.tool,
    invoke:
      platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "codex.cmd", ...tail]
        : ["codex", ...tail],
    prompt_arg: "stdin",
    verified_on: "configured-by-init",
    roles: ["worker"],
    routing_tier: entry.tier,
    cost_rank: entry.cost,
    context_window: 272_000,
    timeout_ms: 600_000,
    usage_parser: "codex-jsonl"
  };
}

export function defaultAdapterProfile(
  tool: string,
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> {
  return {
    tool,
    invoke:
      platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "codex.cmd", ...CODEX_INVOKE_TAIL]
        : ["codex", ...CODEX_INVOKE_TAIL],
    prompt_arg: "stdin",
    verified_on: "configured-by-init",
    // Every default states its role. The orchestrator profiles are resolved by
    // name and must never be *found* by the worker search; the worker profile
    // exists precisely to be found there.
    roles: tool === DEFAULT_WORKER_TOOL ? ["worker"] : ["orchestrator"],
    routing_tier: "strong",
    cost_rank: LAST_RESORT_COST_RANK,
    context_window: 272_000,
    timeout_ms: 120_000,
    usage_parser: "codex-jsonl"
  };
}

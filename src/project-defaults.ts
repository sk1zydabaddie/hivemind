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
 * The desktop asks Core for these two tools by name, and Core resolves each to
 * .hivemind/adapters/<tool>.profile.json. Without them a first prompt fails on
 * a missing file whose name appears in no screen and no document.
 */
export const REQUIRED_ADAPTER_TOOLS = ["planner", "manager"] as const;

/**
 * Every setting this profile depends on is stated. An unstated setting stays
 * whatever the user's own agent configuration last left it, which is how a run
 * silently changes model or sandbox between invocations.
 */
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
    routing_tier: "strong",
    cost_rank: 20,
    context_window: 272_000,
    timeout_ms: 120_000,
    usage_parser: "codex-jsonl"
  };
}

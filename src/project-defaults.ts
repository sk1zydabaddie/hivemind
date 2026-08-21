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
    medium_globs: ["src/**", "app/**", "lib/**", "test/**", "tests/**", "**/*.html", "**/*.css"],
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
 * What one call actually costs, measured rather than assumed.
 *
 * From the 2026-08-11 first-run walk and the textkit run before it:
 *
 *   worker, gpt-5.6-sol     152,229   the most expensive call a default can make
 *   worker, gpt-5.6-terra  ~120,000
 *   planner                 ~21,000
 *   spec drafting           ~20,000
 *
 * The ceiling still has to clear a measured large call even though provider
 * profiles are no longer invented by init. A ceiling under one admitted worker
 * call is not a budget; it is a trap that fires after the money is spent.
 */
export const MEASURED_WORST_SINGLE_CALL_TOKENS = 152_229;

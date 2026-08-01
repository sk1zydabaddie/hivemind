export const autonomyLevels = ["auto", "review_plan", "review_everything"] as const;
export type AutonomyLevel = (typeof autonomyLevels)[number];
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "auto";

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === "string" && autonomyLevels.includes(value as AutonomyLevel);
}

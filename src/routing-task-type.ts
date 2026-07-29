export const routingTaskTypes = [
  "api",
  "architecture",
  "build_tooling",
  "cli",
  "data_model",
  "documentation",
  "integration",
  "migration",
  "observability",
  "orchestration",
  "performance",
  "refactor",
  "security",
  "storage",
  "testing",
  "ui",
  "other"
] as const;

export type RoutingTaskType = (typeof routingTaskTypes)[number];

const routingTaskTypeSet = new Set<string>(routingTaskTypes);

export function isRoutingTaskType(value: unknown): value is RoutingTaskType {
  return typeof value === "string" && routingTaskTypeSet.has(value);
}

export function routingTaskTypeExpectation(): string {
  return routingTaskTypes.join(", ");
}

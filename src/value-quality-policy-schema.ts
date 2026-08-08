import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

export interface ValueQualityPolicy {
  version: 1;
  kind: "value_quality_policy";
  source_evidence_hash: string;
  source_event_count: number;
  error_prone_routing_task_types: RoutingTaskType[];
}

export function validateValueQualityPolicy(
  value: unknown
): { ok: true; value: ValueQualityPolicy } | { ok: false; reason: string } {
  const gated = checkFormatVersion(value, formatVersions.valueQualityPolicy, "the promoted value-quality policy");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    !isRecord(value) ||
    value.kind !== "value_quality_policy" ||
    typeof value.source_evidence_hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.source_evidence_hash) ||
    !isNonNegativeInteger(value.source_event_count) ||
    !Array.isArray(value.error_prone_routing_task_types)
  ) {
    return { ok: false, reason: "value-quality policy header does not match schema version 1" };
  }
  const allowedKeys = [
    "error_prone_routing_task_types",
    "kind",
    "source_event_count",
    "source_evidence_hash",
    "version"
  ];
  if (JSON.stringify(Object.keys(value).sort(compareText)) !== JSON.stringify(allowedKeys)) {
    return { ok: false, reason: "value-quality policy fields do not match schema version 1" };
  }
  const seen = new Set<RoutingTaskType>();
  for (const [index, taskType] of value.error_prone_routing_task_types.entries()) {
    if (!isRoutingTaskType(taskType)) {
      return { ok: false, reason: `value-quality policy error_prone_routing_task_types[${index}] is invalid` };
    }
    if (seen.has(taskType)) {
      return { ok: false, reason: `value-quality policy repeats routing task type ${taskType}` };
    }
    seen.add(taskType);
  }
  return {
    ok: true,
    value: {
      version: 1,
      kind: "value_quality_policy",
      source_evidence_hash: value.source_evidence_hash,
      source_event_count: value.source_event_count,
      error_prone_routing_task_types: [...seen].sort(compareText)
    }
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

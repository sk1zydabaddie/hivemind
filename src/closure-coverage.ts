import { loadTentativePlan } from "./plan.js";
import { queryDependencyClosure } from "./repo-graph.js";

export type ClosureCoverageFlagKind = "dependency_outside_scope" | "forbidden_dependency";

export interface ClosureCoverageFlag {
  task_id: string;
  dependency_file: string;
  entry_points: string[];
  kind: ClosureCoverageFlagKind;
  message: string;
}

export interface ClosureCoverageAdvisory {
  advisory_only: true;
  entry_point_definition: "concrete grounded allowed_files";
  flags: ClosureCoverageFlag[];
}

interface PendingFlag {
  taskId: string;
  dependencyFile: string;
  entryPoints: Set<string>;
  kind: ClosureCoverageFlagKind;
}

// M7.2 intentionally uses grounded writable files as entry points. The check is
// advisory, so adding a separate plan-schema field would add churn without safety.
export async function evaluateClosureCoverage(
  repoRoot: string,
  specId: string
): Promise<ClosureCoverageAdvisory | undefined> {
  const loaded = await loadTentativePlan(repoRoot, specId);
  if (!loaded.ok) {
    return undefined;
  }

  let availableQueryCount = 0;
  const pendingFlags = new Map<string, PendingFlag>();
  for (const task of loaded.value.tasks) {
    const scope = task.grounded_scope;
    if (task.scope_status !== "grounded" || scope === undefined) {
      continue;
    }

    const visibleScope = new Set([...scope.allowed_files, ...scope.read_only_files]);
    const forbiddenScope = new Set(scope.forbidden_files);
    for (const entryPoint of uniqueSorted(scope.allowed_files)) {
      let closure;
      try {
        closure = await queryDependencyClosure(repoRoot, entryPoint);
      } catch {
        continue;
      }
      if (!closure.available) {
        continue;
      }
      availableQueryCount += 1;

      for (const dependencyFile of closure.closure) {
        const kind = forbiddenScope.has(dependencyFile)
          ? "forbidden_dependency"
          : visibleScope.has(dependencyFile)
            ? null
            : "dependency_outside_scope";
        if (kind === null) {
          continue;
        }
        const key = `${task.task_id}\0${kind}\0${dependencyFile}`;
        const existing = pendingFlags.get(key);
        if (existing === undefined) {
          pendingFlags.set(key, {
            taskId: task.task_id,
            dependencyFile,
            entryPoints: new Set([entryPoint]),
            kind
          });
        } else {
          existing.entryPoints.add(entryPoint);
        }
      }
    }
  }

  if (availableQueryCount === 0) {
    return undefined;
  }

  const flags = [...pendingFlags.values()]
    .sort((left, right) => compareText(left.taskId, right.taskId) || compareText(left.dependencyFile, right.dependencyFile) || compareText(left.kind, right.kind))
    .map((flag): ClosureCoverageFlag => {
      const entryPoints = uniqueSorted(flag.entryPoints);
      return {
        task_id: flag.taskId,
        dependency_file: flag.dependencyFile,
        entry_points: entryPoints,
        kind: flag.kind,
        message:
          flag.kind === "forbidden_dependency"
            ? `${flag.dependencyFile} is in the dependency closure of ${entryPoints.join(", ")} and is explicitly forbidden`
            : `${flag.dependencyFile} is in the dependency closure of ${entryPoints.join(", ")} but outside combined allowed_files + read_only_files scope`
      };
    });

  return {
    advisory_only: true,
    entry_point_definition: "concrete grounded allowed_files",
    flags
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

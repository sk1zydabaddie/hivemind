# M7.7c Real-Provider Best-of-N Demonstration

Date: 2026-07-30 (America/Los_Angeles)

## Scope

One approved, bounded best-of-2 run used two sequential real Codex calls under one
`quality_run_id`. There were no retries and no third call.

Quality run:

`Q-T-001-c398dd18-4bb7-4d42-a318-e4434c986a60`

Fixture repository:

`C:\Users\ethan\AppData\Local\Temp\hivemind-m7-7c-best-of-n-demo-20260730`

Base commit:

`208e5bab59865c18cc4ee9eb5120898bf53456fb`

Task:

`T-001 - Implement deterministic dependency-and-capacity wave scheduler`

The task was intentionally substantive. It required graph validation, cycle
detection, downstream-depth calculation, deterministic priority, capacity-aware
wave packing, malformed-input handling, and input immutability. The committed
base contained a throwing `scheduleTasks()` stub and five failing tests.

## Profile Verification

The checked-in root Codex profile was not used because it contains
`--dangerously-bypass-approvals-and-sandbox`, `--ignore-user-config`, and
`--ignore-rules`.

The isolated `codex-drafter` profile used:

```json
[
  "cmd.exe",
  "/d",
  "/s",
  "/c",
  "codex.cmd",
  "exec",
  "--model",
  "gpt-5.5",
  "--sandbox",
  "workspace-write",
  "-c",
  "approval_policy=\"never\"",
  "--ephemeral",
  "-"
]
```

Before spending, the exact invocation was syntax-checked with `--help`. A free
unauthenticated startup probe then reported:

```text
OpenAI Codex v0.146.0
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: none
```

The two real calls independently reported:

```text
OpenAI Codex v0.146.0
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: high
```

Neither real invocation contained a bypass or ignore flag. Both exited zero and
produced non-empty patches.

## Draft D-001

Provider provenance:

```json
{
  "source": "adapter",
  "tool": "codex-drafter",
  "provider_tier": "strong",
  "profile_verified_on": "2026-07-30 Codex 0.146.0 no-auth startup probe: approval never, workspace-write",
  "usage_session_id": "Q-T-001-c398dd18-4bb7-4d42-a318-e4434c986a60",
  "exit_code": 0,
  "wall_time_ms": 178060,
  "effective_tokens": 42169,
  "accounting_source": "provider_reported",
  "provider_usage_status": "captured"
}
```

Candidate patch, verbatim:

```diff
diff --git a/src/scheduler.js b/src/scheduler.js
index 7db6609..75c240f 100644
--- a/src/scheduler.js
+++ b/src/scheduler.js
@@ -1,3 +1,165 @@
-ï»¿export function scheduleTasks() {
-  throw new Error("not implemented");
+export function scheduleTasks(tasks, capacity) {
+  if (!Array.isArray(tasks)) {
+    throw new Error("tasks must be an array");
+  }
+
+  if (!Number.isInteger(capacity) || capacity <= 0) {
+    throw new Error("capacity must be a positive integer");
+  }
+
+  const taskById = new Map();
+
+  for (const task of tasks) {
+    if (task === null || typeof task !== "object" || Array.isArray(task)) {
+      throw new Error("each task must be an object");
+    }
+
+    const { id, cost, depends_on: dependsOn } = task;
+
+    if (typeof id !== "string" || id.length === 0) {
+      throw new Error("task id must be a non-empty string");
+    }
+
+    if (taskById.has(id)) {
+      throw new Error(`duplicate task id: ${id}`);
+    }
+
+    if (!Number.isInteger(cost) || cost <= 0) {
+      throw new Error(`task cost must be a positive integer: ${id}`);
+    }
+
+    if (cost > capacity) {
+      throw new Error(`task cost exceeds capacity: ${id}`);
+    }
+
+    if (!Array.isArray(dependsOn)) {
+      throw new Error(`task depends_on must be an array: ${id}`);
+    }
+
+    taskById.set(id, {
+      id,
+      cost,
+      dependsOn: [...dependsOn],
+      dependents: []
+    });
+  }
+
+  const sortedIds = [...taskById.keys()].sort();
+
+  for (const id of sortedIds) {
+    const task = taskById.get(id);
+    const seenDependencies = new Set();
+
+    for (const dependencyId of task.dependsOn) {
+      if (typeof dependencyId !== "string" || dependencyId.length === 0) {
+        throw new Error(`task depends_on contains an invalid dependency id: ${id}`);
+      }
+
+      if (dependencyId === id) {
+        throw new Error(`task cannot depend on itself: ${id}`);
+      }
+
+      if (seenDependencies.has(dependencyId)) {
+        throw new Error(`duplicate dependency in task depends_on: ${id}`);
+      }
+
+      const dependency = taskById.get(dependencyId);
+      if (dependency === undefined) {
+        throw new Error(`unknown dependency: ${dependencyId}`);
+      }
+
+      seenDependencies.add(dependencyId);
+      dependency.dependents.push(id);
+    }
+
+    task.dependsOn.sort();
+  }
+
+  for (const task of taskById.values()) {
+    task.dependents.sort();
+  }
+
+  const depths = new Map();
+  const visiting = new Set();
+  const visited = new Set();
+
+  const downstreamDepth = (id) => {
+    if (depths.has(id)) {
+      return depths.get(id);
+    }
+
+    if (visiting.has(id)) {
+      throw new Error("dependency cycle detected");
+    }
+
+    if (visited.has(id)) {
+      return depths.get(id);
+    }
+
+    visiting.add(id);
+
+    const task = taskById.get(id);
+    let maxChildDepth = 0;
+
+    for (const dependentId of task.dependents) {
+      maxChildDepth = Math.max(maxChildDepth, downstreamDepth(dependentId));
+    }
+
+    visiting.delete(id);
+    visited.add(id);
+
+    const depth = maxChildDepth + 1;
+    depths.set(id, depth);
+    return depth;
+  };
+
+  for (const id of sortedIds) {
+    downstreamDepth(id);
+  }
+
+  const scheduled = new Set();
+  const waves = [];
+
+  while (scheduled.size < sortedIds.length) {
+    const ready = sortedIds
+      .filter((id) => {
+        if (scheduled.has(id)) {
+          return false;
+        }
+
+        return taskById.get(id).dependsOn.every((dependencyId) => scheduled.has(dependencyId));
+      })
+      .sort((left, right) => {
+        const depthDifference = depths.get(right) - depths.get(left);
+        if (depthDifference !== 0) {
+          return depthDifference;
+        }
+
+        return left < right ? -1 : left > right ? 1 : 0;
+      });
+
+    let remainingCapacity = capacity;
+    const wave = [];
+
+    for (const id of ready) {
+      const task = taskById.get(id);
+
+      if (task.cost <= remainingCapacity) {
+        wave.push(id);
+        remainingCapacity -= task.cost;
+      }
+    }
+
+    if (wave.length === 0) {
+      throw new Error("dependency cycle detected");
+    }
+
+    for (const id of wave) {
+      scheduled.add(id);
+    }
+
+    waves.push(wave);
+  }
+
+  return waves;
 }
```

Gate result, verbatim:

```json
{
  "disposer": "runGate",
  "status": "accept",
  "reason": "all changes are within scope",
  "result": {
    "verdict": "accept",
    "reason": "all changes are within scope"
  }
}
```

Shadow result:

```json
{
  "disposer": "runVerification",
  "status": "pass",
  "reason": "existing shadow verification passed",
  "mode": "full",
  "selection_reason": "structured verification inventory is missing",
  "selected_check": {
    "id": "full-suite",
    "command": "npm test",
    "source": "fail-safe"
  },
  "exit_code": 0,
  "tests": {
    "total": 5,
    "passed": 5,
    "failed": 0
  },
  "runtime_coverage": "unconfigured"
}
```

Verbatim check output:

```text
> wave-scheduler-demo@1.0.0 test
> node --test

TAP version 13
# Subtest: schedules by downstream depth, dependencies, capacity, and stable ID ties
ok 1 - schedules by downstream depth, dependencies, capacity, and stable ID ties
# Subtest: skips an oversized ready task within a wave so a later task can fill capacity
ok 2 - skips an oversized ready task within a wave so a later task can fill capacity
# Subtest: does not mutate input and is stable across input permutations
ok 3 - does not mutate input and is stable across input permutations
# Subtest: validates malformed tasks and dependency references
ok 4 - validates malformed tasks and dependency references
# Subtest: detects multi-node cycles
ok 5 - detects multi-node cycles
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Draft D-002

Provider provenance:

```json
{
  "source": "adapter",
  "tool": "codex-drafter",
  "provider_tier": "strong",
  "profile_verified_on": "2026-07-30 Codex 0.146.0 no-auth startup probe: approval never, workspace-write",
  "usage_session_id": "Q-T-001-c398dd18-4bb7-4d42-a318-e4434c986a60",
  "exit_code": 0,
  "wall_time_ms": 135726,
  "effective_tokens": 37191,
  "accounting_source": "provider_reported",
  "provider_usage_status": "captured"
}
```

Candidate patch, verbatim:

```diff
diff --git a/src/scheduler.js b/src/scheduler.js
index 7db6609..ce86445 100644
--- a/src/scheduler.js
+++ b/src/scheduler.js
@@ -1,3 +1,179 @@
-ï»¿export function scheduleTasks() {
-  throw new Error("not implemented");
+export function scheduleTasks(tasks, capacity) {
+  if (!Array.isArray(tasks)) {
+    throw new Error("tasks must be an array");
+  }
+
+  if (!Number.isInteger(capacity) || capacity <= 0) {
+    throw new Error("capacity must be a positive integer");
+  }
+
+  const ids = [];
+  const records = new Map();
+
+  for (const task of tasks) {
+    if (task === null || typeof task !== "object" || Array.isArray(task)) {
+      throw new Error("each task must be an object");
+    }
+
+    const { id, cost, depends_on: dependsOn } = task;
+
+    if (typeof id !== "string" || id.length === 0) {
+      throw new Error("task id must be a non-empty string");
+    }
+
+    if (records.has(id)) {
+      throw new Error(`duplicate task id: ${id}`);
+    }
+
+    if (!Number.isInteger(cost) || cost <= 0) {
+      throw new Error(`task cost must be a positive integer: ${id}`);
+    }
+
+    if (cost > capacity) {
+      throw new Error(`task cost exceeds capacity: ${id}`);
+    }
+
+    if (!Array.isArray(dependsOn)) {
+      throw new Error(`task depends_on must be an array: ${id}`);
+    }
+
+    ids.push(id);
+    records.set(id, {
+      id,
+      cost,
+      dependencies: dependsOn.slice(),
+      dependents: []
+    });
+  }
+
+  ids.sort();
+
+  for (const id of ids) {
+    const record = records.get(id);
+    const dependencySet = new Set();
+
+    for (const dependencyId of record.dependencies) {
+      if (typeof dependencyId !== "string" || dependencyId.length === 0) {
+        throw new Error(`task depends_on contains an invalid dependency id: ${id}`);
+      }
+
+      if (dependencyId === id) {
+        throw new Error(`task cannot depend on itself: ${id}`);
+      }
+
+      if (dependencySet.has(dependencyId)) {
+        throw new Error(`duplicate dependency in task depends_on: ${id}`);
+      }
+
+      if (!records.has(dependencyId)) {
+        throw new Error(`unknown dependency: ${dependencyId}`);
+      }
+
+      dependencySet.add(dependencyId);
+    }
+
+    record.dependencies = [...dependencySet].sort();
+  }
+
+  for (const id of ids) {
+    for (const dependencyId of records.get(id).dependencies) {
+      records.get(dependencyId).dependents.push(id);
+    }
+  }
+
+  for (const id of ids) {
+    records.get(id).dependents.sort();
+  }
+
+  const depthById = computeDownstreamDepths(ids, records);
+  const completed = new Set();
+  const waves = [];
+
+  while (completed.size < ids.length) {
+    const ready = ids
+      .filter((id) => {
+        if (completed.has(id)) {
+          return false;
+        }
+
+        return records.get(id).dependencies.every((dependencyId) => completed.has(dependencyId));
+      })
+      .sort((left, right) => compareByPriority(left, right, depthById));
+
+    const wave = [];
+    let remainingCapacity = capacity;
+
+    for (const id of ready) {
+      const cost = records.get(id).cost;
+
+      if (cost <= remainingCapacity) {
+        wave.push(id);
+        remainingCapacity -= cost;
+      }
+    }
+
+    if (wave.length === 0) {
+      throw new Error("dependency cycle detected");
+    }
+
+    for (const id of wave) {
+      completed.add(id);
+    }
+
+    waves.push(wave);
+  }
+
+  return waves;
+}
+
+function computeDownstreamDepths(ids, records) {
+  const depthById = new Map();
+  const stateById = new Map();
+
+  const visit = (id) => {
+    const state = stateById.get(id);
+
+    if (state === "visiting") {
+      throw new Error("dependency cycle detected");
+    }
+
+    if (state === "visited") {
+      return depthById.get(id);
+    }
+
+    stateById.set(id, "visiting");
+
+    let depth = 1;
+    for (const dependentId of records.get(id).dependents) {
+      depth = Math.max(depth, visit(dependentId) + 1);
+    }
+
+    depthById.set(id, depth);
+    stateById.set(id, "visited");
+    return depth;
+  };
+
+  for (const id of ids) {
+    visit(id);
+  }
+
+  return depthById;
+}
+
+function compareByPriority(left, right, depthById) {
+  const depthDelta = depthById.get(right) - depthById.get(left);
+
+  if (depthDelta !== 0) {
+    return depthDelta;
+  }
+
+  if (left < right) {
+    return -1;
+  }
+
+  if (left > right) {
+    return 1;
+  }
+
+  return 0;
 }
```

Gate result, verbatim:

```json
{
  "disposer": "runGate",
  "status": "accept",
  "reason": "all changes are within scope",
  "result": {
    "verdict": "accept",
    "reason": "all changes are within scope"
  }
}
```

Shadow result:

```json
{
  "disposer": "runVerification",
  "status": "pass",
  "reason": "existing shadow verification passed",
  "mode": "full",
  "selection_reason": "structured verification inventory is missing",
  "selected_check": {
    "id": "full-suite",
    "command": "npm test",
    "source": "fail-safe"
  },
  "exit_code": 0,
  "tests": {
    "total": 5,
    "passed": 5,
    "failed": 0
  },
  "runtime_coverage": "unconfigured"
}
```

Verbatim check output:

```text
> wave-scheduler-demo@1.0.0 test
> node --test

TAP version 13
# Subtest: schedules by downstream depth, dependencies, capacity, and stable ID ties
ok 1 - schedules by downstream depth, dependencies, capacity, and stable ID ties
# Subtest: skips an oversized ready task within a wave so a later task can fill capacity
ok 2 - skips an oversized ready task within a wave so a later task can fill capacity
# Subtest: does not mutate input and is stable across input permutations
ok 3 - does not mutate input and is stable across input permutations
# Subtest: validates malformed tasks and dependency references
ok 4 - validates malformed tasks and dependency references
# Subtest: detects multi-node cycles
ok 5 - detects multi-node cycles
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Distinctness

`distinctness.json`, verbatim:

```json
{
  "version": 1,
  "quality_run_id": "Q-T-001-c398dd18-4bb7-4d42-a318-e4434c986a60",
  "task_id": "T-001",
  "method": "normalized changed-line set Jaccard",
  "prompt_diversity_strategy": "prior-draft contrast framing",
  "provider_specific_seed_or_temperature": false,
  "human_judgment_required": true,
  "pairs": [
    {
      "left_draft_id": "D-001",
      "right_draft_id": "D-002",
      "exact_patch_match": false,
      "changed_line_set_jaccard_similarity": 0.3129251700680272,
      "shared_changed_lines": 46,
      "union_changed_lines": 147
    }
  ]
}
```

The second prompt explicitly included the first immutable patch and its real
gate/shadow evidence, then said:

```text
Pursue a materially different design or implementation from every prior candidate.
Change architecture, decomposition, algorithm, data flow, or another substantive choice where the contract permits.
Cosmetic renaming, formatting changes, or restating a prior patch do not count as a different approach.
```

The output contained only the candidate diff, so it did not explicitly discuss
or acknowledge the first approach. The prompt visibly influenced code
organization: D-002 extracted `computeDownstreamDepths()` and
`compareByPriority()`, used a tri-state DFS map, and split dependency validation
from reverse-edge construction. It did not produce a materially different
algorithm. Both drafts:

- build equivalent task/dependent maps;
- compute downstream depth with memoized recursive DFS;
- filter ready tasks by completed dependencies;
- sort by depth then ID;
- greedily add every ready task that fits the remaining wave capacity.

The low textual Jaccard score therefore overstates conceptual diversity. This
single demonstration found two independently generated, exact-different,
gate-passed, fully tested implementations, but they are algorithmically the same
approach with different decomposition and naming. The behavioral
material-distinction criterion is not claimed as satisfied.

## Ledger Delta

The demo ledger did not exist before the quality run. Its complete delta was:

```json
{
  "tool": "codex-drafter",
  "quality_run_id": "Q-T-001-c398dd18-4bb7-4d42-a318-e4434c986a60",
  "requests": 2,
  "self_measured": {
    "input_tokens_estimated": 3573,
    "output_tokens_estimated": 2181,
    "total_tokens_estimated": 5754,
    "wall_time_ms": 313786
  },
  "provider_reported": {
    "reports": 2,
    "total_tokens": 79360
  },
  "per_draft_provider_reported_tokens": {
    "D-001": 42169,
    "D-002": 37191
  },
  "effective_tokens": 79360,
  "accounting_source": "provider_reported",
  "absolute_provider_to_self_divergence": 73606,
  "provider_to_self_ratio": 13.792144595064302
}
```

No dollar amount was exposed. Command wall time was approximately 318.5 seconds;
adapter wall time was 313.786 seconds. The 79,360 effective tokens stayed below
the shared 500,000-token session ceiling, and each call stayed below the
150,000-token run ceiling.

## Canonical-State Invariants

The following exact file hashes were captured before the run and matched after:

| State | SHA-256 |
| --- | --- |
| canonical source `src/scheduler.js` | `4c3aa562380ef2046b6d06aadcd68a0b38f48765871a2fb59efce31c4db63c25` |
| canonical task worktree sentinel | `6f6abfe08dfb8cdd16164364e85959219734ce1aafb747360995c0d4c9862a55` |
| canonical patch-bundle sentinel | `e269a5576b64c1892d0f099f3b5f1bdb933f350c121fc26babe582eb1b3df93d` |
| lease store `active.json` | `64975bac79635ea94f0485283e10cf5ad05b6268670e1c2930822a2536c36a2c` |
| canon sentinel | `ccfa61145556b40a913d3a95c87c9d7434c02b9db607f88cd21fbbdfde82d696` |
| canonical task output stream | `396cf3faa3c799c85bfdbd4d77c1e23e2d306d9d2d8f1977f5cf32a08722c4cb` |

Afterward:

- `HEAD` remained `208e5bab59865c18cc4ee9eb5120898bf53456fb`;
- `git status --porcelain` was empty;
- `main` was the only branch;
- the main checkout was the only Git worktree;
- no lease event was emitted and the lease store stayed byte-identical;
- all disposable draft checkouts were removed;
- the seven durable events were one `quality.admission_decided`, two
  `quality.draft_started`, two `quality.draft_verified`, and two
  `quality.draft_disposed`;
- no canonical `task.completed`, `patch.accepted`, or `integration.passed`
  event was emitted.

Only the immutable quality-run artifacts, quality events, and metering ledger
were written.

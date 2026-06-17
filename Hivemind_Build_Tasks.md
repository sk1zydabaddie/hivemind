# Hivemind AI — Build Task Contracts (detailed)

This is the **executable, no-ambiguity build plan** derived from `Hivemind_AI_Overview.md` (the design spec). Each sub-task is a self-contained contract you hand to Codex/Claude Code, sized to **one plan prompt + one implementation prompt**, with a single binary acceptance test.

It is written for the **pre-bootstrap reality**: you are hand-orchestrating, the agent's context rots fast, and it cannot hold the whole spec. So each contract states exactly what to create, what not to touch, the precise behavior and data shapes, and how "done" is proven — leaving nothing to interpretation. Read the named spec slice, paste the contract, run its plan, implement, run the acceptance test, move on.

> **Depth note:** M0–M2 (the ~18 sub-tasks you build by hand before the harness assists) are specified at maximum rigor. M3–M7 are thorough but lighter on far-future implementation minutiae that will evolve; tighten them into full contracts as you reach them.

---

## Shared conventions (read once; every sub-task assumes these)

These hold for **every** sub-task unless a contract overrides them. State them to the agent by reference rather than repeating.

**C1 — Language/runtime.** Pick one stack at M0.1 and never change it mid-build. (Recommended: TypeScript on Node, since the target users live in that ecosystem and Codex/Claude Code handle it well — but any single choice is fine. Record it in `.hivemind/config.json`.)

**C2 — Single source of truth.** The authoritative store is the `.hivemind/` directory on disk. No component holds shared state in memory as the source. SQLite (if introduced at M4) is a rebuildable cache, never the source.

**C3 — Atomic writes.** Every write to a shared file under `.hivemind/` is written to a temp file and `rename()`d into place. Readers never see a half-written file. **Exception — append-only logs:** `log/events.jsonl` (and any append-only Tier-1 log) is *not* temp+rename'd; it is extended by a single atomic append of one complete JSON line (`O_APPEND`). That is the one sanctioned exception to temp+rename — its atomicity guarantee is per-line, not whole-file. (This reconciles C3 with M2.7.)

**C4 — Determinism boundary.** Anything that enforces a guarantee (lease grant, the diff-scope gate, integration, ceilings) is plain deterministic code with **no LLM call and no external/provider network call**. Local loopback IPC to the Hivemind daemon is permitted because it is only a transport to the deterministic single writer, not an external dependency or judgment source. LLM calls happen only in worker/orchestrator invocation, never inside a gate.

**C5 — Exit codes & output.** CLI commands exit `0` on success, non-zero on failure, and print machine-readable JSON to stdout when they produce data (human summary to stderr). Errors are explicit messages, never silent.

**C6 — Fail closed.** Any ambiguity, unresolved path, or unexpected state in a guarantee-enforcing component resolves to *reject/stop*, never "proceed with a warning."

**C7 — The canonical task-contract schema** (used everywhere a contract is read/written; from the spec):

```json
{
  "task_id": "T-003",
  "title": "Implement minimap zoom controls",
  "agent_role": "builder",
  "base_commit": "abc123",
  "acceptance_criterion": "Minimap zoom controls pass their focused test.",
  "allowed_files": ["src/components/Minimap.tsx", "src/styles/minimap.css"],
  "read_only_files": ["src/world/coordinateSystem.ts"],
  "forbidden_files": ["src/save/saveGameSchema.ts"],
  "allowed_symbols": ["Minimap"],
  "forbidden_symbols": ["saveGameSchema"],
  "must_not_change": ["save schema", "public API of coordinate conversion"],
  "required_tests": ["npm run typecheck", "npm run test:minimap"],
  "patch_requirements": ["submit diff only", "include tests run", "include risk notes"]
}
```
In the early build, `allowed_symbols`/`forbidden_symbols` are carried but not enforced (symbol enforcement is M7); `allowed_files`/`forbidden_files`/`base_commit` are enforced from M1.

**C8 — The `.hivemind/` layout** (create lazily as sub-tasks need each piece):

```
.hivemind/
  config.json            # stack, repo_root, test_command, allowed/forbidden globs, risk tiers
  adapters/<tool>.profile.json
  spec/<id>.md
  tasks/<id>.contract.json
  tasks/<id>.knowledge.md
  log/events.jsonl
  patches/<id>/{diff.patch,summary.md,files_changed.json,symbols_changed.json,tests_run.json,risks.md,memory_proposals.json}
  worktrees/<id>/
  leases/active.json
  integration/{queue.json,status.json}
  canon/
```

**C9 — The patch bundle is exactly these 7 files** (C8 `patches/<id>/`). The gate trusts none of the agent-reported `*.json`; it re-derives truth from `diff.patch` applied to `base_commit`.

**C10 — Right-sizing & the split rule.** Every sub-task here is sized to be *context-survivable* per the design spec's canonical discipline — Overview § *Right-sizing tasks: contracts that survive a worker's context*. That means each one is: **self-contained** (this contract + its named spec slice is all the context the agent needs — it never relies on the agent remembering the rest of the spec); defined by **one binary acceptance criterion**; **one-invocation-sized** (small enough to finish well inside one fresh invocation, so the tool's auto-compaction rarely fires mid-task); and depends on prior work only through stated **Depends-on** ordering, never through the agent recalling an earlier task. The **granularity oracle / split rule** is the operative tool while building: *if you cannot state a single binary acceptance check for the unit in front of you, it is too big — split it* into `M_.x.a`, `M_.x.b`, … before handing it off. This is the same discipline Hivemind's own planner will apply to its workers; here you apply it by hand.

Deterministic enforcement is structural: a task contract has exactly one `acceptance_criterion`, and that criterion must be backed by at least one named `required_tests` command. Whether that sentence secretly bundles multiple unrelated tasks is a human ratification/planner-review judgment, not something deterministic lint pretends to prove.

**Gate markers:** **[GATE]** sub-tasks must pass before the next milestone starts. The hardest rule: **M1.5 must be green before any dogfooding (M3).**

---

## M0 — Tracer bullet
*Goal: one command spawns one agent headlessly in an isolated worktree against a hand-written contract and returns its diff. Built first to kill the most version-fragile assumption (does headless invocation behave as assumed?) on day one.*

### M0.1 — `hivemind init` (project scaffold)
- **Depends on:** none.
- **Read first:** Overview § *File Structure*, § *Single Source of Truth*.
- **Goal:** Create the CLI entry point and a `hivemind init` command that scaffolds `.hivemind/` in the current git repository.
- **Create / may edit:** the project's package/manifest + CLI entry (per C1); a `hivemind` binary/command; the `init` command; nothing else.
- **Must NOT create or touch:** any other `hivemind` subcommand, any worktree/lease/gate logic, the target repo's source files.
- **Behavior — exact:**
  - Detect the git repo root from the cwd. If not inside a git repo, exit non-zero with `error: not a git repository`.
  - Create `.hivemind/` with empty subdirs `tasks/`, `log/`, `patches/`, `worktrees/`, `adapters/`, `canon/`, and an empty `log/events.jsonl`.
  - Write `.hivemind/config.json` (atomic, C3) with: `{ "version": 1, "stack": "<C1 choice>", "repo_root": "<abs path>", "test_command": "<detected or \"\">", "allowed_globs": [], "forbidden_globs": ["**/*.lock","**/package.json","**/.git/**"] }`. Attempt to detect `test_command` (e.g. from package.json `scripts.test`); if none, leave `""`.
  - **Idempotent:** if `.hivemind/config.json` already exists, do not overwrite it; print `already initialized` and exit `0`.
- **Out of scope (later):** graph ingest, any other command, validating glob contents.
- **Acceptance test (binary):** In a fresh temp git repo, `hivemind init` exits `0` and `.hivemind/config.json` exists and parses as JSON with the keys above. Running it outside a git repo exits non-zero with the stated message. Running it twice does not overwrite the config.

### M0.2 — Task-contract format + loader
- **Depends on:** M0.1.
- **Read first:** Overview § *Task Contract Compiler* (the JSON schema), conventions **C7**.
- **Goal:** Define and load/validate the task-contract file (`.hivemind/tasks/<id>.contract.json`).
- **Create / may edit:** a contract type/schema + a loader function; a `hivemind contract <id> --validate` command.
- **Must NOT touch:** worktree/lease/gate logic.
- **Behavior — exact:**
  - Parse `.hivemind/tasks/<id>.contract.json` into the C7 shape.
  - Validate: `task_id`, `base_commit`, and `allowed_files` (non-empty array) are required; `allowed_files`/`read_only_files`/`forbidden_files` must be repo-relative paths or globs; the same path may not appear in both allowed and forbidden. On any violation, exit non-zero listing each problem.
  - `hivemind contract <id> --validate` prints the normalized contract as JSON and exits `0` if valid.
- **Out of scope:** generating contracts (that's M5), symbol enforcement.
- **Acceptance test (binary):** A valid sample contract validates and round-trips to normalized JSON; a contract missing `allowed_files`, or with a path in both allowed and forbidden, exits non-zero naming the exact problem.

### M0.3 — `hivemind worktree <id>` (create/teardown)
- **Depends on:** M0.1, M0.2.
- **Read first:** Overview § *Worktree Manager*.
- **Goal:** Create an isolated git worktree for a task on its own branch from the contract's `base_commit`; tear it down.
- **Create / may edit:** the `worktree` command + helper.
- **Must NOT touch:** the agent invocation, leases, the gate.
- **Behavior — exact:**
  - `hivemind worktree <id>` reads the contract, runs `git worktree add .hivemind/worktrees/<id> -b hivemind/<id> <base_commit>`. If the worktree already exists, exit `0` idempotently.
  - `hivemind worktree <id> --remove` runs `git worktree remove` and deletes the branch.
  - Print the absolute worktree path as JSON `{ "worktree": "<abs path>", "branch": "hivemind/<id>" }`.
- **Out of scope:** read-only flagging of non-leased files (that's M2.2).
- **Acceptance test (binary):** After `hivemind worktree T-001`, `.hivemind/worktrees/T-001` exists on branch `hivemind/T-001` at the contract's `base_commit`; `--remove` cleans both up. Output JSON has the correct path and branch.

### M0.4 — Headless adapter + Adapter Profile (one tool)
- **Depends on:** M0.3.
- **Read first:** Overview § *Tool Integration & Harmony*, § *Adapter Profiles*.
- **Goal:** Invoke one coding tool **headlessly** inside a task's worktree, feeding the contract as the prompt, capturing output and exit status.
- **Create / may edit:** an adapter module; `.hivemind/adapters/<tool>.profile.json`; an internal `invokeAgent(taskId, tool)` function.
- **Must NOT touch:** the diff capture (M0.5), the gate.
- **Behavior — exact:**
  - Read `.hivemind/adapters/<tool>.profile.json`: `{ "tool": "codex", "invoke": ["codex","exec","--full-auto"], "prompt_arg": "stdin|arg", "verified_on": "<date>", "context_window": <int> }`. The literal flags live **only** here (C4/Adapter Profiles); code references capabilities, not literals.
  - Build the prompt from the contract (title, allowed/forbidden files, required tests, "submit a diff only") and invoke the tool with cwd = the task's worktree.
  - Capture stdout/stderr to `.hivemind/worktrees/<id>/agent.log` and record the exit code. Non-zero tool exit → surface it, do not crash.
  - Pin autonomy per the harmony section (e.g. `--full-auto` / `bypassPermissions`) so it never blocks on an interactive prompt.
- **Out of scope:** a second adapter, streaming/parsing events (M6), hooks.
- **Acceptance test (binary):** With a real tool installed, `invokeAgent("T-001","<tool>")` runs the tool to completion inside the worktree, writes `agent.log`, and returns its exit code. The exact flags used appear in the profile file with a `verified_on` date.

### M0.5 — `hivemind run` end-to-end (capture diff) **[GATE]**
- **Depends on:** M0.2, M0.3, M0.4.
- **Read first:** Overview § *Core Workflow*, § *Development Plan* (M0).
- **Goal:** Wire contract → worktree → headless invoke → diff into one command that emits `diff.patch`.
- **Create / may edit:** the `run` command composing M0.2–M0.4 + diff capture.
- **Must NOT touch:** the scope gate (that's M1), leases.
- **Behavior — exact:**
  - `hivemind run <id> --tool <tool>`: ensure worktree (M0.3) → `invokeAgent` (M0.4) → compute `git diff <base_commit>` inside the worktree → write `.hivemind/patches/<id>/diff.patch` (atomic). Print `{ "task_id", "diff_path", "tool_exit": <int>, "changed_files": <int> }`.
  - If the tool made no changes, write an empty diff and report `changed_files: 0` (not an error).
- **Out of scope:** judging the diff, bundles beyond `diff.patch`.
- **Acceptance test (binary) [GATE]:** On a **real repo with both Codex and Claude Code**, `hivemind run T-001 --tool <each>` produces a correct `diff.patch` reflecting the agent's edits. This is the tracer bullet; do not start M1 until it works on both tools.

---

## M1 — The gate, airtight
*Goal: the diff-scope gate per the spec's 6 rules. Highest blast radius — airtight before anything builds on it, and before it ever guards Hivemind's own repo.*

### M1.1 — Apply-to-base changeset resolver
- **Depends on:** M0.2.
- **Read first:** Overview § *Diff-Scope Gate Specification* rule 1 & 2.
- **Goal:** Resolve a patch into a trustworthy file-operation list by applying it to the declared base — never by parsing diff text.
- **Create / may edit:** a pure function `resolveChangeset(baseCommit, patchPath) → { ok, ops[] } | { ok:false, reason }`.
- **Must NOT touch:** path checks (M1.2), CLI.
- **Behavior — exact (C4: no external/provider network or LLM):**
  - Create a throwaway checkout/worktree at `base_commit`; `git apply --check` then apply the patch. If it does not apply cleanly, return `{ ok:false, reason:"patch does not apply to declared base" }`.
  - Read the resulting changeset via git **with rename detection OFF** (`--no-renames`), producing `ops`: list of `{ path, op }` where `op ∈ {add,modify,delete,chmod,symlink,submodule,gitattr}`. A rename surfaces as a `delete`+`add` pair.
  - Always clean up the throwaway checkout.
- **Out of scope:** deciding pass/reject (M1.3).
- **Acceptance test (binary):** A clean patch yields the correct `ops` list with renames split into delete+add; a patch generated against a different base returns `ok:false` with the base-mismatch reason.

### M1.2 — Path canonicalization + repo-root confinement
- **Depends on:** none (pure util).
- **Read first:** Overview § *Diff-Scope Gate Specification* rule 3.
- **Goal:** Turn any path into a canonical, repo-confined form, or reject it.
- **Create / may edit:** `canonicalize(repoRoot, path) → { ok, resolved } | { ok:false }`.
- **Behavior — exact:** Resolve `..`, resolve symlinks, apply the filesystem case rules; if the result is outside `repoRoot` or cannot be resolved, return `ok:false`. Membership tests elsewhere use `resolved`, never the raw string.
- **Out of scope:** the decision table.
- **Acceptance test (binary):** `src/a/../b.ts` → `src/b.ts`; a path resolving outside the repo root and a symlink pointing outside both return `ok:false`; an ordinary in-root path returns its normalized form.

### M1.3 — Operation-decision table
- **Depends on:** M1.1, M1.2, M0.2.
- **Read first:** Overview § *Diff-Scope Gate Specification* rule 4 (the table) and the contract's allowed/forbidden sets.
- **Goal:** Map each changeset op to `pass | reject | escalate` using the contract + config, defaulting to deny.
- **Create / may edit:** `decideOp(op, contract, config) → "pass"|"reject"|"escalate"`.
- **Behavior — exact:** Implement the spec's table verbatim — modify-in-allowed→pass; any op outside allowed→reject; delete of forbidden/Critical→reject; symlink add/modify→reject; chmod/submodule/gitattributes/gitignore→escalate; dependency manifest→escalate; **unknown op or path→reject (default-deny)**. Canonicalize each path (M1.2) before membership testing.
- **Out of scope:** orchestrating the whole gate (M1.4).
- **Acceptance test (binary):** A table-driven test with one fixture per row produces the spec's verdict for every row, including default-deny on an unknown op.

### M1.4 — Gate assembly + fail-closed + reason
- **Depends on:** M1.1, M1.3.
- **Read first:** § *Diff-Scope Gate Specification* rules 5 & 6.
- **Goal:** Compose the pure gate function with fail-closed semantics and a reason string.
- **Create / may edit:** `runGate(baseCommit, patchPath, contract, config) → { verdict: "accept"|"reject"|"escalate", reason }`.
- **Behavior — exact:** Resolve changeset (M1.1); if `ok:false`→`reject` with that reason. Else `decideOp` (M1.3) over all ops; **reject wins over escalate wins over accept**. Any thrown error or unhandled case → `reject` with reason (C6). No partial/"warning" verdicts.
- **Out of scope:** the corpus (M1.5), CLI (M1.6).
- **Acceptance test (binary):** Given an all-in-scope patch → `accept`; a patch touching one out-of-scope file → `reject` naming the file; an internal error path → `reject`, never a throw.

### M1.5 — Adversarial corpus harness + fixtures **[GATE]**
- **Depends on:** M1.4.
- **Read first:** § *Diff-Scope Gate Specification* rule 6 (the named fixtures).
- **Goal:** A test suite of adversarial patches the gate must reject.
- **Create / may edit:** a `fixtures/` set + a test that runs `runGate` on each.
- **Behavior — exact:** Build one fixture each for: **rename-launder** (forbidden file renamed to allowed-looking name), **symlink escape**, **`../` path escape**, **wrong-base patch**, **case collision** (`Minimap.tsx` vs `minimap.tsx`), **forbidden-file deletion**, **mode-bit flip**; plus one **happy-path** patch that must `accept`.
- **Acceptance test (binary) [GATE]:** All 7 adversarial fixtures return `reject` (or `escalate` where the table specifies), the happy-path returns `accept`, and the suite is green. **No dogfooding (M3) until this passes.**

### M1.6 — `hivemind analyze <id>` (CLI wiring)
- **Depends on:** M1.4.
- **Goal:** Run the gate on a task's submitted bundle from the CLI.
- **Create / may edit:** the `analyze` command.
- **Behavior — exact:** Load the contract + `config.json` + `.hivemind/patches/<id>/diff.patch`, call `runGate`, print `{ verdict, reason }` JSON, exit `0` on accept, non-zero on reject/escalate.
- **Acceptance test (binary):** `hivemind analyze T-001` on a clean bundle prints `accept` and exits `0`; on an out-of-scope bundle prints `reject` with reason and exits non-zero.

---

## M2 — The MVP
*Goal: leases + parallel worktrees + manual shadow integration — the shippable human-driven safety harness. Completing M2.6 is the MVP demo.*

### M2.1 — Lease store + disjoint-grant check
- **Depends on:** M0.2.
- **Read first:** Overview § *Lease Manager* (the disjoint-write invariant).
- **Goal:** Grant/release file-level write leases, deterministically rejecting overlaps.
- **Create / may edit:** `.hivemind/leases/active.json`; `requestLease(taskId, files[])`/`releaseLease(taskId)`; `hivemind lease <id>` / `--release`.
- **Behavior — exact (C3, C4):** `active.json` is `{ "<path>": "<task_id>", ... }`. `requestLease` canonicalizes each file (M1.2) and grants **only if none is already held by another task**; otherwise reject listing the conflicting paths and holders. Writes are atomic and guarded by a file lock.
- **Out of scope:** symbol leases, read-only flagging (M2.2).
- **Acceptance test (binary):** Granting T-002 a file already leased to T-001 is rejected naming the conflict; disjoint grants succeed; release frees the paths; concurrent grant attempts never both win.

### M2.2 — Read-only flagging of non-leased files
- **Depends on:** M2.1, M0.3.
- **Read first:** § *Lease Manager* (preconditions), § *Write-Intent Gate* (preventive layers).
- **Goal:** Inside a task's worktree, mark everything not in its lease read-only (best-effort preventive layer).
- **Behavior — exact:** On worktree prep, set filesystem read-only bits on all files except the task's `allowed_files`. This is preventive only; the gate remains authoritative.
- **Out of scope:** enforcing it as a guarantee (it isn't one).
- **Acceptance test (binary):** After prep for T-001 (allowed: one file), that file is writable in the worktree and a sampled non-leased file is read-only.

### M2.3 — Write-intent gate
- **Depends on:** M2.1, M1.2.
- **Read first:** § *Write-Intent Gate* (the JSON example).
- **Goal:** Validate a declared write-intent against the granted lease before editing.
- **Create / may edit:** `checkWriteIntent(taskId, intent)`; `hivemind intent <id> <intent.json>`.
- **Behavior — exact:** Parse the intent (`intended_files[]`, `will_not_change[]`, …). Canonicalize each `intended_file`; if any is outside the granted lease → `reject` before any edit (C4/C6). In-scope intents pass.
- **Acceptance test (binary):** An intent naming a file outside the lease is rejected pre-edit; an all-in-lease intent passes.

### M2.4 — `hivemind submit` (patch bundle assembly)
- **Depends on:** M0.5.
- **Read first:** Overview § *Patch Bundle Format*, conventions **C9**.
- **Goal:** Assemble the full 7-file bundle for a task.
- **Behavior — exact:** From the worktree, write `.hivemind/patches/<id>/` with all 7 files (C9): `diff.patch` (git diff vs base), `summary.md`, `files_changed.json` + `symbols_changed.json` (agent-reported, advisory), `tests_run.json`, `risks.md`, `memory_proposals.json`. Missing agent-reported files are created empty, never fabricated.
- **Out of scope:** judging the bundle (that's M1.6 / M2.5).
- **Acceptance test (binary):** `hivemind submit T-001` produces a folder containing exactly the 7 named files.

### M2.5 — `hivemind integrate --shadow`
- **Depends on:** M1.6, M2.4.
- **Read first:** Overview § *Shadow Integration Service*.
- **Goal:** Apply accepted patches together on a throwaway branch, run the project test command, report, clean up.
- **Behavior — exact (C4):** For each queued task, run the gate (M1.6); only `accept`ed patches proceed. Create `integration/<timestamp>` branch off `main`, apply the accepted patches in queue order, run `config.test_command`, capture pass/fail, write `integration/status.json` `{ "branch", "applied": [...], "tests": "pass|fail", "report": "..." }`, then delete the throwaway branch. Never merges to `main`.
- **Out of scope:** auto-merge, the manager proposing remediation (M5/M6).
- **Acceptance test (binary):** Two accepted disjoint patches are applied together, the test command runs, status is reported, and the throwaway branch is removed. A rejected patch is excluded.

### M2.6 — Two-task parallel demo + `hivemind status` **[GATE]**
- **Depends on:** M2.1–M2.5.
- **Read first:** Overview § *The Most Important MVP Demo*.
- **Goal:** Run two tasks in two worktrees end to end and show state.
- **Create / may edit:** the `status` command (reads tasks, leases, patch verdicts, integration status → JSON/table); demo glue/docs.
- **Acceptance test (binary) [GATE]:** Two agents are given disjoint-scope contracts, run in parallel worktrees; an intentionally out-of-scope edit by one is **rejected** by `analyze`; the in-scope patches integrate only after `integrate --shadow` passes; `hivemind status` shows the run. **This is the MVP.**

### M2.7 — Append-only Tier-1 event log
- **Depends on:** M0.1.
- **Read first:** Overview § *Real-Time Supervision* (event list), § *Project Memory Log* (Tier-1).
- **Goal:** Record key actions as append-only evidence.
- **Behavior — exact (C3):** Append one JSON object per line to `.hivemind/log/events.jsonl`: `{ "ts", "type", "task_id", "data" }`. Emit at minimum: `task.created`, `lease.approved`/`lease.rejected`, `patch.submitted`, `patch.accepted`/`patch.rejected`, `integration.passed`/`integration.failed`. Append-only; never rewritten (the C3 append-only exception). **`task.created` definition (MVP):** pre-M5 there is no separate task-create command, so `task.created` is emitted the first time a valid contract enters execution — i.e. on first worktree creation/reuse for that `task_id`. (When the orchestrator arrives at M5, explicit creation will move earlier; the event's meaning — "this contract is now a live task" — is unchanged.)
- **Acceptance test (binary):** Running the M2.6 demo appends well-formed JSONL lines for each of the listed event types, in order.

---

## M3 — Dogfood
*Goal: turn the method on. Self-orchestration waits for M5; **self-protection** starts now — every Hivemind change runs through Hivemind's own gate before it merges. This is a process milestone: one enabling sub-task, then ongoing.*

### M3.1 — Self-protection workflow (gate Hivemind's own changes)
- **Depends on:** M1.6 (the gate must be green — M1.5).
- **Read first:** Overview § *Bootstrapping* (stage 1), § *Development Plan* (M3).
- **Goal:** Route Hivemind's *own* repo changes through `hivemind analyze` before they are allowed to merge.
- **Create / may edit:** a dev workflow hook (pre-commit/pre-merge script or CI step) that, given a feature contract for the change, runs the gate; a short `CONTRIBUTING`-style note describing the loop.
- **Must NOT touch:** the gate internals (frozen at M1), the acceptance criteria of M1.5.
- **Behavior — exact:** For a change to Hivemind itself, write a contract (C7) scoping it, run `hivemind analyze`, and block the merge on a non-`accept` verdict. The human is still the orchestrator (writes the contracts); only the *safety* is automated.
- **Out of scope:** auto-decomposition or orchestration (M5); auto-merge.
- **Acceptance test (binary):** A deliberately out-of-scope change to the Hivemind repo is blocked by its own gate before merge; an in-scope change passes and merges.

### (ongoing) — Build every later feature *through* the harness
- **Rule:** From here, each sub-task in M4–M7 is itself executed inside a worktree + lease + gate (you hand-orchestrate until M5, then Hivemind orchestrates). No new code; this is the operating discipline that makes the remaining milestones their own proof.
- **Acceptance test (binary):** Each shipped M4+ feature has an associated contract and a recorded `accept` verdict in `log/events.jsonl`.

---

## M4 — Daemon + MCP + resource baseline
*Phase 2. Persistence, the MCP surface, and the resource layer. Each sub-task is still one contract; by now you may be dogfooding (M3), so build each through the harness.*

### M4.1 — `hivemind daemon` (single-writer state owner)
- **Depends on:** M2 complete.
- **Read first:** Overview § *Hivemind Core Daemon*, § *Single Source of Truth* (C2).
- **Goal:** A long-running process that is the **only** writer of shared `.hivemind/` state; all mutations route through it.
- **Create / may edit:** the `daemon` command; an IPC surface (local socket/HTTP) for mutations; refactor existing commands to call the daemon when it is running (and fall back to direct single-writer when it is not, preserving M0–M2 behavior).
- **Must NOT touch:** the gate logic; the on-disk formats (daemon writes the same files, atomically).
- **Behavior — exact (C2, C3):** Serialize all writes to `leases/active.json`, `integration/status.json`, `log/events.jsonl`, patch bundles. Agents/CLI never write shared state directly when the daemon owns it. Crash-safe: on restart, state is read from `.hivemind/` (the source of truth), not from memory.
- **Out of scope:** SQLite (M4.2), MCP (M4.3).
- **Acceptance test (binary):** With the daemon running, two concurrent lease requests for the same file are serialized and exactly one wins; killing and restarting the daemon loses no committed state (it re-reads from disk).

### M4.2 — SQLite derived cache
- **Depends on:** M4.1.
- **Read first:** § *Single Source of Truth* (SQLite is a rebuildable index, never the source).
- **Goal:** A fast query index over `.hivemind/`, fully rebuildable from disk.
- **Behavior — exact:** Build/refresh a SQLite DB from the on-disk files (tasks, leases, patches, events). Deleting the DB and rebuilding yields identical query results. The DB is never read as the source of truth for a guarantee (C2/C4).
- **Acceptance test (binary):** Deleting the SQLite file and running a rebuild reproduces the same task/lease/event query results; no guarantee path reads the DB instead of disk.

### M4.3 — MCP server scaffold + transports
- **Depends on:** M4.1.
- **Read first:** Overview § *Hivemind MCP Server*, § *Compatibility Strategy*.
- **Goal:** Expose Hivemind over MCP with working stdio and streamable-HTTP transports.
- **Behavior — exact:** Stand up an MCP server that connects over stdio and HTTP and lists its tools (implemented in M4.4). It calls the daemon (M4.1) for all state changes; it does not write `.hivemind/` directly.
- **Out of scope:** the tool *implementations* (M4.4), Hivemind-as-MCP-client (it is not — one-way control, per the harmony section).
- **Acceptance test (binary):** An MCP client connects over each transport and receives the tool list.

### M4.4 — MCP tools: task / worktree / patch / status
- **Depends on:** M4.3.
- **Read first:** § *MCP Server Design* (the tool list).
- **Goal:** Implement the core MCP tools mapping to existing CLI actions.
- **Behavior — exact:** Implement `hivemind.get_status`, `hivemind.create_task_contract`, `hivemind.create_worktree`, `hivemind.request_lease`, `hivemind.submit_patch`, `hivemind.analyze_patch`, `hivemind.integrate_shadow`. Each validates inputs and routes through the daemon; each returns structured JSON. No tool can bypass the gate.
- **Acceptance test (binary):** Each tool is callable from an MCP client and produces the same effect/verdict as its CLI equivalent; `analyze_patch` returns the gate verdict and cannot be made to accept an out-of-scope patch.

### M4.5 — Quota ledger (self-measured)
- **Depends on:** M4.1.
- **Read first:** Overview § *Resource & Continuity Manager* → *The quota ledger* (self-measured primary, provider-reported secondary).
- **Goal:** Track per-provider capacity primarily by **metering Hivemind's own usage**, calibrated by observed throttles.
- **Behavior — exact:** Maintain `.hivemind/resource/ledger.json` `{ "<provider>": { "used": {...}, "observed_limit": {...}, "resets_at": "...", "source": "self-metered" } }`. Count requests/tokens/wall-time Hivemind itself sends; a 429/throttle calibrates `observed_limit`; a provider-reported number, if present, only refines the estimate. Works with zero provider cooperation. Local models = unmetered.
- **Out of scope:** routing decisions (M4.6), cache metering (M4.7).
- **Acceptance test (binary):** With no provider-reported quota at all, the ledger still reflects consumption from Hivemind's own counts; injecting a simulated 429 updates `observed_limit`.

### M4.6 — Pooling + tier-capped routing + ceilings
- **Depends on:** M4.5, M0.2 (contract tiers).
- **Read first:** § *Resource & Continuity Manager* → *Multi-provider pooling & routing*.
- **Goal:** Route tasks across providers by tier × ledger, with a hard tier cap and a run ceiling.
- **Behavior — exact (C4 for the cap):** Pool all providers; route Low-tier work to cheap/local, High/Critical to the strongest; **a Critical task can never be routed to a weak model to save quota** (hard floor, deterministic). Enforce a per-run ceiling (estimated calls/time); overrun pauses and surfaces, never silently continues.
- **Acceptance test (binary):** A Critical task is never assigned to a below-threshold model regardless of quota pressure; exceeding the configured ceiling pauses the run with a surfaced message.

### M4.7 — Prompt-cache: layered prefix + read cache + metering
- **Depends on:** M4.1.
- **Read first:** § *Resource & Continuity Manager* → *Prompt-cache economics & reuse* (levers A, B, D; the locked reuse constraint).
- **Goal:** Assemble byte-stable layered prompt prefixes, cache reads by content hash, and meter realized cache hits.
- **Behavior — exact:** Build prompts as `[global][repo substrate][task context pack][per-turn delta]`, byte-identical across siblings/turns (no injected timestamps/reordering). Cache file reads/scout findings under `.hivemind/cache/reads/` keyed by `(path, content-hash)`; reuse obeys the **locked rule** — exact-hash only for anything influencing a write, near-match advisory. Record realized cache-hit / read-dedup rate to the event log/ledger (measure, don't assume).
- **Acceptance test (binary):** Two sibling tasks on the same repo produce byte-identical prefixes for the shared layers; a second read of an unchanged file is served from cache (hit recorded); a changed file (new hash) is not reused for a write.

---

## M5 — The orchestrator
*Phase 2/3. The "message one agent, it manages the rest" experience. Self-orchestration begins. M5 is the largest milestone; M5.3 may split further on contact.*

### M5.1 — Spec artifact + ratification gate
- **Depends on:** M4.1.
- **Read first:** Overview § *Discovery & Ideation* (the PRD template, the ratification gate).
- **Goal:** A versioned PRD spec with a hard user-ratification gate before any planning.
- **Behavior — exact (C6):** Store `.hivemind/spec/<id>.md` with the template sections and `status: draft|ratified`. No planning/lease/worker step may run while `status != ratified`. Ratification is a human action (reuses the approval mechanism), never self-asserted by the orchestrator.
- **Acceptance test (binary):** Any attempt to plan or grant a lease while the spec is `draft` is refused; flipping to `ratified` (via the human approval path) unblocks planning.

### M5.2 — Discovery & ideation loop (diverge → refine → converge) + self-critique
- **Generative sub-tasks are judged behaviorally by a human reading the transcript, not by a binary automated test.**
- **Depends on:** M5.1, M5.3 (manager loop) — build the loop logic here, wire to chat in M5.3.
- **Read first:** § *Discovery & Ideation* → *The refinement loop* (the moves, mandatory self-critique, mutual-best-version exit).
- **Goal:** Co-develop a vague wish into the best-achievable ratified spec via the disciplined improvement loop.
- **Behavior — exact:** TWO halves.
  (a) DETERMINISTIC recorder/validator/spec-updater — ALREADY BUILT in `src/ideation.ts`; do not rewrite it. It stays the floor: it validates round shape, applies `spec_updates`, and enforces convergence/ratification (non-goals required, open-questions empty, both parties must call convergence).
  (b) GENERATIVE half — NEW, the actual deliverable: an orchestrator proposal generator that, given the goal + current spec state, makes an LLM call to PRODUCE that round's content — 2 real alternatives with tradeoffs, a substantive self-critique (weakest point + what to cut/change), and proposed `spec_updates` including non-goals and scope. The human STEERS and APPROVES; the human does NOT author the content. The generator FEEDS the existing recorder (a) — it does not bypass it.
  LLM-integration decisions (make these explicit so they aren't skipped again):
    * This is the first LLM call in the codebase. It is allowed here — generation is PROPOSAL, not a guarantee, so it does NOT violate the C4 determinism boundary. C4 still forbids LLM calls inside guarantee-enforcing code (the recorder/validator/ratification stay deterministic). State this distinction in the contract.
    * Use the worker-adapter mechanism already built for invoking a model; do not invent a new provider path. Route the call through the resource ledger so it's metered.
    * The generator PROPOSES; it must NEVER self-approve convergence/ratification — that gate stays with the human (or the deterministic convergence rule). The LLM proposing AND deciding it's done is exactly the failure we forbid.
- **Out of scope:** planning (M5.4); changing the deterministic recorder's behavior.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** Run ideation on the trimr goal ("A command-line tool where I add people and shared expenses, and it tells me who owes whom to settle up"). The ORCHESTRATOR — not a human-authored JSON file — produces each round's alternatives, self-critique, and proposed `spec_updates`. A human reads the transcript and confirms: (1) 2 genuine alternatives with real tradeoffs were proposed by the orchestrator, (2) a non-trivial self-critique each round, (3) non-goals and scope were proposed by the orchestrator and are populated, (4) the human only steered/approved and did not author spec content, (5) convergence/ratification was gated, not self-declared. This test is judged by reading output, not by an automated pass/fail.

### M5.3 — Manager-agent loop + manager chat
- **Depends on:** M4.4 (MCP tools), M5.1.
- **Read first:** Overview § *Primary Manager Agent* (the step sequence), § *Core Workflow*.
- **Goal:** The orchestrator LLM loop that turns a user message into gated actions via the MCP tools.
- **Behavior — exact (C4):** A chat surface drives the orchestrator through: ingest ratified spec → plan → request leases → launch workers → collect/analyze patches → integrate. **Every state-changing step goes through the deterministic tools/gates;** the orchestrator only ever *proposes*. (If this proves too large for one contract, split into: chat I/O, the action loop, and tool-call wiring.)
- **Acceptance test (binary):** A user message results in the orchestrator driving a full task through to a gated integration, with every mutation passing through the deterministic layer (verifiable in the event log).

### M5.4 — Planning loop (tentative plan + task split)
- **Depends on:** M5.1.
- **Read first:** Overview § *Task Planner* → *The Planning Loop* (propose → ground → commit).
- **Goal:** Turn a ratified spec into a tentative task split with proposed parallel/sequence structure.
- **Behavior — exact:** TWO halves.
  (a) DETERMINISTIC plan-lint + storage — ALREADY BUILT in `src/plan.ts`; do not rewrite it. It stays the floor: disjoint parallel scopes, acyclic deps, grounding present/fresh, one acceptance criterion backed by a test, no unflagged Critical. The generator must FEED this, never bypass it.
  (b) GENERATIVE half — NEW, the deliverable: given the ratified spec, an LLM produces the task decomposition — tasks with titles, draft scopes (`allowed_files`/`read_only_files`/`forbidden_files`), dependencies, parallel flags, one `acceptance_criterion` each backed by named tests, and Critical flags. The human steers/approves; the human does NOT author the plan JSON.
  LLM-integration decisions:
    * LLM call is allowed here — a plan is a PROPOSAL, not a guarantee; C4 still forbids LLM calls inside plan-lint/grounding/lease enforcement, which stay deterministic.
    * Use the existing adapter mechanism (same as M5.2's ideation generator and Scout); route through the resource ledger so it's metered. Do not invent a new provider path.
    * The generator PROPOSES the plan; plan-lint DISPOSES on validity; the human RATIFIES. The LLM must NEVER mark its own plan ratified or skip lint.
    * The generated plan flows into the SAME path a human-authored plan JSON does today, so it hits the existing plan-lint unchanged.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** On the trimr spec, the ORCHESTRATOR (not a human JSON file) produces the task decomposition. A human reads the plan and confirms: tasks have real scopes/deps/parallel flags/acceptance criteria, the plan was generated not authored, it passed the existing plan-lint, and nothing was self-ratified. Judged by reading output, not an automated pass/fail.

### M5.5 — Grounding (evidence + existence + freshness)
- **Depends on:** M5.4, M0.2.
- **Read first:** § *Task Planner* → grounding evidence tiers (existence, freshness).
- **Goal:** Require deterministic create-vs-modify grounding evidence before a lease can be granted.
- **Behavior — exact (C4/C6):** `draft_scope.allowed_files` may include optional per-path intent in `draft_scope.allowed_file_intents`: `{ "<allowed_files entry>": "create"|"modify" }`. Missing, ambiguous, or unparseable intent defaults to `modify` (the stricter side). `modify` allowed paths and all `read_only_files` must exist at the task's `base_commit`. `create` allowed paths must **not** exist at `base_commit` (else reject as a silent clobber) and must canonicalize/confine inside the repo and task scope. A `create` glob may ground with zero base matches; a `modify` glob must match tracked files. Evidence must reflect the current base (stale → re-derive). Advisory closure-coverage is a flag only (fail-safe), not a block.
- **Acceptance test (binary):** A modify path that does not exist is rejected; a create path that already exists is rejected; a create path/glob that is confined and does not exist grounds; an unlabeled path is treated as modify and must exist; a scope built on a stale base is flagged for re-derivation.

### M5.6 — Plan-lint (deterministic plan checks)
- **Depends on:** M5.4, M5.5, M2.1.
- **Read first:** § *Task Planner* (plan-lint).
- **Goal:** Deterministically reject a malformed plan before execution.
- **Behavior — exact (C4):** Check: parallel task scopes are pairwise disjoint (else they can't both hold leases); the dependency graph is acyclic; grounding is present and fresh (M5.5); no Critical path is touched without the required approval flag. Any failure bounces the plan with the specific rule.
- **Acceptance test (binary):** A plan with two overlapping parallel scopes, or a dependency cycle, or an unflagged Critical edit, is rejected naming the failing rule; a clean plan passes.

### M5.7 — Scout role + context-pack assembly
- **Depends on:** M5.4, M4.7 (cache).
- **Read first:** Overview § *Resource & Continuity Manager* (Scout-once context packs), § roles.
- **Goal:** A Scout pass that gathers grounding evidence into a reusable context pack.
- **Behavior — exact:** The Scout explores the relevant code and emits findings + a context pack (graph slice + conventions + key files) stored as a cacheable artifact (M4.7) and seeded into `tasks/<id>.knowledge.md`. Workers and reroutes reuse the pack instead of re-exploring.
- **Acceptance test (binary):** A Scout pass produces a context pack that a subsequent worker invocation consumes (verified by a cache hit and a seeded knowledge file) rather than re-exploring from scratch.

### M5.8 — Thrash → re-plan convergence
- **Depends on:** M5.4, M5.6.
- **Read first:** § *Task Planner* (thrash is a planning signal; convergence discipline).
- **Goal:** Detect thrash, re-scope toward the cause, and guarantee termination.
- **Behavior — exact (C6):** On repeated rejections/revisions, classify the cause (scope-too-narrow → widen; overlap → re-sequence; agent-incapable → re-route; spec-ambiguity → escalate to the spec/user). Record each attempted scope; **never re-propose a known-failed scope**; bound the loop with a budget and a terminal `blocked` + escalate state.
- **Acceptance test (binary):** A task engineered to thrash triggers a targeted re-scope, cannot repeat a failed scope, and terminates in `blocked`/escalation within the budget rather than looping forever.

---

## M6 — Real-time + recovery + context
*Phase 5. Live supervision and the continuity layer.*

### M6.1 — Event bus + streamed worker logs
- **Depends on:** M2.7, M4.1.
- **Read first:** Overview § *Real-Time Supervision*, § *Context & Working-Set Management*.
- **Goal:** Publish events to subscribers and stream worker output live.
- **Behavior — exact:** A pub/sub layer over the daemon emits the event types (M2.7 + `task.*`, `quota.low`, `context.low`, `orchestrator.*`) to connected UIs; worker stdout streams live (parse `claude -p --output-format stream-json`; for Codex, parse the `exec` stream — asymmetry per the harmony section).
- **Acceptance test (binary):** A subscriber receives events in real time during a run, and a running worker's output appears live rather than only at completion.

### M6.2 — Live task board + agent monitor
- **Depends on:** M6.1.
- **Read first:** Overview § *Full Application UI* (Task Board, Agent Monitor, Lease View).
- **Goal:** Live views of tasks, agents, leases, quota, and checkpointed state.
- **Behavior — exact:** A UI (or rich TUI) renders current tasks/states, active leases, per-provider quota from the ledger, and which tasks are checkpointed. Read-only view over daemon state.
- **Acceptance test (binary):** During the M2.6 demo run, the board reflects task/lease/quota state changes live.

### M6.3 — Redirect-first correction loop
- **Depends on:** M5.3, M6.1, M2.3.
- **Read first:** Overview § *Real-Time Supervision* (redirect-first; pause/cancel last resort).
- **Goal:** Correct a drifting worker at a safe boundary instead of killing it.
- **Behavior — exact:** At a write-intent/checkpoint boundary, if a worker drifts, the orchestrator injects a correction and lets it continue; pause/cancel is the last resort. Deterministic gates remain the safety; this is about not wasting work.
- **Acceptance test (binary):** A worker heading out of scope is redirected at the next boundary and completes in-scope, without a full cancel/restart.

### M6.4 — Task checkpoint/snapshot
- **Depends on:** M4.1.
- **Read first:** § *Resource & Continuity Manager* (checkpoints), data model `checkpoints` (scope: task).
- **Goal:** Snapshot a task's provider-neutral state for resume/reroute.
- **Behavior — exact (C3):** Write `.hivemind/resource/checkpoints/<id>.snapshot.json` capturing context-pack ref, partial diff, and knowledge so far. Snapshots are provider-neutral so any provider can resume.
- **Acceptance test (binary):** A task can be checkpointed mid-run and the snapshot contains enough to resume; the snapshot names no provider-specific state.

### M6.5 — Quota-wall recovery
- **Depends on:** M4.5, M4.6, M6.4.
- **Read first:** § *Resource & Continuity Manager* → *Quota-wall recovery & continuity*.
- **Goal:** Survive a provider quota wall by pausing and resuming on another provider with no lost work.
- **Behavior — exact:** Predictive: when the ledger nears a wall, checkpoint and reroute before failure. Reactive: on a 429, fall back and resume from the checkpoint on any available provider. The reactive path is always correct; predictive is best-effort.
- **Acceptance test (binary):** A simulated quota wall mid-task results in a checkpoint + resume on another provider, and the completed work is preserved (no restart from zero).

### M6.6 — Context budget + working-set + orchestrator re-hydrate
- **Depends on:** M6.4, M4.7.
- **Read first:** Overview § *Context & Working-Set Management* (stateless over durable store; the hard lane rule).
- **Goal:** Treat context-window pressure as a managed budget; rebuild the orchestrator from the store on demand.
- **Behavior — exact (C2):** Meter assembled context size; near the limit, checkpoint + distill to durable state + re-hydrate lean. The orchestrator reads authoritative state from `.hivemind/` (never trusts a summary for authoritative state); `orchestrator.snapshot.json` lets it tear down and rebuild.
- **Acceptance test (binary):** Forcing context pressure triggers a checkpoint + lean re-hydrate; the orchestrator reconstructs correct state (active leases, task states) from disk, not from a summary.

### M6.7 — Partial-failure degradation
- **Depends on:** M4.1, M6.1.
- **Read first:** § *Robustness Principle* (degrade, don't break), § *Real-Time Supervision*.
- **Goal:** One worker failing must not collapse the run.
- **Behavior — exact (C6):** A worker crash/timeout marks only that task failed/blocked, releases its lease, surfaces it, and lets the other tasks proceed. No shared-state corruption.
- **Acceptance test (binary):** Killing one of two parallel workers leaves the other running to completion; the failed task's lease is released and the failure is surfaced.

---

## M7 — Depth + learning
*Phases 6–7. Semantic depth, memory, and the learning flywheel. Build each through the harness.*

### M7.1 — Symbol-level graph (tree-sitter)
- **Depends on:** M2 complete.
- **Read first:** Overview § *Repo Graph Layer*.
- **Goal:** Parse the repo into symbols and dependency edges.
- **Behavior — exact:** Use tree-sitter to produce, per file, its defined symbols and its import/dependency edges; expose a query for "dependency closure of file X." Stored as a rebuildable artifact (not the source of truth for any guarantee).
- **Acceptance test (binary):** For a known file, the graph returns its correct symbols and import closure; rebuilding from source reproduces it.

### M7.2 — Closure-coverage advisory check (fail-safe)
- **Depends on:** M7.1, M5.5.
- **Read first:** § *Task Planner* (closure-coverage; fails safe).
- **Goal:** Flag a scope that excludes a file in its entry points' dependency closure.
- **Behavior — exact:** Advisory only — emit a flag, **never block**; a wrong/incomplete graph costs at most a missed/spurious flag, never a bad merge (the gate + shadow tests remain authoritative).
- **Acceptance test (binary):** An under-grounded scope is flagged; disabling the graph entirely still lets runs proceed (the check degrades to silence, not failure).

### M7.3 — Two-tier memory (log + canon + promotion gate)
- **Depends on:** M2.7.
- **Read first:** Overview § *Project Memory Log* (Tier-1 vs Tier-2; the review gate).
- **Goal:** Keep automatic evidence (Tier-1) separate from human-reviewed canon (Tier-2) that feeds planning.
- **Behavior — exact (C4 for the gate):** Tier-1 = append-only `log/`; Tier-2 = `canon/`, written **only** via an explicit human-review step. Nothing flows `log/ → canon/` automatically. Planning prompts read canon, never raw log.
- **Acceptance test (binary):** A proposed lesson lands in Tier-1 and does not appear in canon until a human approves it; planning context never includes unreviewed log claims.

### M7.4 — Dreaming / consolidation worker
- **Depends on:** M7.3.
- **Read first:** Overview § *Dreaming / Consolidation Worker*.
- **Goal:** Periodically distill Tier-1 evidence into *proposed* canon/routing/playbooks for review.
- **Behavior — exact:** Produce review proposals only; never auto-assert into canon (obeys M7.3's gate).
- **Acceptance test (binary):** A consolidation run emits proposals to a review queue; none reach canon without human approval.

### M7.5 — Learned routing policy
- **Depends on:** M4.5, M4.6, M2.7.
- **Read first:** Overview § *Agent Scorecards*, § *Resource & Continuity Manager* (waste accounting).
- **Goal:** Adapt routing from metered merged-diff-per-quota and per-provider/per-task-type performance.
- **Behavior — exact:** Derive routing weights from Tier-1 metrics (effective throughput, handoff-safety, merged-diff-per-quota); the tier cap from M4.6 still overrides (a Critical task is never downgraded).
- **Acceptance test (binary):** Feeding history where provider A reliably outperforms B on a task type shifts routing toward A for that type, without ever breaching the tier cap.

### M7.6 — Oracle-strengthening
- **Depends on:** M2.5, M7.1.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*.
- **Goal:** Measure coverage-of-impact, scale the required oracle by tier, and generate characterization tests where coverage is thin.
- **Behavior — exact (C4/C6):** Compute coverage-of-impact (proxy early; graph-precise with M7.1). High/Critical changes **may not integrate on a weak oracle**. Generate characterization tests that **must pass on the pre-change base or are rejected**; a regression is the test flipping pass→fail. Advisory oracle-strengthening, surfaced, never a silent guarantee.
- **Acceptance test (binary):** A High-tier change with no covering test is blocked until an oracle exists; a generated characterization test that fails on the base is rejected; one that passes on base and fails post-change flags a regression.

### M7.7 — Value-gated quality (best-of-N / draft-refine)
- **Depends on:** M4.6, M5.3.
- **Read first:** Overview § *Value-Gated Quality Strategy*.
- **Goal:** Spend extra effort only where value-gated, never blanket.
- **Behavior — exact:** Offer best-of-N (parallel drafts in disjoint worktrees, keep the shadow-tested winner) and draft-cheap/refine-expensive; gate both to High/Critical or error-prone task types; all spend counts against the M4.6 ceiling; all stays advisory (never bypasses the gate).
- **Acceptance test (binary):** Best-of-N runs only for a gated task and is skipped for a Low-tier task; the chosen draft is the one that passed shadow tests.

### M7.8 — Verification learns which checks matter
- **Depends on:** M2.5, M7.1, M7.3.
- **Read first:** Overview § *Verification Engine*.
- **Goal:** Run the relevant checks for a change rather than the whole suite every time.
- **Behavior — exact:** Use the graph (M7.1) + history (M7.3) to select the tests/checks exercising a change's impact set; fall back to the full suite when uncertain (fail-safe).
- **Acceptance test (binary):** For a localized change, the engine runs the impacted subset (verifiably fewer checks) and still catches a regression a full run would; when impact is unknown, it runs the full suite.

---

## Beyond M7
- **Phase 8 — Native adapters** and **Phase 9 — Cloud/team mode** are productization. Decompose them into the same one-acceptance-test contracts when reached.
- **Dogfooding (M3 onward)** means every milestone above M2 is itself built through the harness — hand-orchestrated until M5, then orchestrated by Hivemind protecting and building its own construction.

## The one rule that makes this work
Read the spec slice to write the contract; hand Codex the **contract**, not the whole spec; one binary acceptance test per sub-task; ask it to implement *that sub-task*, not "plan the milestone"; never cross a **[GATE]** until it is green. Start at **M0.1**.

# Hivemind AI — Build Task Contracts (detailed)

This is the **executable, no-ambiguity build plan** derived from `Hivemind_AI_Overview.md` (the design spec). Each sub-task is a self-contained contract you hand to Codex/Claude Code, sized to **one plan prompt + one implementation prompt**, with one acceptance criterion governed by C10.

It is written for the **pre-bootstrap reality**: you are hand-orchestrating, the agent's context rots fast, and it cannot hold the whole spec. So each contract states exactly what to create, what not to touch, the precise behavior and data shapes, and how "done" is proven — leaving nothing to interpretation. Read the named spec slice, paste the contract, run its plan, implement, run the acceptance test, move on.

> **Depth note:** M0–M2 (the ~18 foundational sub-tasks) are specified at maximum rigor. M3–M8 are thorough but lighter on later implementation minutiae that will evolve; tighten them into full contracts as you reach them.

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

**C10 — Right-sizing & the split rule.** Every sub-task here is sized to be *context-survivable* per the design spec's canonical discipline — Overview § *Right-sizing tasks: contracts that survive a worker's context*. That means each one is: **self-contained** (this contract + its named spec slice is all the context the agent needs — it never relies on the agent remembering the rest of the spec); defined by **one acceptance criterion**; **one-invocation-sized** (small enough to finish well inside one fresh invocation, so the tool's auto-compaction rarely fires mid-task); and depends on prior work only through stated **Depends-on** ordering, never through the agent recalling an earlier task. Acceptance is **binary by default**. A task with a generative/judgment core whose **quality** matters requires a **BEHAVIORAL, human-judged** acceptance criterion, because a binary check can be satisfied by a deterministic stub that skips the generation (the M5.2/3/4 skeleton failure). A generative task may remain binary only when its generated output has a declared deterministic validity check, with M7.6's base-valid characterization tests as the exemplar. The **granularity oracle / split rule** is the operative tool while building: *if you cannot state one acceptance criterion for the unit in front of you, it is too big — split it* into `M_.x.a`, `M_.x.b`, … before handing it off. This is the same discipline Hivemind's own planner will apply to its workers; here you apply it by hand.

Deterministic enforcement is structural: a task contract has exactly one `acceptance_criterion`, and that criterion must be backed by at least one named `required_tests` command or human-review check. Whether that sentence secretly bundles multiple unrelated tasks is a human ratification/planner-review judgment, not something deterministic lint pretends to prove.

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
  - Validate: `task_id`, `base_commit`, and `allowed_files` (non-empty array) are required; `allowed_files`/`read_only_files`/`forbidden_files` must be repo-relative paths or globs; the same path may not appear in both allowed and forbidden. `allowed_file_intents` may map each `allowed_files` entry to `create` or `modify`; missing, ambiguous, or invalid intent defaults to `modify` and is never guessed as `create`. On any violation, exit non-zero listing each problem.
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
- **Behavior — exact (C3, C4):** `active.json` is `{ "<path>": "<task_id>", ... }`. `requestLease` canonicalizes each file (M1.2) and grants **only if none is already held by another task**; otherwise reject listing the conflicting paths and holders. Contract-backed lease grant is create-aware: `allowed_file_intents` flows from plan → contract → lease; `modify` paths must exist at `base_commit`, `create` paths must not exist at `base_commit`, and create paths are confined/canonicalized then reserved in `active.json` exactly like existing-file leases. Lease-before-run checks coverage against that same create-aware resolved set. Writes are atomic and guarded by a file lock whose complete PID + unique identity is atomically published. Stale cleanup is serialized and clears only the exact unchanged owner record proven dead; malformed, changed, inaccessible, or ambiguously live locks remain held (C6).
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
*Goal: make self-protection available. M3.1 enables Hivemind to gate its own changes, but mandatory dogfooding is deferred through M7; direct contract-driven development remains the build mechanism.*

### M3.1 — Self-protection workflow (gate Hivemind's own changes)
- **Depends on:** M1.6 (the gate must be green — M1.5).
- **Read first:** Overview § *Bootstrapping* (stage 1), § *Development Plan* (M3).
- **Goal:** Route Hivemind's *own* repo changes through `hivemind analyze` before they are allowed to merge.
- **Create / may edit:** a dev workflow hook (pre-commit/pre-merge script or CI step) that, given a feature contract for the change, runs the gate; a short `CONTRIBUTING`-style note describing the loop.
- **Must NOT touch:** the gate internals (frozen at M1), the acceptance criteria of M1.5.
- **Behavior — exact:** When the self-protection workflow is deliberately used for a Hivemind change, write a contract (C7) scoping it, run `hivemind analyze`, and block the merge on a non-`accept` verdict. The human is still the orchestrator (writes the contracts); only the *safety* is automated.
- **Out of scope:** auto-decomposition or orchestration (M5); auto-merge.
- **Acceptance test (binary):** A deliberately out-of-scope change to the Hivemind repo is blocked by its own gate before merge; an in-scope change passes and merges.

### (optional) — Deliberate self-protection / dogfooding demonstration
- **Rule:** The protected workflow remains available, but it is not the M4–M7 build mechanism. M4–M7 are built by handing scoped contracts directly to the coding agent. A deliberate self-hosted demonstration may be run after M7 exists; it is evidence about orchestration, not a prerequisite for proving each feature correct.
- **Rationale:** The current executor is serial and orchestrator actions consume paid calls. Mandatory dogfooding during M7 would be slow and expensive, and would conflate “is M7 built correctly?” with “is Hivemind orchestrating correctly?” The orchestration thesis was already validated on trimr.
- **Acceptance test (binary, when deliberately demonstrated):** A selected Hivemind change has an associated contract and a recorded `accept` verdict in `log/events.jsonl`.

---

## M4 — Daemon + MCP + resource baseline
*Phase 2. Persistence, the MCP surface, and the resource layer. Each sub-task is one directly assigned, scoped contract; the optional M3 protected workflow remains available but is not mandatory.*

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

### M4.5 — Quota ledger (self-measured with provider refinement)
- **Depends on:** M4.1.
- **Read first:** Overview § *Resource & Continuity Manager* → *The quota ledger* (self-measured primary, provider-reported secondary).
- **Goal:** Track per-provider capacity primarily by **metering Hivemind's own usage**, calibrated by observed throttles.
- **Behavior — exact:** Maintain `.hivemind/resource/ledger.json` with separate `self_measured` usage (requests, prompt/output token estimates, wall-time), optional normalized `provider_reported` usage (input, cached input, output, reasoning, total), and visible `reconciliation` (matched estimate/report divergence plus the accounting/routing source). Provider parsing stays inside adapters. Capture state is explicit: `captured`, `not_available`, or `expected_but_unparseable`; an expected-but-unparseable report is durably recorded and surfaced as a defect signal rather than silently masquerading as provider silence. Hivemind's own counts remain the zero-cooperation fallback; a 429/throttle calibrates `observed_limit`; a captured provider report refines token accounting but is never required for quota-wall correctness. Model output metering excludes stderr CLI chatter. Local models = unmetered.
- **Out of scope:** routing decisions (M4.6), cache metering (M4.7).
- **Acceptance test (binary):** With no provider-reported quota at all, the ledger still reflects consumption from Hivemind's own counts; injecting a simulated 429 updates `observed_limit`. When normalized provider usage is available, both channels and their divergence are recorded; stderr CLI chatter does not inflate model-output estimates. A requested provider-usage format that cannot be parsed is distinguishable from unavailable provider usage and is surfaced.

### M4.6 — Pooling + tier-capped routing + ceilings
- **Depends on:** M4.5, M0.2 (contract tiers).
- **Read first:** § *Resource & Continuity Manager* → *Multi-provider pooling & routing*.
- **Goal:** Route tasks across providers by tier × ledger, with a hard tier cap and a run ceiling.
- **Behavior — exact (C4 for the cap):** Pool all providers; route Low-tier work to cheap/local, High/Critical to the strongest; **a Critical task can never be routed to a weak model to save quota** (hard floor, deterministic). Enforce configured request and wall-time ceilings plus `resource_policy.run_ceiling.tokens` for each metered adapter call and `resource_policy.session_ceiling.tokens` across a durable manager session. Defaults are 150,000 tokens per call and 500,000 tokens per manager session; larger runs require a deliberate pre-run config override. Token accounting uses captured provider totals when available and Hivemind's self-measured estimate otherwise; the chosen source is recorded. A known-too-large assembled prompt is refused before launch. The shipped Codex JSONL protocol reports usage only in the terminal `turn.completed` record and exposes no incremental token-stop control, so the configured per-call amount is an atomic admission reservation, not a provable in-flight consumption stop. A completed call may overshoot it; the exact overshoot, normalized usage, and full charge are surfaced durably, while the output is refused and a depleted session is refused before its next call. This is a token accounting/admission ceiling, not a dollar-price ceiling. Local/unmetered providers do not consume it.
- **Acceptance test (binary):** A Critical task is never assigned to a below-threshold model regardless of quota pressure; exceeding a configured request, wall-time, per-call token, or manager-session token ceiling stops with a surfaced message. Provider-reported totals enforce the token ceiling when captured; missing provider reports fall back to self-measured tokens; an exhausted session is refused before spawning the next metered adapter.
- **Known concurrency limitation:** The implemented token ceilings accumulate settled usage but do not atomically reserve budget for calls that would launch simultaneously. This is sound while metered execution is serial. Any future concurrent executor must reserve the estimated budget for every sibling atomically before launch so multiple calls cannot independently pass preflight against the same remaining session balance.

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
- **Behavior — exact:** TWO halves.
  (a) DETERMINISTIC action-execution loop — ALREADY BUILT in `src/manager.ts`; do not rewrite it. It stays the floor: every manager action is routed through the existing deterministic tools/gates for contract creation, create-aware lease grant, mandatory write-intent, dependency-order enforcement from the event trail, worktree creation, worker invocation, patch submission, diff-scope analysis, queueing, and shadow integration.
  (b) GENERATIVE half — NEW, the deliverable: replace the hardcoded `await_planning_loop` manager proposal with an orchestrator proposal generator. Given the current durable state (ratified spec, grounded+linted plan, task status, lease state, write-intent/gate/integration results), an LLM proposes the next manager actions: request leases, submit write-intent scoped to the granted lease, invoke workers, collect/analyze patches, and integrate. The generated proposal FEEDS the existing deterministic action loop (a); it does not bypass or duplicate it.
  LLM-integration decisions:
    * LLM calls are allowed here because a manager action list is a PROPOSAL, not a guarantee. C4 still forbids LLM calls inside contract validation, lease grant, write-intent checking, diff-scope analysis, integration, quota ceilings, and other guarantee-enforcing code.
    * Use the existing adapter mechanism; route the call through the resource ledger so it is metered. Do not invent a provider path.
    * The generator PROPOSES; deterministic gates DISPOSE. The manager must never self-approve a gate, mark a plan/spec ratified, skip plan-lint, skip write-intent, or treat its own narration as proof.
    * Consequential steps such as worker invocation and shadow integration remain explicit manager actions whose deterministic results are recorded; human approval is represented by the operator choosing to execute those proposed actions.
  (c) REACTIVE LOOP — NEW: an autonomous propose → observe → propose-next loop over the same executor. The loop considers one proposed action at a time, executes it only through the existing deterministic action executor, observes the result, and asks the orchestrator for the next proposal only after an allowed action passes. Every step is classified into exactly one tier:
    * Tier 1 — autonomous: `create_task_contract`, `request_lease`, `check_write_intent`, `create_worktree`, `submit_patch`, `analyze_patch`, and `enqueue_patch` may proceed automatically after their deterministic gate passes, unless the action touches Critical-tier scope or exceeds configured cost thresholds.
    * Tier 2 — human approval with advice: `run_worker`, `integrate_shadow`, configured high-risk actions, Critical-tier scope, irreversible actions, and actions whose estimated cost exceeds `.hivemind/config.json` manager-autonomy thresholds pause with the proposed action, reason, and recommendation. The loop does not execute these without an explicit human approval input.
    * Tier 3 — gate rejection hard stop: any deterministic gate rejection halts the loop. The loop surfaces the rejection reason, diagnosis, suggested options, and a recommendation; it does not ask the orchestrator for a retry and does not execute any variant. The orchestrator may propose changed work in a later human-started re-plan flow, but it must never autonomously change rules/config/provider tiers to force a rejected action through.
  The high-risk action list and cost threshold are configurable in `.hivemind/config.json`, defaulting conservatively to `run_worker` and `integrate_shadow` as human-approval actions and zero autonomous provider-request spend. Configuration changes are outside the autonomous loop and require explicit human action.
  If the generative half proves too large under C10, split it into state→action proposal generation and write-intent generation without creating a parallel manager executor.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** On the trimr spec/plan, the ORCHESTRATOR (not a human-authored action JSON file) proposes manager actions reactively. A human reads `docs/evidence/m5/autonomous-loop-transcript.md` and confirms: Tier-1 actions ran autonomously after passing gates; `run_worker` paused for approval; a tier-cap rejection produced a Tier-3 hard stop with advice; no gate was self-approved or bypassed; and the loop did not alter provider tier/config or auto-retry to defeat the rejection. Judged by reading output, not an automated pass/fail.

### M5.4 — Planning loop (tentative plan + task split)
- **Depends on:** M5.1.
- **Read first:** Overview § *Task Planner* → *The Planning Loop* (propose → ground → commit).
- **Goal:** Turn a ratified spec into a tentative task split with proposed parallel/sequence structure.
- **Behavior — exact:** TWO halves.
  (a) DETERMINISTIC plan-lint + storage — ALREADY BUILT in `src/plan.ts`; do not rewrite it. It stays the floor: disjoint parallel scopes, acyclic deps, grounding present/fresh, one acceptance criterion backed by a test or named human review check, generative skeleton-trap rejection, no unflagged Critical. The generator must FEED this, never bypass it.
  (b) GENERATIVE half — NEW, the deliverable: given the ratified spec, an LLM produces the task decomposition — tasks with titles, `task_type` (`generative` or `deterministic`), draft scopes (`allowed_files`/`read_only_files`/`forbidden_files`), dependencies, parallel flags, one `acceptance_criterion` each backed by named tests/review checks, `deterministic_validity_check` where required, and Critical flags. Generative tasks whose LLM-judgment output quality matters must receive a BEHAVIORAL/human-judged acceptance criterion instead of a stubbable binary one unless they declare a deterministic validity check for the generated output. A task of either type whose acceptance criterion names a mechanically observable interface — CLI flags or arguments, an exported signature, an output shape, or a file format — must declare an independent executable `deterministic_validity_check` that tests that surface from the plan-authored contract rather than relying on tests the worker writes. The human steers/approves; the human does NOT author the plan JSON.
  LLM-integration decisions:
    * LLM call is allowed here — a plan is a PROPOSAL, not a guarantee; C4 still forbids LLM calls inside plan-lint/grounding/lease enforcement, which stay deterministic.
    * Use the existing adapter mechanism (same as M5.2's ideation generator and Scout); route through the resource ledger so it's metered. Do not invent a new provider path.
    * The generator PROPOSES the plan; plan-lint DISPOSES on validity; the human RATIFIES. The LLM must NEVER mark its own plan ratified or skip lint.
    * The generated plan flows into the SAME path a human-authored plan JSON does today, so it hits the existing plan-lint unchanged.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** On the trimr spec, the ORCHESTRATOR (not a human JSON file) produces the task decomposition. A human reads the plan and confirms: tasks have real scopes/deps/parallel flags, `task_type` labels, acceptance criteria with behavioral/human-judged criteria where generative quality matters, the plan was generated not authored, it passed the existing plan-lint, and nothing was self-ratified. Judged by reading output, not an automated pass/fail.

### M5.5 — Grounding (evidence + existence + freshness)
- **Depends on:** M5.4, M0.2.
- **Read first:** § *Task Planner* → grounding evidence tiers (existence, freshness).
- **Goal:** Require deterministic create-vs-modify grounding evidence before a lease can be granted.
- **Behavior — exact (C4/C6):** `draft_scope.allowed_files` may include optional per-path intent in `draft_scope.allowed_file_intents`: `{ "<allowed_files entry>": "create"|"modify" }`. Missing, ambiguous, or unparseable intent defaults to `modify` (the stricter side). `modify` allowed paths and all `read_only_files` must exist at the task's `base_commit`. `create` allowed paths must **not** exist at `base_commit` (else reject as a silent clobber) and must canonicalize/confine inside the repo and task scope. A `create` glob may ground with zero base matches; a `modify` glob must match tracked files. The normalized intent map is persisted from grounded plan into the task contract and re-used by lease grant; create paths are reserved in the lease store so two tasks cannot both create the same path. Evidence must reflect the current base (stale → re-derive). Advisory closure-coverage is a flag only (fail-safe), not a block.
- **Acceptance test (binary):** A modify path that does not exist is rejected; a create path that already exists is rejected; a create path/glob that is confined and does not exist grounds; an unlabeled path is treated as modify and must exist; a scope built on a stale base is flagged for re-derivation.

### M5.6 — Plan-lint (deterministic plan checks)
- **Depends on:** M5.4, M5.5, M2.1.
- **Read first:** § *Task Planner* (plan-lint).
- **Goal:** Deterministically reject a malformed plan before execution.
- **Behavior — exact (C4):** Check: parallel task scopes are pairwise disjoint (else they can't both hold leases); the dependency graph is acyclic; grounding is present and fresh (M5.5); no Critical path is touched without the required approval flag; a `generative` task without a `deterministic_validity_check` must use a BEHAVIORAL/human-judged acceptance criterion rather than a trivially automatable binary/stub criterion; and any task whose acceptance names a mechanically observable interface must carry an independent executable `deterministic_validity_check`. The observable-interface rule is deliberately narrow: prose-only quality criteria remain permitted, while named CLI flags/arguments, exported signatures, output shapes, and file formats are checkable and therefore require the independent check. A check identical to the worker's `required_tests`, or an unconditional pass, is rejected. The exact check is propagated into the immutable task contract, shown during plan ratification, injected into worker context as specification, and executed by verification from the repository's contract; a worker-local contract cannot replace it. Any failure bounces the plan with the specific rule. Plan-lint validates dependency shape, but execution primitives enforce dependency completion as a floor: a dependent task cannot contract, lease, run, or enqueue until the durable event trail proves each dependency integrated.
- **Acceptance test (binary):** A plan with two overlapping parallel scopes, a dependency cycle, an unflagged Critical edit, a generative task with only a stubbable binary acceptance criterion, or an observable interface without an independent validity check is rejected naming the failing rule. A clean deterministic plan and a prose-only criterion pass. A generative plan with behavioral acceptance passes; a generative plan with a deterministic validity check on its output may keep a binary criterion and passes. A worker implementing the wrong named CLI interface fails the contract's validity check even when its self-authored tests pass, and a worker-local attempt to replace the contract/check has no influence.

### M5.7 — Scout role + context-pack assembly
- **Depends on:** M5.4, M4.7 (cache).
- **Read first:** Overview § *Resource & Continuity Manager* (Scout-once context packs), § roles.
- **Goal:** A Scout pass that gathers grounding evidence into a reusable context pack.
- **Behavior — exact:** The Scout explores the relevant code and emits findings + a context pack (graph slice + conventions + key files) stored as a cacheable artifact (M4.7) and seeded into `tasks/<id>.knowledge.md`. Workers and reroutes reuse the pack instead of re-exploring.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** On a real task, the Scout (an LLM, not a fixed file-dump) decides WHICH files/symbols are relevant and emits a context pack. A human reads the pack and confirms: it contains the genuinely relevant files for the task (not a blind dump or a hardcoded set), the relevance was reasoned, and a subsequent worker consumes it (cache hit + seeded knowledge file) instead of re-exploring. The generative relevance-judgment is what's being judged, not merely that a pack was produced and consumed. Judged by reading output, not an automated pass/fail. The Scout PROPOSES context; it never bypasses grounding/lint/lease — those still verify the scope deterministically.

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
- **Behavior — exact:** A pub/sub layer over the daemon emits the event types (M2.7 + `task.*`, `quota.low`, `context.low`, `orchestrator.*`) to connected subscribers. The authoritative bus is read/publish only over durable state: `.hivemind/log/events.jsonl` remains the compact state-transition/control trail, subscribers replay current state from that trail, and observation never mutates state or gates work. Worker stdout streams live during a run through separate durable per-task output streams under `.hivemind/log/tasks/<task_id>.output.jsonl`; tool-specific parsing asymmetry (Claude Code stream-json vs Codex exec stream vs future tools) stays inside the adapter abstraction, not in the event bus or core.
- **Acceptance test (binary):** A subscriber receives authoritative events in real time during a run; a running worker's stdout is observable mid-run from that task's output stream rather than only at completion; a subscriber connecting mid-run can replay correct current authoritative state and separately replay/tail one task's output; and the event bus contains no tool-specific Claude/Codex branching because it consumes normalized adapter stream chunks.

### M6.2 — Live task board + agent monitor
- **Depends on:** M6.1.
- **Read first:** Overview § *Full Application UI* (Task Board, Agent Monitor, Lease View).
- **Goal:** Live views of tasks, agents, leases, quota, and checkpointed state.
- **Behavior — exact:** A Tauri desktop UI renders current tasks/states, active leases, quota/resource events, integration status, and selected per-task worker output. It is a thin read-only presentation layer over the daemon: it consumes `GET /events/stream` for authoritative history-replay-then-live state/control events and `GET /tasks/<id>/output/stream` for selected task output on demand. The UI contains no Hivemind logic, no gate logic, no state authority, and no action controls; Hivemind core does not depend on the desktop shell.
- **Acceptance test (binary):** During a run, the desktop board reflects task/lease/quota/integration state changes live; selecting a task shows that task's output stream live; opening the app mid-run shows current state from history replay before live updates; and the renderer has no Hivemind action controls.

### M6.3 — Redirect-first correction loop
- **Depends on:** M5.3, M6.1, M2.3.
- **Read first:** Overview § *Real-Time Supervision* (redirect-first; pause/cancel last resort).
- **Goal:** Correct a drifting worker at a safe boundary instead of killing it.
- **Behavior — exact:** At the existing write-intent/checkpoint boundary, if a worker drifts, the deterministic write-intent gate refuses the out-of-scope intent and the orchestrator acts as a coach: it proposes a drift-specific correction, records `task.revision_requested`/`task.redirected`, and lets the worker continue by re-declaring intent. The redirect path reuses the existing `revision_requested → in_progress` lifecycle and does not add or replace any safety gate. Deterministic gates remain the referee; redirect is UX/efficiency only. Redirect attempts are bounded; repeated write-intent rejections escalate to re-plan rather than looping forever. `task.cancelled` is last resort only for wedged/no-progress workers.
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** On a real drift, the orchestrator (an LLM, not a fixed template) emits a correction specific to what the worker actually did wrong and useful for getting back in scope, and the worker completes in-scope without a full cancel/restart. A human judges whether the correction is substantive rather than a generic nudge. Separately verify the deterministic floors with binary tests: the write-intent gate refuses the out-of-scope intent before redirect; the redirect bound is enforced and terminates; repeated redirects escalate to re-plan; terminate/cancel is not used before redirect/re-plan.

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
- **Behavior — exact:** Predictive: when the ledger nears a wall, checkpoint and reroute before failure. Reactive: on a 429, fall back and resume from the checkpoint on any available provider. If no eligible provider remains, checkpoint and emit a quota pause awaiting reset rather than `task.failed`; the task stays in progress and the checkpoint remains resumable later. The reactive path is always correct; predictive is best-effort.
- **Acceptance test (binary):** A simulated quota wall mid-task results in a checkpoint + resume on another provider, and the completed work is preserved (no restart from zero). If no eligible provider remains, the same wall checkpoints and emits quota-paused state, not failure; later provider availability resumes from the checkpoint with no lost work.

### M6.6 — Context budget + working-set + orchestrator re-hydrate
- **Depends on:** M6.4, M4.7.
- **Read first:** Overview § *Context & Working-Set Management* (stateless over durable store; the hard lane rule).
- **Goal:** Treat context-window pressure as a managed budget; rebuild the orchestrator from the store on demand.
- **Behavior — exact (C2):** Meter assembled context size; near the limit, checkpoint + distill to durable state + re-hydrate lean. The orchestrator reads authoritative state from `.hivemind/` (never trusts a summary for authoritative state); `orchestrator.snapshot.json` lets it tear down and rebuild. The snapshot is a working-set manifest (refs/retrieval instructions), not an authoritative copy of leases, task state, patch state, or integration state.
- **Acceptance test (binary):** Forcing context pressure triggers a checkpoint + lean re-hydrate; the orchestrator reconstructs correct state (active leases, task states) from disk, not from a summary. A stale-summary divergence fixture must prove the lean prompt follows current `.hivemind/` state, and the snapshot must not contain authoritative state copies that could drift.

### M6.7 — Partial-failure degradation
- **Depends on:** M4.1, M6.1.
- **Read first:** § *Robustness Principle* (degrade, don't break), § *Real-Time Supervision*.
- **Goal:** One worker failing must not collapse the run.
- **Behavior — exact (C6):** A worker crash/timeout marks only that task failed/blocked, releases its lease, surfaces it, and lets the other tasks proceed. No shared-state corruption.
- **Acceptance test (binary):** Killing one of two parallel workers leaves the other running to completion; the failed task's lease is released and the failure is surfaced. Current M5/M6 manager execution is serial, so this acceptance is exercised at the run/daemon primitive layer where independent leased task jobs can be in flight; do not fake manager-level concurrency until the executor explicitly supports it.

---

## M7 — Depth + learning
*Phases 6–7. Semantic depth, memory, and the learning flywheel. Build each by handing its scoped contract directly to the coding agent; mandatory dogfooding remains deferred.*

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
- **Acceptance test (BEHAVIORAL, human-judged — NOT binary):** Given a realistic Tier-1 history, the consolidation worker (an LLM, not a stub) produces DISTILLED proposals — real lessons/patterns extracted from the history, not noise or placeholders. A human reads the proposals and confirms they are substantive distillations a reasonable reviewer would consider promoting. SEPARATELY, the deterministic gate is still verified (binary): no proposal reaches canon without human approval, nothing flows logcanon automatically. So: the DISTILLATION QUALITY is human-judged; the PROMOTION GATE stays a hard deterministic floor. The worker PROPOSES; it never self-promotes to canon.

### M7.5 — Learned routing policy
- **Depends on:** M4.5, M4.6, M2.7.
- **Read first:** Overview § *Agent Scorecards*, § *Resource & Continuity Manager* (waste accounting).
- **Goal:** Adapt routing from metered merged-diff-per-quota and per-provider/per-task-type performance.
- **Behavior — exact:** Automatically derive human-inspectable scorecards and proposed routing weights from Tier-1 metrics (effective throughput, handoff-safety, merged-diff-per-quota), keyed by a separate required `routing_task_type` domain classification that flows planner → plan → contract → run evidence. Its fixed domain is `api | architecture | build_tooling | cli | data_model | documentation | integration | migration | observability | orchestration | performance | refactor | security | storage | testing | ui | other`; the existing `task_type` (`generative` or `deterministic`) remains the acceptance/lint axis and is not overloaded. Each production adapter attempt appends raw provider, timing, token-source, diff-size, exit/timeout, and handoff evidence keyed by task and run; scorecard derivation joins that observation to the subsequent durable patch, integration, revision, and terminal task events, so the resulting metrics remain rebuildable from the authoritative trail rather than becoming a second source of truth. A verified capability-corpus report may also be registered as controlled shadow evidence: registration hash-binds the immutable report and manifest, identifies the exact included providers, records model identifiers and corpus dates, and converts attempts directly into `corpus_shadow` metric samples without fabricating task, patch, or integration lifecycle events. Production and corpus rankings remain separate; production observations take precedence when present and disagreement is surfaced rather than averaged away. A same-name model behavior change cannot be detected automatically, so corpus model/date provenance is an explicit reviewer-visible staleness limit. Derived weights are reproducible proposals, not authority: they influence routing only after explicit human promotion through the M7.3 Tier-2 canon gate. Until promotion, and whenever policy is absent, empty, stale, or invalid, routing uses the existing tier-based path unchanged. The tier cap from M4.6 still overrides every promoted policy (a Critical task is never downgraded).
- **Why human promotion remains required:** Deterministic arithmetic is reproducible, not necessarily correct. Sparse observations can be confounded: one provider timeout and one out-of-scope rejection may reflect transient infrastructure or a prompt/scope defect rather than provider capability. The tier cap catches unsafe downgrades, but it cannot catch a confidently wrong economic inference that systematically misroutes future work. Metric-derived M7.5 weights and LLM-distilled M7.4 routing proposals therefore use the same Tier-2 human-review door; nothing learned becomes authoritative without review.
- **Acceptance test (binary):** Feeding history where provider A reliably outperforms B on a routing task type produces inspectable weights favoring A for that type. The unpromoted scorecard does not affect routing; after interactive human promotion through the M7.3 gate, routing shifts toward A without ever breaching the tier cap. A reviewer can see WHY routing shifted (which metrics drove which weight), so a trivial hardcoded counter that fakes the correlation is distinguishable from genuine metric derivation. A shift for routing task type X does not bleed into type Y; provider-reported cost is preferred when captured with self-measured fallback identified; absent/empty/stale/invalid policy preserves the existing tier-based route; corpus evidence remains distinguishable from production outcomes; a tampered corpus report is refused; and a policy whose evidence identity does not bind its cited report cannot become active.

### M7.6a — Structural oracle measurement
- **Depends on:** M2.5, M7.1, M7.8.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*; § *Verification Engine*.
- **Goal:** Measure and surface the structural relationship between a change's graph-resolved impact set and the checks that claim to exercise it, without yet blocking integration.
- **Behavior — exact (C4):** Reuse M7.8's structured check inventory, graph-derived impact set, named-check execution evidence, and durable verification audit; do not build a second inventory, graph selector, or check runner. For each patch, deterministically record the changed files, graph-resolved impact files, checks associated with those files, and which impact files are covered, uncovered, or unresolved. This structural measurement is **ADVISORY ONLY** and never changes what may integrate. A missing, stale, invalid, disabled, unsupported, or unresolved graph/inventory produces an explicit `unknown` structural result rather than invented confidence. Structural reachability proves only that an inventoried check is associated with an impact file; it is **never sufficient by itself** to classify a High/Critical oracle as strong.
- **Out of scope:** runtime line coverage; characterization-test generation; blocking integration; new graph analysis beyond M7.1/M7.8; single-patch broker oracle feedback.
- **Acceptance test (binary):** A fixture with known changed files, graph impact, and check inventory produces the exact covered/uncovered/unresolved structural result and records it durably; missing or invalid graph/inventory state produces explicit `unknown`; and every result remains advisory, leaving integration behavior unchanged.

### M7.6b — Configured LCOV coverage measurement
- **Depends on:** M7.6a.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*; § *Verification Engine*.
- **Goal:** Measure runtime coverage of changed executable lines and graph-resolved impact files when, and only when, a repository explicitly configures coverage.
- **Behavior — exact (C4/C6):**
  - Coverage is an **opt-in repository capability** configured in `.hivemind/config.json` under `verification.coverage` as `{ "command": "<coverage command>", "report_path": "<LCOV file>", "format": "lcov" }`. M7.6 ingests configured LCOV output; it does not hardcode Jest, c8, V8, or any provider/tool-specific coverage behavior.
  - Distinguish four results: `unconfigured`, `strong`, `weak`, and `unknown`. `unconfigured` means the repository has not opted into coverage; no coverage command runs, M7.6a's structural result remains advisory, and integration behavior is unchanged. `unknown` is reserved for a repository that **did opt in** but whose coverage command/report is missing, malformed, stale, unmappable, or otherwise unusable.
  - Before each configured run, prevent a prior report from being mistaken for current evidence; execute the configured command in the applied shadow worktree, ingest the newly produced LCOV report, and map it to the actual diff and M7.6a impact set. The strict `strong` threshold is: **every changed executable line is hit, and every graph-resolved impact file has an exercising check**. Valid measurement below that threshold is `weak`.
  - A post-change test failure may represent a regression **or an intended behavior change**. Hivemind records the observable pass/fail evidence and affected checks; no LLM decides which semantic interpretation is true.
- **Out of scope:** coverage-tool installation; non-LCOV formats; semantic classification of failures; integration blocking; automatic test generation.
- **Acceptance test (binary):** Configured LCOV fixtures deterministically produce the exact changed-line and impact-file result; complete evidence yields `strong`; an uncovered changed executable line or impact file yields `weak`; configured missing/malformed/stale/unmappable evidence yields `unknown`; and absent coverage configuration yields non-binding `unconfigured` without running a coverage command.

### M7.6c — Characterization candidate validity harness
- **Depends on:** M7.6a, M7.6b.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*; § *Patch Broker* → diff-scope gate.
- **Goal:** Deterministically validate an untrusted characterization-test candidate against the pre-change base and the post-change worktree without allowing it to mutate authoritative project state.
- **Behavior — exact (C4/C6):**
  - Store each candidate as an immutable artifact under `.hivemind/resource/oracle-candidates/<candidate_id>/`, containing its manifest, proposed test-only patch, validation commands, and results. Candidates do not silently modify the task worktree, repository, canon, or integration state.
  - Repositories opt into candidate validation with repository-authored `verification.test_paths: string[]` globs. The candidate cannot add, override, or influence this allowlist. Missing or empty `test_paths` refuses candidate validation with no inferred/permissive fallback, while normal integration remains unaffected. Configuration rejects absolute/traversing patterns and patterns that trivially admit non-test source paths.
  - Build the candidate's synthetic contract only from `verification.test_paths`, then validate its changed paths through the **existing diff-scope machinery**. A candidate touching any path outside the configured test-only scope is rejected by that existing floor; do not build a parallel path check.
  - In a disposable checkout at the task's pre-change `base_commit`, apply only the candidate and run its named test. If it does not pass on the unmodified base, reject it. Then run the same candidate against the applied post-change tree. Base-pass/post-change-fail is recorded as a behavior flip; base-pass/post-change-pass is a valid characterization result.
  - Verify both disposable trees' exact commit/content identity and run the identical repository-configured named check on both. Unprovable/divergent identity or observable non-determinism is `indeterminate`, never a confident characterization. Every path cleans disposable worktrees/branches and leaves the task worktree, repository, canon, and integration state untouched.
  - A post-change failure may be a regression **or an intended behavior change**. The deterministic harness reports the flip and its evidence; the generator/LLM never decides which interpretation is correct. That judgment remains human.
- **Out of scope:** generating the candidate; promoting or applying a validated candidate to the repository; weakening the existing diff-scope gate; treating a behavior flip as automatic proof of a defect.
- **Acceptance test (binary):** Missing/empty `verification.test_paths` refuses only candidate validation; candidate-supplied scope cannot widen the repository allowlist; a candidate touching a non-test path is rejected through the existing diff-scope gate; a test that fails on the base is rejected; a base-pass/post-change-fail candidate records a behavior flip without semantically labeling it; a base-pass/post-change-pass candidate validates; identity uncertainty is indeterminate; the same named check runs on both trees; and all candidate artifacts remain immutable and isolated with no leaked disposable worktree/branch or mutation to the task worktree, canon, and repository.

### M7.6d — Opt-in tier-scaled oracle floor
- **Depends on:** M7.6a, M7.6b, M7.6c.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*; § *Verification Engine*.
- **Goal:** Enforce a strict oracle requirement for High/Critical shadow integration only in repositories that explicitly opt into configured coverage.
- **Behavior — exact (C4/C6):**
  - Enforce at the **shadow-integration primitive**, for every caller. Do not rely on manager behavior. M7.6d must not ship before M7.6a/b/c: measurement and a deterministic remediation path must exist before the blocking floor.
  - **Coverage not configured:** the strict floor does **not** bind. M7.6a structural measurement is surfaced as advisory and integration proceeds exactly as it did before M7.6. Unconfigured coverage means the repository has not opted into this floor; it is not broken state.
  - **Coverage configured:** `strong` means every changed executable line is hit and every graph-resolved impact file has an exercising check. A High/Critical change may integrate only with `strong`; `weak` or `unknown` fails closed and no `integration.passed` event may be emitted. Missing, malformed, stale, unmappable, or failed configured coverage is `unknown`, not `unconfigured`. Low/Medium changes may proceed with a durable low-confidence advisory.
  - M7.8 structural reachability alone is **never sufficient** to classify a High/Critical oracle as strong. A configured weak/unknown stop recommends the explicit `hivemind verify characterize ...` remediation command but never launches it.
  - There is **no human override inside Hivemind v1**. Hivemind must not emit `integration.passed` while its own configured High/Critical oracle requirement is unmet. A durable explicit human-acceptance mechanism may be considered later only if real use shows the strict floor is too rigid; begin strict and loosen only on evidence.
  - This floor applies to **shadow integration only**. The Overview's broader single-patch broker oracle-feedback claim is deferred and remains unimplemented.
- **Out of scope:** making coverage mandatory for all repositories; automatic characterization generation; human override; single-patch broker blocking; changing M7.8's Low/Medium selective-verification rules.
- **Acceptance test (binary):** An unconfigured repository can integrate a High/Critical change with structural evidence surfaced only as advisory; a configured High/Critical change integrates only with `strong`; configured `weak` and every configured `unknown` case fail closed at the shadow-integration primitive with no `integration.passed`; Low/Medium configured weak evidence remains non-blocking and visible; and the remediation recommendation invokes no adapter.

### M7.6e — On-demand characterization-test generator
- **Depends on:** M7.6c, M7.6d.
- **Read first:** Overview § *Shadow Integration Service* → *Oracle strength: raise it, don't just regret it*; § *Value-Gated Quality Strategy*.
- **Goal:** On explicit human request, use an LLM to propose characterization tests for a thin oracle, then subject every proposal to M7.6c's independent deterministic validity harness.
- **Behavior — exact:**
  - Add an explicit on-demand command, `hivemind verify characterize ...`. A weak-oracle result may recommend it but must never launch it automatically. There is no timer, scheduler, implicit retry, or automatic generation during integration. This follows M7.4's cadence decision: provider calls carry an observed roughly 14K-19K token floor, so the human triggers and bounds each spend.
  - Use the existing adapter/profile mechanism and resource ledger; do not add a provider-specific invocation path. The generator receives the task contract/base, grounded scope, context-pack reference, M7.6a impact evidence, M7.6b coverage evidence, and M7.8 inventory, and proposes a **test-only** candidate artifact under `.hivemind/resource/oracle-candidates/<candidate_id>/`.
  - The LLM proposes only. It cannot self-validate, self-promote, modify the task worktree/canon/repository, satisfy the configured oracle floor by narration, or bypass integration. M7.6c independently applies the existing diff-scope gate and the must-pass-on-base rule.
  - Per C10, this generative subtask may retain binary acceptance because its output has an independent deterministic validity rule: the generated test passes on the pre-change base or is rejected. Fixture coverage alone is insufficient to close M7.6e; after free mechanism tests pass, one separately approved real-provider demonstration must capture the actual generated candidate, validity result, and metered spend.
- **Out of scope:** automatic/scheduled generation; applying or promoting candidates into the repository; deciding whether a behavior flip is a regression or intended change; multi-provider best-of-N generation; M7.7 executor concurrency.
- **Acceptance test (binary):** Free fixtures prove adapter output can only become an immutable test-only candidate and cannot bypass M7.6c or launch automatically; then one separately approved real-provider invocation produces an actual candidate that either passes on the pre-change base or is deterministically rejected, with the verbatim candidate, validation result, and spend captured as evidence.

**M7.6 deferred boundaries:** single-patch broker oracle feedback; automatic/scheduled characterization generation; non-LCOV coverage formats; coverage-tool installation; coverage UI polish; flaky-test scoring; automatic candidate promotion/application; semantic regression-vs-intended-change judgment; richer symbol/call-graph precision; and M7.7's simultaneous/concurrent executor prerequisite. M7.7b owns independent speculative draft identities; only simultaneous scheduling remains deferred.

### M7.7a — Value-policy admission
- **Depends on:** M4.6, M5.3, M7.3, M7.5.
- **Read first:** Overview § *Value-Gated Quality Strategy*; § *Agent Scorecards*; § *Project Memory Log*.
- **Goal:** Decide deterministically when extra quality spend is permitted before any adapter launches.
- **Behavior — exact (C4 for the floors):** Quality strategies are explicit, on-demand commands only; the autonomous manager never launches them. High/Critical tasks are eligible, Low-tier tasks are always skipped, and Medium tasks are eligible only when their required `routing_task_type` is identified as error-prone by an active human-promoted Tier-2 value-quality policy. Raw scorecards, Tier-1 evidence, unpromoted proposals, absent/stale/invalid policy, caller claims, flags, and environment variables have zero authority to classify a Medium task as error-prone. Every requested or automatic provider still passes the existing M4.6 tier floor. Best-of-N defaults to `N=2`, rejects values outside `2..3`, and uses one durable `quality_run_id` as the ledger session for generation, refinement, and selection so the 150,000-token call ceiling and 500,000-token session ceiling bind cumulatively.
- **Acceptance test (binary):** Low never launches quality work; High/Critical is admitted; Medium is admitted only by a current promoted Tier-2 error-prone policy; unpromoted/absent/stale/invalid policy has zero influence; `N` defaults to 2 and rejects values below 2 or above 3; every provider remains tier-eligible; and exhausted call/session ceilings refuse before the next adapter spawn.

### M7.7b — Isolated speculative-draft substrate
- **Depends on:** M7.7a, M7.6e, M7.8.
- **Read first:** Overview § *Value-Gated Quality Strategy*; M7.6e's proposer/disposer design.
- **Goal:** Produce and validate independent speculative drafts without weakening the canonical task lease or mutating canonical task state.
- **Behavior — exact (C4 for disposal):** Give every quality invocation a distinct `quality_run_id` and every draft a distinct `draft_id`. Store immutable manifests, patches, output, gate evidence, verification evidence, and provenance under `.hivemind/resource/quality-runs/<quality_run_id>/drafts/<draft_id>/`. Each speculative draft runs in its own identity-verified disposable checkout at the canonical contract's exact `base_commit`; v1 generates drafts sequentially. Speculative drafts hold **no canonical task lease** and cannot mutate the canonical task worktree, patch bundle, lease store, canon, repository, task output stream, or canonical task/patch/integration lifecycle. This follows M7.6e's proposer/disposer precedent: the adapter only proposes inside an isolated checkout, every resulting non-empty patch passes the existing `runGate()` against the canonical contract, and existing shadow verification runs against the actual draft. The real lease invariant is unchanged because only canonical task execution may hold a file lease. Draft events/output use a quality-run namespace and cannot masquerade as `task.completed`, `patch.accepted`, or `integration.passed`.
- **Acceptance test (binary):** Two same-scope fixture drafts use distinct disposable checkouts and immutable artifacts while acquiring no canonical lease and leaving the repository, canonical worktree, patch bundle, lease store, canon, task output, branches, and canonical event state unchanged. Empty or out-of-scope drafts cannot become eligible; actual gate and shadow outcomes are recorded; and every success/failure path cleans its disposable checkout without weakening `runGate()` or shadow verification.

### M7.7c — Sequential best-of-N draft generation
- **Depends on:** M7.7b.
- **Read first:** Overview § *Value-Gated Quality Strategy*; § *Resource & Continuity Manager*.
- **Goal:** On explicit human request, generate N real, materially distinct alternatives through the existing adapter and resource-ledger path.
- **Behavior — exact:** Add an on-demand best-of-N command with `N=2` by default and hard maximum `N=3`; nothing launches it automatically. Generate each draft sequentially in its M7.7b checkout, using the same `quality_run_id` ledger session for all calls. Encourage provider-neutral diversity through prompt framing: the first draft solves the contract directly; each later draft receives the prior immutable draft patches/evidence and is explicitly asked to pursue a materially different design or implementation rather than cosmetic variation. Do not depend on provider-specific temperature or seed controls. Prompt framing encourages but cannot guarantee diversity; material difference remains a human judgment. A real run that produces near-identical drafts is a reportable finding that best-of-N did not earn its multiplied cost, not a passing result to paper over or retry into looking distinct.
- **Acceptance test — TWO coupled parts:** (a) **BEHAVIORAL, human-judged:** In one separately approved real-provider run, a human reads all N actual patches and confirms they are materially distinct approaches/implementations, not N invocations yielding one answer with cosmetic differences. Near-identical output fails the behavioral bar and is reported honestly. (b) **DETERMINISTIC, binary regardless of draft quality:** Exactly N independently identified artifacts are produced sequentially through the existing adapter path; every call is tier-eligible and recorded under the same quality-run session; call/session ceilings bind cumulatively; and no draft mutates or advances canonical task state.

### M7.7d — Shadow-grounded winner proposal
- **Depends on:** M7.7c.
- **Read first:** Overview § *Value-Gated Quality Strategy*; § *Shadow Integration Service*.
- **Goal:** Propose a winner only from real draft patches and their actual deterministic gate/shadow-test outcomes.
- **Behavior — exact (C4):** Selection is deterministic and makes no LLM call. Re-derive the eligible set from each immutable patch and its actual M7.7b evidence: the patch must be non-empty, `runGate()` must have accepted it, and shadow verification must have passed. Rejected, escalated, failed, indeterminate, or empty drafts cannot enter the winner set; escalation requires human handling and is never auto-eligible. If none qualify, record a no-winner result. When multiple drafts qualify, select by the explicit `minimal_verified_change_surface_v1` rule: fewest changed files, then fewest changed patch lines, then smallest UTF-8 patch byte length, then lexical `draft_id`. This minimizes deterministic verified change surface without inventing semantic or stylistic superiority. Record every candidate's patch identity, gate/shadow inputs, eligibility, metrics, rule, and result in an immutable `selection.json` plus a durable advisory event. “Keep the winner” means retain only that immutable **selected advisory artifact** under the quality run. Selection never writes the canonical worktree or patch bundle, never emits canonical acceptance/queue/integration evidence, and never bypasses the normal gate. Automatic adoption is out of scope; it would require a separate deterministic contract with a real lease, approved write intent, re-derived diff, and the normal submit/analyze/integrate pipeline. The earlier LLM-selector concept is deliberately dropped: correctness differences are already disposed deterministically, while choosing between equally passing drafts would add a paid call grounded only in style.
- **Acceptance test (binary):** An ineligible draft cannot be selected; empty, rejected, escalated, shadow-failed, and indeterminate cases are excluded; an empty eligible set yields an immutable no-winner result; multiple eligible drafts follow the recorded deterministic rule rather than iteration accident; and selection records its rule and all inputs durably while producing no canonical task completion, patch acceptance, queue, or integration state. No provider call occurs.

### M7.7e — Draft-cheap, refine-expensive
- **Depends on:** M7.7b, M7.7d.
- **Read first:** Overview § *Value-Gated Quality Strategy*; § *Resource & Continuity Manager*.
- **Goal:** Offer a separate on-demand two-stage strategy that spends one tier-eligible draft call and one tier-eligible critique/refinement call.
- **Behavior — exact:** Add an explicit on-demand draft/refine command; nothing launches it automatically. The first call uses the cheapest provider that still satisfies the task's tier floor. The second uses the strongest eligible provider and receives the immutable first draft plus its actual gate/shadow evidence, then proposes a refined patch in a separate M7.7b artifact. “Cheap” never permits a tier downgrade; for High/Critical work both stages may require strong-tier providers. Both calls and any selection rationale use one `quality_run_id` ledger session, remain immutable/advisory, pass through the same existing gate/shadow disposal, and never adopt themselves into canonical task state.
- **Acceptance test — TWO coupled parts:** (a) **BEHAVIORAL, human-judged:** In one separately approved real-provider run, a human reads the draft, its actual gate/shadow evidence, and the refined patch and confirms the refinement is substantive and evidence-grounded rather than a restatement, cosmetic rewrite, or fixed stub. Weak/non-substantive refinement is reported as a finding, not retried into a pass. (b) **DETERMINISTIC, binary regardless of refinement quality:** Both calls are on-demand, tier-eligible, cumulatively ceiling-bound, isolated, immutable, and advisory; both actual patches go through the existing disposer; and neither stage can write or advance canonical task state.

**M7.7 explicit deferrals:** simultaneous/concurrent generation is a separate future milestone, estimated at roughly one to two weeks plus a dedicated safety audit for manager scheduling, atomic token-budget reservation, cancellation, and partial-failure behavior. Automatic winner adoption is also deferred to its own deterministic contract. Neither deferral permits a lease exception or a shortcut around the canonical submit/analyze/integrate path.

### M7.8 — Verification learns which checks matter
- **Depends on:** M2.5, M7.1, M7.3.
- **Read first:** Overview § *Verification Engine*.
- **Goal:** Run the relevant checks for a change rather than the whole suite every time.
- **Behavior — exact (C4):** Add a structured inventory of named checks (`id`, `command`, JS/TS `entry_files`) while retaining `config.test_command` as the authoritative full-suite fallback. For Low/Medium changes, use the M7.1 graph to select checks whose entry-file dependency closure exercises every changed file. Human-promoted Tier-2 canon may add historical file-to-check associations; raw Tier-1 log never narrows verification, and canon associations may add checks only. Narrowing is forbidden for High/Critical tasks and whenever the graph/inventory/impact is missing, disabled, stale, invalid, unloadable, unsupported, unresolved, dynamic, or otherwise uncertain: run the full suite. The graph-aware selector is the sole documented M7.1 structural-boundary exception and is reachable only from shadow verification; all other guarantee paths remain graph-isolated. Append a durable `verification.completed` audit containing selected/skipped checks and why.
- **Acceptance test (binary):** For a localized Low/Medium JS/TS regression, the engine runs an impacted subset that is verifiably smaller than the inventory and still catches the regression a full run catches. Unknown impact; missing/stale/invalid/disabled graph; non-JS/TS change; unresolved/dynamic dependency; or High/Critical tier runs the full suite. A narrowed run records selected/skipped checks and its impact reason in the durable trail, and a structural test proves only the isolated verification selector may bring graph data into shadow integration.

---

## M8 — Workspace UI
*Turn the verified read-only Tauri monitor into the prompt-first local workspace. Build the rough functional outline first; iterate visually only after the full workspace exists.*

**M8 workspace rules (all six contracts):**

- **Plain language first.** The main UI must let a user run the loop without learning Hivemind vocabulary. Internal terms such as lease, canon, oracle, Tier-2, and write-intent belong in detail views or decision explanations, not primary labels.
- **Chat steers; buttons authorize.** Free text is advisory input to a proposal and can never satisfy a gate, grant approval, ratify a plan, promote memory, authorize spend, or integrate a change. Authorization is always an explicit typed structured action.
- **Thin client, one truth.** The desktop holds ephemeral render state only. Authoritative state remains under the selected project's `.hivemind/`; the UI renders daemon-published state and invokes the same Core primitives as the CLI. No gate, lifecycle, routing, promotion, or integration truth is reimplemented in React.
- **Project confinement.** A workspace shows exactly one selected repository at a time. State, memory, caches, adapter profiles, temporary project material, and daemon identity must never merge across projects. Cross-project memory is permanently out of scope.

### M8.1 (U1) — Project isolation + daemon lifecycle
- **Depends on:** M4.1, M6.1, M6.2.
- **Read first:** Overview § *Hivemind Core Daemon* and *Single Source of Truth*; § *Project Memory Log*; § *Full Application UI*.
- **Goal:** Make the selected repository the top-level workspace boundary and let the desktop attach to or start its repo-bound daemon without requiring a terminal.
- **Behavior — exact:**
  - Select one initialized git repository, canonicalize its root, and bind every stream/read/action to that exact root. Switching projects closes only the old UI streams and clears ephemeral render state before loading the new project; it never merges histories, tasks, memory, leases, caches, or artifacts.
  - A daemon health response and `.hivemind/daemon.json` must both identify the exact selected repo. A daemon for another root is never reused. If no live matching daemon exists, the Tauri shell starts one in the selected repo on an available loopback port and waits for health; app launch opens no terminal.
  - The app never stops or kills a daemon on project switch or app close. Start-if-absent is the only lifecycle authority added here.
  - The pre-M8 audit found that durable Hivemind state, caches, ledger data, and adapter profiles are repo-local, but project-derived disposable checkouts/consolidation workspaces used shared `%TEMP%\hivemind-*` prefixes, and the vanilla desktop persisted a daemon URL in WebView `localStorage`. Close both contamination paths. Disposable work stays in `%TEMP%` only because measured Windows path arithmetic showed that repo-local detached checkouts would add roughly 35 characters to every checked-out path while Git `core.longpaths` is unset; this is an inferred constraint, not documented original intent. Every disposable path is instead namespaced by a stable hash of the canonical repo root, carries an identity-verified ownership manifest, enforces a short Windows root budget, and is cleaned/reconciled fail-closed. The workspace stores no project pointer or daemon URL in global WebView storage. Provider-owned credentials/settings may remain user-level, but they are not Hivemind project state and must never substitute for repo-local adapter profiles.
  - Memory remains two-tier within one project only. No global cache, shared canon, user-profile database, or UI aggregation may become a cross-project memory/oracle tier.
- **Acceptance test (binary):** With projects A and B containing distinct events, canon, tasks, and adapters, switching selects only the matching repo-bound daemon and makes no A state readable in B; the app starts a missing daemon with no terminal; all project-derived runtime material is repo-confined; and closing/switching the app leaves every running daemon alive.

### M8.2 (U2) — React + shadcn workspace shell
- **Depends on:** M8.1.
- **Read first:** Overview § *Full Application UI*; M6.2's thin-renderer contract and current desktop evidence.
- **Goal:** Replace the vanilla renderer with a React + shadcn/ui shell containing Work, Swarm, Memory, and History tabs.
- **Behavior — exact:**
  - Keep the existing Tauri shell and replace the vanilla DOM renderer with one React application using shadcn/ui. Optimize the first outline for one approximately 16:9 desktop window.
  - Establish one shared token layer for color, typography, spacing, state colors, focus, and reduced motion. Later M8 tabs consume these tokens rather than defining parallel themes.
  - Port the current read-only task/group, lease, quota, integration, event, and selected-task output rendering over the same daemon SSE history-replay-then-live and per-task output streams.
  - Add the four tab destinations and navigation, but no Hivemind mutation controls in this unit. React state is disposable presentation state; current/actionable truth comes from the selected daemon.
  - Remove the old vanilla renderer and its tests once parity is proven. No compatibility renderer, duplicate projection path, or stale localStorage daemon selector remains.
- **Acceptance test (binary):** The native Tauri app opens the React/shadcn four-tab shell and reproduces the current board's live read-only task/lease/quota/integration/output behavior from the same daemon streams, while structural tests show no Core authority in the client and the old vanilla renderer no longer exists.

### M8.3 (U3) — Shared action layer + gate-routing audit
- **Depends on:** M8.1, M8.2.
- **Read first:** Overview § *Single Source of Truth*, § *Task Lifecycle*, § *Real-Time Supervision*; M5 manager action executor; M6.3 supervision; M7.3 promotion gate; M7.6d oracle floor; M7.7 value-quality admission.
- **Goal:** Establish one typed UI action surface that reaches the same Core primitives as the CLI and prove the workspace is never a softer door.
- **Behavior — exact:**
  - Publish an auditable action registry before exposing controls. It covers: start/continue manager work; record orchestrator guidance; ratify a ready plan; add/queue a plan amendment; approve a pending manager action; redirect or stop a task; inspect a change; explicitly request characterization or quality work; cancel a quality run; and hand off memory review. Each entry names its Core primitive, authorization shape, daemon route or local-only handoff, required durable evidence, and refusal states.
  - Reuse existing primitives directly where they exist: manager session/loop execution, `executeManagerAction()` and its underlying gates, M6.3 revision/redirect lifecycle, M7.6e characterization generation + M7.6c disposal, M7.7 admission/generation/cancellation evidence, patch/status readers, and `reviewMemoryProposalInteractively()` for canon.
  - The audit currently identifies missing shared primitives for plan ratification, durable human guidance, safe plan amendment, human-requested revision/stop, and quality-run cancellation. Add each missing capability once in deterministic Core with a CLI path first, then route the UI to that same primitive. No UI control exists until its shared primitive and refusal tests exist. Plan ratification becomes a real floor: executable task contracts cannot be created from an unratified plan.
  - Separate guidance from authority structurally. Guidance accepts narrative text and target context only, appends durable advisory evidence, and cannot import/call the approval executor. An approval request carries a daemon-issued pending action id, explicit typed action, subject, and expected durable state; the daemon re-derives eligibility before invoking the primitive. Caller-supplied claims such as `approved`, `human`, `force`, tier, verdict, or gate proof carry no authority.
  - Canon promotion remains a local interactive TTY handoff, not a daemon or React promotion API. Read-only actions may fetch evidence, but they cannot mutate it.
  - Add UI-path bypass coverage for every exposed gated action. Existing dependency, lease, scope, write-intent, tier, ceiling, oracle, promotion, and integration floors remain unchanged and authoritative.
- **Acceptance test (binary):** The action registry covers every control rendered by M8; each mutation reaches the same tested primitive as its CLI equivalent; UI-path attempts cannot admit an ineligible task, breach a tier/token ceiling, mutate a running contract, promote canon programmatically, integrate configured High/Critical weak-oracle work, or authorize anything through free text; and no control is exposed for an action without a shared primitive.

### M8.4 (U4) — Work tab
- **Depends on:** M8.3.
- **Read first:** Overview § *Primary Manager Agent*, § *Task Lifecycle*, § *Real-Time Supervision*, § *Context & Working-Set Management*.
- **Goal:** Make one prompt-first surface sufficient to start, steer, approve, and understand a run in plain language.
- **Behavior — exact:**
  - Anchor the prompt at bottom-center at all times. Show a plain-language activity stream above it; when action is required, a single attention card displaces the top of the stream without covering the prompt.
  - Maintain two daemon-derived queues: **Needs you** contains typed decisions that block progress; **Later** contains review backlog and never interrupts the current flow. The renderer does not infer which queue an item belongs to.
  - Show a persistent spend indicator with provider-call count and effective tokens against the active run/session ceilings.
  - When a plan is ready, show a prominent persistent dismissible banner. Clicking opens full-screen plan review; it never hijacks the screen. U3's plan-ratification floor prevents task execution until the explicit structured ratify action succeeds.
  - Orchestrator steering writes a durable human-guidance record that is assembled into the stateless orchestrator's next proposal. It does not mutate an in-flight action or launch an extra provider turn.
  - Mid-run plan amendments are add-only for active work. New tasks and queued changes to not-yet-started tasks still pass proposal, grounding, lint, ratification, contract, dependency, and lease floors. Editing a running task is refused because its contract is immutable; the available choices are redirect or cancel-and-replan.
  - Worker steering uses the M6.3 `revision_requested -> in_progress` correction path at its safe boundary with human-authored guidance. It never approves an out-of-scope intent. Scout/characterization/quality draft sub-agents are not steerable; cancel the quality run and explicitly restart with new guidance.
  - Present internal failures in plain language, with optional details: for example "project checks blocked," "thin test coverage," "see what's untested," and "write a test."
- **Acceptance test (binary):** In a no-paid run, guidance appears in the orchestrator's next already-scheduled proposal without changing in-flight state; a running-task plan edit is refused while an add-only task amendment follows the normal floors; a human worker correction travels through M6.3 and still requires a valid redeclared intent; plan execution waits for typed ratification; spend/Needs-you/Later remain live; and no chat text authorizes an action.

### M8.5 (U5) — Swarm tab
- **Depends on:** M8.3.
- **Read first:** Overview § *Real-Time Supervision*, § *Task Lifecycle*, § *Full Application UI* (Agent Monitor); M7.7 speculative-draft identities.
- **Goal:** Show the whole active agent hierarchy and make trouble, output, and change movement inspectable at a glance.
- **Behavior — exact:**
  - Render an agent tree with orchestrator root, execution groups, tasks, and observed sub-agents such as Scout, characterization, and quality drafts. Fit the whole swarm in one desktop view with scroll-to-zoom and click-to-inspect.
  - Use plain group labels such as "2 at once" and "in order." Color encodes daemon-published healthy, needs-you, and waiting states; the UI does not derive action eligibility from color.
  - The inspector shows current work, provider/agent, live task-specific output, relevant change evidence, and the U3-audited actions **Redirect**, **Stop**, and **See change**. It exposes no renderer-local mutation.
  - Visualize a change moving through scope checks, project tests, and verification on the tree edges only when matching durable events arrive. There is no ambient motion; reduced-motion replaces travel with an immediate state change and brief non-motion emphasis.
  - Planned parallelism and actual simultaneous activity must not be conflated. A group may say "2 at once" as plan structure, while active indicators come only from real task/run events.
- **Acceptance test (binary):** A representative nine-task no-paid fixture shows all mixed-state tasks and sub-agents on one screen, the needs-you node is visually findable without reading every label, selection tails that agent's live output, real scope-check/test/verification events alone drive artifact movement, reduced-motion removes travel, and every inspector action routes through U3.

### M8.6 (U6) — Memory + History tabs
- **Depends on:** M8.3, M8.4, M7.3, M7.5, M7.6e, M7.7.
- **Read first:** Overview § *Project Memory Log*, § *Dreaming / Consolidation Worker*, § *Agent Scorecards*; M7.3's hardened promotion boundary.
- **Goal:** Make review backlog and durable run evidence understandable without creating another memory or promotion authority.
- **Behavior — exact:**
  - The Memory tab expands the **Later** queue into project-local reviewed canon, pending things to remember, proposed routing/value-quality changes, and draft characterization/quality evidence. Items show their evidence and consequences in plain language.
  - Tier-1 memory/routing/value-quality/verification proposals may reach canon only through the existing `reviewMemoryProposalInteractively()` door. The UI may open/focus that real interactive CLI review, but it cannot submit the confirmation, emulate a TTY, call a daemon promotion route, or construct a human-shaped payload. If no real TTY review is available, promotion remains unavailable.
  - Draft-test and quality artifacts are reviewable evidence, not self-applying code. If retained as project guidance, they first become an evidence-cited Tier-1 proposal and then use the same interactive canon door. This records reviewed guidance/associations only; applying a test patch or adopting a quality winner still requires its separately scoped canonical write path and is not invented here.
  - The History tab reads past runs, durable events, gate/verification evidence, and resource-ledger spend. It is read-only and project-scoped.
  - Neither tab reads or aggregates another project's `.hivemind/`, raw provider session state, or a global memory store.
- **Acceptance test (binary):** Project-local canon/proposals/routing/draft evidence and past-run spend are visible; a real interactive exact-id CLI review can promote an eligible proposal and the UI then observes the resulting canon event/state; non-TTY, headless, daemon, React, and crafted-payload attempts cannot promote; draft artifacts cannot apply themselves; History performs no mutation; and switching projects exposes none of the prior project's memory or history.

### M8.7 (U7) — Verified-set adoption
- **Depends on:** M3.2, M4.2, M5.6, M7.6d, M8.3, M8.6.
- **Read first:** Overview § *Shadow Integration Service*, § *Permissions*, § *Single Source of Truth*, and § *Full Application UI*; M6.4's hash-or-refuse checkpoint consistency; `docs/m8-action-routing-audit.md`.
- **Goal:** Adopt one exact shadow-verified patch set into the configured base branch through one explicitly authorized, identity-bound, recoverable transition.
- **Behavior — exact (C4):**
  - Shadow verification, at the moment it runs, writes one immutable `.hivemind/resource/verification-sets/<verification_id>/manifest.json`. The manifest binds the configured base branch and pre-verification commit, ordered task ids, each immutable patch and contract hash, the combined resulting tree hash, selected/skipped check evidence, oracle assessment, and the governing config hash. A later adoption may read and verify this artifact but may never reconstruct or backfill what the earlier run supposedly verified.
  - A typed `verification.rerun` workspace action is the recovery path for missing or stale adoption evidence. Core derives the current integration queue, requires every immutable contract still targets the live base and every task still holds its lease, then calls the existing shadow verifier. Gates, checks, tier/oracle floors, and cleanup all run again. Success creates a new verification id and immutable manifest at measurement time; the prior event/artifact is only referenced as superseded and is never amended. Chat, guidance, manager proposals, and MCP cannot launch it. A moved base that invalidates an immutable contract requires re-planning rather than an implicit rebase.
  - Adoption targets the exact verified set together. It re-reads the manifest, re-hashes every contract/patch/config/oracle input, re-runs the existing patch gate, proves the active task leases still cover every changed file without a foreign holder, and requires the live base ref to equal the manifest's pre-verification commit. Any missing, malformed, stale, partial, changed, conflicting, or uncertain evidence refuses. A separately verified subset requires its own verification-set manifest.
  - Authorization is an explicit typed human action naming the exact `verification_id`, expected base HEAD, and expected durable-state hash. The daemon issues a pending adoption identity for review; execution re-derives every precondition. Chat, guidance, manager prose, flags, environment variables, or caller-supplied claims cannot satisfy it. CLI, daemon, Tauri/React, and direct-module callers all reach the same primitive. MCP exposes no adoption tool in v1.
  - The primitive constructs one candidate commit in a disposable checkout, proves its tree equals the manifest, records `adoption.started` with the pre-adoption base ref and candidate commit, and performs one guarded compare-and-swap-style base transition. Partial task application is forbidden. The user's checked-out base worktree must be clean and exactly at the expected ref; otherwise adoption refuses without mutation.
  - `adoption.completed` is emitted only after the actual base ref and tree are reconciled to the exact candidate. Work/Swarm/History may say **Merged** only from that reconciled event. `integration.passed` remains **Verified / Ready to adopt**. The completed event retains both pre-adoption and adopted refs so a human can identify and manually revert an unwanted adoption; Hivemind performs no automatic rollback.
  - Failures before the ref transition leave the base unchanged and emit a durable refusal/failure. A crash or event-append failure after the guarded transition is `indeterminate` until startup reconciliation compares the live ref/tree with the durable adoption intent. An exact candidate match appends the missing completion without reapplying; an exact pre-adoption match records failure; every other state fails closed, retains ownership, and requires human recovery. Cleanup completes before leases are released, and the release remains last.
- **Acceptance test (binary):** One typed human-authorized exact verification set advances the configured base ref exactly once to the manifest-bound tree and emits reconciled `adoption.completed` containing both old and new refs. CLI, daemon, UI, MCP, and direct-module bypass tests prove guidance/prose cannot authorize; stale HEAD/patch/scope/config/oracle evidence, missing/foreign leases, weak-or-unknown configured High/Critical oracle evidence, and unverified/partial sets cannot adopt. A legacy/missing-provenance set is visibly non-adoptable; `verification.rerun` executes the real configured checks and emits a fresh manifest while preserving the prior record, but invalid leases, gates, oracle evidence, or moved immutable bases cannot produce an adoptable result. Moved-HEAD, conflict, mid-adoption-crash, and post-transition event-append-failure fixtures prove either no base transition or one recoverable exact transition, never partial application or replay. The UI renders **Merged** only after the completion event agrees with the actual base ref.

**M8 sizing decision:** M8.1, M8.3, and M8.7 require an implementation pass plus an adversarial verification round because their failure modes are project contamination, gate bypass, and mutation of the user's base branch. M8.2, M8.4, M8.5, and M8.6 are scoped for one initial implementation pass each, with visual iteration after the rough workspace exists. U3 and U7 own shared authorization primitives; visual tabs must not invent softer paths.

---

## M9 — Autonomy Levels
*Reduce interruption without changing enforcement, durable evidence, or the user's sole authority over base-branch adoption.*

### M9.1 — Per-project interruption policy
- **Depends on:** M5.3, M6.5, M7.6d, M8.3, M8.4, M8.7.
- **Read first:** Overview § *Full Application UI* — *Autonomy levels*; M8 workspace rules; `docs/m8-action-routing-audit.md`; M5 manager classification and exact pending-action authorization; M8.7 adoption authority.
- **Goal:** Let each project choose how often normal work interrupts the human while preserving every deterministic floor, exact authorization identity, durable decision, and explicit adoption review.
- **Behavior — exact (C4):**
  - Store `auto | review_plan | review_everything` in repo-local durable config, defaulting to `auto`. A typed `autonomy.set` workspace action is the only UI/CLI/daemon mutation path; it validates the closed enum, writes atomically, and appends durable `autonomy.level_changed`. A change applies to the next interruption decision and never retroactively rewrites an authorization already executed. Every manager session records its starting level, and every policy-authorized or human-required decision records the level used; History shows the complete level sequence when a run spans a change.
  - **Always silent:** contract creation, lease request, write-intent check, worktree creation, patch submission, patch analysis, and integration enqueue continue through the existing deterministic executor and append their existing events, but never enter `Needs you` merely for success. Silent means unremarkable, not hidden: the full durable trail remains viewable.
  - **Always human:** verified-set adoption remains the exact M8.7 two-step typed review/execute authority at every level. The autonomy module and manager action set have no adoption action, cannot construct its pending identity, and cannot emit `adoption.reviewed`, `adoption.started`, or `adoption.completed`.
  - **Always surface:** Tier-3 gate rejection or stop, Critical/sensitive-scope escalation, failed or ambiguous authorization, configured High/Critical oracle block, exhausted quota with no reroute, session-token ceiling stop, and a run that makes no durable progress for the bounded 45-second passive interval remain immediate `Needs you` evidence with the durable reason. Stall evidence names the last recorded activity and expected next step, and exposes only the existing audited start/continue/stop recovery action. A live worker is not called stalled merely because it is quiet: PL-1 `Unknown` is treated as alive, and an `Alive` worker surfaces only after its configured adapter timeout plus the passive interval. A dropped project connection surfaces immediately as transport interruption rather than waiting for the durable-progress bound. Unknown or unreadable policy fails toward interruption, never toward autonomous spend.
  - **Configurable:** plan ratification, `run_worker`, and `integrate_shadow` alone vary by level. In `auto`, plan preparation invokes the existing exact-hash ratification primitive with `authorization_source: autonomy_policy`, then workers and shadow verification continue. In `review_plan`, exact-hash ratification remains human-blocking while `run_worker` and `integrate_shadow` continue after ratification. In `review_everything`, all three behave exactly as before M9.
  - Suppression is never reclassification or bypass. A configurable manager action retains its existing consequential classification, receives the same daemon-issued pending id, exact action/subject, and expected durable-state hash, then the policy invokes the same pending-action disposer in-process. The disposer reloads policy, identity, state hash, tier/scope, ceilings, and downstream gates before execution. Critical/sensitive escalation is not suppressible. Each decision appends `autonomy.decision_recorded` with level, action, interruption outcome, exact pending identity where applicable, and result.
  - The Work tab exposes a compact per-project level control, a non-blocking Auto banner showing the real plan/task count while work proceeds, a prominent calls/tokens meter with near-ceiling warning, and an always-reachable Stop control backed only by M8.3 task/quality cancellation. React renders daemon-published policy and decision state; it contains no policy or gate computation. Daemon `task.stop` remains a narrow interrupt while a long manager action owns the mutation queue, and still uses M8.3 bounded death proof, cleanup-before-release, and terminal evidence.
- **Acceptance test (binary):** With fixture adapters, `auto` drives prompt → generated/grounded/linted plan → exact policy ratification → workers → accepted patches → real shadow verification without human input, preserves the same action/gate trail as `review_everything`, and stops at M8.7 adoption review. Tier-3 rejection, Critical escalation, configured High/Critical oracle block, no-reroute quota pause, session-ceiling exhaustion, and a no-gate-event stall still enter `Needs you` with their exact reasons and audited recovery. A healthy long-running worker and PL-1-ambiguous worker identity do not produce a false stall alert; a worker beyond its configured timeout does. `review_plan` cannot execute before exact human plan ratification; `review_everything` retains the pre-M9 plan/worker/integration pauses. At all three levels, CLI, daemon, UI, MCP, manager prose, guidance, and direct-module bypass attempts cannot authorize adoption, stale pending identities cannot execute, and no gate/floor result differs for the same action. Full-trail and History fixtures prove every suppressed step and level decision remains durable and viewable.

### M9.2 — Multi-action proposal batching
- **Depends on:** M5.3, M6.7, M8.3, M9.1.
- **Read first:** Overview § *Full Application UI* — *Autonomy levels* and *Bounded manager batching*; `docs/m8-action-routing-audit.md`; Progress note *Deferred manager multi-action batching optimization*; manager proposal parsing, durable proposal identity, exact pending-action disposal, worker-failure cleanup, and resource-ledger ceilings.
- **Goal:** Reduce provider-owned per-call overhead by allowing one manager proposal to carry a bounded sequence of mechanically determined next actions without changing any action gate, authorization, durable event, or reactive stop.
- **Behavior — exact (C4):**
  - An adapter-generated proposal contains zero to five actions. Core validates the entire proposal shape before consuming any action. Malformed, over-long, cross-task, out-of-order, or unsafe combinations are refused with no partial execution. Single-action proposals remain valid.
  - The only multi-action shapes are contiguous segments of one task's fixed pre-worker pipeline `create_task_contract -> request_lease -> check_write_intent -> create_worktree -> run_worker`, where `run_worker` is terminal when present, and the post-worker pair `submit_patch -> analyze_patch`, where `analyze_patch` is terminal. A batch may start after already-durable prerequisites, but it may not skip or reorder a member within the selected contiguous sequence. The hard maximum of five equals the longest safe fixed prefix rather than granting five arbitrary actions.
  - `run_worker` ends a batch because its completion, crash, timeout, quota pause, and produced diff must be observed before another proposal. `analyze_patch` ends a batch because accept/reject/escalate must be observed before enqueue. `enqueue_patch`, `integrate_shadow`, `get_status`, Scout, redirect/replan decisions, quality admission, and every other result-dependent or cross-task action remain single. Adoption is absent from the manager action domain and is never batchable.
  - The executor advances one durable proposal cursor sequentially. Each action is sent through the same M8.3 dispatcher/executor and independently re-runs its existing dependency, lease, intent, scope, tier, token, oracle, and integration floors. No batch-level approval or cached gate verdict exists. Each provider-spawning action performs its own current ceiling preflight immediately before spawn.
  - At the first deterministic refusal, worker failure/crash/timeout, Tier-3 stop, or unexpected result, Core records that action normally, marks every later action in the proposal discarded without executing it, and stops. Existing M6.7 cleanup remains responsible for worker failure, with worktree/patch cleanup before lease release and definite terminal evidence. The manager must observe the new durable state in a fresh proposal before proceeding.
  - A Tier-2 action receives the same daemon-issued pending id, exact action/subject, and durable-state hash as a single proposal. Review-everything pauses for the human; Auto/Review-plan may dispose only through M9.1's policy path. The proposal cursor advances only after that exact disposer returns. Consequential actions are terminal in every permitted batch, so no predicted action follows an authorization boundary.
  - Every executed action appends the same individual durable events in the same order as single-action execution. Batching adds no alternate lifecycle event and grants no event-level authority; proposal cursor/discard state exists only to prove which paid proposal elements were consumed. For the same actions and outcomes, the authoritative work trail is equivalent to single-action execution.
  - The full and lean manager prompts state the bounded safe shapes and the stop/reactivity rule explicitly. They never invite arbitrary action arrays. The executor remains the deterministic backstop if the model ignores the prompt.
- **Acceptance test (binary):** A valid fixed-pipeline batch executes sequentially with every action independently gated. A mid-batch lease/intent/scope refusal records the refused action, discards all later actions, and executes none of them; a worker crash, timeout, or hard failure at the terminal worker action leaves no orphaned lease/worktree and never continues. Batched and single-action fixtures produce equivalent ordered authoritative work trails. Review-everything pauses at the exact `run_worker` pending identity while Auto uses the same disposer; adoption cannot appear, and no Tier-2 action is followed by another batched action. Zero/single proposals still work, while six-action, malformed, cross-task, skipped, reordered, and unsafe result-dependent proposals fail closed before partial consumption. A two-task fixture measures the projected proposal-call reduction from the accepted batch shapes and records the estimate without making a provider call.

### M9.3 — Deterministic happy-path driver
- **Depends on:** M5.3, M5.5, M6.7, M8.3, M9.1, M9.2.
- **Read first:** Overview § *Full Application UI* — *Autonomy levels*, *Bounded manager batching*, and *Deterministic happy-path execution*; `docs/m8-action-routing-audit.md`; the ratified-plan, manager-session, dependency, event-trail, and exact pending-action readers.
- **Goal:** Stop paying a manager LLM to propose mechanically determined successful pipeline transitions while preserving the same dispatcher, gates, interruption policy, durable evidence, and judgment fallback.
- **Behavior — exact (C4):**
  - Core re-reads the exact ratified plan and current durable contracts, events, leases, write-intent evidence, worktrees, patch state, queue, and verification state before deriving each next transition. It may derive only the existing fixed actions: contract materialization from the ratified grounded task, lease request, contract-derived write intent, dependency-aware worktree creation, tier-eligible worker run, submit, analyze, enqueue, and shadow verification. It stores those actions through the existing bounded proposal/cursor shape and executes every member through the unchanged M8.3 manager executor and action-specific gate.
  - The driver holds no authoritative in-memory lifecycle state and never treats a prior result as current authority. A successful result merely causes another durable-state read. Worker routing remains inside `runTask()`/`routeTaskProvider()`; the driver does not select or downgrade a provider. `run_worker` and shadow verification retain the same exact pending identity, state hash, autonomy decision, ceiling checks, and Review-everything interruption. Adoption remains absent from the manager action domain and always requires M8.7's typed human authorization.
  - Any deterministic refusal, failed/crashed/timed-out or quota-paused worker, rejected/escalated patch, oracle block, stale or malformed evidence, dependency dead end, stall, or other state for which Core cannot prove the one valid next happy-path action stops deterministic advancement. The remaining proposal is discarded exactly as in M9.2 and control returns to the existing LLM judgment path for redirect, cancel, re-plan, or escalation; no later mechanical action executes first.
  - Pending durable human guidance forces a manager judgment proposal before any further deterministic transition. The existing proposal generator receives and consumes the guidance exactly once; recording guidance still launches no call by itself and cannot authorize an action. After that judgment proposal is disposed, the deterministic driver may resume from newly re-read durable state. The UI remains honest that guidance applies at this forced next judgment step, not to an already-running worker.
  - Deterministic proposals are durably identified as Core-derived, but executed work events are identical to equivalent LLM-proposed actions. Proposal provenance has no gate authority. The old general LLM proposal generator remains only for initial explicit manager chat, pending guidance, and non-happy judgment; it is removed from successful workspace/Auto pipeline transitions rather than retained as a hidden fallback.
- **Acceptance test (binary):** A fixture workspace run completes contract → lease → intent → dependency-aware worktree → tier-eligible worker → submit → analyze → enqueue → shadow verification with zero manager-adapter calls and the unchanged worker/planner calls. Its ordered authoritative event trail is identical to the same actions proposed by the LLM fixture. Every action still reaches the existing executor/gates. A mid-path refusal discards later deterministic work and makes the next continuation use the judgment adapter; worker failure/timeout/quota pause, patch rejection/escalation, oracle block, and malformed/unknown state never advance. Pending guidance causes exactly one judgment call before the next transition and is consumed once. Auto, Review-plan, and Review-everything retain their M9.1 interruption behavior, while adoption remains explicitly human at every level.

---

## M10 — Concurrent Task Execution
*Run independent plan tasks simultaneously without changing lease disjointness, deterministic gates, durable evidence, or failure isolation. Default concurrency is two tasks and the hard maximum is four.*

### M10.1 — Parallel-wave admission
- **Depends on:** M5.6, M7.8, M9.3.
- **Read first:** Overview § *Concurrent task execution*; § *Single Source of Truth*; plan-lint parallel scope checks; canonical lease path handling; durable verification state.
- **Goal:** Decide deterministically which tasks may enter one concurrent execution wave before any concurrent scheduler or worker launch exists.
- **Behavior — exact (C4):**
  - A plan-lint rule rejects any `parallel` execution group containing a task whose `parallel_safe` value is false. Sequence groups retain their existing serial semantics.
  - Runtime admission reloads the exact ratified plan and durable verification trail. A task is eligible only after every declared dependency has current verified evidence. For a parallel group, admitted tasks must have pairwise-disjoint **concrete grounded `allowed_files`** after canonical path resolution. Shared `read_only_files` are permitted and do not create write ownership.
  - Plan lint keeps its exact grounded-path overlap check, while runtime admission independently canonicalizes paths and refuses aliases or other conflicts that lexical lint did not detect. Invalid, missing, or unprovable plan, path, or verification evidence fails closed; changed verification inputs are stale and do not satisfy dependency readiness.
  - Admission returns only the admitted and dependency-waiting task identities in stable plan order. It acquires no lease, starts no worker, reserves no budget, emits no lifecycle event, and changes no sequence execution. M10.1 is the deterministic permission gate that a later scheduler must call.
  - Existing lease acquisition and stale-lock behavior are untouched. Independent tasks use the existing real leases only when later canonical execution starts; no exception permits overlapping holders.
- **Acceptance test (binary):** A parallel group containing `parallel_safe:false` fails lint; overlapping concrete grounded writes fail lint/admission; a task with any unverified dependency is not admitted; two lexically distinct paths resolving to the same canonical target are refused at runtime; shared read-only dependencies remain admissible; and a sequence group still admits at most its next serial task. Tests prove admission launches no worker and mutates no lease state.

---

### M10.2 — Atomic metered-call reservations
- **Depends on:** M4.6, M6.7, M10.1.
- **Read first:** Overview § *Concurrent task execution*; § *Resource & Continuity Manager*; PL-1 process-liveness contract; adapter spawn boundary; quota-ledger locking and restart reconciliation.
- **Goal:** Prevent simultaneous metered calls from admitting against the same unsettled session balance before any concurrent scheduler exists.
- **Behavior — exact (C4):**
  - The existing quota ledger evolves atomically under its existing single lock to contain both settled usage and active per-call reservations. There is no parallel balance, reservation file, or caller-owned accounting state. Legacy settled-only ledgers remain readable and normalize into the current ledger document.
  - Every metered adapter invocation reserves the configured per-call token ceiling before `spawn`. Admission atomically requires `settled session usage + active reservations + new reservation <= session ceiling`; no reservation means no metered spawn. Each reservation is durably bound to provider, session, run/task identity, daemon/runtime instance, and the spawned process PID plus process-instance identity. Unmetered local adapters remain outside token reservation.
  - Normal completion atomically records provider-reported usage when captured (self-measured fallback), marks the reservation settled exactly once, and releases the unused reserved remainder. A pre-spawn failure releases its unused reservation. A completed call that exceeds a run/session ceiling remains durably charged and stops before its output advances the workflow.
  - Restart reconciliation uses PL-1 only: `alive` or `unknown` (including EPERM/access denied) retains the reservation. Only a proven-dead process may be reconciled. Valid durable adapter-usage evidence settles the captured amount; absent, malformed, identity-mismatched, or unreadable evidence charges the full reservation conservatively. Age never proves staleness.
  - The capacity projection exposes settled tokens, active reserved tokens, per-call reservation size, session ceiling, and the remaining simultaneous-call budget. With the defaults, 150,000 tokens reserved per call against 500,000 per session admits at most three concurrent metered calls even if a later scheduler is configured for four; the user-visible reason identifies budget, not scheduler cap, as the limiter.
  - This unit starts no scheduler and launches no concurrent tasks. Lease acquisition, lock ownership, and disjointness semantics are unchanged.
- **Acceptance test (binary):** Two simultaneous reservations racing for one remaining call budget cannot both pass. Live and EPERM/unknown process owners are never reclaimed; a proven-dead owner with no valid durable usage is charged the full reservation, while valid durable usage is settled. Settlement is exactly once, duplicate settlement cannot add usage, spawn failure releases its reservation, normal settlement releases unused capacity, and daemon startup preserves live reservations rather than blanket-releasing them. The adapter spawn boundary refuses before process creation when reservation admission fails, and the default capacity reports three simultaneous calls under the 150K/500K ceilings.

---

### M10.3 — Multi-worker lifecycle foundation
- **Depends on:** M2.7, M6.7, M10.2.
- **Read first:** Overview § *Concurrent task execution*; C3 append-only event discipline; PL-1 process-liveness contract; daemon startup reconciliation; M10.2 reservation reconciliation.
- **Goal:** Make the durable event trail and daemon-restart lifecycle safe for multiple independent workers before any concurrent scheduler or launch exists.
- **Behavior — exact (C4):**
  - `appendEvent()` remains the single authoritative event write path. Daemon-owned appends are serialized per normalized absolute repo event path, and each committed record remains one complete newline-terminated JSON object written by one `O_APPEND` call. Records are not buffered into batches or reordered: each task's invocation subsequence is retained exactly, while global inter-task order may vary. The reader rejects a non-newline-terminated trailing record as an incomplete write rather than accepting a possibly torn event.
  - Daemon startup snapshots process liveness once per PID through the shared PL-1 implementation and supplies the same cached tri-state decision to reservation and task reconciliation. `alive` or `unknown`, including EPERM/access denied, retains that worker's lease, worktree, and reservation. Only `dead` permits settlement/charge and task cleanup; worktree/patch cleanup still precedes release of that task's lease last.
  - Startup enumerates every unfinished task in stable identity order and reconciles each independently. A sibling's dead/alive/unknown outcome never releases, removes, settles, or terminally marks another worker's resources. Per-worker failures are collected only after all siblings have been considered, while invalid shared state still stops startup fail-closed.
  - This unit adds no scheduler, concurrent launch, lease exception, or new liveness implementation. Sequence execution and all gate behavior remain unchanged.
- **Acceptance test (binary):** Concurrent stress appends produce the exact requested number of complete parseable JSON lines with zero loss or interleaving, per-task subsequences remain ordered, and a deliberately incomplete trailing line is detected. In a three-worker restart fixture with one dead, one alive, and one EPERM/unknown process, only the dead worker is charged/settled, cleaned, terminally reconciled, and lease-released; the other two retain their reservations, worktrees, and leases. Each PID is probed once across both phases, no sibling resources are reclaimed, and reservations are never blanket-released.

---

### M10.4 — Concurrent deterministic scheduler
- **Depends on:** M9.3, M10.1, M10.2, M10.3.
- **Read first:** Overview § *Concurrent task execution*; M10.1 runtime admission; deterministic happy-path manager executor; M10.2 budget-capacity projection; M8.3 action-routing audit.
- **Goal:** Run admitted independent tasks with genuinely overlapping provider worker processes while keeping every control-plane mutation and deterministic gate serialized.
- **Behavior — exact (C4):**
  - Core reloads the exact ratified plan and durable state, selects the first unfinished execution group, and calls M10.1 admission. Only a `parallel` group with at least two currently runnable admitted tasks enters concurrent scheduling. Sequence groups retain the existing serial manager path unchanged.
  - For each task, contract materialization, ordinary lease acquisition, contract-derived write intent, and dependency-aware worktree creation execute serially through the existing manager proposal cursor, autonomy classification, audited dispatcher, and action-specific gates. The scheduler starts the existing `run_worker` action only after that task's setup passes. Only provider worker processes overlap; manager judgment calls and control-plane mutations do not.
  - Concurrency is `execution.max_concurrent_workers`, default two and valid only from one through the hard maximum four. The effective wave width is further limited by M10.2's current atomic reservation capacity. Durable `scheduler.wave_*` audit evidence distinguishes `configured_cap`, `budget`, and `ready_count` as the binding limit; M10.2 remains the authoritative spawn-time reservation floor.
  - The pool refills one slot only after a running worker reaches a durable terminal result. Every task is re-admitted before setup, every action is independently proposed/executed through the existing path, and worker preparation/routing remains inside the shared run primitive and `routeTaskProvider()` with the tier floor unchanged. An unsuppressible human/critical escalation stays on the existing serial pending-action path rather than being converted into concurrent authority.
  - M10.4's initial boundary stops new launches after a mid-wave refusal/failure and drains started siblings. M10.5 explicitly supersedes that provisional policy with all-settled lane outcomes, survivor verification, group cancellation, and quota coordination. M10.4 introduces no lease exception or altered lease ownership.
  - Trail equivalence is the M10 definition: each task's ordered authoritative event subsequence and gate outcomes match serial execution, while cross-task interleaving and scheduler audit events may differ. No LLM participates in wave selection or slot scheduling.
- **Acceptance test (binary):** Timed fixture workers prove overlapping process windows. Four eligible tasks under cap two never exceed two and the third begins only after a slot opens. A budget capacity below the cap runs fewer workers and records `budget` as the reason. Serial and concurrent fixtures have identical per-task event subsequences and gate outcomes; sequence groups remain strictly serial; setup actions occur in serial order through their existing gates; and an external lease refusal prevents that task's worker spawn. The same two-worker fixture reports its measured serial-versus-concurrent worker-window reduction.

---

### M10.5 - Concurrent failure handling
- **Depends on:** M6.5, M6.7, M8.3, M10.2, M10.3, M10.4.
- **Read first:** Overview section *Concurrent task execution*; M8.3 action-routing audit; `task.stop` cleanup ordering; M10.2 reservation lifecycle; PL-1 restart reconciliation.
- **Goal:** Settle concurrent lanes independently, preserve unaffected siblings, and verify the exact successful survivor set without weakening lease, quota, cleanup, or shadow-verification floors.
- **Behavior - exact (C4):**
  - Worker and independently gated setup failures are lane-local. The scheduler records one outcome per task, continues already-admitted independent siblings, omits failed/cancelled/paused/rejected lanes from verification, and blocks only tasks whose declared dependencies lack durable verification. A lane never releases, removes, settles, or terminally marks a sibling's lease, worktree, reservation, or events.
  - `task.stop` remains the sole task cancellation disposer. Typed `run.stop` first appends durable run-cancel evidence that prevents every later launch, then fans out through the same bounded `task.stop` engine once per active task. There is no group-specific process termination or cleanup path. Cleanup remains worktree/patch first and lease release last; uncertain cleanup emits terminal retryable failure with the lease held.
  - A provider quota wall emits `task.paused` for only that lane and preserves its worktree, lease, and checkpoint. Already-reserved siblings continue. A session reservation refusal prevents every new launch, identifies budget as the reason, and leaves in-flight workers untouched.
  - Stall inspection evaluates every running task independently. A healthy or PL-1-unknown lane cannot clear a sibling's alert. The 45-second bound remains, while a live worker inside its configured timeout or with recent durable output is not called stalled.
  - After the wave settles, completed lanes independently pass existing submit and analyze gates. The scheduler enqueues only accepted survivors, captures the exact ordered queue IDs plus SHA-256 identity, and invokes the existing shadow verifier once for that bound set. Any queue mismatch refuses before verification; no accidental or later-enqueued patch can enter the run.
  - Worker-wait timeouts no longer release leases directly. They record terminal retryable failure and invoke the existing bounded stop engine; unproven death or cleanup ambiguity retains ownership. Daemon restart still reconciles each worker independently through M10.3 and PL-1: alive/unknown retains all resources, proven dead cleans its own worktree before releasing its own lease last.
  - All scheduler, cancellation, quota, stall, and survivor decisions are deterministic. No LLM participates, no lease semantics change, and no failed lane creates authority over a sibling.
- **Acceptance test (binary):** In a real overlapping fixture, one failed lane is cleaned without changing a live sibling's lease, worktree, or active reservation; later independent siblings still run, and the exact successful survivor set verifies together. Cancelling one task leaves its sibling running. Typed run cancellation prevents new launches before fanning out once through `task.stop`. A quota-paused lane preserves ownership while an already-reserved sibling completes. A healthy lane cannot suppress a dead sibling's stall alert, while a legitimate slow live worker does not false-alert. Shadow verification refuses a queue identity mismatch. Concurrent cleanup remains retryable with leases held on uncertainty, and M10.3's mixed dead/alive/EPERM restart fixture continues to prove sibling-independent reconciliation.

---

### M10.6 - Concurrent UI projection
- **Depends on:** M8.2, M8.4, M8.5, M10.2, M10.4, M10.5.
- **Read first:** Overview section *Concurrent task execution*; M8 governing rules; M8.3 action-routing audit; durable workspace inspection; M10 scheduler/reservation events.
- **Goal:** Present genuine concurrent work accurately from one durable Core projection without moving scheduling, gates, or inferred authority into the renderer.
- **Behavior - exact (C4 projection; read-only client):**
  - Core publishes one durable per-task and per-group projection consumed by both Work and Swarm. Group summaries report actual current counts such as `2 working, 1 waiting`, not planned parallelism. A failed lane enters `Needs you` immediately and states that independent siblings continue. Stall alerts remain per task.
  - Selecting a task subscribes only to that worker's output. Each task's artifact motion derives only from that task's real durable gate, verification, or adoption events.
  - Stop-task and stop-group are visibly distinct typed actions. Group stop is the existing audited `run.stop` fan-out; it is not a renderer-owned loop or second disposer.
  - Spend presents settled usage plus active reservations against the session ceiling. Reservations contribute to near-ceiling warnings, and scheduler evidence states when budget rather than the configured worker cap limits concurrency.
  - User-facing surfaces lead with task titles; durable task IDs remain secondary detail. This applies to Work, Swarm, Memory, History, and plan review. Layout remains composed without overlap at the standard desktop window size.
  - React remains a thin client: it performs no scheduling, gate evaluation, state authority, or inferred durable truth. Existing action routing and lease semantics are unchanged.
- **Acceptance test (binary):** A concurrent mixed-state fixture renders actual group counts, one lane-local failure with unaffected-sibling wording, independent stall alerts, task-scoped output, used-plus-reserved spend, and a budget-bound concurrency reason from one Core projection shared by Work and Swarm. Stop-task and stop-group resolve to their distinct audited primitives. Event-bound motion cannot cross task identities. Title-first presentation and no-overlap checks cover the standard populated desktop layout, while structural tests retain the thin-client boundary.

---

### M10.7 - Tiered Codex profiles and capability corpus
- **Depends on:** M4.6, M7.5, M7.8, M10.2.
- **Read first:** Overview sections *Agent Scorecards*, *Resource & Continuity Manager*, and *Value-Gated Quality Strategy*; M7.5's Tier-2 policy boundary; adapter confinement and refused-mode rules.
- **Goal:** Configure real cheap/standard/strong Codex choices and produce repeatable shadow-only evidence about their cost per successful task without granting that evidence routing authority.
- **Behavior - exact (C4 for confinement, floors, and measurement):**
  - Project-owned profiles explicitly pin Luna=`gpt-5.6-luna`/cheap/4, Terra=`gpt-5.6-terra`/standard/10, and Sol=`gpt-5.6-sol`/strong/20. They explicitly select `workspace-write`, high effort, ephemeral JSONL output, and contain no approval/sandbox bypass, ignored-policy flag, ultra/ultracode setting, or dependency on the user's default model. Production tier floors remain unchanged: Low may select Luna, Medium requires Terra or stronger, and High/Critical requires Sol/strong.
  - `hivemind routing corpus describe|run` is explicit and on-demand. Version 1 runs the same fixed matrix for each profile in project-namespaced disposable repositories: a Low documentation change, a Medium exported library behavior with independent conformance, and a High CLI interface depending on the verified library result. Comparing an out-of-tier model inside this fixed disposable corpus never makes that model production-eligible.
  - Each attempt uses the existing adapter process, atomic ledger reservation/settlement, complete worker context, diff capture, `runGate()`, contract-owned deterministic validity check, and shadow verifier. The corpus never adopts, promotes, leases canonical project files, modifies the project worktree, or emits learned policy. Results are immutable artifacts under `.hivemind/resource/capability-corpus/<corpus_run_id>/`.
  - Per attempt record model/profile provenance, inferred task tier, gate and validity/shadow outcomes, revision count, wall time, provider usage and accounting source. Reports expose cached and uncached input plus their ratio; cost applies the run's explicit cached-input price separately from uncached input and output. A post-completion token overshoot remains an unsuccessful attempt but retains normalized usage, charge, cache economics, and exact overshoot instead of disappearing behind a generic adapter failure. Reports include direct cost per successful task and the matched Sol-retry cost for each cheaper-model failure, so a failed cheap attempt's retry premium is visible rather than averaged away.
  - Corpus evidence remains Tier-1 measurement only. It has zero routing influence until a separate human promotion through M7.3/M7.5's single Tier-2 door.
- **Acceptance test (binary, free mechanism):** Checked-in profiles validate as explicit, confined, non-ultra pins and route Low/Medium/High to Luna/Terra/Sol without breaching the tier floor. A fake-Codex corpus run executes the exact fixed matrix through the real adapter/ledger/gate/validity/shadow path, catches a deliberately wrong cheap CLI despite green self-authored tests, preserves dependency order, writes immutable evidence, computes direct and Sol-retry cost per success from provider usage, and leaves the canonical project worktree/canon/leases unchanged. `describe` and all fixture tests make no provider call. One separately approved live corpus run is required before any scorecard promotion.

---

### M10.8 - Real concurrent workspace demonstration
- **Depends on:** M8.7, M9.1, M9.3, M10.1-M10.6.
- **Read first:** Overview section *Concurrent task execution*; M10.4 scheduler; M10.5 all-settled and exact-survivor verification; M8.3 action-routing audit; M8.7 exact-set adoption.
- **Goal:** Demonstrate through the real desktop workspace that two genuinely independent canonical workers overlap in time, preserve every deterministic floor and durable event invariant, verify as the exact authorized survivor set, and adopt only after explicit human authorization.
- **Behavior - exact (C4 floors; behavioral runtime evidence):**
  - Use a fresh scratch TypeScript repository whose actual checked-out base branch is recorded at setup. A real generated plan contains at least two dependency-free `parallel_safe` tasks in one parallel group with pairwise-disjoint concrete write scopes. Auto autonomy and `execution.max_concurrent_workers=2` apply.
  - Both tasks are configured High for this controlled baseline so `routeTaskProvider()` selects the explicitly pinned Sol profile. This isolates scheduler concurrency from unproven cheap-tier reliability; it grants no broader routing exception and does not change production tier floors.
  - The run is driven through the installed desktop UI from prompt through non-blocking plan, concurrent workers, exact-set shadow verification, typed adoption authorization, and final repository write. Auto may not interrupt before adoption unless an always-surface stop actually fires. Adoption remains explicit and typed.
  - Measure each worker process start/end window, their overlap, concurrent elapsed time, and the serial equivalent obtained by summing the same observed worker durations. Record calls, provider usage, cached/uncached input, session reservations, and whether ready work, configured cap, or budget bound the wave. Concurrency is not expected to reduce token use; any material token-cost difference is a finding rather than credited as scheduler value.
  - Verify simultaneous disjoint leases, serialized setup, per-task event subsequences with complete parseable lines, exact authorized surviving-set verification, lane-local UI projection, no false stalls, and cleanup of worktrees, branches, leases, and reservations. Independently verify the base ref and tests after adoption rather than trusting the UI label.
  - The native shell executable must be newer than the implementation/evidence commit before any provider call. The approved one-off token ceilings are restored immediately after the run. Screenshots and a factual experience report are retained as evidence; no result is tuned or retried merely to improve the demonstration.
- **Acceptance test (behavioral, one separately approved paid run):** Two real Sol workers with disjoint scopes have overlapping measured execution windows at concurrency two; the observed concurrent window is shorter than the sum of their same-run durations; configured cap rather than budget binds; both lanes retain correct leases and ordered durable subsequences; the exact accepted pair passes one expectation-bound shadow verification; Auto requests no human action before adoption and raises no false stall; typed adoption changes the independently observed base ref and leaves the expected tests in the base tree; cleanup leaves no task worktree, branch, lease, or reservation. The report includes token/cache/call totals and an honest Swarm/UI assessment.

---

## Beyond M8
- **Native adapters** and **cloud/team mode** remain future productization. Their old Overview phase numbers are roadmap labels, not M8 Workspace contract numbers; decompose them into the same one-acceptance-test contracts when reached.
- **Dogfooding** remains an available deliberate demonstration after M8, not the mechanism used to build M4–M8. When explicitly enabled, it exercises Hivemind's protected workflow against its own repo without replacing each feature's direct contract acceptance.

## The one rule that makes this work
Read the spec slice to write the contract; hand Codex the **contract**, not the whole spec; use one C10 acceptance criterion per sub-task; ask it to implement *that sub-task*, not "plan the milestone"; never cross a **[GATE]** until it is green. Start at **M0.1**.

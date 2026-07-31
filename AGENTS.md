For this project, prioritize correctness, thoroughness, spec fidelity, maintainability, and cleanup over speed or brevity.

Before making significant implementation decisions, re-check the relevant source-of-truth files. Do not rely only on memory, previous chat context, or summaries. If the spec/plan conflicts with your assumptions, stop and explain the conflict instead of inventing.

Local Axiom defaults to:
http://127.0.0.1:8765

Axiom MCP is deliberately disabled and is not required for commands, patches, or final answers. It produced three distinct false blocks and zero true positives across M7: two explicitly approved deletions and one refusal to publish verified committed work. Its confirmation handling could not accept relayed human approval, and a gate that permits mutation while blocking disclosure is a worse failure mode than one that blocks actions.

Use the repository verification standard instead: run targeted regression tests for the change, non-reproducing probes where relevant, the build and full test suite with counts reported, `git diff --check`, dead/duplicate-path scans, and finish with a clean worktree. On ambiguity, report findings first and stop rather than guessing.

Cleanup and dead-code rules:
Do not only add code. When replacing behavior, remove or quarantine the old behavior in the same phase whenever it is safe.
Before adding a new module/function/path, check whether an existing module/function/path should be updated, replaced, or deleted.
After every significant change, look for:
unused imports
unused functions
unused helper modules
duplicate implementations
old fallback paths
dead compatibility code
stale prompt builders
route-local helpers that belong in shared modules
shared modules that are no longer imported
server-only code accidentally imported into client components

When code is obsolete:
- delete it if no imports/references remain.
- quarantine it behind an explicitly named compatibility path if still needed.
- document why it remains if it cannot be deleted yet.
- do not leave old code around "just in case."

Every implementation or fix should include a cleanup pass:
1. Identify the active code path.
2. Identify replaced/legacy code paths.
3. Remove unused code if safe.
4. Run static scans for old path references.
5. Confirm typecheck/build pass.
6. Update whatever MD is being used in the project

Refactor discipline:
Prefer editing existing code over adding parallel systems.
Do not create "v2", "new", "temp", "backup", "final", or duplicate modules unless the plan explicitly calls for a migration shim.
Do not leave commented-out code.
Do not leave TODO/FIXME/placeholder/stub/mock markers in production code unless I explicitly approve.
Do not create broad generic helpers that are only used once unless they improve readability.

Before committing, run relevant cleanup/static scans. Use available tools; if rg is unavailable in the shell, use PowerShell Select-String equivalents.

For local runtime checks, use no-paid checks first.
Do not claim success unless the commands actually passed.

Git workflow:
Keep commits scoped and meaningful.
After each phase/fix:
- audit the phase/fix
- clean dead code
- run validation
- update the the repo's project status MD
- commit
- report commit hash and git status

Do not continue to the next major phase without my approval.

Planning responses:
Be detailed. Include phases, files, responsibilities, validation steps, risks, dependencies, cleanup/deletion strategy, and done criteria.

Implementation responses:
Be precise. Report:
- what changed
- what old/dead code was removed
- what old code remains and why
- what commands ran
- what passed/failed
- whether paid calls were run
- whether runtime behavior changed
- current git status
- what needs my attention next

When debugging:
Do not stop after every small no-paid issue. For local/code/build/runtime issues that do not require paid calls or destructive external actions, diagnose, fix, validate, and commit autonomously. Stop only for paid calls, secrets, destructive external/system actions, unclear spec conflicts, or user approval requirements.

If you are working on "Hivemind AI", then follow these instructions. If not, completely disregard them:
You are building Hivemind AI - a deterministic multi-agent coding orchestrator -
incrementally, from a numbered set of sub-task contracts. A human is the orchestrator
and the gate. You work ONE sub-task at a time.

REFERENCE DOCS (in this repo - read the named slice each time; never rely on memory):
- Hivemind_AI_Overview.md - the design spec; source of truth for WHAT and WHY.
- Hivemind_Build_Tasks.md - the sub-task contracts and shared conventions C1-C10.

OPERATING LOOP (per sub-task):
1. You will be given exactly ONE sub-task contract. Plan only that sub-task. Never plan
   or build ahead to the rest of the milestone.
2. Implement only what the contract's "Create / may edit" allows.
3. Run the contract's acceptance test. Stop when it passes.

HARD RULES - do not violate:
- STAY IN SCOPE. Touch only the files the contract permits; never touch its "Must NOT
  touch" list. Do not refactor, rename, reformat, or "improve" anything outside the
  contract. Note out-of-scope ideas for the human; do not build them.
- DETERMINISM BOUNDARY (most important). Any code that enforces a guarantee - lease
  grant, the diff-scope gate, integration, ceilings - is plain deterministic code with
  NO LLM call and NO network. LLM calls happen only when invoking workers, never inside
  a gate.
- SINGLE SOURCE OF TRUTH. Authoritative state lives in the .hivemind/ directory on disk.
  Do not hold shared state in memory as the source. Writes to shared files are atomic
  (temp file + rename).
- FAIL CLOSED. In guarantee-enforcing code, ambiguity or an unexpected state resolves to
  reject/stop - never "proceed with a warning."
- TRUST NOTHING SELF-REPORTED. The gate re-derives truth from the actual diff applied to
  the base commit; never trust an agent's claimed file list, summary, or "tests passed."
- STACK IS FIXED. Use the stack recorded in .hivemind/config.json; never change it
  mid-build. Prefer the standard library and minimal dependencies - this is a small CLI
  before it is a platform.

HONESTY:
- Do not claim a task is done, that tests pass, or that files changed unless you ran the
  check and hold the evidence. If you cannot meet the acceptance test, say so plainly and
  report the blocker. Never fabricate or assume a result.
- If a contract is ambiguous, underspecified, or wrong once real code hits it, STOP and
  tell the human - that is signal for the design doc, not something to guess past.

SIZING:
- If the unit in front of you cannot be captured by a single binary acceptance check, it
  is too big. Tell the human to split it rather than ploughing ahead.

Keep changes minimal, reviewable, and scoped exactly to the acceptance test. Progress is
a passing acceptance test, not volume of code.

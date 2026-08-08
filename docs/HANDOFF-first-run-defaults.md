# Handoff — first-run defaults

**State: INCOMPLETE. The Core suite is RED at 548/577 with 29 known fixture
failures.** The product change is believed correct and the failures are
understood; what remains is fixture work in nine test files. Do not treat this
branch as finished.

Desktop suite: 46/46 green. `cargo check` on `desktop/src-tauri`: clean.

---

## Why this work exists

A clean install could not reach a first run at all. Three compounding defects:

1. `project.init` wrote no tier globs. Unmatched paths return `"high"`,
   `minimumProviderRank.high` is `"strong"`, and `checkTierEligibility` refuses
   anything below strong — so cheaper providers were **ineligible**, not merely
   deprioritised. A new project could only use the most expensive provider, got
   full test suites on every task, and no selective verification.
2. `project.init` wrote no adapter profiles, but the Work tab sends
   `tool: "planner"` and `tool: "manager"`, which Core resolves to
   `.hivemind/adapters/planner.profile.json` and `manager.profile.json`. Neither
   existed after init, and those filenames appear in no UI and no document. The
   first prompt failed on a missing file the user could not discover.
3. `select_project` in `project.rs` refuses any folder without
   `.hivemind/config.json`, so the desktop could not initialise a project at all.

---

## The invariant (do not weaken this)

> Defaults are a usability floor, not a safety relaxation. Unmatched paths still
> fall to `"high"`, `minimumProviderRank` untouched, `checkTierEligibility`
> unchanged. What changed is that ordinary paths are now **matched**, so the
> floor applies where intended instead of everywhere.

A fresh install must reach a first successful run with no text editor, and the
defaults must not silently choose the most expensive configuration.

---

## What was implemented

**`src/project-defaults.ts`** (new). Single owner of the first-run defaults:

- `defaultTierGlobs()` — the same set the desktop setup dialog already hands
  people (`COST_DEFAULT_GLOBS` in `desktop/src/lib/providers.ts`).
- `TIER_GLOB_KEYS`, `REQUIRED_ADAPTER_TOOLS` (`planner`, `manager`).
- `defaultAdapterProfile(tool, platform)` — a confined Codex profile. Every
  setting the run depends on is stated: `--model` pinned, `--sandbox
  workspace-write`, `--ephemeral`, `--json`. No bypass flags, no `ultra`, no
  `--ignore-user-config`. An unstated setting stays whatever the user's own
  agent configuration last left it, which is how a run silently changes model or
  sandbox between invocations.

**`src/init.ts`**:

- fresh project: writes `...defaultTierGlobs()` into the config and calls
  `ensureRequiredAdapterProfiles`.
- existing project: `ensureTierGlobsRecorded` fills in **only absent** keys. A
  key that is present — *including an empty list* — is a decision someone made
  and is left alone. Absence is the only evidence of non-authorship available.
  `ensureRequiredAdapterProfiles` never rewrites a profile that already exists,
  because that is a choice made in setup.

**`desktop/src-tauri/src/project.rs`** — new `initialize_project` command, plus
`run_core_init`. **Why shell-side rather than an audited workspace action:**
`connect_project_with` refuses a repository without `config.json` *before*
launching the daemon, so there is no daemon to route an action to. The shell
therefore runs Core's own `init` command, exactly as it already runs `build-id`
and `daemon`. No initialisation logic lives in Rust, so the existing
"CLI daemon MCP and React paths cannot introduce parallel authority
implementations" assertion still holds.

**`desktop/src-tauri/src/main.rs`** — registers `initialize_project`.

**Wiring**: `desktop/src/lib/project-session.ts` (generalised `switchProject`
and `initializeProject` onto one `open()` so both share every generation and
error rule) → `desktop/src/hooks/use-workspace.ts` (`initializeProject`,
`initializing`) → `desktop/src/App.tsx` → `setup-screen.tsx`, where the old
"run `hivemind init`" terminal instruction is replaced by a **"Set up this
folder"** button.

**Tests added** in `test/init.test.ts` (all proven to bite against the pre-fix
behaviour):

- `a fresh project routes by cost tier instead of forcing the strongest provider`
- `a fresh project can reach a first run without hand-written adapter profiles`
- `init fills only absent tier globs and never rewrites an authored value`

The pre-existing scaffold test was updated for the new config shape and
strengthened to assert both profiles exist.

---

## The 29 failures — root cause

**Every one is a fixture that received `"high"` ONLY because nothing matched and
the fallback was High.**

Worked example: `integrate.test.ts:221`
(`configured strong runtime and structural evidence permits High integration`)
scopes its task to `src/feature.ts` and asserts
`oracle floor task tier: high`. With no globs, nothing matched, so the fallback
gave High. Now `src/**` matches `medium_globs`, the task is Medium, and the
High-specific assertion fails.

**The in-repo pattern to copy is `verification.test.ts:322`**, which already
declares its intent explicitly:

```ts
{ ...config, low_globs: [], high_globs: ["src/**"] }
```

### Per-file failure counts

| File | Failures |
|---|---|
| `speculative-draft.test.ts` | 9 |
| `integrate.test.ts` | 5 |
| `best-of-n.test.ts` | 4 |
| `draft-refine.test.ts` | 3 |
| `run.test.ts` | 2 |
| `manager.test.ts` | 2 |
| `workspace-actions.test.ts` | 1 |
| `mcp.test.ts` | 1 |
| `manager-concurrency.test.ts` | 1 |

### The fix

**Each affected fixture must DECLARE the tier it exercises**, the way
`verification.test.ts` already does. That is a correction, not a weakening: the
test was always about High-tier behaviour, and it should say so rather than
depend on a global default that was itself the defect.

**Do not change any product tier logic to make tests pass.** Specifically, do
not relax `minimumProviderRank`, do not alter `checkTierEligibility`, and do not
change the unmatched-path fallback from `"high"`. If a fixture is genuinely
testing Medium-tier behaviour, assert Medium; if it is testing High, give it
`high_globs` that cover its scope.

---

## First-run journey — measured result

Clean git repo with `src/`, `docs/`, and a `package.json`; no `.hivemind`. Ran
Core's `init`, then routed real contracts:

```
Low   docs/g.md          tier=low       routes to cheap
Med   src/a.ts           tier=medium    routes to manager
Crit  .github/x.yml      tier=critical  routes to manager
Unmatched other/x.bin    tier=high      routes to manager
```

`planner` and `manager` profiles both load; `findDangerousAdapterArgs` and
`findRefusedAdapterModes` both return empty for each.

**A clean install can reach a first run without a text editor.** Low work admits
the cheap provider, and unmatched paths still fall to High, so the floor is
intact.

**Honest caveat:** with only the two default profiles present, *worker* routing
also selects between them, and both are strong-tier. Functionally fine — same
binary, same model — but a user who wants a cheaper worker still adds a profile.
Not a blocker, and not hidden.

---

## Standards to hold when finishing this

These were held for every other finding in this audit and should not drop here:

- **State the invariant before changing anything**, and say how the change
  preserves it.
- **Prove every regression bites**: temporarily restore the pre-fix behaviour
  and confirm the new test fails with the expected message, then revert. A test
  that passes against both the fixed and broken code is worthless.
- **Nothing weakened.** If an existing test fails, understand why before
  touching it. Prefer strengthening a fixture over relaxing an assertion, and
  say plainly when an expected value changes and why.
- **Full Core suite green with the count, plus desktop, before committing.**
  Do not commit red onto a working branch.

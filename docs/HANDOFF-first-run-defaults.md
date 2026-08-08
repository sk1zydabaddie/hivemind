# Handoff — first-run defaults

**State: COMPLETE. The Core suite is GREEN at 577/577.** The fixture work is
done; see "The 28 failures — root cause" below for what they actually were.

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

## The 28 failures — root cause

The measured count was **28**, not 29, and they had **two** root causes, not
one. The original diagnosis below covers 22 of them; the remaining 6 came from
the *adapter profiles* half of the same change and are described in
"Second root cause" further down.

### First root cause — tier globs (22 failures)

**Each is a fixture that received `"high"` ONLY because nothing matched and the
fallback was High.**

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

### Per-file failure counts (as measured)

| File | Tier globs | Adapter profiles |
|---|---|---|
| `speculative-draft.test.ts` | 9 | — |
| `integrate.test.ts` | 5 | — |
| `best-of-n.test.ts` | 4 | — |
| `manager.test.ts` | 2 | — |
| `workspace-actions.test.ts` | 1 | — |
| `mcp.test.ts` | 1 | — |
| `draft-refine.test.ts` | — | 3 |
| `run.test.ts` | — | 2 |
| `manager-concurrency.test.ts` | — | 1 |

### The tier-glob fix

**Each affected fixture DECLARES the tier it exercises**, the way
`verification.test.ts` already does. That is a correction, not a weakening: the
test was always about High-tier behaviour, and it now says so rather than
depending on a global default that was itself the defect.

One thing the original diagnosis missed: a fixture that names *one* tier is not
enough, because inference stops at the first match in
`critical -> high -> medium -> low` order. `integrate.test.ts`'s "Low weak"
subtest already said `low_globs: ["src/feature.ts"]` and still resolved to
Medium, because the default `medium_globs` entry `src/**` is consulted first.
Every tier helper in the affected fixtures now **replaces the whole four-key
map** rather than merging into it, so naming one tier yields exactly that tier:
`setTierGlobs` (`integrate.test.ts`, `mcp.test.ts`, `workspace-actions.test.ts`)
and `setTierPatterns` (`test/support/manager-fixture.ts`).

No product tier logic was changed. `minimumProviderRank` is untouched,
`checkTierEligibility` is untouched, and the unmatched-path fallback is still
`"high"`.

### Second root cause — default adapter profiles (6 failures)

`ensureRequiredAdapterProfiles` writes `planner.profile.json` and
`manager.profile.json`, both `routing_tier: "strong"`. Routing chooses from
every profile on disk, so any fixture that builds its repo with `initProject`
and then writes its own profiles now has **two candidate providers it never
declared**. Before this branch, `init` wrote no profiles at all, so no
pre-existing test can have depended on them.

That turns three assertions into their opposites:

- `run.test.ts` — a quota-walled `primary` used to leave
  `routeTaskProvider(..., { excludeTools: ["primary"] })` with nothing, which is
  the `task.paused` / `quota_exhausted` path both tests assert. With the
  defaults present it reroutes to `planner` and the task completes.
- `manager-concurrency.test.ts` — same reroute, so the walled lane never pauses.
- `draft-refine.test.ts` — the refinement phase routes with preference
  `strongest` and picked `manager` over the fixture's own `strong-fixture`.

**The fix** is `useOnlyFixtureAdapterProfiles(repo)` in
`test/support/fixture-repo.ts`, which removes the `REQUIRED_ADAPTER_TOOLS`
profiles (imported from `src/project-defaults.ts`, so it cannot drift). It is
called from the fixture builders in `run.test.ts`,
`test/support/manager-fixture.ts`, and `draft-refine.test.ts` — the fixtures
whose assertions depend on which providers exist. This restores each fixture's
pre-branch provider set; it changes no product behaviour.

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

**Second caveat, found while finishing this — since fixed, see below.** Those
two profiles were ordinary routing candidates the moment they existed, so a
quota-walled provider had somewhere to reroute to where it previously paused,
and a `strongest` preference could pick `manager` over a provider the operator
configured deliberately.

---

## Roles: what a profile may be *selected* for

### The invariant

> Role scoping is a **candidate-set narrowing, never a floor change**.
> `minimumProviderRank` and `checkTierEligibility` are untouched, so nothing
> that was ineligible becomes eligible. A profile that declares no role makes
> no claim — absence is not a restriction, exactly as with tier globs.

`AdapterProfile.roles` is an optional list of `worker` | `orchestrator`.

- **Absent** → selectable for everything, exactly as before. Every profile
  written before the field existed is unchanged, which is why this can refuse a
  provider but never admit one.
- **Present** → selectable only for the roles named. An empty list is refused
  rather than honoured: "selectable for nothing" is a mistake, not a decision.

`routeTaskProvider`'s **open search** — the only place a provider is *chosen*
rather than *asked for* — considers worker-scoped candidates only. A **named**
tool is somebody's decision and is still honoured; the tier floor applies to it
exactly as before.

### Why it is not cosmetic

Both defects were silent and neither was anyone's choice:

- **A safety-adjacent path changed.** `checkpointAndRerouteTask` re-searches
  with the walled tool excluded. An orchestrator profile in that pool turned a
  `task.paused` / `quota_exhausted` into a reroute — the quota wall stopped
  producing the pause it exists to produce.
- **A default outranked an operator.** Every comparison ends in `cost_rank`
  ascending, and the defaults were rank 20, so `strongest` picked `manager`
  over a deliberately configured strong provider.

### The third default, and why it exists

Scoping planner and manager out of the worker search broke the first-run
journey, because `run_worker` is proposed **without a tool** — the manager
names no provider, so executing any task depends on routing *finding* one. With
only orchestrator profiles present, a clean install could plan but never build.

So init now writes a third profile, `worker`, scoped `roles: ["worker"]`.

It is ranked `cost_rank: 1000`. A profile that omits `cost_rank` sits at 100,
and every comparison ends in `cost_rank` ascending, so the default worker is
the **last** thing chosen: present so a clean install can build, and beaten by
anything an operator configures. *A default that can outrank a deliberately
configured provider is the same defect as an orchestrator winning the worker
search* — scoping fixed the second, ranking fixes the first.

`desktop/src/lib/providers.ts` lists all three, with `requestedByName` marking
the two the client actually sends by name. A profile the client never names
still has to exist, and setup has to hand it over.

### Acceptance: the journey, not the unit tests

Walked against a real clean install — an actual git repository with `src/`,
`docs/`, `.github/workflows/` and no `.hivemind`, running Core's own `init` and
then the real routing code. **31/31 checks.** The load-bearing ones:

```
worker routing finds a worker on a clean install          -> worker
no search at any tier or preference selects planner/manager
naming planner still routes (medium scope)                -> planner
naming manager still routes (critical scope)              -> manager
default / cheapest / strongest: operator's provider wins   -> builder
Critical work never lands on a below-floor provider        -> strong
unmatched path still falls to High                         -> high/strong
a walled worker may reroute to another worker              -> worker
with every worker walled it pauses, never reaching an orchestrator
```

---

## Standards held while finishing this

These were held for every other finding in this audit and were not dropped here:

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

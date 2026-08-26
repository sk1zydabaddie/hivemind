# Desktop design notes

Decisions and open threads for the desktop client. Written down so they survive
between passes. This file is notes, not policy — Core's invariants live in Core.

## The product model the UI is built for

The app asks for exactly two decisions per run:

1. Type what you want built.
2. Ship it once the work is verified.

Everything between those happens silently. The person is interrupted only when
something genuinely needs a human: work stopped, a change was rejected, a plan
needs review, budget ran low.

Every layout decision below follows from that. When a surface starts asking for
a third decision, it is probably in the wrong place.

## Why the Work tab is a thread

The Work tab was a monitoring dashboard with a prompt bolted on. Two passes of
polish did not fix it, because the problem was structural: the primary
interaction — you typed something — had no reply and no record. Guidance sent
mid-run vanished into a one-line toast held in React state.

The Work tab is now a **run thread**: your messages, the plan, milestones in
plain language, and the ship decision, in order, with the composer anchored
beneath it. The task list moved to the rail, because it is *state you glance at*
while the thread is *the interaction*.

Two rules that keep it honest:

- **It is a conversation with the product, not with a model.** The orchestrator
  is silent on a clean run — the mechanical pipeline (contract, file locking,
  worktree setup, submit, analyze, queue, verify) is deterministic code, not
  model calls. A model transcript would be blank on a successful run. The thread
  narrates what *happened*, not what a model *said*.
- **Every entry comes from a durable daemon event.** `buildRunThread` in
  `src/lib/work-thread.ts` is a pure function over the replayed event history,
  so the thread survives a reload. Nothing in the thread is remembered in React.

## What the thread is allowed to know

Every entry maps to a durable event:

| Entry | Source |
| --- | --- |
| your request | `plan.prepared.data.prompt` |
| the plan | `plan.prepared` / `plan.ratified`, counts from `status.inspect` |
| your guidance | `human.guidance_recorded.data.message` |
| whether guidance was used | `human.guidance_consumed.data.guidance_ids` |
| milestones | task, integration and quota events |
| the ship summary | `adoption.completed` + the plan's acceptance wording |
| the run subject | `status.inspect.active_spec_title` |

`plan.prepared` originally recorded only `prompt_hash`, so the thread could not
show what you asked for. Core now records the normalized `prompt` alongside the
hash, capped at 20,000 characters exactly as `human.guidance_recorded` caps its
message — one pattern for the same problem, and the request is rejected rather
than truncated so the text and the hash can never disagree.

Do not reconstruct any of this client-side. A thread rebuilt from React state
disappears on reload, which is worse than not having it.

## The client's event buffer

`RECENT_EVENT_LIMIT` in `src/lib/projection.ts` bounds how much replayed history
the client holds. It evicts the **oldest** events, which is the head of the
thread — the request and the plan card — so it is deliberately set an order of
magnitude above a realistic run rather than just above it.

A busy task emits roughly 15–25 events across its lifecycle, scout, lease,
write-intent, patch, routing and verification records, so a 15-task run lands
near 400. The limit is 4,000 (~1MB of small objects). When the buffer has
actually dropped events, the thread says so instead of silently losing its
beginning.

## The guarantee we called unclosable is closable — on the harness that is NOT proven

Recorded prominently because it inverts what the status field implies, and it is
a real product statement rather than a footnote.

`no_nested_agents` — "does not start agents of its own" — has been carried as
the highest-severity open item in this file since 2026-08-11, on the finding
that **suppression is unreportable from Codex's own resolved context**. Codex
reports `multi_agent_version: "v2"`, meaning the capability exists, and reports
nothing about whether it is switched off. No probe we write can close that,
because there is nothing on the other side to read.

**On Claude Code it is closed.** The `system/init` record names the exact tool
set the session loaded:

```
"tools": ["Edit","Glob","Grep","Read","Write"]
```

The agent-dispatch tool is not in it. That is a **positive report**, not a
silence: the list was read, and the tool is absent, so nothing in that session
can start an agent of its own. `no_nested_agents` comes back **`verified`** —
the first and so far only harness where it does.

| Harness | `no_nested_agents` | Why |
| --- | --- | --- |
| **Claude Code** | **`verified`** | reports the resolved tool set; the dispatch tool is absent |
| Codex | `unverified`, permanently | reports the capability exists, never whether it is off |
| OpenCode | `verified` | `permission.task: "deny"` in the resolved table |
| Grok Build | unknown | has `--no-subagents`; nothing known about readback |
| Kimi Code | unknown | `[tools] enabled` can omit `Agent`/`AgentSwarm`; no readback |

### Why this is the reverse of what "proven" suggests

Codex is the only `supported` harness — three tiers, real end-to-end runs,
everything else measured against it. And it is the one harness that **can never
verify this particular guarantee**. Claude Code is `unverified` as an
integration and **fully verified as a contract**: 7 of 7, nothing degraded.

Those are two different claims and the catalogue keeps them apart on purpose.
`status` answers *has real work been built and shipped through this?*. The
contract answers *can this agent's boundaries be confirmed?*. A harness can be
strong on one and weak on the other, and Codex and Claude Code are each strong
on the opposite one.

### The product statement

**A person who specifically cares that no unaccounted agents run underneath
their work has a reason to prefer Claude Code**, and that reason is checkable
rather than promotional: connect it, and the connect screen says `verified`
against that line, with the tool list it read.

That is worth saying out loud in a product that sells "Hivemind decides
concurrency". On Codex, that claim rests on the provider not doing something it
does not report; on Claude Code, it rests on a list the run printed.

**What it does not mean.** It is not a reason to prefer Claude Code overall —
Codex is the one with proven end-to-end runs, and `pins_one_model` plus the
per-model cost breakdown behave differently on each. It is one capability, and
the honest framing is a table, not a winner.

## Standing rule: recorded output is necessary and never sufficient

Three for three. Every capability that was verified only against recorded output
has failed the first time it met a live run.

| # | What was recorded-only | How it failed live |
| --- | --- | --- |
| 1 | `--ignore-user-config` accepted | It silently forced a **read-only sandbox**; a worker that could write nothing reported fine |
| 2 | A model pin accepted | **Silently ignored for months** while config said otherwise |
| 3 | `claude-json` parsing a captured `--output-format json` object | Fed a whole **JSONL** document to a single-object parse, found nothing, and refused with *"found no token counts"* — the right refusal for the wrong reason |
| 4 | `claude-json` reused for **Grok**, on the documented match that `streaming-messages-json` *is* the Anthropic Messages wire format | **Not yet — labelled before the probe rather than discovered during it.** Marked `UNVERIFIED-AGAINST-GROK` in the catalogue |

The third is the cheapest to have prevented and the most embarrassing: the
parser was correct about the *fields*, and wrong about the *document*. It had
only ever been shown one object. Claude Code's profile needs `stream-json`,
because the startup readback lives only in the streaming form — so the very
choice that makes the harness verifiable is the one the recorded fixture did not
cover.

> **The rule: a capability may be developed against recorded output and may
> never be CLAIMED from it. Every capability must be observed live at least
> once before it is reported as anything other than `unverified`.**

**The fourth instance is the first one recorded in advance**, and that is the
only thing that makes it different from the other three. A parser verified
against Claude's output has been verified against *Claude's output* — the
documentary claim that Grok emits the same wire format is a statement about a
format, not a measurement of a provider. Same shape as instance 3, where the
parser was right about the fields and wrong about the document.

It fails safe by construction: if Grok's stream differs, the parser finds
nothing, `reports_usage` returns `unverified`, and the contract admits with
spend ceilings switched off and the person told. Bounded and named rather than
silent. The label comes off when a live run confirms it, and not before.

> **A reader is verified against the output it has actually read.** A format
> match is a reason to try, never a reason to claim.

This is why the catalogue's `status` field means "real runs have gone through
it" and not "the tests pass". It is also why `verified_on` exists on a profile.
Fixtures are for the mismatch branches — making a provider genuinely ignore its
own `--model` is not something a test can arrange — and live runs are for the
happy path, which is the one that gets claimed.

## Standing rule: a provider's documented surface is a LOWER BOUND on its actual surface

Two undocumented capability discoveries now, both found by running the binary
rather than reading about it, both changing a design conclusion, and both
contradicting something already written down here as settled.

| # | Discovery | What was recorded before | What it changed |
| --- | --- | --- | --- |
| 1 | **`--ephemeral` suppresses the session rollout** that carries the capability readback | that Codex reports nothing comparable at startup, so four of five capabilities were unverifiable | the entire probe design — drop that one flag and the readback exists |
| 2 | **`--disable shell_tool`** is a *stable* feature flag | this file said "Codex has no tool-level deny, so its boundary is the OS sandbox instead" | the shell-less posture went from "unavailable on Codex" to available on **all four** harnesses |

Neither appears in the provider's documentation. The first was found by
comparing three real invocations; the second by running `codex features list`,
which is not referenced anywhere in the material the discovery pass read.

> **The rule: a provider's documented surface is a lower bound on its actual
> surface. Docs establish what a provider WILL do, never the limit of what it
> CAN do — so a capability that the documentation does not mention is
> `unknown`, never `absent`.**

The practical form of that, for the next provider:

- **Interrogate the binary before concluding a capability is missing.** `--help`
  on every subcommand, any `features`/`config`/`doctor` command, and the strings
  in the binary itself. All four of these harnesses answered questions their
  docs did not.
- **A conclusion of "cannot" needs an experiment, not an absence.** Both errors
  above were negative claims written from silence. `unsupported` is a strong
  state in the contract — it refuses things — and it should be as hard to reach
  as `verified`.
- **Re-check the negative claims when a provider updates.** A feature flag that
  is "under development" today is stable next month, and the staleness rule
  already forces a reconnect; what it does not yet force is a re-read of what
  was concluded impossible.

### The corollary for this file itself

`unsupported` **refuses things**. It is not a softer word than `verified`; it is
the same weight pointing the other way, and it should be as hard to reach.

Both discoveries above contradicted an entry in this file that read as settled.
So:

> **A DESIGN-NOTES entry asserting a provider LACKS a capability is held to the
> same standard as one asserting it has it: it must name the experiment that
> established it, not the search that failed to find it.**

And the entries already written in that shape are **suspect until re-checked**,
not trusted because they are old. Two are now known wrong and were corrected in
place. Any remaining sentence of the form "provider X cannot do Y" should be
read as "nobody has found how" until an experiment is named beside it.

## Standing rule: check the instrument before you spend on the measurement

The corpus comparison — shell-less versus shell-enabled — was approved at 270K
tokens. Before running it, one preflight call went out: **can a shell-less Codex
still produce a diff at all?**

It can. With `--disable shell_tool` a trivial write task emitted a `file_change`
item and the file appeared on disk: `apply_patch` does not route through the
shell tool, so removing the shell costs the agent its ability to run commands
and nothing else.

**That check cost 37K. Skipping it risked the whole 270K.** A shell-less posture
that could not write would have produced a comparison where one arm failed every
task — and the arresting thing is that the *number would have looked fine*. A
0% accepted-diff rate for the shell-less posture reads as a devastating result
for the posture, gets written into a presentation, and is entirely an artefact
of a broken configuration. Nothing downstream would have caught it, because
every part of the pipeline would have behaved correctly.

> **Before an expensive measurement, spend a cheap call proving the instrument
> can register a result at all. A measurement that cannot produce the answer
> "yes" is not a measurement, and a broken arm of an A/B produces a plausible
> number rather than an obvious error.**

This generalises past provider work: it is the same shape as the vacuous
assertion in `design-tokens.test.ts`, which passed because the string it looked
for was gone. Both are instruments that could only ever return one answer, and
in both cases the failure was silent and looked like a result.

## Standing rule: verify the DISTRIBUTION before you verify the capabilities

Added 2026-08-12 after getting this wrong twice in one pass, the second time
while congratulating myself for catching the first.

**Before probing anything, confirm the artifact is the vendor's, by the
vendor's own install instructions and repository — never by a package registry
name.**

### What happened

Discovery for Kimi Code went looking for a distribution and found `kimi-code`
on npm. It turned out to be a third-party wrapper that proxies Claude Code to
Kimi models. Caught it, wrote it up as a trap worth recording, and then
installed `kimi-cli` from PyPI **because its summary string matched the repo's
description** — and reported it as "the official distribution".

It was not. Kimi Code ships as a single binary from
`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, repo
`MoonshotAI/kimi-code`, version **0.35.0**. `kimi-cli` 1.49.0 is a *legacy
Moonshot product* — the real CLI ships a `kimi migrate` subcommand whose help
text reads "Migrate data from a legacy kimi-cli installation into kimi-code",
which is the vendor telling you they are different things.

Everything measured against it was therefore measured against the wrong
artifact, and the verdict built on it — `confined_to_project = unsupported`,
REFUSED — was withdrawn. The two products differ on nearly every question the
contract asks:

| | `kimi-cli` 1.49.0 (wrong) | `kimi-code` 0.35.0 (right) |
| --- | --- | --- |
| Headless | `--print`, **implies `--afk`** | `-p/--prompt`, implies nothing |
| Approval | auto-approved by print mode | opt-in via `--yolo` / `--auto` |
| Tool allowlist | a YAML agent spec | `[tools] enabled`, enforced before execution |
| Subagents | three named in the spec | `Agent` / `AgentSwarm`, up to **128** per call |
| Confinement | absolute paths escaped, proven | **unknown** — the real open question |

### Why the error is worse than an ordinary mistake

**A wrapper passes every capability check by inheriting someone else's.** The
npm `kimi-code` wraps Claude Code — so it would have reported Claude Code's
model pin, Claude Code's usage numbers, Claude Code's tools, and passed. The
probe cannot detect this, because the probe's whole design is to believe what
the process in front of it reports. Provenance is the one question that has to
be answered *before* the process is started, and it is the one question no
readback can answer.

**And a registry will serve you someone else's product under the name you
expected.** That is not an attack; it is what open registries are for. The name
you expected is not evidence.

### The procedure

Every provider, before it is probed, and re-checked whenever it is re-probed:

1. **Find the vendor's own install instruction** — on the vendor's product page
   or its official repository README. Not a blog, not a registry search, not a
   summary string that sounds right.
2. **Install by that instruction**, contained where possible (`KIMI_INSTALL_DIR`,
   `GROK_BIN_DIR`, a throwaway venv or npm prefix). Read a `curl | bash` script
   before running it.
3. **Confirm the installed artifact identifies itself as the vendor's** — the
   npm scope (`@anthropic-ai/…`), the download host (`code.kimi.com`,
   `x.ai`), a checksum the installer verified, or a package the vendor's own
   docs name.
4. **Record the version and the provenance evidence on the connection**, beside
   the capabilities. `provider_version` already exists for staleness; the
   evidence of *which product* that version belongs to is the same field's job.
5. **A mismatch is a refusal, not a warning.** An artifact that cannot be traced
   to the vendor is refused before it is run, for the same reason a
   permission-bypass flag is: running it is the thing you are trying to avoid.

### The three that were already installed here

Provenance was not chosen by this project for `claude`, `opencode` or `codex` —
somebody else installed them. Checked retrospectively rather than assumed:

- **Claude Code** — `@anthropic-ai/claude-code` 2.1.229, author
  `Anthropic <support@anthropic.com>`, in Anthropic's own npm scope. ✓
- **OpenCode** — `opencode-ai` 1.18.15, which is the package name
  `opencode.ai/docs` itself gives (`npm install -g opencode-ai`), published by
  Anomaly, repo `anomalyco/opencode`. ✓
- **Grok Build** — installed here from `https://x.ai/cli/install.sh`, which is
  the command xAI's own docs and the `xai-org/grok-build` README both give. ✓

None of the three was wrong. All three were *unverified* until checked, which
is the point: an installed binary is an assumption until somebody traces it.

## ADE surfaces: what was built, what was refused — 2026-08-13

Six development-environment features were asked for across two passes. Five
were built; one — the embedded terminal — was argued against, the argument was
accepted as a finding, and a checks-output pane was built in its place.

The first pass reported the file tree as **blocked rather than skipped**: it
needed a Core action that did not exist, which was outside a `desktop/`-only
scope. The second pass added that action. Recorded in that order because the
refusal and the blockage carry more information than the code does.

**Account switching closed the last of them — 2026-08-13.** See below for the
mechanism and for the question it turned on: whether a capability probe is
account-independent.

Screenshots: `docs/evidence/ui/ade-2026-08-13/`.

### The rule the whole pass hangs on

> **Chat steers. Buttons authorize.** A note on a diff line cannot approve,
> ratify, or ship anything.

Every ADE feature is a new surface next to a gate, which makes each one a chance
to build a path around it. Stated per feature, in the form "what it can and
cannot do":

| Feature | Can | Cannot |
| --- | --- | --- |
| Ship-bar diff (`open=changes`) | Show every line of the verified set | Annotate, edit, stage, approve. It is read-only, deliberately |
| Per-task diff, from a held file | Show a task's lines; collect notes | Send anything except `task.redirect`; approve, ratify or ship |
| Diff notes | Become **one** `correction` string on `task.redirect` | Authorize. They are guidance, and the editor says so where they are written |
| Accounts panel | Read `config.inspect`, sum `routing.observed` | Write. It dispatches reads only, and estimates nothing |
| File tree | List directories under the project root, read-only | Create, rename, delete, move or edit. Reach `.hivemind/` or `.git/`. Reach outside the resolved root by any spelling |
| File viewer | Show a file's current text | Edit or save. There is no writable element in it and no write action behind it |
| Checks pane | Read what the last recorded run of the project's checks printed | Run anything. Re-running is `verification.rerun`, behind its own gate and unreachable from here |

The notes case is the one worth being explicit about. Notes ride M6.3's proven
redirect channel — the same write-intent boundary a typed correction goes
through — and `annotationsAsCorrection` flattens them into human-authored prose.
There is no second channel, no new action, and no privileged path. A person who
writes six notes has written one correction in six bullets.

The ship-bar dialog carries **no** note affordance. It sits directly above the
ship button, and a comment box there is the adoption gate with an extra door.

`diff-view.tsx` was added to the identifier guard's surface list at the same
time, since it renders patch text and the change viewer once headed every diff
with `# ${result.task_id}`. It has **one** bounded raw-record exception, the
same shape as the full-record dialog: when nothing in a patch can be laid out
line by line, the record is shown verbatim under a sentence saying so. Verbatim
is the promise there, so it is not filtered — but it is reachable only when zero
files parsed, which is the case where hiding anything would be worse.

### The terminal does not earn its place

Asked for as table stakes, with an invitation to push back. Pushed back, and the
argument was accepted as a **finding** — recorded in full under *Finding: an
embedded terminal breaks two invariants* below, along with the checks-output
pane built in its place. The short form:

An embedded terminal is not a viewer; it is a **second, unaudited write path
into the same repository**. Two concrete failures, not a principle:

1. **It would make Hivemind lie about the agent.** `leaves_change_uncommitted`
   is a *measured* capability: Hivemind checks whether an agent committed when
   it was told not to. A human typing `git commit` in a pane inside Hivemind
   produces exactly the state that capability treats as a violation. Hivemind
   would report `mismatched` — accusing the agent of what the person did — and
   the accusation would be indistinguishable from a real one.

2. **It would mutate the repository through a path that emits no event.** The
   trail-rebuild rule is that the projection can be reconstructed from durable
   events. A shell writing files under the daemon breaks that silently: the
   projection stays confidently wrong, and every screen built on it inherits the
   error. This is the same shape as the discovery two passes ago that a
   *provider's* shell had to be denied — denying the agent a shell while opening
   one for the person, in the same working tree, would be theatre.

There is a real need underneath the ask: **seeing why the checks failed.** That
is a checks-output pane — the recorded stdout of the command Core already ran,
which needs no shell. **It was built**; see the finding below.

Note also that `## First run … does not need a terminal` (below) is the same
finding from the other end: a clean install reaches a shipped change with no
terminal command at all. Adding one now would re-open a door that was closed by
walking it.

### The file tree: blocked in the first pass, then built

The first pass reported it as blocked rather than skipping it. The desktop's
entire authority is three Tauri commands (`select_project`,
`initialize_project`, `workspace_action`), and none of the 32 workspace actions
listed or read a project file — so a file tree was not buildable in `desktop/`
at all.

`files.list` and `files.read` now exist. **They are a new authorization surface
even though they only read**, and they are treated as one, because read-only is
not the same as harmless: a reader that can be talked out of its confinement
hands over source, credentials, and the trail itself.

| Rule | How it is enforced |
| --- | --- |
| Read-only | No writing verb exists in `project-files.ts`, asserted against the source — a behavioural test can only prove that *these* calls wrote nothing |
| Confined to the project root | Every path is realpath'd and judged on **where it lands**, not how it is spelled. `..` and absolute paths are also refused lexically, for a usable message |
| `.hivemind/` refused entirely | None of it is user code. It is the trail, the canon, the patches and the config — each already served by an action that shapes what a person may see. The refusal *names* that action |
| `.git/` refused | Not project source, and it holds every credential a helper ever cached |
| Not a write path | `files.list` and `files.read` are the whole surface |

Two details that are the actual guard rather than decoration:

- **The refused-root check runs on the RESOLVED path.** Checking the spelling
  would let a symlink named anything at all reach `.hivemind`. Mutation-tested:
  reverting it to check the input fails exactly one test, the one written for
  it.
- **A listing OMITS `.git` and `.hivemind` rather than erroring**, because a
  tree that will not draw its own root is useless. Naming one of them directly
  is what earns a refusal.

Tested from **every caller** — in process, over the CLI, and over the daemon's
HTTP route — because a guard that lives in one of three entry points is not a
guard. Each of the three also has a non-vacuous positive case, so the refusals
cannot pass against an action that never works at all.

And "editing 2 files" now opens the file, not only its diff. The dialog carries
both: *what changed* and *the whole file*, with the tree beside them. That also
turns the honest dead end into a door — a run whose patches were never retained
used to answer "this run's record does not include the lines it changed" and
stop, and now points at the files, which are still readable.

### A defect this pass found: capability types drifted

`workspace-actions.ts` still declared the **three**-state `CapabilityStatus`
after Core moved to four. `mismatched` — the state that means *the agent
answered, and answered wrong* — fell through every branch and rendered neutral.
TypeScript was silent, because a narrower union is assignable to a wider one at
every place it was read.

The lesson is not "keep the types in sync". It is that **a status enum shared
across a process boundary needs a total mapping at the render site**, so an
unhandled member is a compile error rather than a neutral pixel. `capabilityMark`
now switches exhaustively over the union and assigns the fallthrough to `never`.

Mutation-tested rather than assumed: adding a fifth member to `CapabilityStatus`
fails the typecheck at that function, and only there. A trailing `default`
branch — which is what was there before — cannot fail that test.

### The honesty rule for usage, which is the whole reason it exists

> A connection whose usage is unverified shows that it is unverified. It never
> draws a confident meter.

A provider whose `reports_usage` capability is not `verified` reads **not
readable** in amber, with one sentence saying why. Never a zero — a meter
reading nought when it means *I cannot see* is how three days go to an exhausted
quota with nothing on screen.

Two supporting rules fell out of building it:

- **Unattributable spend is reported, never absorbed.** Tokens the trail cannot
  place against a connected provider get their own line. A total that quietly
  swallows work nobody can attribute is precisely the total that hides the
  problem.
- **The session bar is Core's ledger, not a sum of events.** It is the figure
  the ceiling is actually enforced against. Summing events would produce a
  second opinion, and the two would drift.

### The bug the types were happy with, and the screenshot was not

`routing.observed.provider` reads `codex-terra` — the **agent**. The adapter's
`tool` reads `worker` — the **role**. Matching on `tool` alone put a run's
entire 599K into "unattributed" while the agent that spent it read 0.

Both types were `string`. Both values were real. The join was wrong, and no test
and no compiler could see it — it was caught by *looking at the rendered panel*
and asking why a working agent had spent nothing. `test/provider-usage.test.ts`
now pins `codex-terra` as a literal, so the two names can never quietly diverge
again.

Standing lesson, which generalises past this bug: **when two systems each name
the same thing, a join between them is a claim that needs a test with the real
strings in it.** Type identity is not name identity.

### A trap this project has now stepped in twice

The usage test originally asserted that the source must not match `/estimate/`,
to forbid inventing figures. It failed — on the comment *"never estimates a
figure of its own"*, the sentence that documents the rule being enforced.

This is the second time: banning the word "secrets" once caught the sentence
protecting the most dangerous file scope. **Banned-word assertions catch the
prose that explains the rule before they catch a violation.** Constrain code
shapes, and strip comments before scanning.

**Third instance, in the same pass, while writing the rule down.** The guard
asserting the checks pane cannot reach `verification.rerun` failed on its own
comment explaining that `verification.rerun` is unreachable from there. Knowing
about a trap is not the same as not stepping in it, which is why the fix is
mechanical — comments are stripped before every one of these scans — rather
than a resolution to be careful.

**Fourth instance, and it breaks the fix.** The guard asserting the accounts
panel can never carry a credential banned the words `api_key|token|secret|
password` — and failed on the panel's own visible sentence:

> Hivemind points the agent at one of them and **never sees your password, key
> or token**.

That is not a comment. It is UI copy, rendered for the person who needs to read
it, so stripping comments would not have saved it. The correction is therefore
stronger than "strip comments first":

> **A word ban cannot express a structural rule.** What mattered was that there
> is nowhere to type a secret and no action to send one — asserted as *no
> `<input>`, no `type="password"`, and only the two account reads dispatched*.
> Constrain the shape. The prose that explains a guarantee will always contain
> the words the guarantee is about, and the clearer the prose the more certainly
> it trips.

## Finding: an embedded terminal breaks two invariants — 2026-08-13

**Recorded as a finding rather than a preference, because it is one.** An
embedded terminal was asked for as table stakes; it is refused, and what
follows is a mechanism, not a taste.

> A human shell inside Hivemind makes `leaves_change_uncommitted` report
> `mismatched`, accusing the agent of what the person did — and mutates the
> repository through a path that emits no event.

Both halves are checkable claims about existing machinery:

1. `leaves_change_uncommitted` is a **measured** capability. The probe checks
   whether an agent committed when it was told not to. A person typing
   `git commit` in a pane inside Hivemind produces byte-for-byte the state that
   capability treats as a violation, and nothing in the trail distinguishes the
   two. The accusation would be indistinguishable from a real one — and the
   capability contract's whole value is that `mismatched` means something.
2. The trail-rebuild rule is that the projection can be reconstructed from
   durable events. A shell writing files under the daemon breaks that silently:
   the projection stays confidently wrong, and every surface built on it
   inherits the error without a symptom.

**What was built instead: the checks-output pane.** The need underneath the ask
was *seeing why the checks failed*, and that never required a shell — Hivemind
already ran the command. It only required keeping the output, which until this
pass it threw away: `verification.completed` recorded each check's `id`,
`command` and `exit_code` and dropped stdout and stderr on the floor. A person
could see that `npm test` exited 1 and never what it said.

`.hivemind/checks/<checks_run_id>/` now holds it, beside the trail rather than
inside it — the same shape as a patch bundle, and for the same reason: an event
carrying a megabyte of test output is a record nobody can append quickly and
every reader has to page past. The event keeps the identifier, the file keeps
the bytes, and `checks.inspect` serves the most recent run found *through the
trail* rather than by sorting a directory, because two run identifiers sort by
UUID and UUID is not chronology.

The pane reads and cannot run. Re-running is `verification.rerun`, a different
action behind a different gate, and it is not reachable from there.

## Account switching, and whether a probe is account-independent — 2026-08-13

Built for one reported failure: **three days lost to an exhausted Codex quota
with nothing on screen saying so.** Seeing what is left is half of it; moving to
another account is the other half.

### The mechanism, and why it holds no credential

Every one of these harnesses keeps its own credentials in its own directory,
written by its own `login` command. So **an account here is nothing but a
directory the harness already owns**, named so a person can pick between them.
Hivemind sets exactly one environment variable to point the harness at one of
its own homes. It never reads inside the directory, never writes one, and never
sees a token.

The variable names are **measured, not assumed** — read out of the shipped
artifacts of the installed harnesses:

| Harness | Variable | Where it was confirmed |
| --- | --- | --- |
| `codex` | `CODEX_HOME` | `codex --help`: "Layer `$CODEX_HOME/<name>.config.toml`…" |
| `claude` | `CLAUDE_CONFIG_DIR` | present in the shipped `claude.exe` |
| `opencode` | `OPENCODE_CONFIG_DIR` | present in the shipped `opencode.exe` |

That table is the whole allowlist, and it is deliberately **not extensible by
configuration**: a config-supplied variable name would let a project point the
harness at `ANTHROPIC_API_KEY` and hand Hivemind a credential to carry. Those
names sit *right next to* the allowed ones in the same binaries —
`OPENCODE_API_KEY` and `OPENCODE_AUTH_CONTENT` are two entries away from
`OPENCODE_CONFIG_DIR` — which is exactly why the allowlist is a literal.

**It lives in `agent-catalogue.ts`, and it took a failing test to put it
there.** The first draft gave the map its own module, and a quota reader
another. `provider-knowledge.test.ts` — the guard added two passes ago,
forbidding a fourth file that knows a provider by name — failed on both.

The response that matters is the one not taken: the allowlist in that test has
an escape hatch, and adding two names to it would have been a one-line green
build. Instead the knowledge moved to the files that already own it — *which
home to start a harness against* is startup knowledge, so the map went to the
catalogue; *what a provider says is left* is the same question as what it spent,
so the quota reader went to `adapter.ts`. Neither new module names a provider
at all now; one holds the mechanism, the other is gone.

> **A guard with an escape hatch tests your judgement, not your code.** The
> hatch exists for the case where the fourth file is genuinely right. It is not
> there to make a failing build green, and the tell is whether you can say what
> the new file knows that the three existing ones do not.

Two checks, not one: a name must be on the allowlist **and** must not be
credential-shaped, re-checked at the spawn itself. And selection is keyed by
**harness rather than by role**, which is not cosmetic — the only thing known
when a provider process is spawned is its profile's `tool`. Keying by role would
have left eight call sites each threading an account through, each able to
forget. Keyed by harness, `runAdapterProcess` resolves it itself and nothing can
bypass it.

### Is the probe account-independent? No — and that is not a guess

The honest answer has two parts, and the second matters more.

**There is a mechanism by which an account changes a measured capability.**
`pins_one_model` asks whether the model Hivemind requested is the model that
loaded. Model availability is a property of the *plan*, not the binary — a pin
to a model the new account's plan does not carry cannot resolve the same way.
`reports_usage` and `reports_model_attribution` are weaker but not immune:
subscription and API-key auth are different code paths in these harnesses, and
this project has already recorded one harness running a second model it was
never asked for.

**And the rest cannot be certified independent, because that is a claim too.**
`no_bypass_flags`, `non_interactive`, `confined_to_project`,
`leaves_change_uncommitted` and `no_nested_agents` all *look* like properties of
the binary and the argv. But this project has a standing rule that a claim a
provider **lacks** something needs the same standard as a claim that it has it
— and asserting "these five are account-independent" is precisely that shape of
negative claim. It would need two accounts to measure, and there is one.

So: **switching invalidates the verification for every role on that harness.**
It is the version-staleness problem wearing a different hat, and it gets the
same answer — a probe result is evidence about the tool, the profile **and the
account it ran under**, and evidence does not travel to a configuration nobody
measured.

The capabilities are **marked stale, not deleted**. The previous measurement is
still the best available description of the *tool*; what changed is that it no
longer refers to what is running. The surface says exactly that — "measured, but
not for what is running now" — in the same amber the usage panel already uses
for a figure it cannot trust, which extends the existing honesty pattern rather
than inventing a second one.

> **What would retire this:** a two-account measurement on one harness, probing
> the same binary and profile under both. That would let the invalidation
> narrow from *all capabilities* to *the ones actually shown to move*. Until
> then, blanket invalidation is the conservative direction and the only one the
> evidence supports.

### Quota: Codex was reporting it the whole time

The shipped `codex.exe` carries a `RateLimitWindow` of `used_percent` /
`window_minutes` / `resets_at`, and a `RateLimitSnapshot` with `primary` and
`secondary` windows and a `planType`, emitted on its token-count event.
**Hivemind was discarding all of it** — the same shape as the check output that
got thrown away, and the same fix.

The negative is measured too: the shipped `claude.exe` carries no such field,
its only `RATE_LIMITED` strings belonging to the QUIC stack. So Claude Code's
answer is **"not reported"**, which is a different fact from "0% used" and must
not collapse into one. `parseProviderQuota` returns `null` rather than an empty
snapshot for exactly that reason, and the parser finds the snapshot **by shape**
— the first object carrying a `rate_limits` key — rather than by path, because
matching a path would break on the next envelope change and look like the
provider having stopped reporting.

## Standing rule: a platform result must come off that platform's native filesystem

**Second time a WSL mount has produced a false result, and the two failed in
opposite directions.** That is what makes this a rule rather than a war story:
one direction hides failures, the other manufactures them, and both arrive
looking exactly like results.

| Mount | What it did | Direction |
| --- | --- | --- |
| `drvfs` (Windows drive from Linux) | Made git see `core.fileMode=false`, so three real file-mode failures **passed** | Hid failures |
| `9p` / `/mnt/d` (this pass) | Invented three `daemon did not become ready` timeouts, then **hung outright** with two orphaned daemon processes | Manufactured failures |

> **A cross-mount run is not evidence, in either direction.** A platform's test
> result must come off that platform's native filesystem.

Applied the same day it was written: the Linux suite was re-run after
`rsync`ing the repository to ext4 and `npm ci` there. **733 passed, 0 failed,
0 skipped** — including every daemon test that had hung. The mount was the
whole of the difference.

The trap is that the cross-mount run is *so much more convenient*. It needs no
copy, no second install, and it usually works. That is precisely why it has now
produced two false results: a rig that is right most of the time is the one
nobody re-examines. Convenience is not a property of an instrument that makes
it more trustworthy.

**Third instance, 2026-08-14, and this one was self-inflicted.** The copy to
ext4 was made faster by adding `--exclude docs/evidence` to the rsync. One test
reads a real captured trail out of that folder, so it failed with `ENOENT` and
the run reported **743 pass / 1 fail** — a failure that existed only in the
copy. Same shape as the mount cases: the rig, not the code, and it arrived
looking exactly like a result.

> **Whatever you exclude to make a platform run faster, you have also excluded
> from what the run measured.** An optimisation to a test rig is a change to the
> instrument.

**Fourth instance, 2026-08-14, and again self-inflicted.** A Windows run stalled
at test 185 for thirty-five minutes with zero failures reported — which reads as
"slow suite", not as "broken". It was neither: **two `daemon.test.js` processes
were running at once**, one belonging to a superseded run I had started and
never stopped, holding five orphaned daemons the current run then collided with.

> **Starting a new run does not stop the old one.** A suite that binds ports,
> spawns daemons or takes file locks will interfere with its own previous
> invocation, and the symptom is a hang rather than a failure.

Two things follow. Kill the previous run before starting another — checking for
leftover processes is one command and the alternative is a thirty-five minute
silence. And treat *no output for minutes* as a signal in its own right: this
project has now recorded three hangs and every one of them looked like patience
being required.

Re-run with the evidence present: **744 pass / 0 fail**.

Corollary, and the reason the hang mattered more than the failures: **a hung
run is worse than a failing one.** A failure names itself. This one sat at 191
of 733 tests with two live daemon processes and no output for minutes, which
reads identically to "slow" until someone goes looking.

## Gradients, permitted with a shape — 2026-08-14

The constraint was lifted, with a limit, and the limit is the interesting part.

> One control-gradient shape: a **vertical ramp from a meaning colour to a
> darker mix of itself**. Same hue, two stops, top to bottom. Application-owned
> controls use the reference navy face; destructive controls use clay.

What was ever wrong with gradients was never gradients. It was the **two-colour
multi-hue button** — navy into violet, teal into blue — which is the visual tell
of a product assembled from a template. A same-hue ramp is what a physical
control looks like.

The darker stop is `color-mix(in oklab, var(--navy) 68%, #000000)` rather than a
second hand-picked hex, and that is load-bearing: two hand-picked stops are one
careless edit from being two different hues, and a mix cannot drift from its own
base. `design-tokens.test.ts` enforces both halves — every `-deep` token must be
a `color-mix` of a palette colour, and every `from-`/`to-` pair in the markup
must resolve to the same base name. Mutation-tested: `from-navy to-amber` fails.

As of the measured correction on 2026-08-18, outline, ghost, secondary and link
controls use `--quiet-lift` to `--quiet-deep`, which now aliases the same navy
ramp as the reference button. Washing those controls toward white erased them
against the canvas and was rejected from the installed build.

## Per-task-type routing: the third input — 2026-08-14

Routing knew two things and was missing a third. It knew the task's **tier** —
how dangerous the files are — and it knew a **promoted policy** learned from
measured outcomes. It did not know that a screen and a data model are different
work at the same tier, so both got the same model, and none of it was reachable
from the app.

The new input is deliberately the weakest of the three:

| Guard | How it holds |
| --- | --- |
| The tier cap still binds | **Structural, not a check.** The preference is applied to the pool *after* tier filtering, so a provider the floor excluded is not in the list to be chosen. A test asserts the ordering in the source |
| A promoted policy is still how a *learned* change takes effect | This module never touches that path. A person choosing a model is an explicit instruction; a system changing its own weights still needs promotion, and conflating them would let a preference launder itself as evidence |
| An agent that cannot prove its model pin cannot be **aimed at** | `pins_one_model` must be `verified` and not stale. Routing may still *fall back* to such a provider — unchanged — but it will not be pointed at one |

That third guard is what makes the feature meaningful rather than theatre:
choosing "the strong model for visual work" is worthless if the harness cannot
confirm which model it loaded. The surface greys those agents and says why.

### Visual work is a suggestion, not a default

Asked to decide, and the answer is **suggestion**, for three reasons in order of
weight:

- **A default spends money nobody asked to spend.** Silently upgrading every
  `ui` task changes a project's bill without anyone choosing it, and this
  project's standing posture is that spend is explicit.
- **The claim is unmeasured here.** "The capability gap is largest on visual
  work" is plausible, widely believed, and *not something this repository has
  measured*. Encoding it as a default would be a declared capability — exactly
  what the contract exists to refuse.
- **A suggestion is falsifiable and a default is not.** Offered and declined
  costs nothing. Applied silently, nobody ever learns whether it helped.

So the setting offers it, states the cost and the absence of evidence in the
same sentence, and the person decides. A test asserts no default map exists.

## The install opened an eleven-day-old build — 2026-08-14

Diagnosed before it was touched, and it was none of the three obvious causes.

| Suspected | Actual |
| --- | --- |
| Versioned install path | **No.** `%LOCALAPPDATA%\Hivemind AI`, same path every time |
| Several versions installed | **No.** One location, one binary |
| Stale uninstall entries | **No.** Exactly one, `HKCU` |

**Cause A: nothing stale was installed — nothing new ever was.** The Start menu
shortcut was correct. The binary behind it was from 1 August; the newest built
installer was from 12 August and had never been run. Search was faithfully
opening what was installed.

What made it invisible is that `tauri.conf.json` carried a hardcoded
`"version": "0.0.0"`. Every build produced an identically-named installer, every
uninstall entry read `0.0.0` forever, and nothing anywhere could distinguish an
upgrade from a reinstall — **because nothing anywhere WAS different.**

The fix is a version that changes: a calendar stamp `YY.MMDD.HHmm`, generated at
bundle-prepare time into `gen/version.conf.json` and merged with
`tauri build --config`. Each field stays under 65536, which the Windows version
resource requires — `20260814` would not, which is why the year is two digits
and the date is packed rather than concatenated. It is written to a *generated*
overlay because a build must not dirty the working tree. The app shows it in
settings, so "am I running what I just built" has an answer from inside.

**Cause B: a second shortcut, created by my own test runs.** WSLg publishes
Linux `.desktop` entries into the Windows Start menu. A `rsync` of the repo into
a WSL home carried `desktop/src-tauri/target/`, its AppImage bundle produced a
`.desktop`, and Windows Search indexed a second "Hivemind AI" pointing at
`wslg.exe`. Deleting the Linux copy removed the `.desktop` but **not** the
Windows `.lnk`, which now points at a binary that no longer exists.

**`install:local` is Windows-only on purpose, and the reason is this bug.**
Installing the `.deb` on a development machine is what put `hivemind-ai 0.0.0`
into WSL, which owns `/usr/share/applications/Hivemind AI.desktop`, which WSLg
republishes into the Windows Start menu on every start — the stray shortcut that
came back at 13:42 after being deleted the day before. A convenience script that
installed the `.deb` on Linux would have automated the creation of the second
problem while fixing the first.

So the script refuses on Linux and names the manual path instead. That is a
deliberate stopping point rather than an unfinished one: on a machine that is
building the product, installing the product is how the two get confused.

The lesson is not about packaging:

> **A build tree synced into another OS's home directory becomes that OS's
> installed software.** `target/` is build output on one platform and a package
> index on the other.

The same reasoning covers the Linux `.desktop` entry proper: one stable
`Name`/`Exec` from a stable `productName` and identifier, so a `.deb` upgrade
replaces rather than adds. `targets: "all"` was left alone deliberately —
`packaging.test.ts` records that pinning it once broke Linux packaging, and
narrowing it to Windows and Linux would have silently dropped macOS.

### The fix that had never once run

The calendar versioning above was written, reviewed, tested and committed, and
it had never executed. `tauri:build` passed `--config src-tauri/gen/version.conf.json`,
and that file was generated by `prepare-bundle.mjs` running as Tauri's
`beforeBuildCommand`. The CLI validates `--config` while parsing arguments,
which is strictly before it runs any build hook:

```
error: invalid value for '--config': failed to read configuration file
       src-tauri/gen/version.conf.json: The system cannot find the file specified
```

`src-tauri/gen/` is gitignored, so **every clean checkout was a clean tree and
every clean tree hit this.** The fix for the eleven-day-old build was itself
never able to run, which is why the installed binary went on reporting `0.0.0`
after the versioning shipped. Two rules:

> **A build hook cannot produce the build's own arguments.** A generated input
> must exist before the tool that reads it starts, not be generated by that
> tool partway through starting.

> **Stamp exactly once per build.** The tempting fix — leave the stamping in the
> hook and *also* call it earlier — stamps twice. If the clock crosses a minute
> between them the build carries one version while `app-version.txt` records
> another, and `install-local.mjs` reports INSTALL DID NOT TAKE against a
> perfectly good install. A verifier that can fail on a correct build is worse
> than no verifier.

So stamping moved to its own `stamp-version.mjs`, run by the shipping script
ahead of the CLI; `prepare-bundle.mjs` keeps everything a build needs regardless
of how it was started and stays on `beforeBuildCommand`, so a bare `tauri build`
still gets a fresh frontend. `packaging.test.ts` asserts the *order*, not the
presence — and the assertion was checked against the old script string to
confirm it fails on the broken shape.

There is a third lesson, and it is the uncomfortable one:

> **A fix is not done when it is committed. It is done when it has run.** Three
> passes of packaging work, all correct on paper, and the symptom the user
> reported never changed once. The evidence that would have caught it was free:
> `gen/` held `shell-build-id.txt` and not `version.conf.json`, which said
> plainly that the script had last run before the versioning was added to it.

## Project switching, and what already held — 2026-08-14

Asked whether switching tears anything down. **It does not, and the reason is
recorded in the shell:**

> `project.rs`: *"Dropping Child detaches the daemon. Tauri intentionally owns
> no shutdown hook so closing or switching the app cannot kill it."*

The daemon is per project and outlives the switch, so a run in flight on the
project you leave keeps running and its state is intact when you return. What
*is* torn down is this client's view — streams closed, projection reset,
inspection cleared — and that is the thing keeping two projects from bleeding
into each other. Both halves were already right; what was missing was a way to
move between them.

**Recents are shell state, and that placement is the whole design.** Storing
them inside a project would make one project the registry of the others, which
is exactly the cross-project coupling the isolation work removed. They live in
the app's own config directory and hold **paths and nothing else** — no task, no
run, no capability, no connection. So switching cannot carry a verification
across, because there is nothing in the store that could carry one. A test
asserts the record's fields.

A path that no longer exists is dropped rather than offered: a folder that has
been moved is a dead end the shell can see coming, and offering it would be the
same failure as the stale Start-menu shortcut.

### The one part not built, and why

**Attention on a project you are not looking at.** Knowing whether project B
needs you requires reading B's state, and the honest ways to do that are: ask
B's daemon if it is already running, or start one. Starting a daemon for every
recent project to render a dot is a real cost — processes, file locks, and a
`.hivemind` write — paid on a screen nobody asked to be expensive.

Asking an *already-running* daemon is cheap and honest, and is the shape worth
building: a project with work in flight has a daemon; a project with nothing
happening does not, and has nothing to report anyway. Recorded rather than
guessed at, because the version that shows a badge for every project would have
to invent one for the projects it cannot cheaply reach — and an invented badge
on the screen whose entire purpose is "where should I look" is worse than none.

## Git on a folder that has none — 2026-08-14

**Answered before it was built: it explained and then stopped.**

`plainConnectionProblem` returned *"Hivemind works inside a git repository… It
needs git to keep your work separate until you ship it. Choose a folder that is
a git repository"* with `command: null` and no action. Accurate, well-worded, and
a dead end — for the most ordinary first-run case there is: somebody who has
been editing a folder without git.

> **Explaining a requirement is not the same as offering the step.** This is the
> front-door failure five walks were spent closing, in its last remaining form.

It offers now, and the offer refuses rather than guesses. Three properties worth
keeping:

- **The first commit is explicit about what it takes.** The readiness check
  names the files that would be committed, so the offer can say what it is about
  to do rather than asking for trust.
- **A folder holding a secret is refused, not committed.** `.env`, `id_rsa`,
  `credentials.json` and friends stop it, and the refusal names the file. The
  reason is not squeamishness: **a first commit cannot be un-made without
  rewriting history**, which is precisely what somebody who has never used git
  cannot be asked to do. Guessing here is unrecoverable in a way guessing
  elsewhere is not.
- **The refusal is re-checked at the action, not trusted from the readiness
  call.** They are two round trips apart and a file can appear between them.

Git init and Hivemind setup stay two separate steps, because they refuse for
different reasons and one can succeed where the other cannot — collapsing them
would report one failure as the other.

## Two guards fired on the egress capability, and both were right — 2026-08-14

Adding `known_endpoint` tripped two existing tests, and neither was noise.

**`capability-contract.test.ts` refused a capability that had not chosen a
side.** The test asserts every capability appears in exactly one of two lists —
*must refuse when unverified* and *may degrade* — so adding one forces the
decision rather than letting it default. `known_endpoint` goes on the refusing
side, beside `confined_to_project`, for the identical reason: being wrong is
unbounded. That test is a small thing that makes a real decision unskippable.

**`provider-knowledge.test.ts` fired for the second time**, and got the same
answer as the first: move the knowledge, do not widen the allowlist. The
per-harness endpoint table and the default-home table both went to
`agent-catalogue.ts` — *which endpoint a harness starts against, and where it
reads its config, are startup knowledge*, the same argument that put the account
variables there. `provider-endpoint.ts` now holds the mechanism and names no
provider at all.

Worth noting that the answer was the same both times without the rule having to
be restated: the escape hatch exists for a fourth file that genuinely knows
something the three do not, and neither of these did.

## A fixture that described a repository which cannot exist — 2026-08-14

The most consequential defect of the pass, found by a test I did not write.

**A profile's `tool` is the ROLE.** `worker.profile.json` carries
`tool: "worker"`, because Core resolves adapters by the name callers send and
callers send the role. The harness — `codex-cli`, `claude`, `opencode` — is
reachable only through the connection record's `agent_id` and the catalogue.

Four separate places keyed a harness lookup off `profile.tool`:

| Site | What it silently did |
| --- | --- |
| `accountEnvironmentForTool` | Applied **no account, ever**. Account switching worked in tests and did nothing in production |
| `invalidateVerificationForHarness` | Invalidated **nothing** on a switch, so a stale verification survived exactly the event it exists to catch |
| `inspectProjectConfig` | Showed **no account** against any role |
| the new `known_endpoint` probe | Matched no harness, so every provider read `unknown` and **refused** |

Only the last one failed loudly, and only because `adapter-probe.test.ts`
builds its profile the way `buildProfileForAgent` does. **The three account
tests passed throughout**, because their fixtures wrote `tool: "codex"` — a
shape no real profile has.

> **A fixture is a claim about what the system's data looks like.** Three of
> these tests asserted correct behaviour over a repository that cannot exist,
> and every one of them was green while the feature did nothing at all.

This is the vacuous-assertion family again, arriving through the *input* rather
than the assertion: the check could fail, the data could not produce the
failure. The sixth instrument instance was a judge visible to the judged; this
is a judge shown a defendant who was never there.

Two guards now hold the line. One asserts an account resolves through the role
with a profile shaped exactly as `buildProfileForAgent` writes it. The other
asserts every key in `ACCOUNT_HOME_VARIABLES` is a harness some catalogue agent
actually declares — **a key nothing can match is a feature that silently does
nothing**, and that one is cheap, general, and would have caught this on the day
it was written.

## Effects, and the six that earned their place — 2026-08-14

The constraint that decided all of them: **this visual language spends attention
on STATE.** Amber means needs-you, navy means active. An effect that spends
attention on decoration competes with that, and makes the interface worse even
when each piece looks nice on its own.

### Built

| Effect | Why it earns its place |
| --- | --- |
| **Spring curves** on panels, dialogs, the phase spine | Two curves, no more — a vocabulary, not a collection. A panel that decelerates reads as a thing with mass; one that stops dead reads as a redraw. Both overshoot slightly, small enough to feel physical rather than bouncy |
| **Hover lift** on clickable cards | 1px and a soft shadow. A card that jumps is a card that moves the thing you were about to click |
| **Progress inside the button that started it** | The action and its progress are one object, so there is nothing to associate. **Indeterminate on purpose**: a queued action has no sub-steps Core reports, and a sweeping animation would be motion carrying no information |
| **Deeper press** on primary actions | `active:` goes *down past rest* with an inset shadow. Returning to zero would feel like nothing happened |
| **Attention edge** on the one thing needing you | The only effect carrying meaning rather than polish |
| **Float depth** on dialogs only | Says which layer owns the next click. `--shadow-panel` stays deleted |

Two rules hold the set together, both asserted by test:

- **Exactly one attention edge.** It lives on the single primary queue item —
  the rest collapse inside it — so uniqueness is a property of *placement*
  rather than a rule anyone has to keep. If two things glow, neither means
  anything.
- **Reduced motion stops the edge pulsing without removing it.** Somebody who
  asked for less movement still needs to know which thing needs them. Everything
  else drops to 0.01ms.

And nothing animates on a replayed trail that did not animate live: the
completion animation still fires only on artifact movements, which
`recordArtifactMovements` writes from the live stream alone. Reading an old run
should not celebrate.

### Skipped, with reasons

| Skipped | Why |
| --- | --- |
| **Cursor glows** | Decoration that follows the pointer rather than the state. It draws the eye to *where you already are* — the one place attention does not need directing — and fights the instrument aesthetic directly |
| **Subtle grain** | A texture for dark, atmospheric surfaces. This is a light app on a near-white canvas where grain reads as a rendering artefact, and it would sit underneath dense mono figures that need a clean ground |
| **Dynamic refraction** | Expensive per frame, and gimmicky in a window that is mostly text. It would be the most computationally costly effect in the app in service of the least information |

### Acrylic/Mica, argued and declined

The case for was real: it is the single effect that would make this read as a
native Windows 11 application rather than a web page in a frame, and Windows is
the primary platform. Three things decided against, and the third is the one
that could not be got past:

1. **Two visual identities.** WebKitGTK has no equivalent, so Linux keeps the
   fallback permanently and every screenshot in `docs/evidence/` is taken on one
   of two different-looking products.
2. **Legibility against dense mono.** The spend meter, token counts, diff
   gutters and the checks pane are all small mono figures, which is exactly
   where translucency costs most.
3. **It spends attention on chrome.** Mica tints the entire window surface — the
   least targeted effect available, applied to the largest area, sitting
   *behind* the amber edge that is supposed to be the one thing pulling the eye.

That last point is the same constraint the whole set was judged against, and
Mica fails it worst of anything considered.

## Standing rule: the rig measures something other than what you think

**Three instances, and they are the same family as the six instrument failures
seen from the other side.** An instrument failure returns one answer regardless
of the truth. A rig failure returns a true answer *about something other than
what you meant to measure*. Both arrive looking like results.

| # | The rig | What it actually measured |
| --- | --- | --- |
| 1 | `drvfs` — a Windows drive mounted into Linux | git saw `core.fileMode=false` exactly as on Windows, so three real mode failures **passed**. It measured Windows semantics and called them Linux |
| 2 | `9p` — `/mnt/d` from WSL | Invented three daemon timeouts, then hung outright with orphaned processes. It measured the mount's latency and called it the daemon |
| 3 | `rsync --exclude docs/evidence` — 2026-08-14 | Added to make the Linux copy faster. One test reads a real captured trail out of that folder, so the run reported **743 pass / 1 fail** — a failure that existed only in the copy. Re-run with the evidence present: **744 / 0** |

The third is the instructive one, because nothing was wrong with the mount, the
platform or the code. **The optimisation was the defect.**

> **Whatever you exclude to make a platform run faster, you have also excluded
> from what the run measured.** An optimisation to a test rig is a change to the
> instrument, and has to be justified as one.

The two families together:

> An instrument that can only return one answer is not evidence.
> A rig that measures something other than what you think is not evidence either.

Nine occurrences across six instruments and three rigs, all rediscovered
independently. That count is what motivates recording provenance mechanically
rather than trusting each session to re-derive the question.

## Standing rule: a list that lives only in a session's context is already lost

**Retention and verification provenance both spent time in exactly that state**,
and were only written down on 2026-08-14 because an inventory was demanded and
they surfaced by being *absent* from every file.

The same pass turned up the inverse failure: a §7–§22 audit backlog that a
collaborator was prioritising against **did not exist and never had**. It came
from a session's context, not the repository. Nobody could check it, because
there was nothing to check.

> **Anything worth tracking gets written to a file in the pass that creates
> it.** Not the pass after. A list held in a session's context is lost when that
> session ends, and — worse — a list *remembered* from one is unfalsifiable:
> it cannot be verified, corrected, or closed, and it competes for attention
> with work that can.

Both directions cost the same thing. An item that exists but is unrecorded gets
dropped; an item that is recorded nowhere but remembered gets worked on. The fix
for both is a file.

## Standing rule: an instrument that can only return one answer is not evidence

**Third instance, so it is a pattern rather than three accidents.** Each time,
something that looked like a passing check was structurally incapable of
failing, and each time it read as a result.

| # | The instrument | Why it could only say yes |
| --- | --- | --- |
| 1 | `design-tokens.test.ts` asserting a string was **absent** | The string had never been present. The assertion passed on an empty file, on a deleted file, and on the real one — it distinguished nothing |
| 2 | The **shell-less preflight** on the provider comparison | Without it, the measurement would have run against a configuration that was silently broken, and produced numbers. Numbers from a broken rig look exactly like numbers |
| 3 | The **screenshot harness waiting on a timer** | 2.6 seconds is plenty for a warm dev server and not enough for a cold one. The first shot came back a blank white PNG and the harness reported `shot 01-ship-diff` |

> **An instrument must be able to return the answer you do not want.** If it
> cannot, it is not measuring — it is asserting, in the shape of a measurement.

The general form of the fix, which is the same in all three: **wait on the
content, not on the clock; assert the presence of what should be there, not the
absence of what never was.** The shot harness now polls for a named string from
each surface and *throws* if it never appears, so a blank frame fails at capture
instead of on disk.

## The benchmark that measured the wrong component — 2026-08-13

Built to test whether **enforcement** catches defects a stated rule does not.
Raw Codex passed both tasks that were run, so it produced **no evidence for
enforcement at all** — and the reason it passed is the finding worth keeping.

> A precise acceptance criterion, with the edge cases enumerated, was sufficient
> on its own. And that criterion was **planner output** — not something a person
> types into a prompt box.

So such evidence as there is supports Hivemind's **planner**, not its
**enforcement**, which is not the claim the instrument was aimed at. The
benchmark measured a different component than the one it was pointed at and
found in its favour, which is worth exactly as much as it sounds.

Two specific results, both unflattering to the case for gates:

- The `--limit 0` trap — the obvious `if (limit)` inverts the contract — was
  **avoided**, and the agent's own tests **rejected** a known-wrong reference.
  It tested the contract, not its own interpretation.
- The `package.json` trap was **not sprung**. It read the file and left it
  alone. The prohibition was its own line, in capitals; there is no reading
  under which editing it was permitted. So *"enforcement caught what a stated
  rule didn't"* does not hold — on that task the stated rule sufficed.

**Where the case for the gates actually rests, then.** Not here. On the
observational evidence that already existed: a real worker that reached for
`package.json` in an actual run, and T-002's wrong interface shipped with green
self-authored tests. Both single incidents, neither a rate. The honest position
is that the gates are justified by *failures that did happen*, not by a
benchmark showing they would happen again — and the benchmark run to look for
the second kind of evidence did not find it.

> **The drift to refuse: "inconclusive, so the gates are probably fine."** That
> inverts the burden. Inconclusive means we still do not know. A write-up that
> reads as validation because it failed to disprove anything is the same
> instrument failure as the five below, arriving through the conclusion instead
> of the method.

Also recorded, from the cost side: the design predicted the raw arm would be
*cheaper* per prompt with no planner or verification calls. It was **more
expensive** — 212K and 151K against a predicted 60–125K — because raw Codex with
a shell explores, and every turn re-sends the accumulated context.

> **Removing a component does not necessarily remove its cost, because the
> component may have been suppressing a larger one.**

### The fifth instance: a judge visible to the judged — 2026-08-13

> **A judge visible to the judged measures compliance with the judge, not the
> thing it was meant to measure.**

The capability corpus lists `corpus-check.mjs` — the deterministic conformance
check — in **every task's `read_only_files`**. The agent can read the check it
is about to be scored by, and write against it.

So what the corpus measured was *can this model satisfy a printed check*, not
*did it understand the contract*. Those are different questions, and only the
second is what a tier measurement is for.

**This attaches to results already recorded, and they are cited here with the
caveat from now on:**

- **Luna's 30/30 across the corpus, and the 3/3 at zero revisions** in the
  shell-enabled control arm. Both are real runs that really passed. What they
  are evidence *of* is narrower than recorded.
- **The routing weights promoted to canon** on
  `CC-20260803235418-…` — a controlled shadow corpus report. The policy may
  well still be right; deterministic scoring, sample sizes and confounders were
  all reviewed. But **its evidence is weaker than the record says**, because
  the scores it rests on were achievable by reading the scorer.

Nothing is being withdrawn. The distinction that matters, and the one this
project has had to make before over the Kimi provenance error: *the finding may
be correct and the evidence still insufficient for the claim it was used to
support.* Recording the second does not require asserting the first is wrong.

**Why it belongs in this family.** It is the same failure as the vacuous
assertion and the no-hazard confinement tests, seen from the other side. Those
were instruments that could not return the answer you did not want. This is an
instrument the *subject can see*, which collapses to the same thing: once the
check is readable, passing it stops being correlated with the property it was
supposed to detect. Both produce a green result that means less than it appears
to, and both look exactly like evidence.

The replacement holds the check out of the repository entirely — see
`docs/BENCHMARK-DESIGN.md`. It is the judge's instrument, run against both arms
afterwards, and neither arm ever sees it.

### The fourth instance is the most serious of the four

Recorded separately because the first three were instruments that *measured
badly*. This one **did not measure at all**, on the guarantee this project
refuses providers over.

Two confinement tests built their hazard with `symlink(..., "file")` and fell
back to a bare `return` when the OS refused — and Windows refuses with `EPERM`
unless developer mode is on. On the machine they were written on, both tests
built **no hazard whatsoever** and reported `ok`.

What they were nominally proving is the confinement of `files.read`: that a
link inside the repository pointing outside it is refused on where it *lands*
rather than how it is spelled. That is the same class of guarantee as
`confined_to_project`, which this project **refuses an entire provider** for
failing. So the ranking is not sentiment:

- Instances 1–3 produced a number or a verdict that was wrong or unearned.
- Instance 4 produced a **green check on a security boundary that was never
  exercised** — and would have kept producing one for as long as the tests were
  run on Windows.

They now use a directory junction, which needs no privilege and which
`realpath` resolves through, so the hazard is real on both platforms; where even
that fails they **skip loudly** through the test context. `skipped` is visible
in the output, `return` is not. Confirmed non-vacuous afterwards: the Windows
run reports `# skipped 0`, and the Linux run exercises real symlinks.

> **When you cannot build the hazard, say so.** A silent fallback turns
> *untested* into *passing* — and does it most readily on exactly the platform
> where the hazard is hardest to build, which is where you needed the test.

## The identifier rule, and why it took five asks — 2026-08-12

**A person never sees `T-001`, `G-1`, `S-001` or `V-…`.** Not smaller, not
muted, not on hover. A task is identified by its title; two tasks with the same
title are a planner problem.

This was asked four times and answered four times with *"we lead with the title
and keep the identifier secondary"*, which is a different thing. Worth recording
why that kept happening, because the shape generalises:

- **Every individual placement was defensible.** A mono `T-001` under a row
  title is *secondary*. A `taskTitles[id] ?? id` fallback is *honest*. Reviewed
  one at a time, each one survives.
- **Nothing looked at the composite.** `attentionHeadline` stripped a literal
  `${task_id} ` prefix and passed everything else through, so a title Core had
  already composed *from the task title* fell through to the predicate slot
  intact — and the bar rendered the title, then the whole title again, then
  `T-001`. Nobody wrote that sentence; it was assembled by two correct-looking
  rules meeting.
- **The tests asserted the wrong contract.** `work-presentation.test.ts` pinned
  `taskId: "T-001"` as an *expected field*, so the behaviour being asked about
  was protected by a passing test.

So the fix is not another careful placement. `src/lib/identifiers.ts` owns one
pattern and three functions, `taskTitleOrNull` returns **null** rather than the
identifier so a caller cannot accidentally fall back to one, and
`test/identifiers.test.ts` **renders the real components against real replayed
trails** with `react-dom/server` and scans the markup. Restoring the identifier
in the rail row fails 12 render assertions; that mutation was run.

Two things the render guard needed to avoid being vacuous, both learned from
the `design-tokens` mutation experiment: it asserts the corpus really does
contain identifiers to leak, and it asserts the surfaces really do render their
content (real task titles from `@midrun`), so a scan that passes because nothing
rendered fails instead.

**Where identifiers still live, deliberately:** the full-record dialog, which
says in its own description that it shows the internal names because that is
what support will ask for. One place, and you have to open it.

## Restored: the agent graph is a place again — 2026-08-12

Folding Swarm into a Story/Map toggle was defensible on the code and wrong on
the product, and this file made the wrong argument for it: *"a tab whose inputs
are a subset of another tab's is a rendering, not a place."* The inputs are a
subset. **The picture is not.** A list can say three tasks are running; only a
shape can show three agents hanging off one branch with a fourth waiting under
them, which is the one thing this product does that a person cannot get
anywhere else.

`src/components/workspace/agent-graph.tsx` is built to be understood in about a
second, by someone who has never seen the app:

| Question | Answered by |
| --- | --- |
| which agents exist | one node each, all on screen at once |
| what is each doing | the node's own sentence, from its phase |
| what waits on what | the connector — a fan-out branches, a chain drops |
| which needs a human | the only clay node, and the only one with a glyph badge |

**Parallel versus sequential is shape, not label.** Three agents at the same
time are drawn under a branch: trunk down, bar across, a drop into each. A
dependent stage is a single line with `THEN`. A stage nobody has reached yet is
dashed and faint. The words above each stage confirm what the drawing already
said rather than being the only way to know it.

**What was right about the consolidation is kept.** The graph dispatches
nothing. It selects an agent; the rail acts on it. `App.tsx` renders one
`WorkTab` for both the Work and Agents tabs with a different `stage`, so the
attention bar, the ship bar, the rail inspector and the composer are the *same
instances* either way — there is still exactly one inspector, and shipping never
depends on which view you are looking at.

`PhaseSpine` moved to its own file, because three surfaces draw it and the rail
should not need the graph to exist in order to have a gauge.

## Comprehension: the three fixes — 2026-08-12

**The Story/Map toggle is gone.** Two renderings of one run, presented as
navigation, made a person choose between them before they had seen either. The
graph is a tab; the thread is the Work tab; there is no toggle.

**The header carried three kinds of information on one line.** `0/4 done · took
26m 27s · Only what needs me` mixed progress, a duration and *a setting the
person had chosen* into one middot-separated row where nothing said which was
which. It is now three placed things: an eyebrow-labelled **What you asked for**,
the headline of what is happening now, and a real progress element underneath.
The interruption control moved into the button group and is labelled
**Interruptions** rather than rendering its own value, so the header's last word
can no longer be read as a third status.

**Where a first-time user looks** is now decided: the largest thing on an idle
screen is the composer's own instruction, and on a live run it is the headline
with the progress bar directly beneath it.

## Gamification, and the line it must not cross — 2026-08-12

Progress should feel good; nothing may be invented. Every number below is a sum
over the durable record, and the two that would feel best are named as missing
rather than estimated.

- **Progress that moves on events.** The run bar is cleared phases over total
  phases — the same fact the per-agent gauge states — promoted from a 2px
  hairline on the header's edge to a real track with a figure. If the run makes
  no progress for a minute, it does not move for a minute. That is the whole
  difference between a progress bar and a spinner, and `thin-client.test.ts`
  asserts no timer drives it.
- **A completion moment.** One wipe of the run's colour across an agent node the
  instant the live stream reports its work landed. It reuses `.artifact-marker`
  — still the only animation in the app — as an overlay on a node that is
  already correct underneath, so reduced motion removes it and loses nothing.
  It cannot fire on a replayed history, because `recordArtifactMovements` only
  writes from the live stream. Reading an old trail should not celebrate.
- **A ship confirmation worth reaching.** The shipped card is a navy band with
  the real count, the real branch and the real commit, at the size the moment
  deserves rather than as another row in a log.
- **Accumulation in Project.** `src/lib/project-totals.ts` sums tasks shipped,
  runs shipped, working time, calls and tokens across `history.runs`.

**No badges, no confetti, no XP, no streaks — and no time saved.** Time saved
needs how long a person *would* have taken, which is a counterfactual and is in
no record, ever. Files touched is in the adoption events but not in the per-run
summary Core builds, so it is not totalled either. Both are named on screen:
*"Not counted here, because this project's record does not carry it: how many
files all of this changed, and how much time it saved you."* `projectTotals`
returns them in an `absent` array and a test asserts there is no `timeSaved` or
`streak` field for one to hide in.

## Done: four tabs became two, then three

The shell went **Work** + **Project**; it is now **Work**, **Agents** and
**Project**. Memory and History stay merged into Project — that half was right
and is unchanged. The Swarm half was reverted on 2026-08-12; see "Restored: the
agent graph is a place again" above.

Reading the code made the case harder than the original argument did, and the
first bullet is the one that turned out to be wrong:

- ~~**Swarm could not show anything Work did not already have.**~~ `buildSwarmTree`
  does take exactly `inspection.execution_groups`, `inspection.tasks` and
  `projection.subagents` — the same inputs the rail reads. **That was true and
  irrelevant.** Identical inputs do not make identical output: a graph of agents
  shows parallelism as a shape, and no list of the same facts does. Judging a
  view by its inputs rather than by what a person can see in it is the mistake
  here, and it is worth not repeating.
- **It was a second inspector for the same tasks.** `TaskInspector` in the tree
  and `InspectorPane` in Work rendered one task, one output stream and the same
  three controls, in two code paths with two vocabularies ("Redirect" against
  "Guide this agent"). That is a divergence waiting to happen, and merging them
  removed it.
- **Memory and History could not act.** Every memory card ended in "review this
  in a terminal", and History was read-only plus one trail dialog. Two tabs, one
  subject, zero decisions.

What that bought, beyond one less decision model:

- `src/legacy.css` is **gone**. It existed only to serve those three tabs, so
  every surface is utility-only now and the `@layer legacy` quarantine went with
  it.
- Stopping one task moved into the rail inspector, so `task.stop` is reachable
  from the one place that owns task controls.
- The map dispatches **no actions at all**. It selects a task; the rail acts on
  it. That is what keeps it a view rather than a second place to be.

### The four phases

`src/lib/phases.ts` is the model both the map and the rail draw: **Queued →
Editing → Checked → Ready**, plus shipped, stopped, and needs-you. It is a
`Record<TaskState, TaskPhase>` and nothing else — a rendering of the state Core
publishes, exhaustive by type so a new task state upstream refuses to compile.
It reads no events, keeps no time, and holds no state; deriving a phase any
other way would make the client a second opinion about where a task is.

### Standing rule: the trail must be able to REBUILD the state, not just attest it

A durable event is not enough because it proves something happened. It has to
carry what is needed to reconstruct the state it describes. Ask of every new
event: **could the state be rebuilt from this alone?** If not, the trail is a
receipt, not a record.

This has now bitten five times:

1. a checkpoint that could not be resumed from,
2. a pre-M8.7 verification that could not be adopted from,
3. `plan.prepared` storing the request as a hash, so the run could not say what
   was asked for,
4. `task.created` omitting `required_tests`, `deterministic_validity_check` and
   `routing_task_type`, so **Core's own contract validation refuses a contract
   rebuilt from Core's own log** — found by replaying the trail through the UI.
5. `adoption.completed` omitting `changed_files`, so the trail could prove a
   commit landed but not say what it carried. The shipped card read **"0 files
   changed" over a commit that changed eight** — found by shipping a real run
   through the app on 2026-08-11. `adoption.reviewed` had recorded the files all
   along; the started/completed pair had not.

The fourth is the sharpest statement of the rule: the system cannot reconstruct
its own state from its own durable record. The fifth is the cheapest to have
prevented — the data was one scope away, already in hand.

The rule keeps catching things because it is asked too late. Ask it of the
event when the event is written, not when a surface finally needs it.

## Standing rule: when you loosen a gate, audit what GRANTS the thing it guarded

The most serious hole found in this project, and the audit that missed it.

**What happened.** Moving the planning gate — planning may run against an
unratified spec, execution may not — silently widened a second gate that
depended on it. Autonomy's policy branch reached plan ratification against an
*unsigned* spec and ratified it: `.hivemind/plans/ratified/S-001/` existed on
disk while `convergence.user` was `false`. **The human signature was bypassed on
the path that leads to writing to the user's branch.** Not a near miss: the
artifact was written, and only the adoption gate downstream stood between that
and a merge.

**Why the audit missed it.** Before the change I audited for anything that
*infers* ratification from a plan's existence — does any code treat "a plan is
here" as evidence a spec was signed? That audit was clean, and it was the wrong
question. It asked about **consumers** of the invariant and never about
**producers** of it. Nothing inferred ratification from a plan; something
*granted* ratification without the act that produces it.

So, alongside *the trail must rebuild the state* and *capture the trail and the
project state*:

> **When you loosen a gate, audit what grants the thing that gate guarded.**
> Listing the readers of an invariant is half an audit. The other half is every
> writer: which code paths can produce this state, and does each still require
> the act that is supposed to produce it?

### The full audit, run 2026-08-11

Every state in the system that is *granted* rather than derived, and what grants
it. This is the audit that should have been run the first time.

| Granted state | Written by | Reachable without the act? |
| --- | --- | --- |
| Spec ratified | `ratifySpec` — CLI `--ratify`, `adoptSpec` | **No.** Both go through `checkIdeationRatifiable`, which requires both convergence signals, and `convergence.user` needs a challenge-bound authorization. |
| Plan ratified | `ratifyPlanWithSource` — human via `plan.ratify`, policy via the `auto` branch | **No, after the fix.** Both callers now pass through `requireActiveSpecRatified` inside the granting function, before anything is written. This is the hole. |
| Change adopted | `appendAdoptionCompletion`, only inside `adoptVerifiedSet` | **No.** Requires a pending authorization matching a durable recorded review, refused if already consumed. |
| Canon promoted | `writeJsonAtomic(canonPath, …)` — one writer, in `memory-review.ts` | **No.** Behind a TTY check and a typed confirmation. |
| Quality admission | `value-quality.ts` | **N/A.** Refuses; grants nothing. |

The pattern that made the plan case dangerous and the others safe: **the check
lives inside the granting function, not at its call sites.** `adoptVerifiedSet`
verifies its own authorization; `ratifySpec` runs its own gate. Plan
ratification had its spec check at one call site and not the other, so a second
caller was one edit away from skipping it. It is inside
`ratifyPlanWithSource` now.

**Design rule that falls out:** a function that grants a privileged state should
verify its own preconditions. A caller that has to remember is a caller that
eventually forgets.

## Standing rule: walk the journey, do not only test the units

Three defects, all in the first-run seam, all invisible to 634 passing tests,
all found by clicking through the product rather than by testing it. Together
they are the strongest evidence this file has for the rule.

1. **`prepareWorkspacePlan` kept a duplicate ratification check.** The planning
   gate was moved in `checkPlanningAllowed`; this path called
   `requireActiveSpecRatified` directly, so the first prompt still refused a
   drafted spec. Found by typing a prompt.
2. **Autonomy signed for the person.** With planning loosened, `auto` ratified a
   plan against an unsigned spec. Found by looking at what was on disk after the
   first defect was fixed.
3. **The dispatcher and `adoptSpec` disagreed about a field.** An edit landed
   `nothing_to_decline` in one and not the other, so Approve — the single action
   a first run depends on — failed with "payload contains an unsupported field".
   Found by clicking Approve.

What they have in common is not carelessness; each was a reasonable edit. It is
that **no test walks the journey**. The suite tests units richly and the seams
between them not at all, and all three defects lived precisely in a seam: a gate
moved in one place and duplicated in another, a policy branch downstream of a
changed precondition, a payload contract split across two files.

The rule:

> **Walk the journey before claiming it works.** A suite that passes tells you
> the units are right. Only using the product tells you they are connected. For
> any flow the product actually sells — first run, prompt to shipped — walking
> it is part of the definition of done, not a verification afterthought.

The cost of not doing it is visible in the history: the front door was claimed
finished three times, and each time walking it found something a test could not
have. The cost of doing it is one paid run.

### The fourth walk, which reached shipped and still found four more

`docs/evidence/e2e-2026-08-11-walk4/` is the first walk to get from prompt to
shipped with no terminal. It also found four defects against 646 passing tests,
which is the point worth keeping:

1. **A byte-order mark silently cost the project its checks.** `init` parses
   `package.json` to find the test command; a BOM makes `JSON.parse` throw and
   the catch returned `""`. Setup reported success, and the run failed at
   *integration* — after the worker was paid for — naming a config key.
2. **The cost readout undercounted by a third of the calls.** Drafting bills to
   the spec and everything after it to the run, and the readout summed one
   session. 2 calls shown, 3 spent.
3. **The setup screen told people to paste files it had already written.**
4. **"restart the daemon before using this project"** — an instruction with no
   control anywhere in the app to carry it out.

Two of these are worth generalising beyond the seam rule.

> **A catch that returns a default is a decision to be silent.** Absent and
> unreadable are different facts, and collapsing them hides the second one
> until it costs something. Distinguish them or say so.

> **A number a person spends money against must be reconciled to the ledger,
> not to one of its sessions.** Any per-session view will eventually miss a
> session, and the miss always flatters us.

Note also what caught defect 1: the fixture was written with PowerShell, which
writes BOMs. The walk was one accident away from measuring my own setup instead
of the product. Walking is not a guarantee — it is only better odds than not
walking.

## Standing rule: capture the trail AND the project state

Every verification run keeps its JSONL trail alongside its screenshots. A
screenshot cannot be replayed into a redesigned UI; the trail can, and it is the
only artefact that stays useful after the surface changes.

The M10.8 concurrent run and the M8 end-to-end runs are lost to replay because
only PNGs and prose were kept. Their durations, their nine-task plan and their
adoption refs exist as numbers in a README and cannot be rendered by anything.

### The capture procedure, and why it snapshots at the pauses

**Capture `project-state/` at every point the run stops for a human, not only
when it ends.** A run pauses exactly twice on a clean path — at the plan review
and at the ship bar — and those two pauses are the only moments the two most
important states in the product exist. A single end-of-run snapshot has neither,
which is why the plan review, the ship readiness and the mid-run spend all had
to be synthesized or corrected after the fact.

For the next real run, alongside the trail:

```
# 1. the moment the plan review appears, before pressing Approve
cp -r .hivemind docs/evidence/<run>/project-state-at-review/

# 2. mid-run, while more than one agent is working
cp -r .hivemind docs/evidence/<run>/project-state-at-midrun/

# 3. the moment the ship bar appears, before pressing Ship it
cp -r .hivemind docs/evidence/<run>/project-state-at-ship/

# 4. after adoption, as today
cp -r .hivemind docs/evidence/<run>/project-state/

# 5. mid-run, the project's SOURCE tree — not .hivemind
git -C . ls-files -z | tar --null -cf docs/evidence/<run>/source-at-midrun.tar -T -
```

Each is a few hundred KB and takes a second. What each one retires:

| Snapshot | Retires |
| --- | --- |
| at-review | the `@review-*` pending-plan boolean, and gives a real unratified spec |
| at-midrun | the mid-run **spend ledger**, which is the last synthesized value left in the set — the whole run's bill currently shows over a trail cut at three of five calls, and unlike the lease store it cannot be rebuilt because no per-call resource event exists |
| at-ship | the `@ship` readiness boolean |
| **at-midrun, taken while a task holds a lease AND has submitted a patch** | the **note editor**, which has no screenshot at all. Reaching it needs a task that is both leasing and has a diff, and no trail in the corpus is both: walk4 retained patches but its task record carries no `lease_files`, textkit carries leases and retained no patches. This is a timing requirement on snapshot 2, not a new snapshot — take it *after* the first `task.patch_submitted` while other agents are still working |
| **source-at-midrun** | the **file tree** and the **file viewer**, which today are served from a live capture of this repository rather than from a trail, because `project-state` is `.hivemind` and no trail ever kept the project's own source |
| **`.hivemind/checks/`, inside snapshots 2–4** | the **checks pane**. New in this pass and therefore absent from every existing trail; it comes along free with the `cp -r` once a run is recorded by a build that writes it |

Two of these are the same lesson as the original rule, one level down: **a capture
is complete when every input to the surface is in it**, and "the surface" now
includes surfaces that read the working tree rather than the record. The
`project-state` snapshot was named for `.hivemind` when `.hivemind` was
everything a surface could read. It no longer is.

The collector should prefer a snapshot whose name matches the cut it is building
and fall back to `project-state/` — which is what it reads today, and is why
every cut is currently served state from after itself.

**The generalisation, which is the third correction to this rule:** the rule
first said *keep the trail*, then *and the project state*, then *and the state
is later than the cut*. All three are the same question asked at different
times — **what does this surface read, and when was it true?** A capture is
complete when every input to the surface is in it **and dated at the moment the
surface is being replayed at.**

### The rule as first written was incomplete, and quietly so

"Capture the trail" was not enough, because **a run's state is not all events**.
The plan, the spend ledger, the manager session, the spec and the contracts are
*files*. A trail replayed on its own therefore comes back with a null plan and
zero spend — and says so nowhere. It projects, it renders, it looks right.

The cost of that was not hypothetical. The plan review and the spend meter were
listed as "waiting on a real trail" for five passes. A real trail arrived on
2026-08-11 and **still could not draw them**, because the missing pieces were
never events to begin with. Every replay verification done before that date was
partial in a way nobody could see: the surfaces that depend on file state were
being checked against nulls and called verified.

An evidence folder now carries `project-state/` mirroring `.hivemind/`, and the
collector restores it beside the trail. Captured, never invented — a folder
without one replays exactly as before.

The generalisation worth keeping: **ask what the surface reads, not what the
system emits.** A capture is complete when every input to the surface is in it,
and events are only one class of input.

### And: every trail projects only to its end

The second gap in the same rule. A captured trail replays to its final state, so
a *finished* run is the only state a trail could ever draw. Mid-flight — three
agents working at once, which is the thing this product exists to do — stayed
fixture-only even after real trails existed.

The two live screenshots of it are the proof: both landed inside an
inspection-lag window and show "Waiting to start" beside three running tasks.
Nobody caught it, because a screenshot is whatever the UI happened to be showing
when a human pressed a key.

`tools/collect-replay.mjs` now also emits `<id>@midrun`: the trail cut at peak
concurrency and projected by Core, which draws the honest mid-run state. For a
run that reaches a ship it emits a full `timeline` — one Core projection at each
point the run visibly changed — so playback can move the rail with the story
instead of serving the finished projection over an unfinished thread.

A finished run is the easy state to render. The states that have been wrong five
times are the ones in the middle.

## The positioning sentence, verbatim, for hivemind.build

The setup screen now carries this permanently — not dismissible, not boxed:

> **There is no editor, no terminal and no preview here, deliberately.**
> Hivemind checks what an agent did before it can reach your branch, and each of
> those three would be a way around the check. If you want to write the code
> yourself, you want an IDE — that is a better tool for it, and this is not
> trying to be one.

**The site is not in this repository**, so this cannot be applied here. Lifted
verbatim it fits a landing page above the fold; the wording is deliberate in
three ways and all three should survive an edit:

1. **The refusal comes first**, because a person scanning for "does it have an
   editor" gets their answer in six words.
2. **The reason is attached**, because "we do not have that" reads as unfinished
   where "that would defeat the check" reads as a decision.
3. **It names the alternative.** A refusal with no way forward is the dead-end
   shape this project keeps recording; sending somebody to an IDE is the honest
   ending and costs nothing.

Why it earns permanent space: editor, terminal and preview are the three most
visible features of every comparable tool — Orca ships a Monaco editor, infinite
terminal splits and a Chromium window per worktree, and Cursor, Windsurf, Zed
and BridgeSpace all ship the same three. Somebody who wants those will find
Hivemind unfinished however much gets built, because what they want is what the
architecture exists to prevent. Better they self-select in six words than after
an afternoon.

## Fixed bug: the Grok invocation must pass the prompt to `--single`

The catalogue now records prompt transport per harness. Grok uses an argv
prompt and leaves `--single` as the final template argument; the generic
adapter appends the prompt immediately after it. The other connected harnesses
continue to use stdin.

`grokInvoke()` builds:

```
["--single", "--model", model, "--tools", …]
```

`--single` **takes the prompt as its value**. Measured against `grok 1.0.4`:

```
$ grok --single --model grok-code-fast-1 -p "say ok"
error: a value is required for '--single <PROMPT>' but none was supplied
```

So the argv either consumes `--model` as the prompt or fails to parse. The
correct form puts the prompt there:

```
grok --model … --tools … --no-subagents --sandbox workspace --single "<prompt>"
```

which does reach the auth wall and emits a `system/init` event before refusing.

Two reasons it survived review. The profile was written from documentation
rather than from the binary, and `prompt_arg: "stdin"` reads plausibly beside a
flag whose name sounds like a mode rather than a parameter. Both are the same
error — **a flag's name is not its arity**, and only the binary can say which.

The regression test asserts both the prompt transport and the final position of
`--single`, so a catalogue refactor cannot silently restore the broken shape.

The live probe then established the next boundary rather than erasing it. Both
machine-readable formats report usage and model attribution, but neither says
which sandbox took effect. Writing the in-project canary proves the worker is
not silently read-only; it does not prove where else it could write. The
required confinement claim therefore still refuses.

## Harness notes: two things that look like defects and are not

Both cost real diagnosis time once. Written down so the next person skips it.

**A control found only by its visible text misses the icon-only ones.** The
first GUI driver could not find Settings, because it matches `hasText` and that
button has none — its accessible name is its only label. A driver has to look at
`aria-label` too, which is also how a screen reader finds it. Related, and the
same shape: on the setup screen **`Set it up` opens the agent dialog** and
initialising is **`Set up this folder`**; a driver that greps for "set" clicks
the wrong one and then reports that setup did nothing.

**Two CDP clients driving one app produce fake disabled states.** A second
script attached while the first was mid-action saw `Ship it` visible and
disabled, because `busy` was true from the other client's in-flight request.
That reads exactly like a control wired wrong. One driver at a time, or accept
that every enabled/disabled reading is unreliable.

## Reconciling spend against the provider — option B, ready to run

The subagent finding turns on one unanswered question: **does the provider's
aggregate usage include nested calls?** The cheapest way to find out is to
compare a day of Hivemind's own accounting against the provider's billing.

Hivemind's side for **2026-08-11**, from the ledgers in `docs/evidence`:

| Run | Calls | Tokens |
| --- | --- | --- |
| `e2e-2026-08-11-firstrun-noterminal` | 6 | 294,500 |
| `e2e-2026-08-11-gui-confirmation` | 7 | 414,536 |
| **Total inside projects** | **13** | **709,036** |

Plus roughly 185K over 3 calls from standalone probe experiments run outside any
project, which have no ledger. So Hivemind believes it spent **about 894K
tokens across 16 Codex calls** that day.

If the ChatGPT usage page for 2026-08-11 shows materially more, the difference
is work Hivemind never saw — which is the nested-call gap, measured. If it
matches, the risk is sized at roughly zero and the finding downgrades to
provenance only. The comparison needs a person with the account open; the
number above is the half that could be computed here.

## Playback: the demo comes out of the capture

`/replay.html?scenario=<id>&play=6` replays a run on its own clock: events on
their real relative timing, worker output on the same clock, and the projection
stepping through the captured `timeline`. 4× is 43s, 6× is 29s, 8× is 22s.

Everything it plays is captured. Two liberties, both about time and neither
about content: gaps are clamped at 20s before scaling, so the 24 minutes between
a settings change and the prompt do not become 24 minutes of demo, and a worker
thinking for 90 seconds still reads as work. Output uses the events' clock
rather than its own — its first version drifted, because it restarted timing
whenever the app happened to open the stream.

This exists because the alternative was a screen recording, and a screen
recording would have re-captured the same inspection lag that spoiled the two
live mid-run screenshots.

## Standing rule: real trails verify, fixtures only lay out

`npm run replay:collect` then `/replay.html?scenario=<id>` is permanent
infrastructure. **Any UI change is replayed against real trails before it counts
as verified.** The fixture harness is a layout tool for arranging surfaces that
have no captured data yet — nothing more.

Five passes of green fixtures produced a UI that rendered "A task has to revise
its change ×3" on real data, merging three different failing tasks into one row.
No fixture caught it because every fixture had a title for every task.

## What replaying real trails caught this pass

Three defects that every fixture would have passed. Recorded because the shape
of them keeps repeating, not because these three instances matter most.

**A verified task drawn in failure red.** The map coloured a task's phase spine
from Core's `needs_you` queue as well as from its state. On
`final-run-transcript-4` that put T-002 — `verified`, checks passed — in clay,
directly above its own words "Checks passed, ready to ship". The queue item was
real (`reverification_required`: the checks are stale, not failed), but how far a
task *got* is its state and nothing else. The queue is a separate fact and now
gets a separate, quieter mark. **Two true things, one of them rendered as the
other.**

**Core's own copy leaking banned vocabulary onto the primary surface.** The
attention bar rendered "These checks predate verified-set provenance. Run the
real project checks again before adoption." verbatim — Core's sentence, with two
words the product does not say. A containment guard already existed in
`plainPrimaryDetail`; its word list was simply narrower than the actual ban list.
It is now `src/lib/vocabulary.ts`, one list shared by the guard and its test,
and `test/vocabulary.test.ts` asserts it against the **real captured detail
strings** in `tools/replay-data.json` — including that at least one real string
still trips it, so the guard cannot quietly stop being exercised.

This is a containment check, not a translation: the client recognises *its own*
banned vocabulary and declines to render the sentence, falling back to wording
chosen by the item's typed `kind`. It still does not guess what Core meant. When
Core writes `plain_reason`, the guard stops firing on its own.

**A 360px rail held open for nothing.** `m7-4-consolidation-behavioral` has five
queue items and **zero** projected tasks — a shape no fixture had. The rail
rendered "No tasks in this run yet." across 500px of white. The body grid now
drops the rail entirely when there are no tasks.

### Still leaking, and why it is not fixed here

`rejected add src/ledger.js` still renders raw in the attention bar and the task
row. It carries no banned vocabulary, so the guard correctly leaves it alone; it
is simply terse gate output. The fix remains Core's `plain_reason`, and adding a
fourth client-side regex for it would repeat the mistake this file already
records three times.

On `m7-4` the thread reads "T-101 has to revise its change" because that trail
carries no task titles at all — `inspection.tasks` is empty, so `task_titles` is
empty. Leading with the identifier is correct there: naming it anything else
would be invention. Where a title *is* known, `attentionHeadline` now leads with
it and demotes the identifier, which is the same rule the rows already followed.

## A known class of bug: Core records it, the UI never shows it

The chat hole was `human.guidance_recorded` having no display. A later audit
found the same shape four more times. Treat this as a class, not a series of
one-offs: **when Core appends an event, something must either render it or
deliberately suppress it.** An event with no reader is a silent state.

Two are outstanding, both needing Core to surface state it already records.

#### `adoption.indeterminate` — the most dangerous silence in the app

Emitted by `src/adoption.ts` (`appendIndeterminate`) when the live base ref
matches neither the pre-adoption ref nor the candidate ref, when the candidate's
tree does not match the adoption intent, when HEAD cannot be read, or when the
adoption intent is malformed. It means **Hivemind cannot tell whether your code
landed on your branch.**

Today the reconciliation loop records it, `continue`s, and returns
`{ok: true, value: {reconciled}}`. `inspectLatestAdoptionReadiness` does not
consider it, so the workspace shows nothing at all — or worse, re-offers the
ship bar as though the attempt never happened.

Needed from Core, in `buildQueues`:

```
kind:   "adoption_indeterminate"          // new WorkspaceQueueItem kind
title:  "Hivemind cannot tell whether this change landed"
detail: the recorded reason, plus the two refs it compared
action: null                              // there is no safe automatic recovery
change_set: the verification_id, task_ids and changed_files it was adopting
```

The item must also carry the refs (`pre_adoption_ref`, `adopted_ref`,
observed HEAD) so the client can show a person exactly what to check. This is
the one place where the honest UI is "we do not know; here is how to find out",
and inventing a recovery action would be worse than saying nothing.

`adoption.failed` (phases `precondition`, `base_transition`, `reconciliation`)
needs the same treatment at lower severity: a failed ship currently folds back
into `exactReview = false`, so the bar silently reverts to "Fresh checks passed;
review the change set" with no mention that the previous attempt failed. A
`needs_you` item with the failure reason and a `verification.rerun` action would
close it.

#### `scheduler.run_cancel_failed` — Stop that half-worked

`src/manager.ts` emits this when some workers refuse to stop, carrying
`failures`, `stopped_task_ids` and `retryable: true`. Nothing surfaces it. The
run.stop call returns `{ok: false, reason: "run cancellation incomplete and
retryable: …"}`, and `plainActionError` pattern-matches `/already terminal/`
inside that aggregate string — so a partial run-level failure can report the
per-task message "This task has already finished and cannot be stopped again."
Wrong, and it hides that workers are still alive.

Needed from Core:

```
kind:   "run_stalled"                     // existing kind is a fine fit
title:  "Some work could not be stopped"
detail: which tasks, and why each refused
action: { type: "run.stop", payload: { session_id, reason } }   // retryable
```

Separately, `plainActionError` must stop matching patterns inside aggregated
reasons. The durable fix is the plain-language field on the daemon error noted
below; until then the client should not infer meaning from a substring.

## First run: closed on 2026-08-11. It does not need a terminal.

**A clean install reaches a shipped change with no terminal command and no
hand-written document, including connecting the agent.** Walked, not reasoned
about — the history below records the front door being called finished three
times, and each walk found something, so this one was run end to end before the
claim was made.

`docs/evidence/e2e-2026-08-11-firstrun-noterminal/` holds the trail. A fresh git
repository with a `package.json`, one source file and **no `.hivemind`**, driven
through the exact typed actions the desktop dispatches, in the order it
dispatches them:

| | Step | Action |
| --- | --- | --- |
| 1 | Set this folder up | `project.init` |
| 2–4 | Connect an agent for each role, each probed | `adapter.connect` ×3 |
| 5 | Type what you want built | `spec.draft` |
| 6 | Prepare a plan | `plan.prepare` |
| 7–8 | The one review: sign the spec, ratify the plan | `spec.adopt`, `plan.ratify` |
| 9–10 | Let it work | `manager.start`, `manager.continue` |
| 11–12 | Ship it | `adoption.review`, `adoption.execute` |

Every step returned ok. What that produced, verified in the repository rather
than in the action results:

```
bd64af8 Hivemind adoption V-335aa795-...   src/greet.js | 3 ++
17b51e0 base                               test/greet.test.js | 8 ++
npm test on master after adoption: 1 test, 1 pass, 0 fail
```

**Cost: 294,500 tokens over 6 calls** — three probes (~118K) and the work
itself (~176K: one drafting call, one planning call, one worker call). Worth
stating plainly, because connecting three agents is a third of a first run's
bill, and the screen says so before the click.

### Confirmed by clicking, not only by dispatching

The action-level walk above proved every typed action works from a clean
install, and said plainly that it had *not* pressed the buttons that send them.
That gap was closed the same day: `docs/evidence/e2e-2026-08-11-gui-confirmation`
drives the release build over the WebView2 debugger — real clicks, real
`Control+Enter` in the real composer, **no action dispatched directly** — from
`Set up this folder` through three `Connect` buttons, the prompt, the review,
`Approve and start`, and the ship. It reached a shipped commit whose tests pass.

Every control did what its label said. Two things looked like defects and were
the driver's fault, recorded so nobody chases them: `Set it up` on the setup
screen opens the *agent* dialog and initialising is `Set up this folder` (the
first script clicked the wrong one), and a visible-but-disabled `Ship it` was
two CDP clients driving one app so `busy` was true from the other's in-flight
action.

#### What it found: shipping is two clicks, and the evidence showed one

A real run's ship bar first reads **"Fresh checks passed; review the change
set"** with **Show me the changes**. Only after that does it become **"Confirm
this exact change set"** with **Ship it**. Core requires the review to bind the
exact set before it will authorise a merge — `exactReview` is false until an
`adoption.reviewed` event exists — so the two-step is correct.

But `04-ship-bar.png` shows only the second state, because the `@ship` replay
scenario is rebuilt with `exactReview = true`. **The first state a person
actually meets had never been captured**, in any screenshot or scenario. That is
the synthesized-boolean cost showing up exactly where this file predicted it
would: a state reconstructed to be *interesting* skipped the state that comes
before it. The capture-at-the-pause procedure fixes this too — a snapshot taken
when the ship bar first appears is the missing one.

#### Cost, measured against the estimate

414,536 tokens against an estimate of 294,500. The three probes were within 1%
(118,794 against 117,890); the run half doubled because the planner wrote a
**two-task** plan where the previous prompt's was one. So the variance is plan
shape, not estimation error, and the useful first-run number is: **connecting
three agents costs ~118K regardless, and everything after depends on how many
tasks the planner writes.**

### The four walls that used to be here, and what removed each

| Wall | Removed by |
| --- | --- |
| The desktop could not initialise a project | `initialize_project` (Tauri) and `project.init` (typed action) |
| Adapter profiles had to be hand-written | `adapter.connect`, which also verifies them |
| A spec had to be written by hand in nine sections | `spec.draft` + the one review |
| An unconfigured project routed everything to the flagship | Core's `initProject` writes tier globs itself |

## The original first-run walls, kept for the record

Nobody had walked a clean install. What actually happens:

1. The app opens on `.`, `select_project` canonicalises a git root, and
   `desktop/src-tauri/src/project.rs` refuses with **"selected repository is not
   initialized for Hivemind"** unless `.hivemind/config.json` already exists. The
   desktop cannot initialise a project. A first-time user must run
   `hivemind init` in a terminal before the app is of any use.
2. `initProject` writes no tier globs and no adapter profiles.
3. The Work tab asks Core for two tools **by name** — `plan.prepare` sends
   `tool: "planner"`, `manager.start` sends `tool: "manager"` — and Core resolves
   each with `loadAdapterProfile`, i.e. `.hivemind/adapters/<tool>.profile.json`.
   Neither file exists after init, so the first prompt fails on a missing adapter
   profile with no UI anywhere that explains which files are wanted.

The setup screen and the agent dialog make steps 2 and 3 comprehensible and hand
over the exact files, but the app still cannot apply them. Everything below is
what Core would need for a first run without a text editor.

**Walked again on 2026-08-11, and step 3 is not the last wall.** With adapter
profiles and tier globs in place, the first prompt still fails:

> `no active spec; create and ratify a spec before planning, leasing, or running workers`

Reaching a first prompt took four terminal commands and a hand-written document,
none of which appears on any surface in the app:

```
hivemind spec S-001 --create --title "…"     # then fill nine sections by hand
hivemind ideate S-001 --start --title "…" --goal "…"
hivemind ideate S-001 --round round.json     # ≥2 alternatives with tradeoffs,
                                             # plus a self-critique round
hivemind spec S-001 --ratify
```

The spec gate is doing real work — it refuses a spec with empty non-goals, and
it refuses ratification without genuine alternatives and a self-critique. The
problem is not that the gate exists, it is that the product's whole promise is
"type what you want" and the first thing it does is refuse until you have
written a nine-section document in a text editor. `project.init` in the list
below is necessary but not sufficient: a first run also needs a way to get from
a sentence to a ratified spec.

That error is also raw Core text on a primary surface, and it says *spec*,
*leasing* and *workers* — the client's guard suppresses it and falls back to the
kind-based sentence, which is correct but loses the one detail that would tell
somebody what to do.

A proposal for this is written up under **"Proposal: the front door"** below,
after the Core actions it depends on.

### The cost defect in an unconfigured project

`inferScopeTier` (src/routing.ts) returns **`"high"`** for any path matching no
configured glob, and `initProject` configures none. `minimumProviderRank.high`
is `providerTierRank.strong`, and `checkTierEligibility` **refuses** any
candidate below that floor — so on a fresh project cheaper providers are not
merely deprioritised, they are ineligible. Every task routes to the strongest,
most expensive provider, and `compareCandidates` sorts high/critical by provider
rank descending, so it picks the strongest of those too.

A new user's first run is the worst-case configuration, and nothing in the
product tells them. The fix is one change in `initProject`: write ordinary
default globs so that documentation is low, source and tests are medium, and
build/CI/auth paths are high or critical. Those defaults now live with Core in
`src/project-defaults.ts`; the desktop has no second copy to drift.

### Invariant change: planning no longer requires a ratified spec

Taken deliberately on 2026-08-11. Recorded here because it inverts a gate three
Core tests named, and someone should be able to find out why.

**What changed.** `checkPlanningAllowed` required the active spec to be
*ratified*. It now requires the active spec to be *valid*. `plan.prepare` will
run against a draft.

**Why.** A plan is a proposal: planning reads the repository and writes a
tentative plan. Nothing in it touches the repo. The invariant that matters is
that **execution** requires a ratified spec, and `requireActiveSpecRatified`
still guards contracts, leases, worktrees, workers, scouts, integration and
checkpoints. The original gate was written when nothing generated a spec, so
requiring ratification before planning was free — it protected against wasted
planner tokens, not against repo mutation. Once the app drafts a spec from a
prompt, that same gate makes it impossible to show anyone a plan before they
commit to the document it came from, which is precisely what a first run needs.

**What it costs.** Planner spend on a spec that may never be ratified. A person
can now prompt, see a plan, and walk away, having paid for a planning call
against a document nobody adopted. That is the deliberate price of showing
someone a plan before they sign, and it is a real cost: on the 2026-08-11 run a
planning call was 23.3K tokens.

**What makes it safe, and where that is proved.**
`test/unratified-spec-gate.test.ts` asserts both halves: an unratified spec
permits planning, and then *tries* contract creation, lease grant, worktree
creation, worker run, scout run and checkpoint against it and confirms each
refuses, and refuses **because** the spec is unratified rather than incidentally.
Integration is the one path that cannot be reached from an empty repository — it
refuses for want of a queue before it consults the spec — so that one is
asserted structurally, and the test says so rather than fabricating a queue and
calling it behaviour.

**Nothing inferred ratification from a plan.** Audited before the change: every
execution surface calls `requireActiveSpecRatified` itself. `contract.ts` checks
the spec at line 180 *before* reading the linted plan at 196, so contract
creation never treats "a plan exists" as evidence a spec was ratified. That
shape — one gate standing in for another — is the one that has bitten this
project repeatedly, and it is not present here.

One ordering consequence for the UI: `ratifyPlan` itself requires a ratified
spec, so the single review must sign the spec before it ratifies the plan.

### The vacuity experiment, and what it found

Four real drafting calls on 2026-08-11, `codex-terra`, 4 calls / 79,137 tokens.
Verbatim output in `docs/evidence/spec-drafting-vacuity.json`.

| Prompt | Non-goals | Open questions | `assessNonGoals` |
| --- | --- | --- | --- |
| "make the text stuff better" | none | 1 | empty |
| "Add a titleCase(text) helper…" | 1 | none | 1 substantive |
| "…reads a config file from disk…" | none | 1 | empty |
| "make the text stuff better" (again) | none | 1 | empty |

**Zero vacuous entries.** The drafter never wrote "None recorded" or "Anything
else". When it had nothing to decline it returned an empty list, which is what
the prompt asked for and is the honest answer.

**It asks rather than guesses.** Both vague runs invented no constraints and
raised a question instead — "Which text utility or utilities should change?" —
and did so consistently across two runs. That is the behaviour that matters
most: open questions block ratification, so a drafter that guesses is worse than
one that returns nothing.

**It did not decline the tempting scope.** The config-reader prompt has obvious
adjacent scope — writing config, schema validation, caching, watching for
changes — and the drafter declined none of it. It asked about file format
instead, which is a legitimate question, but the temptation went unaddressed.
On the specific thing this experiment was designed to test, the answer is no.

**The one substantive non-goal is real but mild.** "Does not change the
behavior of existing text helpers" is derived from the project's file list
rather than from the prompt's own phrasing, and a person might well have written
it. It is not padding. It is also the kind of thing a builder would probably
have respected anyway.

#### The finding that matters: the gate refuses the honest answer

`ratifySpec` requires Non-goals to be non-empty. Three of four drafts produced
**zero** non-goals — correctly, by the prompt's own instruction. Those specs
cannot be ratified.

For these three it does not bite, because each also raised an open question and
would have blocked anyway. But a prompt that is specific enough to need no
question and has no tempting adjacent scope would produce an unratifiable spec,
and the person would be blocked by a rule nobody meant to apply to them.

So the collision is real and currently latent. The options, none of which should
be chosen quietly:

- **Let a drafted spec ratify with empty non-goals**, treating "nothing to
  decline" as a legitimate answer and losing the gate's forcing function.
- **Require the drafter to always produce one**, which is how "None recorded"
  gets invented and the gate becomes theatre — the outcome this experiment was
  run to detect.
- **Ask the person**, making "is there anything this should not do?" part of the
  one review. Keeps the gate honest and costs a field on a screen.

The third is the only one that preserves what the gate is for. It is not built;
`assessNonGoals` was deliberately not loosened to accommodate any of them.

### The one review, built

`src/components/workspace/spec-review.tsx`, inside the existing plan takeover.
One screen; the person acts once. `spec.adopt` signs the spec, then
`plan.ratify` ratifies the plan, because ratifying a plan requires a ratified
spec — ordering, not a second decision.

**Non-goals is an input, not a display.** Drafted entries arrive prefilled and
marked *Suggested*; anything typed is marked *Yours*. The heading asks the
question — "Anything this should NOT do?" — rather than presenting a default,
and an empty drafted list says "Nothing was suggested" instead of hiding the
field. The person's answer is what gets written to the spec. This follows the
experiment: the drafter left writing, validation, caching and watching all
undeclared on the config-reader prompt, so drafted non-goals cannot be the
forcing function. They are a bonus; the person is the author.

**Open questions block, visibly.** The refusal is the first thing on the screen,
in clay, with the question quoted and the remedy stated, and the approve button
is disabled with the reason beside it. Core refuses this too — the UI only
explains the refusal before somebody hits it.

#### What this was verified against

`16-review-blocked.png` and `17-review-ready.png` in
`docs/evidence/e2e-2026-08-11-textkit`, replayed from **real** data: the plan is
the real four-task plan from the 2026-08-11 run, and the spec is a **real
drafted spec** from the vacuity experiment — the config-reader draft with its
one genuine blocking question, and the titleCase draft with its one suggested
non-goal.

**One thing is synthesized, and only one:** no captured trail contains a plan
*awaiting* ratification — the real run's plan was ratified during it — so the
scenarios present the real plan as pending. Per the standing rule: the plan
content, the spec content, the question and the suggestion are all real; the
pending state is not. A trail captured before ratification would close that,
and is worth taking on the next run.

### spec.draft, and what is left of the front door

`spec.draft` is one adapter call that turns a prompt into a short-form spec,
opens its ideation session, and records the drafter's own alternatives and
self-critique as the orchestrator's round. What comes out is a drafted,
orchestrator-signed spec that `plan.prepare` can plan from.

The round is the drafter's real material. The drafting prompt asks for two
genuinely different ways to satisfy the request with real tradeoffs, and says
that if the request is too thin for two honest alternatives it should raise an
open question rather than invent a second one. A round assembled to satisfy a
validator would be the same theatre as a placeholder non-goal.

**It cannot sign for a person.** `spec.draft` writes
`orchestrator_calls_convergence` and nothing else, and
`test/spec-convergence.test.ts` now names it as another caller that must not
reach `convergence.user` — 7/7, alongside the direct module call, the invented
authorization, the replay, the spec edited after presentation, the CLI without a
TTY, and the four automated surfaces.

#### "Nothing to decline" is an answer

The rough edge is closed. The review offers "There is nothing this should leave
alone" as an explicit choice, which satisfies the Non-goals section. It is never
the default and never prefilled — it has to be chosen — because the gate is
collecting a person's judgement about scope, and "I considered it and there is
nothing" is a judgement. `assessNonGoals` is unchanged: it measures *drafted*
output quality, where a vacuous entry is still theatre.

### The drafter was too eager

Product call, taken 2026-08-11 after the first-run walk. "Add a way to validate
email addresses" blocked on whether validation means practical syntax or the
full standards range. The ambiguity is real, but a reasonable implementer picks
practical syntax and ships, and the person corrects it if wrong.

**Non-blocking ambiguity is the normal condition of software work.** If every
ordinary request stops at a questionnaire, this is a requirements-gathering tool
rather than a build tool.

So the drafter now distinguishes two things:

- **A stated assumption is the default.** Where the request leaves a choice open
  and a competent person would just decide, decide — and record it. The review
  shows "Decisions made for you", and the person can reject any of them.
- **A blocking question is rare and expensive.** Only where no reasonable
  default exists and choosing wrong wastes the whole run. *"Which of the three
  services should this live in"* blocks. *"How strict should validation be"*
  does not.

Assumptions are shown as prominently as non-goals, for the same reason: the
person is accepting a decision they did not make. Drafted non-goals are
constraints somebody else wrote; assumptions are choices somebody else made.
Both have to be visible or the review is a rubber stamp.

The test of whether this worked is the same prompt, unchanged, reaching a plan
with a stated assumption instead of a question.

### A quota-paused run has no way back

Found finishing the first-run walk. When a run pauses on `quota_exhausted` the
manager session reads `stopped`, `continuation_available` is false, and the
queue item carries `action: null`. The person is told "waiting for capacity" and
given nothing to do about it — the same class as the `run_stalled` and
`adoption.indeterminate` silences already listed here: Core records the state,
and the app can only describe it.

What is needed from Core is a resume that does not re-plan: the task's contract,
lease and worktree all survive the pause, so the work is one worker call from
continuing. Today the only way forward is a new prompt, which throws away a plan
the person already approved and pays for planning twice.

### Fresh install pins everything to the flagship

Logged here, belongs in the settings / bring-your-own-keys work.

`init` writes tier globs correctly, so the routing floor computes the right tier
for each task. But it writes only three adapter profiles — `planner`, `manager`,
`worker` — all pinned to `gpt-5.6-sol` at `routing_tier: "strong"`. The floor
has nowhere to fall: there is no cheap or standard provider to route down to, so
every role runs on the most expensive model available.

Measured on the first-run walk: 3 calls, 194,810 tokens, all `gpt-5.6-sol` --
planner 20,469 and 22,112, worker 152,229.

**The defaults are internally inconsistent.** `init` writes a 150,000-token run
ceiling, and one flagship worker call cost 152,229. Either number alone is
defensible; together they guarantee a first run stops on quota *after* the money
is spent. Whatever fixes the provider defaults has to fix the ceiling in the
same change, or the fix is not a fix.

Fixing it today means hand-writing `codex-terra` and `codex-luna` profiles,
which is the terminal again — so it is not a first-run fix, it is the settings
surface's job. `adapter.connect` in the Core-actions list below is where it
belongs.

### Proposal: the front door

Not built. Written down because the design choice is real and worth settling
before code.

#### What the spec is actually load-bearing for

Read the enforcement rather than the convention, and the answer is narrow.

| Enforced | Where | What it demands |
| --- | --- | --- |
| `# Spec: <title>` | validate | non-empty title |
| exactly one `status:` line | validate | `draft` or `ratified` |
| nine `##` headings present | validate | **headings only — bodies may be empty** |
| Non-goals non-empty | ratify | some text |
| Open questions empty | ratify | no text |
| ≥2 alternatives with tradeoffs | ratify | recorded in the ideation session |
| ≥1 round, each with a self-critique | ratify | recorded |
| `convergence.orchestrator` | ratify | a sign-off |
| `convergence.user` | ratify | **a separate sign-off** |

What consumes the document: `buildPlanningGenerationPrompt` passes the whole
markdown to the planner as context, and the title becomes
`active_spec_title`. That is all.

What does **not** read it: grounding (base commit and per-task evidence against
the repo), all eight plan-lint rules (parallel safety, scope overlap, dependency
cycles, critical approval, right-sizing, skeleton-trap acceptance), file scope
(the plan's `allowed_files`) and conformance (the plan's
`deterministic_validity_check`). Scope and conformance derive from the **plan**,
not the spec.

So **seven of the nine sections are conventional** — a thinking scaffold for the
person and context for the planner. Non-goals and Open questions are
load-bearing as *gates*, not as data. And the gate's real work is not the
document at all: it is forcing alternatives, a self-critique, and **two distinct
signatures** before any work starts.

That reframes the problem. The gate is not protecting scope derivation. It is
protecting intent quality, and it already distinguishes "a model converged" from
"a person converged".

#### The authorship line

A model may **draft**; only a person may **converge**. Core already models this:
`convergence.orchestrator` and `convergence.user` are separate booleans, and
ratification requires both. Any first-run flow that writes `convergence.user`
without a human act is forging the one signature the gate exists to collect.
That rules out the obvious shortcut — scaffold a spec, auto-ratify it, never
show it — however tempting its simplicity.

The sharp edge is Non-goals. A non-goal is a *constraint on what gets built*. A
generated non-goal is a generated constraint, and one nobody read can silently
narrow the work. If the app drafts non-goals, it must show them. That single
consideration, more than anything about document structure, decides the flow.

#### Recommended: one review, and it is the plan review

```
prompt → drafted spec (orchestrator-converged) → plan → ONE review → work
```

The person's single approval carries both signatures, because the review shows
the things both gates are actually checking:

- **what will be built** — the plan, as today: steps, file scopes, how each
  result is checked;
- **what will not** — the drafted non-goals, stated plainly, because they are
  constraints the person is adopting;
- **anything the drafter could not resolve** — open questions, which **block**.
  Core already refuses ratification while any remain, so they cannot be a
  footnote; answering them belongs on this screen, and an unanswered one means
  the run does not start.

This stays inside the two-decision model: type what you want, approve the plan.
It does not bypass the gate — it collects the same signature against strictly
more information than a nine-section document read in isolation would give,
because the plan is concrete where the spec is prose.

What it costs: one more model call before planning, and a review screen that
grows a "what this will not do" section. What it must not become: a spec
displayed for form's sake. If the drafted non-goals are always "None recorded",
the gate is vacuous and we have built theatre.

#### The smaller version, and why it is not as small as it looks

"Have `project.init` write a valid scaffold the user never sees" does not
actually unblock a first run. The scaffold satisfies *validate*; it does not
satisfy *ratify*, which needs the ideation record and both signatures. Getting
past that without a human act means auto-signing `convergence.user` — the one
thing ruled out above.

If a smaller step is wanted first, the honest one is a Core change rather than a
client trick: let a **short spec form** be first-class — title, goal, non-goals,
acceptance — accepted by `plan.prepare` on equal terms, with the nine-section
document reserved for deliberate work. That says "a one-line intent is a
legitimate spec shape" instead of pretending a placeholder is a document. It is
a smaller change than it sounds, because nothing parses the nine sections.

#### Open question for the human, not for this file

Whether a drafted spec should be *kept* as the project's spec, or treated as
scaffolding for the plan and discarded. Keeping it means the project accumulates
documents nobody wrote. Discarding it means `active_spec_title` and the run
history lose their subject line. I lean toward keeping it, marked as drafted,
because the ideation record already distinguishes who converged — but this is a
product call about what the project's memory should contain.

### Built: the settings surface, and a probe instead of a declaration

All four actions below exist now, and the screen that needed them replaces
"Hivemind cannot read these from here yet" with the values themselves. What
follows is what changed against the spec and why, then the part that matters.

**Positioning, so the copy is coherent.** Hivemind is an agent development
environment; a coding agent is a *harness* that runs inside it, paid for by a
subscription the person already has. The screen therefore asks *which coding
agent do you have* and the answer is a harness plus a subscription. Hivemind
holds no provider credential, and a desktop test asserts no input on that screen
asks for one. (The first version of that test banned the *words* — and caught
"Auth, secrets, migrations", which is the plain-language name of the most
dangerous file scope. Banning the vocabulary would have banned the sentence that
protects it. It checks inputs now.)

#### Deliberate departure: `project.init` writes NO adapter profile

**Do not "complete" the spec by adding this later.** It was left out on purpose
and approved as a departure on 2026-08-11.

The spec has `project.init` write `planner` and `manager` profiles for the
chosen provider. It does not, because **a profile written there is a
declaration no probe has checked** — which is the exact thing `adapter.connect`
exists to replace. Writing one at init would reintroduce, in the same commit,
the failure the probe was built to end: a profile that claims capabilities
nobody verified. Connecting an agent is the next call and it is one click per
role.

`initProject` does still write its own default profiles, so a first prompt has
something to resolve. Those are declarations too, and `config.inspect` now says
so: they come back `installed` with `connected_at: null`, and the screen reads
*"Installed before Hivemind could check it — reconnect to verify what it can
do."* against *"Checked when you connected it"* for a probed one. That
distinction is the whole difference between this build and the last one, and it
only exists because init's profiles are not treated as connected.

The same reasoning removed a second thing after the walk below: an earlier
`project.init` also wrote its own tier globs, from a constant that duplicated
Core's. Core's `ensureTierGlobsRecorded` fills only the keys that are **absent**;
the copy here overwrote whole lists, so re-running setup on a project whose
globs had been customised would have silently reset them. Two sources of truth
for one default, and the second one clobbered the first. `project.init` is now a
thin wrapper that adds nothing.

### HIGHEST-SEVERITY OPEN ITEM: nested sub-agents cannot be verified away

Promoted here from a documentation caveat on 2026-08-11, because the probe
turned a prediction into a measurement. Read this before picking a fix.

`Hivemind_Build_Progress.md` recorded that refusing provider-owned ultra modes
closes only *inspectable* paths, and stated the limit: Hivemind cannot detect a
provider-side or session-level mode absent from the profile, the invocation and
the environment. That was reasoning about what *could* be observed. The probe
now reports what *is* observed:

```
UNVERIFIED   Does not start agents of its own   asked off   got v2
```

Codex's `turn_context` reports `multi_agent_version: "v2"` — that the capability
exists — and reports **nothing** about whether it is switched off for this
profile. It is the same record that yields the model, the sandbox and the
approval policy, so this is not a gap in our reading: **suppression is
unreportable from the provider's own resolved context.** No probe we write can
close it, because there is nothing on the other side to read.

#### What actually breaks, corrected

An earlier version of this note — and the commit message that shipped it — said
a nested fan-out breaks all four of one-worker / one-lease / one-scope /
one-diff. **That was wrong, and the error mattered**, because it aimed the fix
at the wrong layer. Checked against `decision.ts` and `analyze.ts`:

| Invariant | Survives a fan-out? | Why |
| --- | --- | --- |
| One scope | **Yes** | `decideOp` rejects `outside_allowed_files` on the *patch*. Enforcement is on the artifact, not on the agent's behaviour, so it does not care how many agents produced it. |
| One diff | **Yes** | Same gate. Everything the worktree contains is analysed as one change set against one contract. |
| One lease | **Yes** | The lease is over files, and the diff is what gets checked against it. |
| One worker | **No** | Hivemind decides concurrency; a nested fan-out runs provider calls it never authorised. |

That is the architecture working: **scope is enforced where the work lands, not
where it is produced.** It is exactly why this design is defensible, and stating
otherwise undersold it.

So the hole is real but narrower and differently shaped than "correctness":

1. **Cost control — the serious one.** If aggregate usage does not include
   nested calls, every ceiling under-enforces by an unknown factor. Spend is the
   one place where under-reporting is both silent and expensive, and there is
   **no client-side accounting that can see spend the provider does not
   report.** Reserved-versus-effective overshoot detection cannot help: it
   compares against the same reported number.
2. **Provenance.** `routing.observed` records that one provider at one tier did
   the work. If a sub-agent on a different model did part of it, the routing
   evidence is wrong — and routing-weight memory proposals *learn* from that
   evidence, so a wrong attribution teaches the project a wrong preference.
3. **Concurrency ownership.** `max_concurrent_workers` governs Hivemind's
   workers, not calls made underneath one. Affects rate limits and quota
   pacing rather than correctness.

#### Closure options, in order of what each buys

**A. The provider reports its resolved sub-agent setting.** One more field in
the same `turn_context` that already carries model and sandbox.
*Buys:* complete verification with **zero new mechanism** — the probe compares
it like everything else, at connect time and re-checkably every run. It is the
only option that actually closes the hole.
*Costs:* nothing on our side.
*Available today:* **No.** Entirely dependent on the provider exposing something
it currently does not. We can file the ask; we cannot ship it.

**B. Reconcile one real day's spend against the provider's own billing.**
*Buys:* an answer to the question that decides how bad this is — *does aggregate
usage include nested calls?* If it does, ceilings hold and severity collapses to
provenance alone. If it does not, we learn the size of the gap.
*Costs:* one real run plus a human reading their ChatGPT usage page. Manual,
one-off, not automatable, and only as precise as that page.
*Available today:* **Yes** — and it is the cheapest thing that would most reduce
the uncertainty. **Recommended first move**, because A is unavailable and every
other option is guesswork until this is known.

**C. Keep refusing what is inspectable and report the rest as unverified.**
*Buys:* closes every path we *can* see (profile, invocation, environment), and
keeps the gap on screen at connect time instead of behind a green mark.
*Costs:* nothing; already shipped.
*Available today:* **Yes, in place.** This is the floor, not a fix — it makes the
hole visible without making it smaller.

**D. Watch the worker's process tree.** Count processes in the group Hivemind
already spawns detached for `kill(-pgid)`.
*Buys:* would catch a fan-out that spawns OS processes.
*Costs:* small.
*Available today:* Yes, but **evaluated and not recommended** — a coding agent's
sub-agents are almost certainly further API calls inside one process, not new
processes, so this would report clean while the thing it is looking for happens.
Worth building only if someone first demonstrates the fan-out is process-shaped.

**E. A behavioural probe: a prompt whose honest completion needs fan-out.**
*Buys:* weak evidence from our side with no provider cooperation.
*Costs:* a probe call, and a real risk of false confidence — absence of fan-out
on one prompt is not suppression, and a green result here would be worse than no
result.
*Available today:* Yes; **not recommended** for that reason.

**The reasoning in one line:** only **A** closes it and it is not ours to build,
so the honest sequence is **B to size the risk, C to keep it visible, and A as
the ask** — with D and E written down as considered and rejected so nobody
rebuilds them.

#### The probe, and what a real agent actually reports

There was no capability probe anywhere. `validateAdapterProfile` is static field
validation and `findDangerousAdapterArgs` refuses bypass flags at spawn; neither
had ever confirmed that a flag TOOK EFFECT — and this project has shipped that
failure twice, with `--ignore-user-config` silently forcing a read-only sandbox
and, separately, a model pin silently ignored for months.

So connecting runs the agent once and compares what it reports against what was
asked for. Designing that meant finding out what a real agent actually says,
which took three live runs against codex-cli 0.147.0:

1. `codex exec --json` emits `thread.started`, `turn.started`, `item.*` and
   `turn.completed`. **It names no model and no sandbox anywhere.** Reading the
   stream alone, four of five capabilities would be unverifiable.
2. Codex writes a session rollout file per run — but `--ephemeral`, which every
   profile carries, suppresses it.
3. Dropping only `--ephemeral` produces a rollout whose **`turn_context`** record
   states `model`, `sandbox_policy.type`, `approval_policy`, `workspace_roots`
   and `multi_agent_version`. That is a genuine startup readback of what
   resolved, not what was requested.

The probe therefore runs **the profile's own argv with exactly one flag
removed**, and finds the rollout by the `thread_id` the run prints on its own
stdout — so it never guesses which file belongs to which run. Probing a
different invocation would prove nothing about the one that runs real work;
dropping that one flag changes only whether the session is persisted.

| Capability | How it is verified |
| --- | --- |
| Carries no bypass flags | static, before anything spawns; a refused profile is never executed |
| Runs without asking anything | exits on its own inside the timeout, and `approval_policy` is read back |
| Can write in this project | `sandbox_policy.type` read back **and** the file it was told to write is on disk — two independent proofs, because a silently read-only sandbox reports success and writes nothing |
| Runs the one model you chose | `turn_context.model` compared to the `--model` argument |
| Reports what it spent | the configured parser has to find real tokens in **this run's own output** |
| Does not start agents of its own | **unverified.** It reports a sub-agent capability; whether it is off is not something it reports |

A live connect on 2026-08-11 verified the first five and reported the sixth as
unverified. `docs/evidence/adapter-probe-2026-08-11/` holds the profile and the
connection record it wrote.

**What is proven live and what is proven by test.** The readback *mechanism* is
live: a real run, a real rollout, real values compared. The *mismatch branches*
are covered by `test/adapter-probe.test.ts` with a stubbed readback, because
making Codex genuinely ignore its own `--model` is not something a test can
arrange. Both regressions have a test named after them.

**Cost, stated before the click.** A connect is one real model call — about 40K
tokens and ten seconds on Codex. The button says so.

**Unverified never becomes supported.** A capability with no readback is
reported `unverified`; only a *failed* required capability refuses. Nothing is
written when a probe fails, so a project can never hold a profile whose
capabilities were assumed.

#### Honest about what works

The catalogue is Core's now, and the client reads it rather than carrying its
own. Three Codex tiers are `supported` — one harness, three models, which is
what tier routing needs. Claude Code is `unverified` and **not connectable**: its
usage parsing has only been checked against recorded output, and its old profile
carried `bypassPermissions`, which this build refuses. OpenCode is
`unsupported`: no argv, no usage parsing, no run. Both carry the specific reason
on screen. A test asserts exactly one harness is supported and that every other
entry has a caveat and no invocation — so the catalogue cannot grow a button
that cannot work.

#### Everything that used to need a text editor

Found by reading Core's config rather than from a list: tier globs (as *Simple /
Ordinary / Risky / Dangerous*, never "tier" or "glob"), both token ceilings, the
worker concurrency limit, the test command, and the interruption level. The run
ceiling shows the measured reality beside it — one real worker call cost between
106,792 and 179,698 tokens on this project's own runs, so a ceiling below that
stops the run *after* the money is spent. The number comes from Core so the
warning cannot drift from what a call costs.

`config.set` takes a fixed key list and refuses anything else rather than
merging it; every write goes back through the same `validateConfig` the loader
uses. It cannot lower a routing floor, because floors are derived from tier and
only the lists that *assign* a tier are writable.

### Core actions the settings surface needs

Named to match the existing dispatcher style. All would be additions to
`workspaceActionTypes`.

**`config.inspect`** — read. Unblocks everything else; without it the client
cannot show what is configured, only what it was told at runtime. Should return
the resolved `HivemindConfig` (tier globs, `test_command`, `base_branch`,
`execution`, `resource_policy`, `verification`) plus, for each file in
`.hivemind/adapters`, the validated profile and any problems
`validateAdapterProfile` found. Read-only; no secrets are involved because
Hivemind never holds provider credentials.

**`config.set`** — write, narrow. Accept only a whitelist —
`low_globs`/`medium_globs`/`high_globs`/`critical_globs`,
`resource_policy.run_ceiling.tokens`, `resource_policy.session_ceiling.tokens`,
`execution.max_concurrent_workers` — and validate through the existing
`validateConfig` before writing. Refuse anything else rather than merging
arbitrary JSON.

**`project.init`** — write. Wrap `initProject` so the desktop can set up a folder
it has been pointed at, and in the same call:

- write the default tier globs above, so the project does not start in its
  most expensive configuration;
- write `.hivemind/adapters/planner.profile.json` and
  `.hivemind/adapters/manager.profile.json` for the chosen provider, because
  those two names are what `plan.prepare` and `manager.start` resolve and a
  project without them cannot take a first prompt.

This is the single change that removes the terminal from first run. Queued
second, after `config.inspect`, because the client should be able to read the
result of what it just wrote.

**`adapter.connect`** — write **and verify**. This is the one that must not be a
declaration. Accept `{ role, provider_id }`, build the profile server-side, run
`validateAdapterProfile` and `findDangerousAdapterArgs`, then **probe** before
recording anything.

The probe must read back what the provider reports **at startup**, and compare it
to what was asked for. A flag being accepted is not evidence it took effect —
both known regressions were exactly that shape: `--ignore-user-config` silently
forced a read-only sandbox, and separately silently pinned an old model. So:

| Capability | What the probe must confirm |
| --- | --- |
| Runs one exact model | the model the provider *reports running* equals the pinned one |
| Stays inside the project | the sandbox mode the provider *reports* is the workspace-write one, not a silently downgraded read-only |
| Runs without prompting | a trivial prompt exits without waiting on input, within the profile timeout |
| Reports usage | the configured `usage_parser` finds real token counts in that run's output |
| Carries no bypass flags | already enforced; keep refusing at preflight |

Connection should fail with the specific missing capability, not a generic error,
and nothing should be written when the probe fails. Core returns those typed
capabilities through `config.inspect`; the desktop carries no provider-specific
capability catalogue of its own.

**Role names.** The client hardcodes `planner` and `manager`. Either Core should
report the roles it expects in `config.inspect`, or config should carry a
role→tool mapping. Today the only thing tying them together is a desktop test.

### Core-side copy — done

Three fixes, all in Core, all shipped on 2026-08-11.

**`plain_reason` is written where the cause is known.** The cause was being
thrown away at the point it was known: `decideOp` returned only a verdict, so by
the time anything wanted to explain a refusal the only material left was the
operation and the path. `decision.ts` now carries a typed `DecisionCause`
alongside the verdict, `plainDecisionReason` turns it into one sentence naming
the file, and `analyze.ts` writes `plain_reason` onto `patch.rejected` /
`patch.accepted` beside an untouched durable `reason`.

The real run on 2026-08-11 produced 11 events carrying both halves:

```
reason      : "all changes are within scope"
plain_reason: "Every file it changed was one this task was given."
```

That run was clean, so only the accept path was exercised on real data. The
refusal sentences are covered by `test/plain-reason.test.ts`, which asserts every
cause has a sentence, that it names the file, and that it contains none of the
vocabulary the client would refuse to render.

`plainTaskIssue` is **deleted**, not extended, and a desktop test asserts it
stays deleted. Note the shape of this by construction: `plain_reason` is written
when an event is produced, so the eight older trails in `docs/evidence` cannot
gain it retroactively, and they correctly still replay with the raw reasons.

**`taskAttentionTitle` leads with the title.** It only ever looked the title up
in the plan, so a run whose plan is not loaded composed "T-001 needs a revision"
beside a row reading "Initialize CLI package metadata and usage docs". The
durable status carries the title too, and is the wider source of the two. Where
neither knows a title — a trail with no `task.created`, which the m7-4 evidence
is — leading with the identifier is correct, because anything else is invention.

**Core says *ship*.** The language pass settled on *ship*; Core said *merge* in
the adoption readiness sentence, the run outcome detail and the failed-adoption
title. All three now say ship, and the readiness sentence no longer puts
"verified-set provenance" and "adoption" on the attention bar.

The client's containment guard (`src/lib/vocabulary.ts`) stays exactly as strict
as it was. It declines an unsayable sentence and falls back to wording chosen by
the item's typed `kind`; it never rewrites one. Core's copy improving is what
stops the guard firing — the guard does not relax to meet it.

### Actions with no way to reach them

Eight audited workspace actions have no control anywhere in the desktop. This
was re-swept on 2026-08-26 against direct React action construction plus the
Core-published queue actions consumed by Work. The exact set is asserted in
`desktop/test/seams.test.ts`, so another action cannot silently join it:

- `manual_task.review` / `manual_task.authorize` — manually authored tasks have
  no surface at all.
- `verify.characterize` — no way to ask for a characterization test.
- `quality.best_of_n` / `quality.draft_refine` — no way to start a second
  attempt from anywhere. `quality.cancel` used to be reachable from the tree
  tab, which was the wrong half to expose on its own; folding that tab in
  removed it rather than pairing it. `quality.cancel` itself is now also
  unreachable, including from the `quality_cancel_failed` item that says a
  cancellation did not take.
- `memory.review_handoff` — Project explicitly says "Review this in a
  terminal", while Core already returns the bounded local handoff command and
  no client caller asks for it.
- `accounts.add` — Accounts can select a registered account but cannot register
  the provider-owned account directory the action already validates.

A second attempt still shows on its task's card in the graph, so when a start
control exists it has an obvious home. These remain recorded gaps, not work
silently folded into the conversation-content repair.

### Waiting on Core

- **Durations.** There is no elapsed time anywhere, and "how long will this
  take" is the first thing a person asks during a run. A client-side ticking
  clock would be ambient motion and derived state; the clean version is Core
  emitting durations on events it already sends.
- **Raw error text leaking into a polished surface.** `plain-language.ts` maps
  known Core failures to plain sentences with a fixed regex list. Anything
  unmapped renders raw. The correct fix is a plain-language field on the daemon
  error, not a longer list of regexes here.

### The command palette needs a command registry

⌘K currently covers navigation, opening a project, and jumping to the composer.
The commands people would actually want — ship it, stop the run, review the plan
— live in the Work tab's state, and the palette lives in the shell above it.

Wiring them needs a small registry: the shell owns a command list, and each tab
registers and deregisters its commands as its state changes. That is the right
shape, and it is worth doing deliberately rather than reaching down into a
child's state from the shell. Until it exists, the palette should not pretend to
offer actions it cannot perform.

### Core tests must not assert desktop copy

`test/workspace-actions.test.ts` reads desktop source and, until recently,
asserted literal UI labels. That coupling is brittle in three separate ways:

- it breaks on every language pass, which is exactly the work this client needs
  most and the one thing the brief keeps asking for;
- when it breaks it *looks* like a Core regression, because it fails in Core's
  suite under a Core test name;
- it went undetected across three commits, because it lives in a suite the
  desktop work never runs — desktop iterates on `npm test` inside `desktop/`,
  and the Core suite takes eleven minutes.

The split that holds: **Core asserts behaviour** — that the client dispatches
only audited action types, that an affordance exists and is wired to the right
handler, that no mutation route or Core import crosses the boundary. **Desktop
asserts its own copy** — labels, plain language, and the absence of internal
vocabulary, in `desktop/test/thin-client.test.ts` where a language change and
its test move together.

If a Core test needs to know a control exists, it should match the condition and
the handler, never the words on the button.

### The two synthesized booleans, and what retires them

Everything in a replayed scenario is captured except two flags. Both are marked
in the scenario's own `source` field so the data admits it, and both are listed
here with the capture that would remove the need for them.

| Scenario | Synthesized | Everything else | Retired by |
| --- | --- | --- | --- |
| `<id>@ship` | that `inspectLatestAdoptionReadiness` would answer **ready** | the queue item is rebuilt field-for-field from the run's own `adoption.reviewed`: tasks, files, branch, base commit, both identifiers | a trail captured **while the ship bar is on screen** — i.e. an evidence folder whose `project-state/` is taken between `adoption.reviewed` and `adoption.execute`, rather than after the run |
| `<id>@review-*` | that the plan is **pending** rather than approved | the plan is the run's own ratified plan; the spec is a real drafted spec from `spec-drafting-vacuity.json`, with its real open question and real suggested non-goal | a capture taken at the plan review, before Approve is pressed — the state every first run passes through and no capture has yet stopped in |

Both have the same root cause and the same one-line fix on the next real run:
**capture `project-state/` at the decision, not only at the end.** A run that
pauses for a human is the only moment those two states exist, and the person
sitting at that pause is the one who can take the snapshot.

Neither flag can conjure an affordance. `@ship`'s item carries the real
`adoption.execute` payload it was recorded with, and `@review-*` leaves
`needs_you` empty; nothing in either invents a control or an authorization.

### Two states the corpus could not draw, and now can

Both were added to `tools/collect-replay.mjs` during the visual pass, because a
surface the brief asked to be judged could not be rendered from real data at
all. Both are marked in the scenario's own `source` field.

**`<id>@ship` — ready to ship.** `inspectLatestAdoptionReadiness` compares the
verified set against the *live* repository, and a scratch repository is not the
repository the run happened in, so a trail cut just before `adoption.completed`
projects as "the checks are stale" rather than "ready". The live run showed the
ship bar; the replay of the same trail could not. The queue item is now rebuilt
from the run's own `adoption.reviewed` event, field for field as `buildQueues`
builds it — real tasks, real files, real branch, real base commit. What is
synthesized is the *state*, that readiness would say ready.

**`<id>@review-blocked` / `@review-ready` — the one review.** No trail holds a
plan *awaiting* ratification either. These pair the run's real plan with a real
drafted spec from `docs/evidence/spec-drafting-vacuity.json`, including its real
blocking question and its real suggested non-goal. One boolean is synthesized:
pending rather than approved. `assumptions` is left empty because that
experiment predates the drafter writing them, and an invented assumption would
be exactly the theatre the experiment was run to detect.

**`empty-project`.** A real projection with its run-shaped fields cleared — the
same emptying `replay.html` already does before a playback's first frame. The
first thing anyone sees had never had a scenario.

### Verification debt

Every design judgement through five passes came from a fixture harness that
stubs the Tauri IPC and the SSE transport. `tools/collect-replay.mjs` now closes
part of that gap: it reads captured trails out of `docs/evidence` (never writing
to them), replays each into a scratch repository, and runs Core's real
`inspectWorkspace` over it, so `replay.html` drives the app against a projection
Core actually produced. That is still not a live daemon — no worker output, no
live leases, no spend — so treat both harnesses as instruments, never as
verification.

The harness can now be driven to a surface that needs a click, so a headless
capture can reach the map and the project record:
`/replay.html?scenario=<id>&view=map`, `&tab=project`. That lives entirely in
`tools/replay.tsx` — the app has no test hooks of its own. (Radix's tab trigger
activates on mousedown and focus, not on a bare programmatic `.click()`, which
is why the harness dispatches the whole sequence.)

#### What the evidence corpus does not contain

Across all eight replayable trails there is **no `plan.*` event, no `adoption.*`
event, and no routing, quota or resource event**. `task.started` appears exactly
once. So the two decisions the whole redesign is built around — approving a plan
and shipping a verified change — have never been rendered from real data, and
the spend meter reads zero for runs that cost real money.

The M10.8 concurrent run and the M8 end-to-end runs were retained as screenshots
and prose. Their durable trails — the 52-record M10.8 log, the 9-task E2E plan —
are not in the repository, so they cannot be replayed. Whatever process captures
evidence should keep the JSONL alongside the PNGs; a screenshot cannot be
replayed into a different UI, and the trail can.

**Closed on 2026-08-11.** `docs/evidence/e2e-2026-08-11-textkit` is a real run
driven end to end through the desktop app: one prompt, a plan review, an
approval, three workers in parallel, a dependent fourth task, and a ship. Its
trail carries `plan.*`, `adoption.*`, `routing.observed` and a completed run —
all four things this corpus had never contained — and it replays:

```
npm run replay:collect
/replay.html?scenario=e2e-textkit-parallel-run
```

So the plan review, the ship confirmation and the populated Project surface have
now each been rendered from real data. Two of the three were right the first
time; the ship card was not, and that is recorded above as the fifth instance of
the rebuild rule.

### Closed: a trail alone was never enough

The first replay of that run projected a **null plan and zero spend**, because
the plan, the ledger and the manager session are *files, not events*. That is
the whole reason the plan review and the spend meter had stayed fixture-only:
the corpus could not have drawn them however carefully it was replayed.

An evidence folder may now carry `project-state/`, mirroring `.hivemind/`, and
the collector restores it beside the trail. Captured, never invented — a folder
without one replays exactly as before. `config.json` is the one file merged
rather than copied, and only `resource_policy` and `execution`: `repo_root` and
the base branch belong to the machine that ran it.

Two things this immediately caught, both the "silently wrong UI" shape:

- **Spend rendered amber against the wrong ceiling.** 622.6K of real usage
  compared to init's 500K default, for a run whose real ceiling was 2.5M. A run
  comfortably inside budget drawn as nearly out of it.
- **No mid-run state existed anywhere in the corpus.** Every trail projects only
  to its end, so "three agents at once" — the thing the product is *for* — had
  only ever been a fixture, or a live screenshot caught at whatever instant
  somebody pressed the button. Both live captures of it landed inside an
  inspection-lag window and show "Waiting to start" beside three running tasks.
  The collector now also emits `<id>@midrun`: the trail cut at peak concurrency
  and projected by Core, which draws the honest state.

The mid-run cut is worth more than a screenshot. A finished run is the easy
state to render; work in flight is the one that has been wrong five times.

Still not drawn from real data: **populated memory** (this project learned
nothing), the **refusal half of `plain_reason`** (nothing was rejected), and
**mid-run lease state** (leases are released at adoption, so a post-run capture
cannot hold them).

`task.created` records `title`, `agent_role`, `base_commit`,
`acceptance_criterion` and `allowed_files`, but **not** `required_tests`,
`deterministic_validity_check` or `routing_task_type`. Core's own contract
validation refuses a contract rebuilt from the trail without them, which means
the durable log is not sufficient to reconstruct the workspace state it
describes. The collector fills only `required_tests`, from the command the
acceptance criterion names, and marks it.

### Client-side, not yet done

- **Responsive behaviour outside 1440×900.** Partly done: the rail is 300px
  below ~1100, 360px to ~1600, and 420px above it, and it disappears entirely
  when a run has no tasks. It is deliberately **not** hidden at narrow widths —
  the first attempt hid it below 1100, which takes the live output, the guide
  control and the stop control off the screen. That is a capability loss
  dressed as responsive behaviour. Still outstanding: at the 820px minimum the
  rail is cramped rather than collapsible, and a real collapse would need the
  inspector to have somewhere else to go.
- **Accessibility beyond the basics.** The task list is buttons inside sections;
  a listbox with roving focus is probably more correct. Keyboard traversal and
  screen-reader flow have not been tested on the redesigned markup.
- **Spacing drift has no guard, and needs a different instrument.**
  `design-tokens.test.ts` covers colour, token resolution and — since the
  mutation experiment — radius, because all three are declared as literals in
  `@theme inline`. Spacing is not declared anywhere: it is Tailwind's default
  scale, spent as utilities in TSX, so `px-3` against `px-3.5` is invisible to a
  CSS assertion no matter how it is written. Catching it needs **a lint over the
  markup** — scan the TSX for spacing utilities outside an allowed set, and for
  arbitrary values like `p-[13px]` — which is a different kind of test from a
  token contract and should not be bolted onto that file. Worth building if
  spacing starts drifting; recorded now so the gap is deliberate rather than
  assumed covered.

## Styling

Tailwind v4 (CSS-first, no config file) with the shadcn token set mapped onto
the logo palette in `src/styles.css`, so `npx shadcn add <x>` lands on the
palette with no edits.

### The design system, stated once — 2026-08-11

The whole system, so a future surface has something to conform *to* rather than
a set of examples to imitate. Everything below is enforced by tokens or by a
shared primitive; nothing is a convention held in someone's head.

**Radius.** 2px marks · 3px chips, inputs and keycaps · 4px controls and cards ·
5px panels · 6px overlays. Nothing above 6, and nothing is a pill. The scale
lives in `@theme inline` as `--radius-xs` … `--radius-3xl`, so `rounded-md` means
4px everywhere including in a component the CLI generates.

**Elevation.** Two shadows, and both belong to things that genuinely float
*above* the app: `--shadow-raised` (popovers, tooltips) and `--shadow-overlay`
(dialogs). **There is deliberately no `shadow-panel`.** A panel is separated by
its 1px rule and the canvas behind it. Deleting the token rather than agreeing
not to use it is what makes this hold: reaching for elevation in a layout now
requires inventing a shadow, which is visible in review.

**Rules.** One rule colour, `--rule`. There used to be a second lighter
`--rule-soft` for "inner" borders, which meant every surface had to decide which
weight it was — and they disagreed. It is deleted.

**Type.** 10px (segment names only) · 11px labels, counts, metadata · 12px
secondary · 13px body and controls · 14px primary rows and prompts · 15px panel
headlines · 17/20/22px dialog and surface headlines. Three tracking values are
tokens — `tracking-label` (0.07em), `tracking-tight`, `tracking-tighter` — so the
21 hand-written `tracking-[-0.015em]`-style values are gone.

**The label voice.** 11px, medium, `tracking-label`, uppercase, muted. Panel
headers, lane headings, field names. If a piece of text is a *heading* rather
than a label it is sentence case at 13px or larger. Setting the run's subject —
a sentence somebody typed — in the label voice shouted it, and that was caught
by looking at it.

**Figures.** Mono, and tabular by default: `code, pre, kbd, time, .font-mono`
carry `font-variant-numeric: tabular-nums` in the base layer, because every
figure in this app is read against another one. Hairlines separate readings on
an instrument line, not middots — a middot at 12px reads as punctuation inside
the number.

**Focus.** One treatment, declared once on `:focus-visible`: a 2px navy outline,
1px clear. No component brings its own ring. The one exception is the section
tab, which insets it, because a full-height tab outlined outside itself reads as
a floating box.

**Icons.** **lucide-react, and nothing else.** Its default stroke of 2 is drawn
for 20–24px icons and reads a weight too heavy beside 13px Geist, so
`svg.lucide { stroke-width: 1.75 }` normalises it once in the base layer. That
rule is the only hand-written rule in the app and it is deliberately a
normalisation of a third-party default, not a rule about a surface. It also
enforces the set: an icon from another library carries no `.lucide` class, so it
renders at the wrong weight and shows itself.

**The shared primitives.** `src/components/ui/panel.tsx` — `Panel`,
`PanelHeader`, `PanelLabel`, `PanelCount`. A panel used to be a class string
repeated in three files, which is three chances to disagree, and they did: the
Work rail, the Project record and the plan review each had their own padding,
header height and label style.

### What 21st.dev gave, and what it did not

Used as a source of proven structure, never as a style donor. Every component
was rewritten onto the tokens above before it shipped.

**Taken: `@originui/command`.** Two shapes this palette did not have — the search
row as a ruled header with a leading icon, and `CommandShortcut` as a real
`<kbd>` pushed to the right of a row, so the palette teaches its own shortcuts.
What had to be conformed:

| Arrived as | Shipped as |
| --- | --- |
| `@radix-ui/react-icons` magnifier — **a second icon set** | lucide's `Search` |
| `rounded-lg`, `shadow-black/5` | 4px/6px corners, one rule, no shadow |
| `ring-[3px]` focus | the one navy `:focus-visible` outline |
| `opacity-60` on icons | `text-muted-foreground` |
| 14px rows, `tracking-widest` shortcut text | 13px rows, mono keycap |

**Rejected: every tabs component in the catalogue**, including `@originui/tabs`.
They are all the lifted-pill shape this app already had, so taking one would
have changed nothing except which file the opinion came from. The section tabs
are hand-built as a navy underline on the chrome's own edge — four utilities,
and the toolbar reads as chrome rather than as a widget sitting on chrome. This
is the rule working as intended: a hand-built element that matches beats an
imported one that does not.

**Not searched for at all:** the agent tree, the four-phase task cards, the plan
review and the ship confirmation. Those are the product. No registry has them,
and a component that nearly fits one of them would be worse than nothing.

### What the audit had to fix

Run over every surface at the end of the pass, looking for anything that came
from somewhere else.

- **`shadow-panel` on 14 elements**, including every panel, the two header
  buttons and the plan cards. Removed with the token.
- **`--rule-soft` as a second border weight** in 9 places. Deleted.
- **Three `rounded-full` pills**: the connection dot, and both halves of the
  routing weight bar. The dot is a 6px square now, matching the task marks; the
  bar is a 3px square gauge, matching the spend meter.
- **Radii spread across 6, 8, 10 and 14px.** Now 2/3/4/5/6.
- **Two segmented controls with different mechanics** — the Story/Map toggle and
  the Highlights/Everything toggle were a tinted tray with a raised active chip;
  they are now one bordered, divided group with a navy-wash active cell.
- **Panel headers at three different heights** with three label styles. One
  `PanelHeader`, 36px.
- **`text-sm` (14px) inside the dropdown menu** against 13px everywhere else,
  plus Tailwind's default `shadow-md`/`shadow-lg`, plus 16px icons.
- **Two dialog header paddings** (`px-8 py-6` and `px-6 py-5`) across four
  dialogs. One.
- **A leading hairline** on the run header's instrument line whenever the first
  reading was absent — each reading carried its own separator. `MetaLine` now
  collects what is present and interleaves after.
- **The task row's phase gauge sat directly under the title**, where it read as
  an underline of the title rather than as a gauge. It is at the foot of the row.
- **The map card said its phase twice** — once in the named segments, once in a
  summary line underneath. The line is gone and the count moved to the footer.

### The three surfaces that changed shape, and why

Structure is unchanged; these are the same components rendering the same data.

**The run thread is no longer a chat.** The request was a right-aligned bubble,
which put the one thing the person actually wrote on the far right of a 900px
column and left the left half of the panel empty. It is a quoted block on the
same left edge as everything else, marked by a navy rule. Milestones are a log:
a fixed mono time gutter, a continuous hairline, a square node. The Work tab is
a record of a run, and it should not have looked like a messaging app.

**The idle board is no longer a hero.** A 32px headline broken across two lines
over a paragraph is a marketing page. It is 22px, and the product's whole shape
is stated as two numbered steps against a rule — which is more information in
less space, and is the thing a first-time user actually needs.

**Project runs are a record, not cards.** Rows are flush to the panel, separated
by one rule, with the date fixed in a mono gutter so a stack of runs reads down
a single column.

### Deliberate exceptions

- **`ui/empty.tsx` stays verbatim and stays centred.** It is the standing proof
  that a CLI-generated component lands styled with no manual conversion, so
  editing it would destroy the thing it exists to prove. Its centred block is
  also the right shape for a single empty state inside a panel — the ban on
  centred symmetry is about page layouts, not about one block.
- **The brand mark is drawn, not iconographic.** Two interlocking hexagons in
  the two identity colours, reduced from `Branding/Icon Only White Backround.png`.
  It replaced four rounded squares in a grid, which was both generic and,
  literally, four cards in a grid.

### Round two: four things that looked like style and were arithmetic

Every one of these was reported as "this looks wrong". Three were, and the
fourth was a capture serving state from the wrong moment. Recorded because the
shape keeps repeating: **a surface that looks broken is worth diagnosing before
it is worth restyling.**

**The run's duration was measuring the buffer, not the run.** `runSpanMs` took
the first and last timestamps in the replayed event buffer. The textkit trail
opens with an `autonomy.level_changed` twenty-six minutes before anybody typed
anything, so a six-minute run reported **"took 30m 43s"** and its mid-run cut
reported **"took 26m 27s"** — numbers made almost entirely of the time somebody
spent in settings. The window now starts at the newest `plan.prepared`, which is
the event carrying the request the thread leads with; a trail with no plan keeps
the whole window rather than inventing a boundary. Three tests cover it,
including a trail carrying two runs.

**"Took" on a live run was the capture, not the clock.** The client reads
Core's `manager_session.status` to decide whether a run is live, and
`project-state/` is captured *after* the run — so a trail cut mid-run was served
a session reading `complete`. Core derives that status from the session's own
pending actions, so rewinding the file would mean inventing a scheduled action,
and an invented action can surface an approval control. The enum is corrected on
the projection instead, only for a cut that reaches no terminal event, with
`pending_action` and `continuation_available` untouched. See "the capture is not
wrong, it is later" below.

**"0 files changed" over a commit that changed eight was real, and the trail was
right.** `adoption.completed` in that trail genuinely has no `changed_files` —
it is the pre-fix shape, exactly as the evidence README says. The defect was the
client's: `readStringArray(...) ?? []` collapsed *absent* into *empty*, and the
card stated the second. This is the standing rule about silent catches, arriving
through a `??` rather than a `try`. `changedFiles` is now `string[] | null` and
the card says the record does not list them. The ship bar was always right
because it reads `adoption.reviewed`, which does carry the field.

**"Files being edited — 0" beside three agents holding two files each** was the
same capture problem as the manager session, and this half *was* reconstructible.
See below.

### Standing rule extended: the capture is not wrong, it is LATER than the cut

"Capture the trail AND the project state" was written for state that was
*missing*. The mid-run cuts found the other direction: state that is **present,
captured, and from after the moment being replayed**. A finished manager session
and an emptied lease store were both rendered as fact over a live run.

> **A cut trail must not be handed the run's final file state.** Ask of every
> restored file: is this the same at the cut as at the end? If not, either
> rebuild it from the trail or say the scenario cannot draw it.

The lease store rebuilds cleanly, because `lease.approved` records what was
granted and `lease.released` gives it back — replaying the pair to the cut point
reconstructs exactly who held what. It is written to
`.hivemind/leases/active.json` and read back through Core's own
`readActiveLeases`, so the reconstruction has to satisfy Core's validation to
appear at all. `@midrun` now shows three agents holding two files each, which is
what the live run showed and what the corpus never could.

That is the *trail must be able to rebuild the state* rule paying out: the
events carried enough, so the state came back.

**Still later than the cut, and not rebuildable: the spend ledger.** `@midrun`
shows "5 calls · 622.6K", which is the whole run's bill on a trail cut when
three of five calls had been made. Unlike leases, this cannot be reconstructed:
`resource/ledger.json` is a file and the trail carries no per-call resource
event to replay. Retired by the same capture that retires the two synthesized
booleans — `project-state/` taken at the pause rather than at the end — or by
Core emitting a durable event per call, which would make the ledger rebuildable
the way the lease store now is.

### The rail now draws the map's gauge, because it is the same fact

The rail's four segments were unlabelled grey underlines. The map's are named —
Queued / Editing / Checked / Ready — with the current one in the standing's
colour. Same data about the same task, told worse on the surface people look at
most, and it read as a rendering bug.

`PhaseSpine` is exported from `agent-map.tsx` and the rail renders it, with the
count beside the identifier exactly as the map's card footer does. One
component, so the two cannot diverge again. Note the colour source: the spine is
coloured by `phase.standing` and never by the queue, which is the rule already
recorded above — how far a task *got* is its state and nothing else.

### The empty state was the largest thing on screen

During a live run the inspector held "Nothing from this agent yet" over ~450px
of white, in the exact place the product's claim is strongest. The rail's grid
gave the task list `auto` and the inspector `1fr`, so the panel with nothing to
say got all the leftover height.

Inverted: the list takes the height, the inspector hugs what it has. And an
agent that has said nothing is not an agent doing nothing — with leases restored
the panel now says what it is holding, and opens the file list by default when
it holds anything.

### Progress through phases, not through finished tasks

The rule under the run header was driven by completed count, so it sat at 0% for
the whole first wave of a run — three agents working, and the one ambient-free
progress signal in the app showing nothing having happened. It is now the sum of
cleared phases over the total, which moves every time any task clears one. The
`n/m done` figure beside it is unchanged and still correct; what was missing was
motion, not a different number.

### A disabled control is never filled

"Start building" sat over an empty box as a filled navy button at 45% opacity,
which still reads as pressable. The filled variants now drop to the canvas with
a rule when disabled; the quiet variants keep fading. One rule in
`buttonVariants`, so no surface decides this for itself.

### Confirmed, not fixed: `rejected add src/ledger.js`

Checked rather than assumed, because the client rewriting Core's strings is a
mistake this file already records three times.

- Core's `plainEvidence` (`workspace-inspection.ts`) reads
  `plain_reason` **first**, ahead of `report`, `reason` and `recommendation`.
- `analyze.ts` writes `plain_reason` beside the durable `reason` on
  `patch.rejected` / `patch.accepted`.
- The client renders `task.issue` and `item.detail` verbatim. The containment
  guard leaves this string alone correctly: it carries no banned vocabulary, it
  is simply terse gate output.
- `final-run-transcript-4`, the trail that produces this string, contains **zero**
  occurrences of `plain_reason`. It predates the field.

So the client is deferring correctly and will light up with no change the moment
a rejection happens on a current Core. It has not been *observed* doing so,
because no captured trail contains a rejection carrying the field — which is the
corpus gap already listed under "the refusal half of `plain_reason`".

### The guard that could not fail, and what the guard can actually reach

`test/design-tokens.test.ts` asserted

```js
expect(styles.indexOf("@layer theme, base, legacy, components, utilities;"))
  .toBeLessThan(styles.indexOf('@import "tailwindcss"'));
```

The `legacy` layer went with `legacy.css`, so `indexOf` returned `-1` — and `-1`
is less than any real index. **The assertion passed because the string it looked
for was gone.** Fixed: both halves are asserted now, that the declaration exists
and that it precedes the import.

**Then the whole file was mutation-tested**, because one vacuous assertion is
evidence about the file, not about one line. Each mutation was applied to
`styles.css`, the suite run, and the file restored:

| Mutation | Before | After |
| --- | --- | --- |
| `--amber` → `#ff9900` | fails | fails |
| `--color-muted-foreground` removed from `@theme` | fails | fails |
| `--primary` repointed to `--clay` | fails | fails |
| `@layer` declaration deleted | **passes** | fails |
| `--radius-md` 4px → 9px | **passes** | fails |
| `--radius-3xl` 6px → 24px | **passes** | fails |
| `--radius-sm` deleted | **passes** | fails |

So the answer to "can it catch radius drift" was **no**, and it is now yes: the
radius scale is declared as literals in `@theme inline`, which makes it exactly
as reachable as colour. Every `rounded-<x>` in the app resolves through one of
six names, so asserting those six is a complete guard, and the "nothing above
6px" check catches a pill arriving through a token rather than a class.

**Spacing is out of reach for this file, and should stay out of it.** Spacing is
not declared in CSS at all — it is Tailwind's default scale, spent as utilities
in TSX (`px-3` against `px-3.5`). A CSS assertion cannot see it. Catching that
drift needs a different instrument: a scan of the TSX for spacing utilities
outside an allowed set, which is a lint over markup rather than a token
contract. Worth building if spacing starts drifting; not worth pretending this
file covers it.

### The token contract, and why it has a test

A shadcn component is styled *entirely* through the semantic token names. A
token that is missing does not fall back to something reasonable — it generates
**no CSS at all**, and the element renders unstyled. That failure is silent:
the class is on the element, it just does nothing.

This had already happened. `--muted-foreground` was declared in `:root` but
never exposed in `@theme inline`, so `text-muted-foreground` — the most common
text utility in generated components — emitted nothing. It was live in three
components already shipped: the command palette's group headings, input
placeholder and shortcut hints; the dialog description; the dropdown menu's
icons and shortcuts. All of them rendered at full `--ink` instead of muted.

The cause is a name collision worth remembering. shadcn's `muted` is a **pair**
— `--muted` is a *surface*, `--muted-foreground` is *text*. The logo palette's
Muted (`#667085`) is a text colour, and it had taken the surface's name. So
`bg-muted` resolved to a dark grey block, and the text half was never mapped.
The fix maps them separately (`--color-muted` → Surface, `--color-muted-foreground`
→ Muted) and renames the app's own `text-muted` to `text-muted-foreground` —
87 occurrences, identical rendered colour, and it aligns the app with the
vocabulary the CLI emits rather than fighting it.

`test/design-tokens.test.ts` asserts every token a generated component can
reference is present in `@theme inline` **and** resolves to the palette value it
should. Adding a token to `:root` alone will not satisfy it, because that is
exactly the mistake that was made.

**Chart tokens are deliberately absent**, and the test asserts their absence so
it stays deliberate. `--chart-1` through `--chart-5` need five mutually
distinguishable hues; the palette has two colours that carry meaning and none
that are decorative. A chart component needs a palette decision first, and
should fail visibly rather than silently pick something.

- **Panels on a canvas.** Content lives in rounded panels with real padding on a
  `--canvas` ground. Grouping comes from the container, not from a grid of
  full-bleed rules.
- **Palette.** Navy and charcoal are the identity. Amber and clay appear *only*
  where they carry meaning (needs attention, failed). No other hues, no
  gradients.
- **Motion reflects real events.** The run-progress rule moves when a task
  finishes. `.artifact-marker` is the only animation in the app: it fires when
  the live stream reports a change clearing a phase, plays once, and is an
  *overlay* on an already-filled segment — which is what lets reduced motion
  hide it outright and leave the segment underneath still correct.
- **`src/legacy.css` is gone.** It served the three tabs that no longer exist,
  so the `@layer legacy` quarantine went with them. Every surface is
  utility-only; there is no longer anywhere to put a hand-written rule.

### The acceptance test, re-run this pass

`npx shadcn@latest add alert` produced a component that rendered styled with
**zero manual class conversion and zero config edits**, and every utility it
referenced compiled to real CSS resolving to a palette value (`--destructive` →
`--clay` → `#b65b4f`, `--muted-foreground` → `--muted` → `#667085`). The probe
was removed. `empty` was added the same way and **kept**, so the app now carries
a verbatim CLI-generated component as standing proof of the contract — if the
token mapping regresses, it renders unstyled and `test/thin-client.test.ts`
fails.

### A test with no viewport cannot fail on overflow

The provider restructure made the setup screen tall. Its `ScrollArea` carried
`min-h-0` and nothing else, which gives a flex child no height at all: it grew
to its content, and the app shell's `overflow-hidden` clipped the remainder with
nothing to scroll. Measured after the fact at 1440x900 it hid **416px**, at
1366x768 **548px**, at 1280x720 **596px** — the page stopped mid-way through the
role assignment and a new user could not finish setup. First screen after the
daemon block, and a hard stop.

The desktop suite had 211 tests at the time and not one of them could have
caught it. They render into an unbounded container, so overflow does not exist
there: the markup is present, every assertion about it passes, and a control
clipped below the fold is indistinguishable from one you can press.

> **A test that cannot see the constraint cannot fail on it.** This is the
> instrument rule again, and the seventh instance: an absent-string assertion, a
> no-hazard confinement test, a shell-less preflight, a timer-based screenshot
> harness, a judge visible to the judged, five fixture-only UI passes — and now
> a whole suite with no viewport.

The verification was worse than absent, it was misleading. The cold-open walk
asserted on `document.body.innerText`, which returns clipped text exactly as
readily as visible text. The walk read the entire setup screen, reported every
step present, and could not have noticed that half of it was unreachable.

**The evidence set was not hiding it by being generous.** The screenshots are
1416x808 — *smaller* than the 1440x900 they were captured at, so nothing was
concealed by a taller-than-real viewport. The class was hidden for a duller
reason: the setup screen was never in the evidence set. All three shots are Work
and Project, both of which were and are fine.

`tools/check-reachable.mjs` is the instrument that has the constraint. It loads
each surface at 1280x720, 1366x768 and 1440x900 and asks one question per
control: scroll it into view, then is it inside the viewport? A control that
cannot be scrolled to cannot be pressed. It opens the dialogs too, because a
dialog does not exist until it is opened and an Approve button below the fold is
this bug on the surface that authorises a change.

It was written before the fix and run against the broken build first, which is
the only way to know an instrument can fail. Two things fell out of that run
that reading could not have found:

- the harness was checking the Work tab three times over and reporting it as
  "setup", because an effect redirected the `?section=` deep link whenever a run
  existed. An explicit request is not something a default may overrule;
- the replay's captured settings predated the provider restructure — `providers:
  0, models: 0` — so the surface it rendered had no provider cards and could not
  have been tall enough to fail. **A fixture is a claim about what the data
  looks like, and that one had quietly become false.**

The suite keeps a narrow structural companion for the exact regression, and only
that. The first version swept every `ScrollArea` and immediately flagged the task
board, which is `min-h-0` inside a `Panel` whose grid row already bounds it — a
regex over class names cannot see the parent, so it cannot tell a bounded
`min-h-0` from an unbounded one. Widening the pattern until that false positive
went away would have produced a test that passes on the bug as well.

> **A shape ban cannot express a structural rule** — the same lesson the word
> bans keep teaching, in a different costume.


### An assertion that reads the DOM is not an assertion about what a person can see

The seventh instrument instance, and the first where an entire suite lacked the
constraint rather than one assertion being vacuous.

The cold-open walk drove the real app, clicked real controls, and asserted on
`document.body.innerText`. That call returns text that is clipped, scrolled out
of view, or sitting under an `overflow: hidden` with nothing to scroll — exactly
as readily as text a person can read. So the walk read the entire setup screen,
reported every step present, and **passed on a screen half of which was
unreachable**. Not a near miss: it reported success on the broken state, and
would have gone on doing so indefinitely.

> **Presence in the DOM is not visibility, and visibility is not reachability.**
> A test that queries markup is answering "did this render", which is a
> different question from "can somebody get to it".

The general form is worth keeping because it is not about `innerText`
specifically. `querySelector`, `getByText`, `toBeInTheDocument` and every
snapshot are the same assertion wearing different clothes: all of them pass on a
control nobody can press.

**The suite still cannot catch this class, and adding tests to it will not
change that.** It renders into an unbounded container, so overflow does not
exist there. That is a property of the environment, not of how many assertions
are written in it.

`npm run verify:reachable` is the only thing that can. It builds the replay with
Vite's production transform, serves that output under the exact committed Tauri
CSP, loads each surface at 1280x720, 1366x768 and 1440x900, scrolls each control
into view and asks whether it landed inside the viewport, and opens the dialogs
rather than only navigating — a dialog does not exist until it is opened, and
an Approve button below the fold is this bug on the surface that authorises a
change. It also checks decoded image dimensions and browser resource/console
errors. That second half is load-bearing: a dev server loaded provider SVGs that
the production build inlined as `data:` URLs and the installed CSP blocked.

The CSP stayed narrow. Imported assets are emitted on `self` by setting Vite's
inline threshold to zero; allowing `data:` would loosen a security boundary for
cosmetic content. Mutation-testing the instrument by restoring the old inline
threshold made it fail on all five provider marks with both zero natural size
and explicit CSP violations.

### Provider identity, project checks, and compact relief

Three visual ideas sit beside each other in the provider row and must not be
collapsed into one treatment:

- the provider mark is identity. It keeps the provider's own colour or
  monochrome artwork and takes no app gradient, tint, shadow, or invented tile;
- the status text is evidence. Product-wide “proven end to end” and a current
  project's “checked here” are different facts and are now rendered as such;
- the checkbox is an action. It uses the same-hue navy ramp and the shared
  raised/pressed token pair, enlarged from 16px to 18px so its rim, base and
  contact shadow survive native-scale rendering.

The completed step mark remains flat because it reports state rather than
answering a press. “Choose another” is an outline action and now uses the quiet
control ramp and relief: it answers a press, while the pale fill keeps it from
competing with the filled primary. Provider marks remain identity rather than
controls, so they still take no app tint, tile, gradient or shadow.

The outline action now opens a chooser with both ways people actually locate a
project: a native folder browser first, and a manual full-path field beneath it.
The native route belongs to the shell, not React. Its custom command returns a
path and grants no dialog-plugin permission to the webview; the existing
project-selection command remains the only path that validates and opens the
folder. Browsing is presentation, not a second project authority.

An untracked folder is not automatically safe to turn into a repository. The
shell already inspected the proposed first commit and refused dependency trees,
build output and likely secrets; the screen did not call that command, so it
offered an action the shell was guaranteed to reject. The rejection was then
dropped by an unobserved promise. Readiness is now requested before the action
is offered. React renders the shell's structured answer and owns no git gate:
safe folders get the raised “Start tracking” action, unsafe folders get the
plain-language refusal and “Choose another folder,” and a late action failure
is visible as “Nothing changed” with its reason. The later “Set it up” step is
also disabled while git is unresolved; it is not a second route around the
same prerequisite.

Known generated directories are not a question for the person after all. When
the only problem is a closed-list dependency or build directory (`node_modules`,
`dist`, `target`, and their peers), the same raised action becomes “Set up git
for me.” The shell appends exact top-level rules to `.gitignore`, initializes
git, verifies every directory is ignored, stages the remaining files, and makes
the first commit. Any failed verification stops before staging. Secrets, loose
binaries, and non-empty folders with no recognisable source still refuse because
ignoring those would require judgment rather than preparation. A truly empty
folder is different: it is a valid greenfield project with nothing to inspect or
accidentally commit. The one-click action initializes Git and creates an explicit
empty base commit; it never invents a placeholder source file merely to satisfy
Git.

The update bar follows the same rule. A recheck sets “Checking…” before the
round trip and, when the answer is identical, leaves “Checked again just now;
the result did not change.” A fast request or an unchanged failure can no
longer make a real click look inert.

### A public updater channel is a release invariant — 2026-08-18

An HTTPS URL in configuration is not an update channel. The repository was
private and the stable GitHub Releases URL returned 404 to every installed
client; source tests could prove only that the URL existed. The repository is
now public, and publication is one fail-closed command: prepare the signature
and manifest, create a draft release, upload both assets, publish only after
both succeed, then fetch them anonymously through the configured endpoint.

The remote guard compares the returned version to the exact locally stamped
build. That last comparison matters because a valid older manifest is still a
failed release. Public asset names contain no spaces because GitHub normalizes
spaces during upload; the manifest must name the served asset, not the local
installer filename. Release tags are never reused, because a CDN may continue
serving an earlier deleted asset at the same tag URL. These were observed
failures, not speculative rules.

The provider selection is genuinely plural now. Continue builds a deterministic
plan that gives every selected, connectable provider at least one real worker
probe and fills every empty role; a regression test proves a second selection
cannot disappear behind the first. Kimi is visible but disabled because there
is no complete usage reader/invocation yet. Its absence is named instead of
turning a click into a guaranteed paid failure.

So it has to be run. Before shipping a surface that grew, and after any change
to a layout that bounds one. The suite going green is not evidence about this
class and never will be.

### Reduced motion must change the report, not erase it

The universal reduced-motion rule used to collapse every animation to one
0.01ms iteration. That is valid for decorative entry and exit effects and was
over-applied to functional spinners: a still glyph became the entire report of
a multi-minute build. The global rule now collapses transitions and named
decorative effects; functional indicators choose their reduced presentation.

For source updates, the spinner may remain still. The adjacent report changes
on factual build output and ticks elapsed seconds, so two captures three seconds
apart differ without motion. Source output has ordered stages but no defensible
total, so it never gets a percentage. Release downloads do expose downloaded
and total bytes through the updater callbacks, so only that route may render a
real percentage. React displays those shell facts and owns no gate or update
decision.

### A record older than a field is a permanent input

Three crashes in one session, all the same bug:

| Field | Surface it took down |
| --- | --- |
| `ChecksView.provenance` | the ship moment |
| the accounts view's `roles` | the Project tab |
| `config.task_type_routing` | the settings dialog |

Each read a property straight off a value that was absent because the record
predated the field. Each was found by replaying a real or older trail rather
than by a test. None was a near miss — all three took the whole surface down.

Trails are durable by design and the architecture rests on rebuilding state from
events written months ago, so **there is no future in which the client only sees
records from its own version**. Records that predate a field are not a migration
to finish; they are an input that will always exist.

The types were the bug. `task_type_routing: Record<string, …>` is a claim that
the field is always present, so TypeScript correctly allowed indexing it. The
type described the code that writes records today, not the records that exist.

The mechanism is therefore the type system rather than a convention:

> **Every collection-valued field on a daemon response is optional to the
> client.** Absent is a value it will really see.

`strict` is on and `tsc --noEmit` gates the ship path through `bundle:prepare`,
so a direct `.length`, `.map()` or `[key]` on one of these is now a build error.
Verified by reverting one call site and watching the build fail on it, because
an instrument nobody has seen fail is not an instrument. `src/lib/durable.ts`
holds the single path — `list`, `table`, `present` — so no caller invents its
own default.

Scoped to collections deliberately. An absent scalar renders as a blank, which
is cosmetic; an absent array or object is dereferenced and takes the surface
down. Covering both would be noise around the part that has actually bitten.

**Same family as the schema-migration convention, one layer out.** Core has 21
modules declaring `version: 1` and hard-failing on anything else — present,
inert, and hypothetical, because no format has ever reached version 2. This is
that problem on the client, except the records are already in the wild, the
versions already differ, and the failure has already happened three times. The
difference in posture is deliberate: Core refuses a format it cannot read
because acting on a misread contract is unbounded, while a surface reading a
missing field degrades to the empty case, since refusing to draw a settings
dialog is worse than drawing one with nothing chosen yet.


### The version scheme was broken for ten hours of every day

`npm run ship` refused at 09:24:

```
failed to parse config: `tauri.conf.json > version` must be a semver string
```

The calendar stamp built its last field as `${pad(hours,2)}${pad(minutes,2)}`,
which before 10am produces `0924` — and a semver numeric identifier may not
carry a leading zero. So between midnight and 09:59 the app could not be built
at all.

Every build in this project's history had happened after 10am. The scheme was
broken for **ten hours of every day** from the moment it was written, and
nothing had ever run in them.

> **A bug that only fires inside a window nobody has worked in is invisible
> until somebody works in it.** It cannot be found by reading, because reading
> is what produced it; it is found by doing the thing at a different hour.

`hours * 100 + minutes` fixes it: monotonic within the day (5, 924, 2359),
still under the 65536 the Windows version resource imposes, and no leading zero
because a number has none. The month/day field never needed the care, since a
month is never zero.

`packaging.test.ts` now stamps every hour of the day against a semver pattern
and checks the sequence still increases — and asserts the shape that shipped
FAILS that pattern, because an instrument nobody has seen fail is not an
instrument.

### The dev loop closes itself

Three rounds were lost to one sequence: a commit lands, the app is opened, and
the app is the previous build. `install:local` existed the whole time and
verifies that it took. It did not help, because **the step that fails is
remembering to run it**, and a fix whose first requirement is remembering is not
a fix for that.

So the app answers the question itself. When the open project is Hivemind's own
source — checked by reading the identifier out of its `tauri.conf.json`, not by
the folder's name — it compares the modified time of the binary it is running
against the newest of the repository's `HEAD` commit time and the newest file
under the directories a build actually reads.

Not versions. A version string only says what the last build *claimed*, and the
failure being closed is a build that never happened.

Two acts, not one. Windows holds a running executable locked, which
`install-local.mjs` already names as the usual reason an install silently does
not take — so the build runs while the app is open, and the swap happens on the
way out: a detached helper waits for this process to exit, installs, and starts
the new copy. Presenting that as a single button that quietly ends the session
would hide the thing actually happening.

Guarded by the same idleness proof as the daemon restart, read off disk rather
than asked of the daemon. Rebuilding mid-run is harmless and restarting the app
is not the danger either — the daemon outlives app close by design. The danger
is restarting into a new build while a run is live and losing track of which
build produced which result. If anything is in flight, the bar says so and
offers nothing.

Detection is automatic; the act is a click. Rebuilding costs minutes of CPU and
installing replaces the running binary — neither is something to do to somebody
who did not ask for it.


### The mechanism exists and nothing asks it

A third failure family, distinct from the two already named. It is not the
instrument family — an assertion that can only return one answer — and not the
rig family — a measurement of something other than what you think. It is:

> **The mechanism exists, is correct, is tested, and nothing consults it.**

Three instances, all found in one week and all of which passed review looking
finished:

| Instance | What existed | What was missing |
| --- | --- | --- |
| `provider_version` | Written onto every connection record | Never compared, so a self-updating harness silently invalidated its own verdict |
| `daemon_instance_id` | Recorded on every reservation, shape-validated | Never filtered on |
| `compareAdapterVersion` | Written and unit-tested | Imported by nothing but its own test — the check had never once run |

**Review cannot catch these.** Every one looks right in a diff: the field is
populated, the function is covered, nothing is absent. The absence is somewhere
else entirely — in the call that was never written. That is what makes this its
own family rather than carelessness.

#### Half of it is mechanically detectable

`tools/audit-unreached.mjs`, wired as `npm run audit:unreached`, finds an
exported function that no production module imports and that is not called
inside its own file. That is exactly instance 3.

Building it took three passes, and the failures are worth keeping because they
are the same lesson again:

- **Word matching reported 445 dead exports**, including `invokeAgent`. Any
  function whose name appears anywhere — a comment, a string — counted as used.
- **Static imports only reported the whole CLI as dead.** `cli.ts` reaches every
  subcommand through `await import()`.
- **A greedy `[^}]*` swallowed whole blocks** into the capture, so it found nine
  dynamic imports in `cli.ts` and extracted none of the nine names.

Each version looked plausible and returned confident nonsense. The measurement
that made it usable was checking the output against functions known to be live.

It also distinguishes a genuinely unreached mechanism from a merely over-broad
`export`: `plainReason` and `createDaemonServer` are both called inside their
own files, so the function is live and only the export is wider than needed. 18
unreached against 70 over-exported — collapsing those two would have made the
result useless.

**It reports rather than fails.** The remaining 18 include entry points reached
by dispatch, and a check that failed the build on those would be one whose first
response is to loosen it until it stops — which is how the word bans went wrong
four times.

#### The other half is not

An unread FIELD — instances 1 and 2 — is not decidable by grep. Property access
is dynamic: `record[key]`, destructuring, spreads, and `JSON.parse` results read
through an index signature. A checker would produce both false positives and
false negatives, and a checker that is wrong in both directions about a safety
property is worse than none.

The next-best guard, where the field's misuse would be dangerous, is **a test
that asserts the field is NOT consulted**. `daemon_instance_id` now has one:
scoping the ceiling by instance would hand out a second full budget after every
daemon restart, so a test proves the ceiling counts across instances, and the
declaration says why the obvious tidy-up is a bug. That converts a silent
write-only field into a stated decision — which is the actual remedy for this
family, since the problem was never the field but the silence around it.

## UI consistency is a rendered contract — 2026-08-17

The consistency pass found four ways a shared component could still disagree
with itself on screen: callers overrode Button height and padding; identical
Panel headers replaced their primitive's fill five times; selection cards,
chips, segments and pane toggles each recreated the same state; and framed
dialogs used two gutter systems. The temporary theme workshop amplified every
one by allowing production tokens to change from local storage.

The closed ownership is now:

- `Button` owns command height, padding, type, radius, gradient, and relief.
  Callers may position or constrain it, but visual overrides fail
  `ui-consistency.test.ts`.
- `SelectionControl` owns selected wash, pressure response, radius, gradient,
  and spacing for cards, chips, segments, panes, graph nodes, lanes and file
  rows. Its quiet ramp expresses pressability; navy wash separately expresses
  selection. It never borrows a primary command's strength.
- `PanelHeader` owns its height, fill, rule, and horizontal gutter. Callers do
  not restyle it.
- Framed `DialogContent`, `DialogHeader`, and `DialogFooter` own the zero-gap
  shell and one header/footer gutter rhythm.

Source enforcement is necessary and insufficient. `verify:reachable` now
groups visible production primitives by variant, size, icon state, selection
and disabled state, then compares computed height, padding, gap, type, radius,
border, fill, gradient, colour, and shadow. The rendered check caught an
inherited line-height difference on its first run; it was fixed in the Button
primitive. A shared class that renders differently now fails the same
production-bundle path used for viewport and CSP verification.

Build `26.817.1941` was installed and inspected at 1440×900 on both the Work
surface and the loaded Settings dialog. That screen-level check confirmed the
closed component ownership above and the absence of the deleted theme
workshop; source and replay results were not accepted as substitutes for it.

### The interaction system is closed at every scale — 2026-08-18

The installed audit found the remaining inconsistency after the first pass:
only filled Button variants carried the construction people recognized, while
outline/ghost/link Buttons, tabs, selection controls, and eleven raw `<button>`
call sites remained separate visual systems. The fix closes both routes:

- `--relief`, `--relief-compact`, and `--relief-micro` each have a paired
  all-inset pressed token. Large controls travel 2px; compact and micro controls
  travel 1px. Shadow values no longer live in `pressable.tsx`.
- every application-owned button now routes through `Button` or
  `SelectionControl`; `ui-consistency.test.ts` rejects a new raw `<button>`;
- tabs, checkboxes, radios, switch thumbs, selection controls, and Button
  variants all use the same vertical, derived-hue lighting contract;
- `verify:reachable` now compares rendered tabs and pressables as well as Button
  and SelectionControl groups.

The background follows the same palette without pretending to be elevation.
`--canvas-atmosphere` is two broad, low-strength navy/clay radial fields over a
vertical canvas ramp. The React root consumes that token directly—body-only
styling had been painted over—and substrate panels are 88% opaque so the field
can be seen without sacrificing text. There is no backdrop filter, no ambient
animation, and no new elevation level.

Build `26.818.856` was built, installed, verified against the binary on disk,
and inspected at a 1440×900 client size. The Work surface proves the large,
row, tab and icon treatments plus the live substrate; Settings proves the
compact provider-role controls. Evidence is in
`docs/evidence/ui-consistency-installed-26.818.856/`.

Final verification passed Core 815/817 with two intentional skips, Desktop
298/298, Rust 32/32, and all 24 production surface/viewport checks.

### The reference is the ceiling, not a starting point — 2026-08-18

The installed correction above was rejected on screen. Its quiet controls were
near-white on a white canvas, while five or six simultaneous shadow terms made
them read as extruded slabs. The supplied reference measures approximately
`#425c85` at the lit face and `#0e2140` at the bottom, followed by one dark edge
and a short soft falloff. That is now the standard:

- quiet controls alias the reference navy ramp instead of a near-white wash;
- resting relief has exactly two terms: one restrained top reflection and one
  short contact shadow; compact and micro scales keep the same construction;
- selected cards receive no elevation token because selection occludes nothing;
- enabled navy controls own descendant foreground contrast, and the production
  reachability run fails on dark caller text inside them.

Build `26.818.931` was built, installed, and verified against the binary on
disk. All 24 production surface/viewport checks passed, including the new
descendant-contrast guard. The installed Work and Settings surfaces were then
captured at a 1440x900 client size. Those captures show the measured navy face,
short contact shadow, and inherited white foreground at native scale; they are
recorded in `docs/evidence/ui-reference-correction-installed-26.818.931/`.

### Relief is permission, not a universal interactive style — 2026-08-18

The installed screen exposed a more fundamental error than the gradient values.
The rule says that only a control which answers a press **may** claim relief; it
does not say every interactive element must become the same raised button. The
implementation had made that substitution in two conspicuous places:

- `TabsTrigger` turned the Work, Agents, and Project navigation back into the
  lifted pills this document had already rejected in favour of an underline on
  the chrome edge;
- the three example prompts were routed through the raised `Button` row variant,
  making lightweight suggestions compete with committed actions.

The next visual pass is therefore an overhaul of presentation hierarchy, not a
stronger version of the same effect. Explicit command actions may retain the
navy relief; navigation, suggestions, and selection rows use flat state devices
such as underline, fill, rules, hover, and focus. Structure, copy, dispatcher
paths, and authoritative state remain unchanged. The grounded design context is
recorded in `.21st/design.json`; production implementation is gated on choosing
one of the explored visual directions.

### Precision Instrument is visual language, not layout — 2026-08-19

The selected direction changes only Hivemind's visual treatment. It does not
move controls, replace navigation, alter information architecture, change copy,
or create a parallel workflow. Real screenshots from DeepSeek Harness, the
Codex/VS Code agent surface, Claude Code, OpenCode, Nexa, and Orca were recorded
in `docs/evidence/ui-reference-research-2026-08-19/`. They are references for
tone, density, borders, surface separation, typography, and interaction
hierarchy only—not templates for Hivemind's structure.

The 21st workflow searched the catalogue with the repository context and then
reviewed the source for items `18169`, `23286`, `9051`, and `7406`. The active
design kept the underlined-navigation principle from `18169`, the restrained
top reflection and contact shadow from `23286`, and a much lower-strength
technical-grid principle from `7406`. It rejected their incompatible component
families, pill radii, extra bevels, local state, dependencies, violet hue, and
full-screen structures. Item `9051` was rejected because its toolbar state and
surface language duplicated Hivemind's existing primitives. No catalogue code
was pasted or installed, so the UI remains one coherent Hivemind component
family rather than a mix of authors and libraries.

The resulting hierarchy is explicit:

- committed default and destructive actions may use the single-hue navy or clay
  relief and its required pressed-state pair;
- quiet, outline, secondary, ghost, and link actions remain flat;
- top navigation uses a navy underline on the chrome edge;
- suggestions remain rule-separated rows with hover and focus state;
- selection controls use a ground-level navy wash rather than relief;
- the canvas uses a 24px, low-strength navy dot grid beneath the existing broad
  fields, with no backdrop filter, motion, or new elevation membership;
- large work panels use a translucent navy wash so the substrate remains
  perceptible instead of returning to white-on-white.

Build `26.819.2301` proved that the initial panel surface still hid the canvas,
so that pass was rejected after installed visual inspection. Build
`26.819.2308` contains the corrected workplane, was installed, and was verified
against the executable on disk. All 24 production surface/viewport checks
passed. The installed 1440x900 Work and Settings evidence is in
`docs/evidence/ui-precision-instrument-installed-26.819.2308/`.

### Orca-derived Hivemind supersedes Precision Instrument — 2026-08-20

Screenshots were not treated as sufficient specification for this pass. The
official `stablyai/orca` repository was cloned fresh and inspected at commit
`9d06b3ba938d3c5467de5b82b0bec322af2620a8`. Its source establishes a compact,
solid system rather than the guessed glossy language used in earlier passes:

| Orca relationship | Hivemind adaptation |
| --- | --- |
| `#0a0a0a`, `#171717`, `#1e1e1e`, `#262626` surface ladder | `#080d15`, `#101822`, `#172230`, `#223044` navy-black ladder |
| 7% white ordinary rules; 15% white inputs | 8% white ordinary rules; 15% white inputs |
| `0.625rem` base curve and `.6/.8/1/1.4/1.8/2.2` scale | 10px base with 6/8/10/14/18/22px steps, plus the existing 4px micro step |
| 36px default and 32px compact buttons | the same shared `Button` geometry |
| solid buttons and flat line tabs | solid Hivemind-navy committed actions; flat underline navigation |

Only visual relationships were copied. Hivemind's React structure, placement,
copy, workflows, dispatcher, authoritative state, and provider marks did not
move. Orca's Electron mechanics, editor layout, dependencies, and information
architecture were not imported. No mixed 21st component family was installed.

The rejected dot grid, broad atmospheric fields, light substrate, control
gradients, and unused gradient tokens were removed rather than retained as
fallbacks. Ground panels have no decorative elevation. The closed raised,
floating, and overlay membership remains intact, while dark-surface shadow
measurements replace the obsolete near-white calculations. The production
reachability contrast check now uses WCAG relative luminance instead of an RGB
average that incorrectly classified the clay action face as dark text.

Installed inspection rejected build `26.820.24`: its inherited light dialog
scrim washed the dark shell gray. The scrim now uses the canvas color at 72%
and both Dialog and Command own opaque dark surfaces. Final build `26.820.31`
was built, installed, verified against the executable on disk, and inspected at
a 1440×900 client size on Setup, Work, and Settings. Evidence is in
`docs/evidence/orca-skin-installed-26.820.31/`.

The 21st workflow remained part of the pass. The local design context was read
before implementation and `21st review desktop --json` reviewed 87 files after
the change. Catalogue search could not run in this shell because the 21st CLI
was not signed in and no `API_KEY_21ST` was available; that limitation is
recorded rather than describing an unauthenticated search as completed. The
existing authenticated catalogue research remains advisory, and the official
Orca source is the implementation reference for this selected skin.

Final verification passed Core 815/817 with two intentional skips, Desktop
300/300, Rust 32/32, and all 24 production surface/viewport checks. No paid
provider call or paid 21st generation was used.

### Hivemind identity lives above Orca material — 2026-08-20

The user accepted the Orca-derived installed skin and selected a narrower
identity pass rather than another overhaul. Orca remains the material system:
10px curves, compact controls, opaque stepped planes, low-alpha rules, flat
navigation, and the closed elevation scale are unchanged. Hivemind now owns
four repeated visual signatures:

- the dark ladder moves from neutral navy-black to a more legible midnight
  sequence: `#07111c`, `#0d1923`, `#14253b`, and `#1e3553`;
- the default committed-action Button alone takes a shallow same-hue navy face,
  a brighter hover face, and a pressed inverse. The shared relief pair and 2px
  press still redeem it. Destructive, outline, secondary, ghost, navigation,
  suggestion, selection, checkbox, radio, and switch treatments do not take
  this gradient;
- the flat active navigation line starts at one 5px hex node, echoing the mark
  without turning a tab into a raised control;
- `hivemind-field.svg` draws two interlocking hex loops and deterministic branch
  lines behind only Setup and the idle Work canvas. It is a same-origin emitted
  asset, not a CSP-blocked data URL. It is never repeated or animated, its
  strongest source opacity is 7%, and it is removed below 1080px rather than
  competing with content.

No React structure, copy, workflow, provider identity art, dispatcher path, or
authoritative state changed. No old gradient vocabulary was restored: the
three primary-face state tokens are closed to `Button` and the earlier dot
grid and broad atmospheric fields remain deleted.

The 21st build workflow read the current project context and attempted a fresh
catalogue search before implementation; the CLI remained signed out with no
token. `21st review desktop --json` then reviewed 87 files and reported the
same broad static findings already disproved or covered by the global focus
contract and the 24 production reachability runs, so no unsafe autofix was
applied. No 21st component family was installed and no paid generation ran.

`npm run ship` built, installed, and verified build **26.820.1055** against the
executable on disk. The production bundle emitted `hivemind-field-*.svg` beside
the application assets. The running installed app was inspected at a 1440×900
client size on Setup, Work, and Settings; evidence is in
`docs/evidence/hivemind-identity-installed-26.820.1055/`. Final verification
passed Core 815/817 with two intentional skips, Desktop 301/301, Rust 32/32,
and all 24 production surface/viewport checks.

### Sign-in is a handoff; verification is a measured run — 2026-08-20

Provider setup now has two visibly and architecturally separate verbs:

- `Sign in` is a quiet outline action. Core maps a provider id to one fixed
  provider-owned CLI login command and launches it in a separate terminal or
  browser flow. React receives only the experience and explanatory text, never
  the command. Hivemind does not read or keep credentials.
- `Continue` answers with durable evidence and therefore keeps the committed
  navy relief. It runs the existing capability probe and writes a profile only
  after that probe passes. Choosing a provider is not presented as proof that
  it works.

This distinction also keeps the relief rule coherent: opening an external
provider flow is a secondary handoff, while committing to measured setup is
the answering control. Provider brand marks remain identity art rather than
buttons. OpenAI, Grok, and OpenCode retain their monochrome artwork; Claude and
Kimi retain their source colors. The marks are sized in `em` beside the label
and emitted under the Tauri application's own origin rather than tinted or
inlined as CSP-blocked data images.

Provider-check progress never fabricates a percentage. The honest information
available is the selected provider sequence, the current provider, and elapsed
time, so the control reads `Checking <provider> — <index> of <total> · <seconds>s`.
That text is the functional liveness channel when reduced-motion suppresses the
decorative spinner. It must differ between captures taken several seconds
apart even when no pixel rotation occurs. The updater uses the same distinction:
an active provider check produces provider-check wording and a `Try again`
action, not a claim that ordinary task work is running and not another build
request.

Installed build **26.820.1257** was checked at a 1440×900 client size. The
provider screen shows all five marks, stronger native-scale checkbox relief,
quiet Sign in actions, and the relieved Continue action. Kimi and Grok each
opened their own flow and returned a Hivemind handoff notice without credential
entry. A local no-network delayed probe produced non-identical `0s` and later
elapsed captures. Evidence is in `docs/evidence/desktop-26.820.1257/`.

### Settings is one plain-language surface — 2026-08-20

Settings no longer restates the static agent catalogue as a stack of technical
cards. Its first section now reuses Setup's exact provider-row implementation:
the same source-coloured or monochrome mark, subscription wording, provider-
owned Sign in handoff, current-project standing, and expandable evidence. This
is a shared component, not two visually similar copies. An unknown provider id
gets alignment space rather than an invented monogram.

Model choice is a separate, live question. On opening Settings, Core asks each
installed CLI for the model slugs it publishes without sending a model prompt:
Codex uses app-server `model/list`, Claude Code exposes its installed aliases,
OpenCode and Grok use their list commands, and Kimi Code exposes its configured
aliases. Planner, manager, and worker rows group those exact slugs by provider.
No credential file is read. A selected slug is discovered again inside Core
before it can reach the existing paid capability probe, so React cannot forge
an executable or model argument. A newly detected model receives conservative
standard-tier and 100K-context metadata rather than an unmeasured cheap or
strong routing claim.

The old Codex cheap/balanced/strong presentation is gone. The ordinary surface
contains the provider and model choices, three run limits, and one plain-
language approval choice. Project checks, file-risk patterns, and optional
routing by kind of work sit behind one flat Advanced disclosure. Its controls
are mounted only while open, so a collapsed section cannot leave invisible
keyboard targets outside the viewport. Paid capability checks are still
explicit committed actions and disclose the measured approximate call cost
before the press; simply opening Settings and refreshing models is no-cost.

The 21st workflow read the repository design context before implementation.
Fresh catalogue search remained unavailable because the CLI is not signed in,
so no search result was claimed and no mixed component family was installed.
The final `21st review` over Settings, the shared provider row, and Setup found
zero errors. Its three warnings point to pre-existing Setup widths that pass all
three production reachability sizes, so they were not used to rewrite working
geometry.

Installed build **26.820.1450** was inspected at a 1440x900 client size. The
upper capture proves the shared five-provider family, truthful 22-model
discovery summary, and concrete model-slug controls. The lower capture proves
the compact run limits, plain-language approval choices, collapsed flat
Advanced disclosure, and exact installed build footer. Evidence is in
`docs/evidence/settings-overhaul-installed-26.820.1450/`.

Final verification passed Core 821/823 with two intentional skips, Desktop
302/302, Rust 33/33, and all 24 production surface/viewport checks. No provider
model, paid capability probe, provider sign-in, or paid 21st generation call
was run.

### The first prompt starts where attention is — 2026-08-20

An empty Work surface no longer splits attention between introductory copy,
example requests, and a composer pinned to the bottom edge. It contains one
chat-shaped composer centered in the available canvas. The container uses the
existing `rounded-xl` 14px step, remains a ground-level opaque panel with no
invented elevation, and keeps the quiet Hivemind identity field behind unused
space. Its only action is a circular up-arrow Button: a committed action that
uses the existing primary face, relief pair, focus ring, disabled state, and
pressed redemption.

Submitting is the visual state change. Presentation state moves the same form
to the footer immediately, before the planner response returns; durable plan,
task, and gate truth remain outside React. Once docked, the composer retains
the same radius and circular send action while the existing guidance, approval,
continuation, spend, and feedback behavior remains available. Disconnecting
resets only the placement so a newly selected empty project starts centered.

The three examples and the old explanatory empty-state block were deleted,
not hidden or retained as fallback code. The 21st build workflow attempted its
required catalogue search but the CLI remained signed out. Its final review of
the changed Work and Button files reported zero errors; the remaining warnings
are pre-existing shared Button and Work-file findings, while the new bounded
composer passed the production viewport matrix.

Installed build **26.820.1508** was built, installed, verified against the
binary on disk, and inspected at a 1440x900 client size. Evidence is in
`docs/evidence/work-centered-composer-installed-26.820.1508/`. All 24
production surface/viewport checks passed. No planner or provider model call
was made to create the screenshot. Final verification passed Core 821/823 with
two intentional skips, Desktop 302/302, and Rust 33/33.

### Work chrome favors balance over decorative signatures — 2026-08-20

The active navigation treatment is a plain, centered underline. This
supersedes the earlier hex-node treatment: the node added visual weight without
carrying state that the line did not already communicate. Navigation remains
flat and makes no claim to button relief.

The idle composer uses the 18px radius step. Its prompt is a full-width 15px
field with matching horizontal insets, while the plus and circular send actions
share a bottom row so neither distorts the text's visual center. The docked
composer keeps the compact single-row geometry required by smaller production
viewports. `Nothing running` is centered against the whole header rather than
the space left over by Checks and Interruptions.

The project-name control is a flat disclosure into an overlay menu, not a
raised primary action. Current-project identity, recent-project switching, and
the native folder picker live together there. Attachments use the same quiet
disclosure language; their visual chips show relative paths and never imply
that Hivemind copied or uploaded file contents.

Installed build **26.820.1621** was inspected at a 1440x900 client size.
Evidence is in
`docs/evidence/project-switcher-composer-installed-26.820.1621/`. The 21st
review over App, Tabs, and Work reported zero errors; its nine warnings are
pre-existing fixed-width, long-duration, and autofocus findings covered by the
passing production reachability matrix.

Final verification passed Core 821/823 with two intentional Windows skips,
Desktop 304/304, Rust 34/34, and all 24 installed-production reachability
checks. No paid model or provider call was run.

### Empty navigation destinations state what will appear — 2026-08-20

Work owns the first request. Agents must not duplicate that composer merely
because both destinations share the run shell. Before durable work exists, the
Agents canvas stays quiet and says that agents will appear after a conversation
starts. It offers no action and claims no elevation. Once work exists, the same
destination replaces that message with the authoritative agent graph.

This is a presentation branch only. The shared run header, checks,
interruptions, inspector, and shipping controls remain one implementation, and
React derives emptiness from Core's projected tasks rather than inventing a
second lifecycle state. Installed build **26.820.1827** was inspected at
1440x900; evidence is in `docs/evidence/agents-empty-installed-26.820.1827/`.
Final verification passed Core 822/824 with two intentional Windows skips,
Desktop 304/304, Rust 34/34, and all 24 installed-production reachability
checks. No paid model or provider call was run.

### Connected providers replace the sign-in action — 2026-08-20

Provider-wide evidence, a current-project capability check, and the CLI's
current login standing are three different facts. The shared Setup/Settings
row now keeps them separate. Core asks only the fixed, provider-owned no-cost
status commands published by Codex, Claude Code, and OpenCode, bounds their
runtime and output, and reduces the answer to `signed_in`, `signed_out`, or
`unknown`. Raw output, account email, organization, and credentials never
cross the dispatcher. Grok and Kimi expose no equivalent safe status command
in the installed versions, so they remain unknown unless a stronger successful
project capability check already exists.

When either source proves a connection, the quiet `Sign in` Button is replaced
in place by a non-interactive checkmarked `Connected` status using the existing
navy wash, border, radius, and compact height. The adjacent standing still says
whether the proof is only `Signed in` or the stronger `Checked here`; product-
wide `Proven end to end` is no longer allowed to masquerade as the person's
current account state. Returning focus after an external sign-in re-runs the
read-only status action, while React owns no credential or authoritative login
decision.

Installed build **26.820.2158** was built, installed, verified against the
binary on disk, and inspected at a 1440x900 client size. The installed Settings
surface shows Codex, Claude Code, and OpenCode with checkmarked `Connected`
replacements and `Signed in` standing. Evidence is in
`docs/evidence/provider-connected-installed-26.820.2158/`. All 24 production
surface/viewport checks passed. No provider model, paid capability probe,
provider sign-in, or paid 21st generation call was run.

### The first-request canvas carries a living Hivemind field — 2026-08-20

The idle Work field is still one self-hosted, non-repeating SVG rather than a
grid or wallpaper. It now draws a wider connected system on both sides of the
composer. More cells and branches make the identity visible at native scale;
the strongest stroke remains at the existing 7% ceiling, so added density does
not compete with the amber attention edge.

Decorative motion is a slow six-to-twelve-pixel change in field position and
scale. It exists only under `prefers-reduced-motion: no-preference`. Reduced
motion retains the complete static field, and Hivemind never changes the OS
setting to make decoration move. The idle-only class is removed synchronously
when the first form is submitted, before the planner returns or durable tasks
arrive, so neither the field nor its animation remains behind live work.

The centered composer advances from the 18px to the 22px radius step. Its new
flat `Agents` disclosure opens inside the composer and shows Planner, Manager,
and Workers separately. Opening it performs only the existing no-cost
`config.inspect` and `models.discover` reads. Selecting a different slug uses
the existing audited `adapter.connect_model` action, which repeats the provider
capability check before Core changes the durable role profile. The menu says
that this may consume provider quota; no React-owned model setting or unchecked
shortcut was added. Role changes are disabled while a run is active.

The 21st build workflow used the checked-in project design context after both
required catalogue searches reported that the CLI was signed out. Its final
review reported zero errors. No catalogue component was installed, so Button,
DropdownMenu, tokens, and role actions remain one Hivemind component family.

Installed build **26.820.2311** was built, installed, verified against the
binary on disk, and inspected at a 1440x900 client size. Evidence is in
`docs/evidence/idle-composer-agents-installed-26.820.2311/`. The user also
independently inspected and accepted the installed visual result. Production
reachability now opens the role menu and treats menu items as controls; all 27
surface/viewport combinations passed. Final verification passed Core 824/826
with two intentional Windows skips, Desktop 305/305, and Rust 34/34. Model
discovery was no-cost; no model, capability probe, or paid 21st generation call
was run.

### Conversation turns and run records are different shapes — 2026-08-21

The earlier rule that the run thread is “no longer a chat” applied one visual
shape to two different kinds of information. A task milestone is a record and
keeps the fixed time gutter, rule, and node. A message is a conversation turn:
the person's submitted text aligns right in a bounded navy-wash bubble and the
product's normalized response aligns left. This supersedes the quoted-block
treatment for messages only; plan, task, verification, and ship records do not
become chat bubbles.

Conversation truth is durable Core state. `conversation.message_recorded` and
the `spec.draft_*` events are appended before and after the provider boundary,
so reloads reconstruct the same request, stage, response, or failure. React may
move and clear the composer at submit time, but it does not invent the message,
provider result, gate state, or completion state.

The drafting stage reports functional liveness as changing elapsed text from a
durable start timestamp. It does not depend on decorative animation, so reduced
motion never turns it into a frozen glyph. Source drafting exposes no honest
total and therefore gets no percentage or progress bar. The product presents a
normalized goal and blocking questions; it never presents hidden model
reasoning or raw chain of thought as if that were the product's voice.

This contract is installed in build **26.821.51**. The production replay gate
opens the first-message state at all three supported viewport sizes and proves
functional liveness by requiring elapsed text to differ after three seconds.
That brings reachability coverage to 30 surface/viewport combinations.

### Installed history replay is an acceptance surface — 2026-08-21

An executable version match does not prove that an upgrade installed the same
Core that was bundled. Local installation therefore verifies three identities:
the executable version, the shell manifest, and a generated Core build manifest.
The Windows installer removes only its owned Core resource directory before
copying the replacement, preventing deleted modules from surviving an upgrade.
This keeps the CSP and packaging boundary closed instead of teaching the UI to
tolerate a mixed install.

Opening a completed project is also a materially different UI state from a cold
or short replay. Durable history can arrive as a burst of thousands of records.
Every record must update the deterministic projection, but React does not need a
separate paint or a redundant state dispatch for each one. The workspace hook
coalesces projection paints to one animation frame and changes transport-error
state only when its value actually changes. Functional liveness remains elapsed
text; reduced motion disables decorative entry/exit animation outright rather
than running it for a nominal fraction of a millisecond.

The installed native harness is now the guard for this class. It uses the real
Tauri shell and installed resources, exercises project selection and history
replay, and fails on blocked resources, severe console output, React runtime
errors, or a shell that stops responding. Build **26.821.647** reopened the
completed real project with no browser errors. This complements, rather than
replaces, the 30 viewport reachability checks.

### The light-palette measurements in this file are historical — 2026-08-21

The skin flipped from light to dark on 2026-08-20 (the Orca-derived shell,
`b4bea13`). Every measured visual figure recorded in this file before that
date was sampled on the light `#f5f6f8` canvas: the amber attention-edge peak
of 14.7/255 over 11px, the raised 4.3/4 and floating 10.3/10 shadow values,
the 59/57 grey-smudge rejection, the 16.3/13 rejected `floating` candidate,
and the glass-diff percentages. The same figures appear in `docs/STATE.md` §4;
that is the same light-palette record. The sections stay because they are the
reasons the decisions were made; the figures no longer describe the installed
skin.

**The load-bearing ones did not go stale — they were re-derived, and by a
mechanism rather than a re-sample.** The elevation ceiling is computed from
the tokens against the dark ground plane `#0d1923` in
`desktop/test/elevation.test.ts` (raised 11.9 and floating 14.7 on the
strongest channel, overlay below 26), and `styles.css` records that
dark-surface derivation beside the tokens themselves. A hand-sampled figure
would have had to be re-sampled on every palette change; a computed one moves
with the tokens, which is why the test calculates instead of carrying a
measurement.

The backdrop-filter ban survives the palette change on its palette-independent
leg — a promoted compositing layer loses subpixel antialiasing window-wide —
and is still asserted. Its other leg, "a blur has nothing to redistribute on a
near-white canvas", is an argument about the old palette; on the dark opaque
stepped planes the ban holds for the antialiasing reason and because blur
would soften text without clarifying depth (see the depth comment in
`styles.css`).

**Reading rule for this file:** a measured figure binds only if a test
computes or asserts it against the current tokens. A figure that lives only in
prose is a record of the palette it was measured on, dated by its section.


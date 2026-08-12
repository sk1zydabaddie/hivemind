# Universal provider support: the contract, and what each provider can actually answer

Discovery pass, 2026-08-12. **No paid calls were made.** Everything below comes
from one of three sources, and each claim says which:

| Source | What it is | Strength |
| --- | --- | --- |
| **CLI** | `--help` and read-only subcommands run on this machine today | Authoritative for flags |
| **DOCS** | the provider's own documentation | Authoritative for intent, silent on behaviour |
| **NONE** | nobody has run it | A question, not a finding |

Versions dry-run here: `codex-cli 0.147.0`, `claude 2.1.229`, `opencode
1.18.15`. Grok Build and Kimi Code are not installed, so every claim about them
is DOCS.

---

## The finding that changes the shape of the problem

**Hivemind does not need the agent to have a shell.**

The worker's job is to produce a diff. Core runs the project's checks itself
(`runShadowVerification` → `runGate`), computes the change set itself
(`captureWorktreeDiff`), and decides admission itself (`decideOp`). The worker
prompt already says so: *"Submit a diff only. Do not commit, push, rename
unrelated files, or edit outside the contract."*

Today that sentence is an **instruction**, not a boundary. Every provider below
offers a way to make it a boundary, by denying the shell tool outright:

| Provider | How the shell is removed | Source |
| --- | --- | --- |
| Claude Code | `--tools "Read,Edit,Write"` — a positive allowlist of built-in tools | CLI |
| OpenCode | `permission.bash: "deny"` in config | CLI (schema) |
| Grok Build | `--disallowed-tools` / `--deny` | DOCS |
| Kimi Code | not documented | NONE |
| Codex | not available — the sandbox is the boundary instead | CLI |

Denying the shell collapses the two capabilities that are otherwise hardest to
verify:

- **confinement** stops depending on an OS sandbox nobody reports, because a
  file-edit tool restricted to the working directory is the whole attack
  surface;
- **does-not-commit** stops depending on the model's good behaviour, because
  there is no `git` to run.

**What it costs** is real and should be measured rather than assumed: agents
often run the tests themselves and iterate before answering. A shell-less
worker submits its first attempt. That is a quality question, and §4 is the
instrument for it — not a correctness question, because Core checks the diff
either way.

**Recommendation:** make the shell-less posture the *default* profile for every
new provider, and treat a shell-enabled profile as a separate, separately
verified posture. Codex, which has a real OS sandbox and is already proven, is
the one that keeps its shell.

---

## 1. The contract

`src/capability-contract.ts`, with `test/capability-contract.test.ts` (12 tests)
exercising every capability in every state on a machine with none of these
agents installed.

### Four states, not three

The brief asked for three. The fourth is the one the probe exists to produce.

| State | Meaning |
| --- | --- |
| `verified` | Asked for, read back, matched |
| **`mismatched`** | Asked for, read back, **disagreed** |
| `unverified` | Asked for, nothing to read back |
| `unsupported` | The provider structurally lacks the feature |

*"Asked for gpt-5.6-terra, reported running gpt-5.5"* is not `unsupported` —
the provider has model pinning, advertises it, and did not do it. Both
regressions this project has shipped were exactly that shape. Folding it into
`unsupported` would file the most dangerous observation the system can make
under the same word as "this tool has no such feature".

**`mismatched` refuses unconditionally, for every capability, whatever the
admission policy says.** A provider that reports doing something other than
what it was told is not a provider whose other answers can be trusted.

### Evidence classes, and what each can establish

| Class | What it is | Can it verify? |
| --- | --- | --- |
| `readback` | the provider reported what it resolved | yes |
| `static` | a property of the argv, true before anything spawns | yes |
| `observation` | we looked at the machine afterwards | **only a claim about this run** |
| `absent` | nothing was available | no |

The distinction is load-bearing. "The agent did not write outside the project
during one probe" is not proof it could not — that is the false confidence the
sub-agent behavioural probe was considered and rejected for. But "this run
created no commit" is completely settled by comparing HEAD before and after,
because there is no hidden way to have committed.

So: **an observation can refute anything, and can verify only a claim scoped to
this run.** A `verified` finding backed by an observation against a
disposition-scoped capability is automatically downgraded to `unverified` and
takes that capability's policy — which, for confinement, refuses.

### Admission, and the asymmetry

| Capability | verified | unverified | unsupported |
| --- | --- | --- | --- |
| Carries no bypass flags | admit | **refuse** | **refuse** |
| Runs without asking you anything | admit | **refuse** | **refuse** |
| Can write here, and only here | admit | **refuse** | **refuse** |
| Leaves the change for you to approve | admit | **refuse** | **refuse** |
| Runs the one model you chose | admit | admit — *routing off* | admit — *routing off* |
| Reports what it spent | admit | admit — *ceilings off* | admit — *ceilings off* |
| Does not start agents of its own | admit | admit — *counting off* | admit — *counting off* |

The line is **what it costs to be wrong**. An unconfined agent can change
anything on the machine — unbounded, so unverified refuses. An unreadable bill
is bounded and describable — so it admits, with the ceiling *actually switched
off* and the person told.

That last clause is the part that makes a degraded admission honest rather than
a shrug. A test asserts every admit-with-limitation names a real
`DegradedFunction`, because admitting an agent whose usage cannot be read while
still drawing a spend meter would be worse than refusing it.

**Silence is never admission.** A capability with no finding is a probe that
did not run, and refuses with the question named.

---

## 2. Per-provider discovery

### Codex — **proven, unchanged**

The baseline. One empirical discovery that appears in no documentation:
`--ephemeral` suppresses the session rollout that carries the readback, so the
probe drops that one flag and nothing else. Five capabilities verified live;
sub-agents `unverified` and unreportable from the provider's side.

### Claude Code — **adaptable, and the best-instrumented of the four**

| Question | Answer | Source |
| --- | --- | --- |
| Headless one-shot? | **Yes.** `-p/--print`, exits with a status code | CLI |
| Structured output? | **Yes.** `--output-format json \| stream-json`; `--json-schema` for a typed result | CLI |
| Model pinned? | **Yes.** `--model` | CLI |
| Readback? | **`system/init` reports the resolved model, tools, MCP servers and plugins** | DOCS |
| Confinement? | **Two mechanisms, and a trap.** See below | DOCS |
| Usage? | `--output-format json` carries `total_cost_usd` and a per-model breakdown — **documented as a client-side estimate that can differ from the bill** | DOCS |
| Sub-agents? | Yes, nested to any depth — **and visible**: messages carry `parent_tool_use_id`, `--forward-subagent-text` emits their text | DOCS |
| Disable sub-agents? | Yes — `--tools` allowlist without the agent tool, or `--disallowedTools` (a bare tool name removes it from context) | CLI |
| Commits? | Only if `Bash(git commit *)` is allowed. Deny it, or deny Bash | CLI |

**The confinement trap, and it is the sharpest finding in this pass.** Claude
Code has a real OS-level sandbox — Seatbelt on macOS, seccomp/bubblewrap on
Linux and WSL2 — configured through `settings.json`. Three things about it
matter:

1. **It covers the Bash tool only.** File edits are governed by permission
   rules, not by the sandbox. Confinement is therefore a two-mechanism claim.
2. **Native Windows is not supported.** The sandbox needs WSL2. Hivemind's
   primary development platform is Windows.
3. **By default, when the sandbox cannot start, Claude Code warns and runs the
   command unsandboxed.** That is precisely the silent-downgrade shape that
   burned this project twice. `sandbox.failIfUnavailable: true` makes it a hard
   failure, and **any Hivemind profile must set it.** There is also a
   `dangerouslyDisableSandbox` escape hatch the model may reach for on a
   sandbox failure, closed by `allowUnsandboxedCommands: false`.

Combined with the shell-less posture above, the recommended Claude Code profile
denies Bash entirely — which sidesteps 1, 2 and 3 at once and makes the
provider adaptable on Windows.

**Open, needs one paid run:** whether `system/init` carries anything naming the
resolved permission mode or the allowed directories. If it names the model
only, then `pins_one_model` verifies and `confined_to_project` rests on the
tool-allowlist argument plus the nonce-file observation. `claude doctor` was
tried as a free readback and reports installation health only.

### OpenCode — **adaptable, and it can be read back for free**

| Question | Answer | Source |
| --- | --- | --- |
| Headless one-shot? | **Yes.** `opencode run [message]` | CLI |
| Structured output? | **Yes.** `--format json` — "raw JSON events" | CLI |
| Model pinned? | **Yes.** `-m provider/model` | CLI |
| Readback? | **Yes, and without spending anything** — see below | CLI |
| Confinement? | `external_directory` permission, `--dir`; deny-able per pattern | CLI (schema) |
| Usage? | **Yes.** `opencode stats` reports input/output/cache-read/cache-write and cost; sessions persist to a local database and `opencode export <id>` emits JSON | CLI |
| Sub-agents? | Yes — a `task` permission and a `subagent_depth` config key | CLI (schema) |
| Disable sub-agents? | **Yes.** `permission.task: "deny"` | CLI (schema) |
| Commits? | Only via `bash`; deny it | CLI (schema) |

**`opencode agent list` prints the agent's fully resolved permission table.**
Run in this repository today it emitted the merged rules, including
`external_directory` with its allow/ask patterns and per-pattern `read` rules.
That is a genuine readback obtained **for free** — no model call — which is a
strictly better position than Codex on cost, and a weaker one on strength:

> It reports what the configuration **resolved to**, not what the run
> **applied**. It is a `readback` of the disposition, not of the turn.

That distinction should be recorded on the finding rather than smoothed over.
It is enough to verify confinement and sub-agent denial; it is not enough to
verify the model pin, because the pin travels on the command line per-run.

**Open, needs one paid run:** whether `opencode export` carries the resolved
model per message and per-message token counts. `opencode stats` proves the
numbers exist; the question is whether they are attributable to one run.

**One caveat found in the schema:** `--auto` is described in its own help as
*"auto-approve permissions that are not explicitly denied (dangerous!)"*.
Hivemind's `findDangerousAdapterArgs` should treat it as a bypass flag unless
paired with an explicit deny set, in which case the deny set — not the flag —
is what gets verified.

### Grok Build — **probably adaptable; every readback question is open**

| Question | Answer | Source |
| --- | --- | --- |
| Headless one-shot? | **Yes.** `-p/--single`, `-c/--continue`, `-s/--session-id` | DOCS |
| Structured output? | **Yes.** `--output-format plain \| json \| streaming-json` | DOCS |
| Model pinned? | **Yes.** `-m/--model` | DOCS |
| Readback? | **Unknown — no init event or session record is documented** | NONE |
| Confinement? | `--sandbox <PROFILE>` with OS-level profiles, plus `--allow`/`--deny` rules and `--cwd` | DOCS |
| Usage? | Third-party sources say streaming output includes usage; xAI's own headless page does not document it | DOCS (weak) |
| Sub-agents? | Yes, and **`--no-subagents` disables them** — the only provider with a dedicated flag | DOCS |
| Commits? | Not documented; it has shell tools and the docs describe "git workflows" | NONE |

Grok Build has the **best-shaped flags of any provider here** — a real sandbox
profile, an explicit sub-agent switch, Claude-compatible tool aliases — and the
**least documented evidence**. Every capability could plausibly verify; none
can be shown to today without running it.

It also ships `--dangerously-skip-permissions` as a Claude-compatibility alias,
which the preflight must refuse by name.

**What I would do first:** install it and run `grok --help` (free) to confirm
the doc-derived flags, then one paid probe to find out whether
`--output-format streaming-json` carries an init event. That single answer
decides whether Grok is a fully-verified provider or a degraded one.

### Kimi Code — **structurally hostile to this contract as documented**

| Question | Answer | Source |
| --- | --- | --- |
| Headless one-shot? | **Yes.** `--print` (implies `--afk`), `--prompt/-p` | DOCS |
| Structured output? | **Yes.** `--output-format text \| stream-json` (JSONL) | DOCS |
| Model pinned? | **Yes.** `--model/-m` | DOCS |
| Readback? | **No.** The stream carries user, assistant and tool messages only — no init event, no resolved model, no working directory | DOCS |
| Confinement? | `--work-dir` and `--add-dir` set *workspace scope*; **no sandbox is documented** | DOCS |
| Usage? | **Not documented in the stream** | DOCS |
| Sub-agents? | Yes — built-in `coder`, `explore`, `plan` subagents. **No disable flag documented** | DOCS |
| Commits? | Not documented | NONE |

**The blocking problem is not any single row — it is that `--print` implicitly
enables `--afk`, which auto-approves every tool call.** Kimi's own
documentation states it: *"all tool calls are auto-approved, and interactive
questions and plan mode switches are also handled automatically."* There is no
documented middle setting. So headless Kimi is *unconditional approval with no
documented sandbox*, which under this contract is:

```
confined_to_project = unsupported  →  REFUSE
```

That is the contract working exactly as intended. Kimi Code is not "broken" and
is not "silently trusted" — it is **refusable with a reason a person can read**:
*"This agent has no way to be confined to one folder, so Hivemind will not run
it against your code."*

**What would change the verdict:** an undocumented sandbox, or `--work-dir`
turning out to be an enforced boundary rather than a context hint, or a config
key that denies the shell. All three are worth ten minutes with the binary
installed — a free `kimi --help` would settle the first pass. I would not
commit to Kimi Code publicly before that.

### Does anything commit directly to git?

**No provider was found that commits as its normal mode of operation.** All
four leave changes in the working tree and can only commit by running `git`
through a shell tool the profile grants them.

Stating it loudly anyway, because the brief asked and because the current
protection is weaker than it looks: **today the only thing stopping a commit is
a sentence in the worker prompt.** `leaves_change_uncommitted` turns that into
a measured fact — HEAD recorded before the probe, compared after — which costs
nothing, works identically on every provider including ones nobody has heard
of, and cannot be defeated by a prompt the model chooses to ignore.

### Verdict

| Provider | Verdict | Blocking unknown |
| --- | --- | --- |
| **Codex** | **Adaptable — proven** | none |
| **Claude Code** | **Adaptable** | whether `system/init` names anything beyond the model |
| **OpenCode** | **Adaptable** | whether `export` attributes tokens to one run |
| **Grok Build** | **Likely adaptable** | whether *any* structured readback exists |
| **Kimi Code** | **Refused as documented** | whether confinement exists at all |

Four adaptable, one refusable with a reason — which is the shape the brief
asked for, arrived at rather than assumed.

---

## 3. Fragility: a harness over five harnesses that all ship weekly

### Where provider-specific knowledge lives

Exactly three places today, and the goal is to keep it at three:

| Concern | File | Per provider |
| --- | --- | --- |
| How to start it | `src/agent-catalogue.ts` | one `invoke` builder |
| How to read what it spent | `src/adapter.ts` (`usage_parser`) | one named parser |
| How to read what it resolved | `src/adapter-probe.ts` (`readback`) | one named reader |

`readCodexRollback` is already selected by `agent.readback === "codex-rollout"`,
so the seam exists. **The one change this pass recommends** is that the same
tagged-union treatment be applied to the usage parser and the invoke builder,
so that a provider is a single record naming three functions and nothing else
in the tree branches on its identity.

A test should assert that: no file outside those three may contain a provider's
name. That is mechanically checkable and would have caught the drift that put
`cmd.exe` handling in three separate files.

### What happens when a provider changes its output

This is the question that matters, and the answer has to be **degrade or
refuse, never silently misread.**

The current design already gets this right in one place and should be extended:
`readCodexRollback` returns `null` on any unrecognised shape, and every
capability that depends on it comes back `unverified` rather than guessed. An
unrecognised record is not evidence of anything.

Applying that consistently gives three failure modes and no fourth:

| What broke | What happens | Why it is safe |
| --- | --- | --- |
| The readback shape changed | capabilities → `unverified` → confinement **refuses** | The agent stops being usable, loudly, at connect time |
| The usage parser stopped matching | `reports_usage` → `mismatched` (a parser configured and finding nothing) → **refuses** | Better than a ceiling reading zero |
| The output format changed entirely | non-zero exit or timeout → `non_interactive` **refuses** | A run that cannot be read is a run that did not happen |

The one genuine hazard is a parser that keeps matching but matches the *wrong
field* — reading a cache-read count as a total, say. That is the silent
misread, and no structural rule prevents it. The mitigation is the corpus in
§4: a certification run has a known cost envelope, and a usage number an order
of magnitude away from it is a failed certification rather than a cheap run.

**The re-probe question, and a recommendation.** A capability verified at
connect time is a fact about the version that ran then. Providers auto-update —
`claude doctor` reports "Auto-updates: enabled" on this machine. So a connection
record should carry the provider version it verified, and the version should be
checked cheaply on every run; a changed version means the connection is
**stale**, not invalid, and the person is asked to reconnect rather than being
silently run against unverified capabilities. That is a small addition to the
connection record and it is what keeps a weekly-shipping dependency honest.

### The corpus as a certification suite

**Yes, and it is the mechanism that makes "any CLI agent" honest rather than
aspirational.** `src/capability-corpus.ts` already does the hard half: it runs a
fixed task set through `runAdapterProcess`, captures a worktree diff with
`captureWorktreeDiff`, and runs the real gate with `runGate`. It is a
certification suite that is currently pointed at model tiers instead of at
adapters.

What it adds that the probe cannot:

| The probe answers | The corpus answers |
| --- | --- |
| Can it start, and does it report what it resolved? | Does it produce a diff Hivemind's own gate accepts? |
| One trivial nonce write | Three real tasks, including a dependent one |
| Nothing about quality | Whether a shell-less posture costs accuracy |
| Nothing about cost | A known envelope, so a wrong usage number is visible |

**Proposed certification:** an adapter is `supported` when it passes the probe
*and* completes the corpus with every task's diff accepted by `decideOp` and
its checks passing. It is `unverified` when it passes the probe but has not run
the corpus. It is `unsupported` when either refuses, with the specific
capability or the specific failing task named.

That gives the launch claim a spine: **"Codex certified; Claude Code and
OpenCode certified; Grok Build probed but not certified; Kimi Code refused,
here is the reason"** is a sentence that is true, checkable, and re-runnable
per release.

The corpus costs real money per certification, which is exactly why it belongs
behind an explicit decision rather than in a connect flow. Its cost should be
estimated per provider before it is run — the same estimate-and-pause the
connect probe already does.

---

## What this pass did not do

No adapter was built. No probe was extended. No paid call was made. The
contract is written and tested; `probeAdapter` still emits the older
three-state shape and has **not** been migrated onto it — that migration is a
build task, and it should happen alongside the first new provider rather than
speculatively, so the generalisation is proven by a second case rather than
designed for one.

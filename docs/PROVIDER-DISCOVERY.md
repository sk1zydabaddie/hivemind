# Universal provider support: the contract, and what each provider can actually answer

Discovery pass, 2026-08-12, updated the same day after the free installs.
**No paid calls were made.**

> **Update.** Grok Build 1.0.3 and Kimi Code 1.49.0 were installed into a
> temporary directory and dry-run, so their rows are now CLI rather than DOCS.
> Kimi's verdict moved from *refused as documented* to **refused as measured**,
> which is a stronger claim and a worse finding: see below.

## HEADLINE: a pinned model is not the only model you pay for

**Observed, not inferred.** A Claude Code probe pinned to `sonnet` returned this
in its own `result` record:

```
claude-sonnet-5           :  4 in / 167 out / 19,903 cache read   $0.042
claude-haiku-4-5-20251001: 541 in /  14 out                       $0.000611
```

The pin **took** — `system/init` reported `model: claude-sonnet-5`, exactly what
was asked for. And the harness still ran a second model of its own choosing.
This is the cost half of the sub-agent concern **observed for the first time**,
on a real run, rather than reasoned about.

### Why Haiku ran — answered, not guessed

It is documented, and it is not a sub-agent. `ANTHROPIC_DEFAULT_HAIKU_MODEL` is
described in Claude Code's own docs as *"The model to use for `haiku`, or
background functionality"*, and the costs page names what that covers:

> **Background token usage.** Claude Code uses tokens for some background
> functionality even when idle: **conversation summarization** (background jobs
> that summarize previous conversations for `claude --resume`) and **command
> processing**. These background processes consume a small amount of tokens
> (typically under $0.04 per session).

So it is internal housekeeping, as expected. The open question was whether it
**scales**, because a variable component nobody controls would be a different
problem from a fixed one.

### It does not scale — measured

Two probes in the same repository, one trivial and one 2.2× the cost:

| Task | Sonnet cost | Haiku in/out | Haiku cost | Haiku share |
| --- | --- | --- | --- | --- |
| write one file | $0.0420 | 532 / 16 | $0.000612 | **1.44%** |
| read 6 files, write 7 | $0.0939 | 583 / 15 | $0.000658 | **0.70%** |

Sonnet's cost rose **2.24×**. Haiku's rose **1.07×** — input up 9.6%, output
flat. **The Haiku component is effectively fixed per session, not proportional
to the work**, which matches the documented "under $0.04 per session" and means
the Claude Code cost model has a small fixed overhead rather than an
uncontrollable variable one.

That is the better of the two possible answers, and it is worth stating in the
same breath as the finding: this weakens the tier-routing claim by a **bounded,
near-constant amount**, not by an unknown one.

### The product consequence, stated before it reaches a slide

**Tier routing means less on Claude Code than on Codex.**

Hivemind's routing claim is "cheap work goes to a cheap model". On Codex that is
the whole story: you pin a model, that model does the work, you pay for it. On
Claude Code you pin a model and pay for **that model plus whatever the harness
picks for its own housekeeping**. The pin governs the agent; it does not govern
the process.

What this does **not** break, and the distinction matters:

- **Ceilings still hold.** `reports_usage` reads the run's total, which includes
  every model. Nothing escapes the budget, and no limit is defeated.
- **The work still routes.** A cheap task still runs its agent on the cheap
  model. The saving is real, just smaller than the model prices imply.
- **It is bounded.** Measured at ~1.4% of a trivial run and falling as the task
  grows; documented at under $0.04 per session.

What it **does** mean:

- **Per-task cost predictions from model prices are wrong on Claude Code**, by a
  small fixed amount per session. Any figure quoted as "this task costs X
  because it ran on the cheap model" needs the overhead added.
- **`routing.observed` provenance is incomplete.** It records one provider at
  one tier; a second model contributed. The routing-weight memory proposals
  learn from that evidence, so they are learning from a slightly wrong
  attribution.

### The asymmetry, which is the bigger point

**Codex reports a total with no per-model breakdown. The same thing could be
happening there and would be invisible.**

This finding is as much about *which providers let you see anything* as it is
about Claude Code. Claude Code did not do something worse than Codex — it did
something **observable**. `modelUsage` is the reason we know, and Codex's
`turn_context` has no equivalent field.

The honest ranking is therefore the opposite of how it first reads:

| Harness | Second model? | Can we tell? |
| --- | --- | --- |
| Claude Code | **Yes, measured** | **Yes** — `modelUsage`, per model, per run |
| Codex | Unknown | **No** — one total, no breakdown |
| OpenCode | Unknown | Partly — per-step tokens, no model attribution seen yet |
| Grok Build | Unknown | Unknown |
| Kimi Code | Unknown, and it has a documented **secondary model** for subagents | Unknown |

**So the contract needs a capability it does not yet have:** *reports what each
model cost*, distinct from *reports what it spent*. A provider that reports one
total is `unsupported` for that finer capability, which correctly degrades
`routing_provenance` — and would have flagged Codex rather than leaving the
question unasked. That is a proposal, not built.

Kimi Code's docs describe `[secondary_model]`, whose "consumer today is subagent
spawning: when set, newly spawned subagents bind to it by default instead of
inheriting the main agent's model." So at least one other harness has this by
design, deliberately, and says so.

---

Everything below comes from one of three sources, and each claim says which:

| Source | What it is | Strength |
| --- | --- | --- |
| **CLI** | `--help` and read-only subcommands run on this machine today | Authoritative for flags |
| **DOCS** | the provider's own documentation | Authoritative for intent, silent on behaviour |
| **NONE** | nobody has run it | A question, not a finding |

Versions dry-run here: `codex-cli 0.147.0`, `claude 2.1.229`, `opencode
1.18.15`, `grok 1.0.3`, `kimi-cli 1.49.0`. The last two were installed into a
temporary directory (`GROK_BIN_DIR`, a throwaway venv) and never authenticated;
installation needs no account, running does.

**One trap worth recording:** the npm package named `kimi-code` is **not**
Moonshot's. It is a third-party wrapper that proxies Claude Code to Kimi models.
Installing it and calling the result "Kimi Code" would have poisoned the whole
discovery. The official distribution is `kimi-cli` on PyPI, whose summary reads
"Kimi Code CLI is your next CLI agent."

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
| Claude Code | `--tools "Read,Write,Edit,Glob,Grep"` — a positive allowlist, so the shell is *absent* rather than denied | CLI |
| OpenCode | `permission.bash: "deny"` in the project's config | CLI |
| Grok Build | `--tools` allowlist, plus `--no-subagents` | CLI |
| Kimi Code | drop `kimi_cli.tools.shell:Shell` from an `--agent-file` spec | CLI |
| Codex | **`--disable shell_tool`** — a stable feature flag, found by interrogating the binary | CLI |

**Built, in `src/agent-catalogue.ts`.** Each entry now carries a `shell_denial`
recording the mechanism *and how the denial is confirmed to have taken effect* —
because "we passed the flag" is not "the flag worked", which is the entire
lesson of this project.

| Provider | Confirmed by | Status today |
| --- | --- | --- |
| Claude Code | the tools array the run reports at startup | **needs one paid run** |
| OpenCode | the resolved permission table, printed free | **accepted, precedence unproven** |
| Grok Build | nothing yet | unconfirmed — needs an account |
| Kimi Code | n/a — denial would not help | refused for another reason |

Two of these were checked for free today:

- **Claude Code's argv is valid.** Running the whole shell-denying invocation
  with one deliberately invalid `--json-schema` produced *only*
  `Error: --json-schema is not valid JSON` — every other flag was accepted by
  `claude 2.1.229` before any call was made. That establishes **acceptance**,
  not effect, which is exactly the distinction the contract is built on.
- **OpenCode accepts the deny, and the print does not prove it wins.** With
  `permission.bash: "deny"` in the project config, `opencode agent list` shows
  `bash deny *` landing on the primary `build` agent — and byte-identical output
  across repeated runs, so the readback is stable. But the `explore` subagent's
  table contains **both** `bash allow *` (its own rule) and `bash deny *` (ours),
  and the print does not say which wins. So the free readback establishes *the
  rule was accepted*, and a run that is told to use a shell and does not is what
  would establish *the rule holds*. Denying `task` as well means no subagent is
  spawned in the first place, which is the belt to that brace.

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

### Can a shell-less worker still run the project's tests? No. Here is the call.

The question is real and the two sides are not symmetric, so it is worth
setting out rather than assuming.

**What is lost.** A worker with no shell cannot run `npm test` before it
answers. It writes its change and submits. Everything it would have caught by
running the tests — a typo, a wrong import, an assertion it misread — now gets
caught one layer later, by Core's shadow verification, and comes back as a
rejection. Rejections cost a second worker call, so first-attempt quality is
paid for in tokens either way; the question is only *who* pays and *when*.

**What is gained.** Confinement stops being a property of an OS sandbox that
one provider reports, one does not support on Windows, one silently disables
when it cannot start, and one does not have. It becomes a property of the argv
Hivemind is holding. `leaves_change_uncommitted` stops depending on the model
obeying a sentence. And the two capabilities that `refuse` when unverified —
the two whose failure is unbounded — become the two that are easiest to get
right on a provider nobody has integrated yet.

**Which way I would go: shell-less by default, and I would not treat it as
provisional.** Three reasons, in order of weight.

1. **The failure modes are not comparable.** A worse first-attempt rate costs
   money and time, is visible in the ledger, and is bounded by the run ceiling.
   An unconfined agent is unbounded and invisible until it has already
   happened. When the two sides of a trade are "bounded and measurable" against
   "unbounded and silent", the trade is not close.
2. **It is the only posture that generalises.** The launch claim is "anything
   else must pass the probe". A posture that depends on each provider having a
   reportable OS sandbox cannot be offered to a harness that ships next month.
   A positive tool allowlist can.
3. **The cost is measurable before it is paid.** The corpus is exactly the
   instrument: run the same three tasks shell-less and shell-enabled on Codex,
   which is the one provider that can do both, and compare accepted-diff rate
   and tokens-per-successful-task. That is a number, not an argument, and it
   costs one corpus run against a provider already proven.

**What I would NOT do is decide it globally and permanently.** The posture is
per-profile and recorded on the connection, so a project that measures the
tradeoff and wants its worker to self-verify can have a shell-enabled profile —
on a provider whose confinement is `verified`, which today means Codex. What
must never happen is a shell granted to a provider whose boundary is
`unverified`, and the contract already refuses that.

**Recommendation:** shell-less is the default profile for every new provider.
Codex keeps its shell deliberately — its boundary is a sandbox it reports, so it
is verified either way — which makes it the control case for measuring what a
shell is worth.

> **Correction, 2026-08-12.** This document previously said Codex has no
> tool-level deny and must rely on its sandbox. That was wrong.
> `codex features list` names **`shell_tool`** as a *stable* flag, and
> `--disable shell_tool` removes it. Nothing in the documentation says so; it
> took asking the binary, which is the same shape as the `--ephemeral`
> discovery.
>
> **And a shell-less Codex still writes files.** Measured: with
> `--disable shell_tool`, a trivial write task emitted a `file_change` item and
> the file appeared on disk. `apply_patch` does not go through the shell tool,
> so removing the shell costs the agent its ability to run commands and nothing
> else. That is the fact the whole posture depends on, and it is now observed
> rather than assumed — **on all four harnesses the shell can be removed
> without removing the ability to produce a diff.**

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

> **Updated after installing it.** `grok 1.0.3`, contained in a temp directory,
> never authenticated. Every flag below is now CLI rather than DOCS, and one
> third-party claim was confirmed against the binary itself.

The flags are the best-shaped of the four: `-p/--single`, `--prompt-file`,
`--prompt-json`, `-m/--model`, `--cwd`, `--max-turns`, `--tools` (allowlist),
`--disallowed-tools`, `--allow`/`--deny` rules, **`--no-subagents`**, and
`--sandbox <PROFILE>` (also settable as `GROK_SANDBOX`). `--output-format` has
four values and two are structured in a *published* way:
`streaming-json` is "NDJSON of the agent native ACP session updates" and
`streaming-messages-json` is "NDJSON in the Anthropic Messages API wire format".
An adapter reading a documented wire protocol is a much better position than one
reading a bespoke shape.

The five sandbox profile names — `workspace`, `read-only`, `strict`, `devbox`,
`off` — were reported by a third-party page and are **confirmed present in the
shipped binary** beside the string `sandbox`. `danger-full-access` is absent.

It also ships `--dangerously-skip-permissions` and `--permission-mode
bypassPermissions` as Claude-compatibility aliases; the preflight must refuse
both by name.

**What could not be learned for free:** the sandbox profile list cannot be
elicited from the binary's own validation, because it checks authentication
*before* it validates flags — `grok --sandbox bogus -p "x"` answers "Not signed
in" rather than naming the valid profiles. Every readback question therefore
needs an account.

### Grok Build — the documentary picture, kept for the record

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

### Kimi Code — **verdict withdrawn; re-measured against the vendor's build**

> **A REFUSED AS MEASURED verdict was published here and is wrong.** It was
> measured against `kimi-cli` 1.49.0 from PyPI, which is a *legacy Moonshot
> product*, not Kimi Code. See "Standing rule: verify the DISTRIBUTION before
> you verify the capabilities" in `desktop/DESIGN-NOTES.md`.
>
> **Current verdict: `unverified`, attemptable, one open question.**

The vendor's distribution is `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
(repo `MoonshotAI/kimi-code`), which installs a single binary — **kimi-code
0.35.0**, installed here into a contained directory in WSL2 and dry-run. It
ships a `kimi migrate` subcommand whose help reads *"Migrate data from a legacy
kimi-cli installation into kimi-code"*, which is the vendor saying plainly that
the thing measured before was a different product.

| Question | kimi-code 0.35.0 | Source |
| --- | --- | --- |
| Headless one-shot? | **Yes.** `-p/--prompt`, and it implies nothing about approval | CLI |
| Structured output? | **Yes.** `--output-format text \| stream-json` | CLI |
| Model pinned? | **Yes.** `-m/--model`; current models are K2.7 Code and K3 (1M context) | CLI |
| Approval | **Opt-in.** Read-only tools auto-allow; `Write`, `Edit`, `Bash` need approval by default. `--yolo` skips regular approvals, `--auto` is fully autonomous | DOCS |
| Shell denial? | **Yes, and the strongest kind.** `[tools] enabled` is a positive allowlist its docs say is *"enforced again before execution"*, not merely shown to the model | DOCS |
| Sub-agents? | **Yes, and they are the concurrency finding of this pass.** `Agent` and `AgentSwarm`; a swarm takes **up to 128** subagents and by default "ramps up concurrency **without an upper limit**" | DOCS |
| Disable sub-agents? | **Yes** — same allowlist: omit `Agent` and `AgentSwarm` | DOCS |
| Permission rules? | `[[permission.rules]]` with `allow`/`deny`/`ask` and patterns like `Read(path-pattern)` | DOCS |
| Confinement readback? | **No.** Nothing reports the workspace it resolved | DOCS |
| Confinement itself? | **UNKNOWN — the open question** | NONE |

**What changed and what did not.** The earlier finding — that an absolute path
outside the working directory passes validation — was true of `kimi-cli` and
says nothing about `kimi-code`, whose file tools are a different
implementation. It has not been re-measured, and it cannot be without an
account: the binary is compiled, so there is no validator to run the way there
was in the Python package.

**So Kimi Code is `unverified`, not refused**, and the contract handles it
correctly either way: `confined_to_project` unverified **refuses admission**
until a probe answers it. The difference is that the reason is now honest — "we
have not checked" rather than "we checked and it failed".

**`KIMI_CODE_HOME` relocates its config directory**, so a Hivemind profile can
supply `[tools] enabled` without touching anything in the person's home.

**One thing worth flagging beyond Kimi:** an `AgentSwarm` of up to 128
subagents with no default concurrency cap is the sharpest example yet of why
`no_nested_agents` exists. Hivemind's `max_concurrent_workers` would be
governing one process that can fan out 128 ways underneath it.

### The withdrawn measurement, kept for the record

Recorded because the *procedure* failure matters more than the finding.
Installed `kimi-cli` 1.49.0 from PyPI and dry-ran it. Two findings, the second
decisive — **about the wrong product**.

**Its shell CAN be removed.** The agent specification is a YAML positive list of
tools, supplied with `--agent-file`. Dropping one line removes
`kimi_cli.tools.shell:Shell`, and dropping the `subagents:` block removes helper
agents. This is the strongest shell-denial mechanism of the four.

**It would not help, because the working directory is not a boundary.** Kimi's
own file-writing tool was executed here — no model call, the validator is local
code — and this is the shipped logic:

```python
# kimi_cli/tools/file/write.py
if (not is_within_workspace(resolved_path, self._work_dir, self._additional_dirs)
        and not path.is_absolute()):
    return ToolError(message=f"`{path}` is not an absolute path. "
        "You must provide an absolute path to write a file "
        "outside the working directory.")
```

Run against a real path outside the working directory:

```
is_within_workspace(absolute outside): False
absolute path outside work-dir     -> ALLOWED
relative path outside work-dir     -> REFUSED
```

The check only refuses a path that is outside **and relative**. An absolute path
outside the working directory passes — and the error message *instructs the
model how to do it*. `--work-dir` is a default root, not a fence. The only thing
between that and a write is approval, and `--print` auto-approves everything
("Print mode auto-dismisses AskUserQuestion and auto-approves tool calls for
this invocation" — its own `--help`).

So denying the shell protects nothing: `WriteFile` alone leaves the project.

**What would change the verdict**, and it is worth re-checking when Kimi
releases: an enforced workspace boundary on the file tools, or a sandbox. The
check above is four lines and one of them is the bug; a single `and` becoming an
`or` would flip this to adaptable.

### Kimi Code — the documentary picture, kept for the record

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

## 5. The probes, RUN — results

Both approved probes were run on 2026-08-12 against a scratch repository.
**Total cost: about $0.13, all of it Claude Code; the OpenCode probe ran on a
free model and cost nothing.** Both estimates (~15–25K tokens) were right.

### Claude Code — **passes, and reports more than expected**

`connectAdapter` returns `ok: true`. `system/init` carries everything the
discovery hoped for and one thing it did not:

```
INIT model      : claude-sonnet-5
INIT tools      : ["Edit","Glob","Grep","Read","Write"]
INIT permission : acceptEdits
INIT cwd        : <the project root>
INIT version    : 2.1.229
```

**The shell denial is verified by runtime readback.** `tools` came back as
exactly the allowlist that was passed, with no `Bash`. That was the single
load-bearing unknown and it is closed: Claude Code's shell denial can be
`verified` rather than `unverified`, which is what makes it admissible under
the contract at all.

**`claude_code_version` in the same event retires the separate `--version`
call** for this provider — the staleness check can read it from the run it
already made.

**One thing found that no amount of reading would have produced.** The `result`
record carries `modelUsage`, a per-model breakdown, and it shows **two** models
ran:

```
claude-haiku-4-5 : 541 in / 14 out / $0.000611
claude-sonnet-5  :   4 in / 167 out / 19,903 cache read / $0.0426
```

The pin took — the main agent ran the model asked for — but the process spent
tokens on a second model of its own choosing. So `pins_one_model` must compare
the **main agent's** model from `init` and separately report that other models
appear in `modelUsage`; comparing a single number would have hidden this.
Codex cannot report this at all, which means Claude Code is the first provider
where the cost-attribution half of the sub-agent concern is *observable*.

Note also `init.model` is `claude-sonnet-5` while the profile asked for
`sonnet`. The comparison has to resolve an alias to a canonical name rather
than test string equality, or every run would report a mismatch.

**A real defect was found and fixed by running this.** `claude-json` fed the
whole JSONL document to a single-object JSON parse, found nothing, and the
probe refused with *"the claude-json reader found no token counts"* — the right
refusal for the wrong reason. It now reads either shape. This is the third time
this project has had a capability that was only ever checked against recorded
output fail against a live one.

**Still `unverified`, and honestly so:** `confined_to_project` and
`pins_one_model`, because no `claude-init` readback reader is wired into the
probe yet. The raw capture proves the data is there; reading it is the build
task. Worth stating plainly: **the current three-state probe admits Claude Code
while the four-state contract would refuse it**, because confinement unverified
refuses. That gap is the argument for the migration, and it is exactly the case
the migration was meant to be proven against.

### OpenCode — **the shell deny holds, and usage is per step**

Run with `permission: { bash: "deny", task: "deny" }` and a prompt that asked
for a shell command. The model's own answer:

> *"I don't have a shell/bash tool available in this session, so I can't run
> `echo hello`. I'll create the file with the write tool instead."*

**The deny removes the tool from the model's toolset rather than refusing the
call.** That settles the precedence question the free readback could not: the
project rule wins, and the `bash allow *` sitting in the `explore` subagent's
table is unreachable once `task` is denied. It also demonstrates the shell-less
posture working end to end — the agent noticed, adapted, and completed the task
with `write`.

**Usage does not need `opencode export`.** Every `step_finish` event carries it
inline:

```json
"tokens": { "total": 6075, "input": 5754, "output": 117,
            "reasoning": 204, "cache": { "write": 0, "read": 0 } },
"cost": 0
```

So an `opencode-json` parser sums or takes the last `step_finish.part.tokens` —
simpler than the session-export route the discovery assumed.

**HEAD was unchanged** after the run, so `leaves_change_uncommitted` verifies on
the first provider it was written for. One thing to watch: every step carries a
`snapshot` hash, so OpenCode is writing git objects as it works. It did not move
the branch, which is what the capability measures, but a future adapter should
know those objects appear.

### What each provider needs next

> **Superseded 2026-08-12 — the first two rows are done.** This table was
> written before the probes ran. Both readers were built and both probes ran on
> 2026-08-12 (about $0.13, all of it Claude Code); Claude Code came back
> verified on 7 of 7 and OpenCode's deny was confirmed behaviourally. Kept for
> the record of what was outstanding at the time, with the current state below.
> Section 5 has the results.

| Provider | Remaining work, as of 2026-08-11 | State now |
| --- | --- | --- |
| Claude Code | a `claude-init` readback reader (model / tools / cwd / version), and alias→canonical model comparison. Then it is verified on five of seven. | **Built and probed.** Verified 7/7. Not corpus-certified — that is a separate paid decision |
| OpenCode | an `opencode-json` usage parser and an invocation; its readback is `agent list` plus the behavioural shell check, both proven today. | **Built and probed.** Deny confirmed from the run itself. Not corpus-certified |
| Grok Build | an account. Every readback question is still open. | **Unchanged.** Still needs an account |
| Kimi Code | an account, and one question: are its file tools confined to the workspace? | **Unchanged.** Still needs an account |

## The estimates that were given before running

Nothing below has been run. These are the two the discovery says are worth
buying, and what each answers.

| Probe | Estimate | What it settles |
| --- | --- | --- |
| **Claude Code** ×1 connect | **~15–25K tokens**, ~15–30s | Whether `system/init` names the resolved tools and permission mode. That decides whether the shell denial is `verified` or `unverified` — and for confinement, `unverified` refuses, so this single run decides whether Claude Code is admissible at all. Also whether `claude-json` finds real token counts in a live run's own output, which is the caveat that has kept it `unverified` since it was added. |
| **OpenCode** ×1 connect | **~15–25K tokens**, ~15–30s | Whether `opencode export` attributes tokens to one run, and whether a shell attempt is actually refused under `permission.bash: "deny"` — the precedence question the free readback cannot answer. |

**Why so much less than Codex's ~40K per connect.** Codex's probe pays for a
`--sandbox workspace-write` session with reasoning effort pinned high, on a
272K-context model. Both probes above are one trivial file write with no
reasoning pin, and Claude Code's is on `sonnet` rather than a flagship. The
estimate is deliberately a range and deliberately wide: the probe prompt is
fixed but the startup context a harness loads is not, and Claude Code loads
`CLAUDE.md` and any project hooks unless `--bare` is used — which this profile
deliberately does not use, because bare mode refuses OAuth and would break the
"no provider credential" rule.

**Worst case if both are wrong by 3×:** ~150K tokens total, about a fifth of one
first-run walk. **These are cheap.** The expensive thing is the corpus
certification, which is a separate decision and should be estimated separately
per provider once these two have passed.

**What I would buy first, if only one:** Claude Code. It is the provider most
people asking for this already have, and its single unknown is load-bearing —
if `system/init` does not name the tools, the shell denial cannot be verified
by readback and needs a behavioural canary instead, which is a design change
rather than a config change.

## 6. The migration, done and proven against the case that exposed the gap

`probeAdapter` now OBSERVES and `capability-contract.ts` DECIDES. The old rule
was `required && failed`, which admitted an agent whose confinement came back
`unverified`. That is the gap, and it is closed: admission is
`decideAdmission(findings)` and nothing else.

**Proven on the case that exposed it.** Claude Code, re-probed after the
`claude-init` readback was wired:

```
ok: true | version: 2.1.229 (from the run, not a second spawn) | 25,763 tokens
  verified   no_bypass_flags            ev=static       req=none       got=none
  verified   non_interactive            ev=observation  req=no prompts got=acceptEdits
  verified   confined_to_project        ev=readback     req=null       got=workspace-write
  verified   pins_one_model             ev=readback     req=sonnet     got=claude-sonnet-5
  verified   reports_usage              ev=observation  req=claude-json got=25,763 tokens
  verified   no_nested_agents           ev=readback     req=off        got=none
  verified   leaves_change_uncommitted  ev=observation  req=no commit  got=branch unchanged
degraded: []
```

**Seven of seven verified, nothing degraded.** It is admitted because its
boundary is now `verified` by readback — not because the probe is lenient. The
before/after is the point: the same agent, the same argv, refused by the
contract this morning and admitted this evening, and the only thing that changed
is that something now reads what the run reports.

Two results worth separating out:

**`no_nested_agents` is `verified` — the first time on any harness.** The tools
array is a positive report: it was read, and the dispatch tool is not in it. So
absence is evidence here, where on Codex the provider reports the capability
exists and nothing about whether it is off, which is why Codex's stays
`unverified` forever. **Claude Code is verifiable on the one capability the
project has been calling unclosable.**

**The model pin needed alias resolution.** `init.model` is `claude-sonnet-5`
where the profile asked for `sonnet`. String equality would have reported a
mismatch on every single run and refused a harness that did exactly what it was
told — the opposite failure to the one this check exists for, and just as wrong.
`modelPinHeld` treats a version-free name as an alias and requires an exact
match for anything carrying a digit, so the `gpt-5.5` regression still fails as
it always did.

**And the separate `--version` call is retired for this agent**, because
`claude_code_version` is in the same record. Spawning the binary again to ask
what it just told us is a wasted process and a second chance to be wrong.

## 7. OpenCode, adapted — the second provider through the contract

Written because the discovery was complete: the deny holds, tokens are inline,
the permission table is readable, and `leaves_change_uncommitted` verified on it
first. It is the second case through the four-state contract and it has a
**different evidence shape from Claude's**, which is what makes it a real test
of the generalisation rather than a second instance of the same thing.

```
ok: true | version: 1.18.15 | 11,189 tokens
  verified    no_bypass_flags            ev=static       got=none
  verified    non_interactive            ev=observation  got=bash denied
  verified    confined_to_project        ev=readback     got=workspace-write
  unverified  pins_one_model             ev=absent       req=opencode/deepseek-v4-flash-free
  verified    reports_usage              ev=observation  got=11,189 tokens
  unsupported reports_model_attribution  ev=absent       got=one total only
  verified    no_nested_agents           ev=readback     got=none
  verified    leaves_change_uncommitted  ev=observation  got=branch unchanged
degraded: ["cost_prediction","routing_provenance","tier_routing"]
```

**Six verified, one unverified, one unsupported — admitted, with three things
switched off and said out loud.** That is the degraded admission the contract
was built for, arrived at rather than designed: OpenCode reports no model
anywhere this reads, so the pin cannot be confirmed and tier routing is off.

**Where the evidence differs from Claude's, and why that matters.** Claude Code
reports what it resolved *in the run*. OpenCode reports what it resolved
*before* the run — `opencode agent list` prints the merged permission table for
free, no model call. The contract needed no change to accommodate that, which is
the generalisation holding: `readback` is a class of evidence, not a place it
comes from.

But the free readback proves only that a rule was **accepted**, not that it
**wins** — the `explore` subagent's table carries both `bash allow *` and our
`bash deny *`, and the print does not say which. So the probe corroborates from
the run itself.

**And the corroboration had to be rewritten before it was right.** The first
version matched the model's sentence — and failed, because it expected "do not
have" and the model wrote "I don't have a shell tool". Matching a model's prose
is the mistake this project has now recorded three times. It reads the stream
structurally instead: the probe prompt asks for a shell command, and a run with
a shell emits a `tool_use` event naming it. A fact in a field, not a sentence in
a reply.

**Two things the adapter needed that the discovery had not surfaced:**

- **`opencode` is a `.cmd` shim on Windows**, so the readback could not spawn it
  directly — the identical trap that once left a Linux clone holding three
  unusable profiles. The platform branch belongs in the readback for the same
  reason it belongs in the invocation.
- **The usage parser is per-step, not per-run.** Every `step_finish` carries its
  own `tokens` block and there is no run-level total anywhere, so the reader
  sums the steps.

## 8. The corpus comparison — half run, and the estimate was wrong

**Posture A is measured. Posture B is not, because the estimate was wrong by
enough that continuing was a decision rather than an execution.**

### What was measured

> **⚠ Caveat added 2026-08-13, after the fact.** Every corpus task lists
> `corpus-check.mjs` — the deterministic conformance check — in its
> `read_only_files`. **The agent could read the check it was about to be scored
> by.** So these numbers measure *can this model satisfy a printed check*, not
> *did it understand the contract*. The run is real and the tasks really passed;
> what the pass is evidence **of** is narrower than this section originally
> claimed. The same caveat attaches to Luna's 30/30 and to the routing weights
> promoted on `CC-20260803235418-…`, which may still be right but rest on
> weaker evidence than recorded. Nothing is withdrawn: a finding can be correct
> and its evidence still insufficient for the claim it was used to support.
> Generalised as *a judge visible to the judged measures compliance with the
> judge* in `desktop/DESIGN-NOTES.md`; the replacement holds the check out of
> the repository entirely (`docs/BENCHMARK-DESIGN.md`).

Codex `gpt-5.6-luna`, high reasoning effort, the three corpus tasks including
the dependent one, shell **enabled**:

| | shell-enabled |
| --- | --- |
| Attempted / succeeded | 3 / 3 |
| Revisions | **0** |
| Tokens | **403,544** |
| Cost | $0.0147 |
| **Cost per successful task** | **$0.0049** |

| Task | Tokens | Files | Revisions | Checks |
| --- | --- | --- | --- | --- |
| T-001 document the format | 123,202 | 1 | 0 | pass |
| T-002 sort module + tests | 92,665 | 2 | 0 | pass |
| T-003 CLI + tests (**dependent**) | 187,677 | 2 | 0 | pass |

Every task landed on its first attempt with the validity check and the shadow
tests passing. That is the baseline the shell-less posture has to be compared
against, and it is a demanding one: **there is no revision headroom to lose**.
A shell-less worker cannot do better than 0 revisions; it can only do worse.

### The estimate was wrong, and how

**Estimated 40–55K per call. Actual 92K–188K.** Posture A alone came to 403K
against a 270K approval for *both* postures.

The error has a specific cause worth recording: the estimate was extrapolated
from the preflight, which was **one trivial file write at `low` reasoning
effort**. The corpus profile runs at `high` effort on tasks that write real
modules with tests. Reasoning tokens and iteration count both scale with that,
and neither was in the sample the estimate came from.

> **An estimate extrapolated from a cheaper configuration than the one being
> estimated is not conservative — it is wrong in the direction that gets
> approved.** The preflight was the right thing to run and the wrong thing to
> extrapolate from.

### The rule caught something prospectively — 2026-08-13

**First time one of these standing rules has fired before the money was spent
rather than after.** Worth recording, because a rule that only ever explains a
past mistake is indistinguishable from a good story.

Estimating the raw-Codex arm of the replacement benchmark, the first draft came
out at 45–83K per prompt — **below the observed 92–188K floor for this exact
configuration** — on the reasoning that raw Codex has no planner or verification
calls and should therefore cost less.

That is this rule exactly, in a new costume. Removing Hivemind's overhead does
not move the dominant cost, which is **high-effort reasoning over the same
repository**; the overhead was never the large term. The estimate was corrected
to 250–500K before anything was approved, and the correction is what put the
staged option on the table at all.

The tell, for next time: **the draft estimate was below the measured floor of
the same configuration.** That comparison is cheap and mechanical, and it is the
one to run against any estimate before presenting it. An estimate that comes in
under something already measured needs a reason, and "it does less work" is not
one unless the work removed is the expensive part.

### What finishing would cost

Posture B is the same three tasks with `--disable shell_tool`. Expect a similar
403K if the shell-less worker performs comparably, and **more** if it revises —
which is the outcome the comparison exists to detect, so the cost is correlated
with the result being interesting.

| | |
| --- | --- |
| Spent so far | **403K** (posture A) + 37K (preflight) |
| Posture B estimate | **400–550K** |
| Total to finish | **~840–990K** |

Against an approval of 270K. Not spent.

### Deferred, not abandoned — and why stopping was right

**Posture B will not be run.** The control arm settled the question it needed
to, in a way that made the second half not worth its price:

- **There is no revision headroom to lose.** 0 revisions is the floor. A
  shell-less worker can match it or fall short; it cannot beat it. So posture B
  cannot produce a result that favours the shell-less posture — only one that
  is neutral or negative.
- **The informative outcome is also the expensive one.** If shell-less workers
  revise, the run costs *more* than 403K, and the more interesting the finding
  the larger the bill.
- **It would not change the decision.** Shell-less was adopted on
  **correctness and generalisation** — it makes confinement a property of the
  argv rather than of an OS sandbox that one harness does not report, one does
  not support on Windows, and one silently disables when it cannot start. Cost
  was never the argument for it, so a cost number cannot settle it.

**What the baseline is worth on its own.** It is a shell-**enabled** Codex
measurement at high reasoning effort over three tasks including a dependent
one, and it bounds how bad shell-less could be: any degradation shows up
against 0 revisions and $0.0049 per successful task.

**What would make it worth running.** A real report of degraded first-attempt
quality from a shell-less worker — a rejection rate that looks worse than this
baseline in ordinary use. Then the comparison has a hypothesis to test rather
than a number to collect, and this baseline is what it is measured against.

## What this pass did and did not do

**Built and tested:** the contract (`src/capability-contract.ts`, 12 tests); the
version-staleness rule (`src/adapter-version.ts`); the measured commit check
(`src/repo-observation.ts`, now a live capability in `probeAdapter`); the
shell-denying invocations and the `shell_denial` record on every catalogue
entry; and `test/provider-knowledge.test.ts`, which fails if a fourth file in
`src/` branches on a provider by name.

**Deliberately not built:** any new adapter, and the migration of
`probeAdapter` onto the four-state contract. That migration happens alongside
the first new provider so the generalisation is proven by a second case rather
than designed for one — approved on that basis.

**One rule changed as a result of this pass.** The catalogue used to require
`invoke === null` for anything unproven, so an unproven agent could not be
connected at all. That has been replaced: **the probe is the gate.** An agent
may now carry the argv the probe will run — that is how it earns a status
instead of keeping one forever — and `connectAdapter` still records nothing
unless the probe passes. An `unsupported` agent keeps `invoke === null`, because
it has been measured and refused and there is nothing left to attempt.

---

## Presentation material

`docs/evidence/presentation/provider-board.html` — the provider table, the six
headline numbers with what each does and does not measure, the T-002 story, and
the verified replay details, in one page. Published as a private artifact.

Two things it says that are worth keeping straight when the numbers are quoted
out loud:

- **Tier routing saves roughly half, not 54.7×.** The 54.7× is real and applies
  to Low-tier work in isolation. Across one task of each shape it is 52.4%,
  because Medium is 2.4× and High and Critical stay on the flagship by design.
  And it bought a *cheaper token*, not less work: Luna and Terra used token
  volumes 0.22% apart.
- **The replay's event clock is 28.9s; page-load to shipped is ~34s.** The
  difference is app boot before the first event lands. A recording should start
  when the four tasks appear.

## 9. The contract had no idea where your code goes — 2026-08-14

**A ninth capability, and the first one added because something was *missing*
rather than because a provider behaved unexpectedly.**

Every capability in the contract was about what an agent may **do**: which flags
it carries, where it may write, whether it commits, whether it spawns
sub-agents. None of them asked **where the prompt is sent** — and a prompt
carries the contents of every file in the task's scope.

`ANTHROPIC_BASE_URL`. Codex's `model_providers[].base_url`. OpenCode's
`baseURL`. Set any one of them and the harness talks to that host instead of the
vendor's, ships every file it is working on there, and **all eight existing
capabilities still read `verified`.** Nothing in the system noticed, and nothing
in the system could have.

This is not a local-model concern. Anyone who has set one of those variables is
in this state today and was before local models were raised.

### What can be determined, and what cannot

The obvious design is to read the endpoint back the way `pins_one_model` reads
the model. **That is not available.** Codex's `turn_context` — the richest
readback any of these harnesses produces — carries the model, the sandbox, the
approval policy and the workspace roots, and **no endpoint at all**. Checked in
the shipped binary rather than assumed.

So `known_endpoint` is determined from configuration, and its evidence class
says `static` rather than borrowing `readback`'s authority. Three inputs, in
override order: the profile's argv, the environment the process will be spawned
with, and the harness's own config file in the home it will actually read —
which the account mechanism may have changed, so the home is resolved from the
same variable that selects an account.

### The three states, and why the middle one exists

| Standing | Meaning | Admission |
| --- | --- | --- |
| `vendor_default` | No override anywhere | **Verified.** The vendor's documented endpoint |
| `configured` | An override is set | **Verified, and NAMED.** Somebody chose it; that is not a violation. But the host is recorded on the connection and shown, because a deliberate choice must not hide behind a green tick |
| `unknown` | Hivemind cannot inspect this harness | **Refuses** |

The middle state is the interesting one. A configured endpoint is a *decision*,
not a fault — refusing it would make local models and proxies impossible, which
is not the goal. What was wrong was that the decision was **invisible**.

The refusal is the other half:

> "Hivemind cannot tell you where your code is going" is not a degradation
> anyone can accept on your behalf.

Same asymmetry as `confined_to_project`: being wrong is unbounded, so unsure
fails closed. A harness Hivemind does not know how to inspect is refused rather
than run hopefully — which also means adding a harness now requires saying where
it sends things, rather than that question being skipped by default.

One implementation note worth keeping: the config search is textual rather than
a TOML/JSON parse. Three harnesses use three formats, and a parser that fails on
an unfamiliar dialect would report "no override" for a file that has one. A
regex errs toward *finding* an override, which is the safe direction here.

## 10. Grok Build — live probe refused on two required boundaries — 2026-08-17

The first-party npm package `@xai-official/grok` 1.0.4 is installed on this
machine. `grok inspect`, `grok models`, and the full help surface were read
without a model call, then device authorization completed and one real
Hivemind connection probe ran.

### What is needed

| | |
| --- | --- |
| **Account** | An **X.AI plan** (the consumer subscription that includes Grok Build) **or** an `XAI_API_KEY` |
| **Install** | Complete: first-party `@xai-official/grok` 1.0.4, the npm alternative named by xAI's enterprise documentation |
| **Result** | The probe ran and refused; no adapter or connection record was written |

Either credential works. The API key is the cheaper way to answer the one
question below if a plan is not wanted, though a plan is the shape the product
assumes elsewhere.

### The prepared invocation

```
grok --model grok-4.5
     --tools read,write,edit,glob,grep
     --no-subagents
     --sandbox workspace
     --output-format streaming-messages-json
     --single "<prompt>"
```

Windows takes the `cmd.exe /d /s /c grok.cmd` prefix, like the other two `.cmd`
shims. Verified against the guards already: `findDangerousAdapterArgs` returns
`[]` and `findRefusedAdapterModes` returns `[]`, so the prepared argv cannot
carry `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`
— the two Claude-compatibility aliases Grok also ships.

Four deliberate choices:

- **`grok-4.5`, not `grok-code-fast-1`.** xAI retired the old code slug on
  2026-05-15, and the installed CLI now lists `grok-4.5` as an available
  current model. The old invocation still resolved through a redirect, which
  would have made the model-pin check report the wrong thing.

- **`--tools` as a positive allowlist**, so the shell is *absent* rather than
  denied. Same shape as Claude Code, which is the posture that verified there.
- **`--no-subagents`** — the only provider with a dedicated switch for it.
- **`--sandbox workspace`**, the narrowest profile that still permits the writes
  a worker must make. `danger-full-access` is absent from the binary entirely.
- **`streaming-messages-json` over `streaming-json`**, and the trade is worth
  stating. `streaming-json` is the ACP session stream and is where an init event
  would appear if one exists — the readback question. `streaming-messages-json`
  is documented as **NDJSON in the Anthropic Messages API wire format**, whose
  usage block `claude-json` already parses and is verified against.

  **Usage decided it.** An agent with an invocation and no usage reader refuses
  on a capability nothing could satisfy, so a prepared probe with no parser
  would never pass — `config-actions.test.ts` enforces exactly that, and caught
  the first attempt. Reusing a parser for a format the vendor documents *as*
  that wire format is not a guess; writing one for an unmeasured shape would be.

  It fails safe either way: if Grok's stream differs, the parser finds nothing,
  `reports_usage` returns unverified, and the contract **admits with spend
  ceilings off and the person told** rather than refusing.

### What the real probe settled

The Hivemind probe used the exact catalogue invocation and finished in 4.8s:

- It wrote the requested file inside the disposable project.
- Its Anthropic-compatible stream reported **10,063 effective tokens** and
  attributed the call only to `grok-4.5-build`.
- It exited without prompting and left the branch unchanged.
- It did **not** report the resolved sandbox, so a successfully written canary
  cannot prove where else it could have written. The required confinement claim
  stayed unverified and refused.
- Core has no Grok entry in its endpoint-configuration surface. The CLI permits
  custom model `base_url` values, so the endpoint cannot be assumed from the
  vendor default. That required claim also stayed unverified and refused.

A second, smaller call against `streaming-json` produced an
`available_commands` record, incremental output, usage, and an end record. It
still did not report the resolved sandbox. This rules out switching formats as
the missing fix. The call used 4,825 effective tokens.

No paid Kimi call was made. The installed 0.36.1 CLI has no configured provider
or account, so only its local doctor/configuration and documented tool-policy
surface were verified.

### Installed-screen evidence

`npm run ship` built, installed, and verified desktop build **26.817.1422**.
`docs/evidence/provider-setup-26.817.1422.png` is the running installed app at a
1440x900 client area (the capture includes the one-pixel Windows frame and title
bar). It shows all five provider marks loaded, native-scale checkbox relief,
the filled Continue ramp, and Grok/Kimi disabled as “Cannot connect yet.” The
production reachability/resource check also passed every surface at 1280x720,
1366x768, and 1440x900 with no image or CSP error.

Everything below is doc-derived and unexercised until then. The binary checks
authentication *before* it validates flags, so no more can be learned for free.

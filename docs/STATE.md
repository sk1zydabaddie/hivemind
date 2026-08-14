# Where Hivemind actually stands

**Written 2026-08-14, for someone who has not read the sessions that produced
it.** Every claim here names its evidence, and every gap names its blocker. If
you are picking this up cold, read this file before the others: it is the map of
what is true, what is thin, and what is missing.

The rule this file exists to serve: **a claim without evidence is a plan.**

---

## 1. What works, with the evidence

### A clean install reaches a shipped commit with no terminal

`docs/evidence/e2e-2026-08-11-firstrun-noterminal/`

A fresh git repository with a `package.json`, one source file and **no
`.hivemind`**, driven through the twelve typed actions the desktop dispatches,
in the order it dispatches them — project init, three probed agent connections,
a typed prompt, a plan, one review, the run, the ship. Every step returned ok.

Verified in the repository rather than in the action results:

```
bd64af8 Hivemind adoption V-335aa795-…   src/greet.js | 3 ++
npm test on master after adoption: 1 test, 1 pass, 0 fail
```

**Cost: 294,500 tokens over 6 calls** — three probes (~118K) and the work
(~176K). Worth stating plainly, because connecting three agents is a third of a
first run's bill.

Confirmed again by clicking, not only by dispatching:
`docs/evidence/e2e-2026-08-11-gui-confirmation/` drives the release build over
the WebView2 debugger — real clicks, real `Control+Enter`, **no action
dispatched directly** — and reaches a shipped commit whose tests pass.

### Two platforms green, with counts

| Platform | Filesystem | Result |
| --- | --- | --- |
| Windows | NTFS | **761 passed, 0 failed, 2 skipped** |
| Linux | native ext4 | **763 passed, 0 failed, 0 skipped** |

Plus desktop **180 passed / 16 files** and Rust **15 passed**.

The two skips are genuine platform skips, not hidden failures. The counts differ
legitimately. Both numbers must come off that platform's **native** filesystem —
see the rig rule in §4.

To reproduce the Linux number: copy the tree to a path on the distro's **own**
ext4 (`~`, not `/mnt/d`), `npm ci`, `npm test`. Two traps, both hit before:

- **Name the distro.** `wsl.exe` runs the *default*, which is not necessarily
  the one with the toolchain — the default here is a Debian image with
  `automount` disabled, where `/mnt/d` does not exist. Use `-d Ubuntu-22.04`.
- **Copy `docs/evidence`.** Excluding it removes a fixture the suite reads, and
  the failure that produces looks like a real one.

### Three harnesses pass the capability contract

`docs/PROVIDER-DISCOVERY.md`

Capabilities are **measured, never declared**. Connecting an agent runs it once
and compares what the provider reports against what the profile asked for; the
result records the delta, not the request.

| Harness | State |
| --- | --- |
| Codex | **Supported.** Real runs have gone through it end to end |
| Claude Code | **Verified 7/7** by probe. Reports more than expected — including a per-model usage breakdown Codex cannot produce |
| OpenCode | **Probed and verified.** Shell denial confirmed from the run itself, not from the flag |
| Grok Build | Prepared, never run — see §3 |
| Kimi Code | Refused as measured, with the reason recorded |

The contract has **nine** capabilities. The ninth, `known_endpoint`, asks where
the harness sends your code — a prompt carries every file in scope, and a base
URL redirects all of it while the other eight still read verified.

### Concurrency proven causally, not sampled

`Hivemind_Build_Progress.md`, M10.8

Two independent High tasks through Auto with two simultaneous confined workers.
Worker windows **56.579s and 96.314s, overlapped for 55.462s**, completing in a
**97.431s** concurrent window against a **152.893s** same-run serial equivalent
— 36.3% lower wall time, 1.57× speedup.

Causal rather than sampled: each task held a **disjoint two-file lease** and its
own reservation; both patches passed the scope gate, both contract validity
checks and the combined 15-test shadow suite; exact-set verification
`V-ec02bcec-…` named both survivors. `master` moved atomically from
`253176ae` to `c14bcd9c`, and independent repository checks found the adopted
tree and all 15 tests. Cleanup left zero task worktrees and zero active
reservations.

### The deterministic happy path

A run that needs no human decision takes no human decision. Autonomy is a
per-project policy (`auto` / `review_plan` / `review_everything`), and in `auto`
the M10.8 demonstration **demanded no attention until adoption**.

### Tier routing, promoted on real evidence

Routing keys off task tier, with a promoted policy learned from measured
outcomes rather than configured by hand. One policy has been promoted:
`M-37f4a2a0-…`, from a controlled shadow corpus report.

**Read §2 before citing this one.**

---

## 2. What is claimed but thin

Nothing here is withdrawn. Each is a real result whose evidence is weaker than a
first reading suggests.

### The tier-routing evidence rests on a judge the judged could see

Every capability-corpus task listed `corpus-check.mjs` — the deterministic
conformance check — in its `read_only_files`. **The agent could read the check it
was about to be scored by.**

So the corpus measured *can this model satisfy a printed check*, not *did it
understand the contract*. The runs are real and really passed. What they are
evidence **of** is narrower than recorded, and that caveat attaches to Luna's
30/30, to the 3/3 shell-enabled control arm, and to the routing weights promoted
on that evidence.

The policy may well still be right. Its evidence is weaker than the record said.

### Enforcement's value rests on two incidents, not a rate

The case for the gates is **observational**:

- a real worker that reached for `package.json` during an actual run;
- T-002's wrong interface shipped with green self-authored tests.

Both are single observed incidents. Neither is a rate. The gates are justified
by *failures that did happen*, not by a measurement showing they would happen
again.

### The benchmark did not find in enforcement's favour

`docs/BENCHMARK-STAGE1.md`

Raw Codex, given a precise specification with the edge cases enumerated,
produced correct code and a test suite that **rejects a wrong implementation**.
The gates had nothing to do on the two tasks tested.

The finding is about **specifications, not gates**: what made it come out right
was an acceptance criterion enumerating the edge cases — which is *planner
output*, not something a person types into a prompt box. So such evidence as
exists supports Hivemind's planner rather than its enforcement, which is not the
claim the instrument was aimed at.

Two of three failure modes were never run. One task per mode, one model, one
run. **Do not cite this as validation, and do not cite "inconclusive" as
validation either.**

### Project memory is machinery with an empty store

Two-tier store built and verified. **Exactly one item has ever been promoted.**
The Project surface reads *"nothing has been added to this project's standing
guidance"*, and that is accurate.

What would fill it needs sustained use on one project, which this repository has
not had — it has been *building* Hivemind rather than using it.

**Do not confuse this with the stateless orchestrator over a durable trail**,
which is built, exercised on every run, and load-bearing. Because the
orchestrator holds no conversation, context rot cannot happen to the planner —
*structurally*, and that holds with the canon permanently empty. Crediting an
empty store with a benefit that comes from statelessness is claiming a result
for the wrong component.

### Claude Code and OpenCode are verified, not certified

Both pass the connect probe. **Neither has had a whole piece of work built and
shipped through it.** Corpus certification is a separate paid decision and has
not been made. The honest launch sentence is *"Codex certified; Claude Code and
OpenCode probed and verified; Grok probed but not certified; Kimi refused, here
is the reason."*

### The Grok usage reader is borrowed, not measured

`claude-json` is reused for Grok on the documented match that
`streaming-messages-json` **is** the Anthropic Messages wire format. It has
never seen Grok's stream. Marked `UNVERIFIED-AGAINST-GROK` in the catalogue —
labelled before the probe rather than discovered during it.

It fails safe: if the stream differs, usage returns unverified and spend
ceilings degrade rather than the probe refusing.

---

## 3. What is not built, and what blocks each

| Item | Blocker | Cost when unblocked |
| --- | --- | --- |
| **macOS verification** | **No hardware.** Case verdict, process control, Finder PATH, `.app`/`.dmg` launch, WebKit vs WebKitGTK, temp dirs | ~1 hour on a Mac |
| **macOS codesigning + notarisation** | **Apple Developer account, $99/yr** | Half a day. Buys distribution, not correctness — an unsigned `.app` runs after a right-click Open |
| **Windows code signing** | **A certificate — see §3.1.** Deliberately deferred: the beta ships unsigned with a plain note on the download page, so SmartScreen is expected rather than a surprise | An hour once a certificate exists. Tauri supports it in config directly |
| **Grok Build** | **An X.AI plan or an `XAI_API_KEY`.** Everything else is ready: install from `x.ai/cli/install.sh`, then connect it like any other agent. The argv is prepared and verified clean against both bypass guards | ~15–25K tokens, one probe. It answers one question: does the stream carry an init event naming the resolved model, tools and sandbox |
| **Kimi Code** | **An account**, plus one open question: are its file tools confined to the workspace | One probe |
| **Local models / custom endpoints** | **Nothing structural remains.** The egress capability was the prerequisite and is built — all three harnesses already accept a custom base URL, and `known_endpoint` now names a configured one and refuses an undeterminable one. What is left is a profile shape per backend and a decision about what `reports_usage` means when tokens are free | A pass, no account |
| **WebKitGTK GUI walk** | Nothing — buildable now | **1–2 days.** The largest remaining piece; it is what would let a click-level walk run anywhere but Windows |
| **Linux `.desktop` launch PATH** | Nothing. **Half done**: the failure explains itself and the escape hatch resolves, both tested. What remains needs a machine with a desktop environment to confirm a display manager hands the app a minimal PATH | 20 minutes on a Linux desktop |
| **Schema migration beyond two formats** | Nothing — a decision. **21 modules declare `version: 1` and hard-fail on `!== 1`, and no format is ever version 2.** The convention is present and inert; only task contracts and `daemon.json` have real migration | A pass per format, or a decision to leave them |
| **`.hivemind` retention** | Nothing — but it interacts with the trail-rebuild rule, so it is *classify then prune*, never age or size. One corpus run logged ~7M tokens of evidence | A pass, after the classification |
| **Dogfooding** | Nothing. Deferred since M3; M10.4 removed the serial limitation that justified it | A deliberate demonstration |
| **Four unreachable actions** | Nothing — no UI. `manual_task.review` / `manual_task.authorize`, `verify.characterize`, `quality.best_of_n` / `quality.draft_refine`. All audited, all working, none reachable | Half a day |
| **Attention on a project you are not looking at** | A decision. Knowing requires asking that project's daemon; starting one per recent project to render a dot is a real cost, and an invented badge on the screen whose purpose is *where should I look* is worse than none | Small, once the "ask only running daemons" shape is accepted |

### 3.1 Windows code signing — the options, for when there is revenue

Nothing is signed today, on any platform. Verified with
`Get-AuthenticodeSignature`: both the installer and the installed binary read
`NotSigned`. **This is a decision, not an oversight** — the beta ships unsigned
and the download page says so plainly, so a SmartScreen prompt is something the
reader was told to expect rather than a reason to distrust the download.

What an unsigned Windows download costs: SmartScreen shows the full-screen
"Windows protected your PC — unrecognised app", with Run hidden behind *More
info*. Developers click through it without thinking, which is close to the
entire current audience. It becomes a real problem at consumer scale, and it sits
awkwardly against the product's own pitch — a tool that refuses to act on what it
cannot verify, arriving as a binary the OS says it cannot verify.

**Tauri supports signing directly**, confirmed against the installed CLI's
config schema (`@tauri-apps/cli` 2.11.2): `bundle.windows` accepts
`certificateThumbprint`, `digestAlgorithm`, `timestampUrl`, `tsp`, and
`signCommand`. No custom pipeline is needed — a certificate and four config keys.

| Route | Rough cost | The catch |
| --- | --- | --- |
| **Azure Trusted Signing** | **~$10/month** | **Requires a verified legal entity that has existed 3+ years.** That, not the price, is the likely disqualifier — and it is a clock nobody can shorten, so it is worth checking the entity's age *before* budgeting for anything else |
| OV certificate | ~$200–400/yr | Since June 2023 the key must live on FIPS 140-2 Level 2 hardware — a physical token that must be plugged in to sign. Removes "unknown publisher" but **starts at zero SmartScreen reputation**, so early downloaders may still see the prompt |
| EV certificate | ~$300–600/yr | Same hardware token. The only option granting **immediate** SmartScreen reputation |
| Self-signed | free | Worthless for this purpose. Satisfies SmartScreen not at all |

Prices are approximate and move; confirm before committing. The ordering
conclusion does not depend on them: **check the entity-age requirement first**,
because it decides between a $10/month line item and a $300+/yr one.

---

## 4. The standing rules

These were each learned from a specific failure. They are listed here so the
next session does not have to rediscover them.

### About evidence

> **The trail must rebuild state.** The projection is reconstructed from durable
> events. Anything that mutates the repository through a path emitting no event
> breaks it silently — which is why there is no embedded terminal.

> **Capture the trail AND the project state**, and date the capture at the
> moment the surface is being replayed at. A run's state is not all events: the
> plan, the ledger, the spec and the contracts are *files*.

> **Real trails verify; fixtures only lay out.** A surface judged against a
> fixture has been judged against something nobody ran.

> **Recorded output is necessary and never sufficient.** A capability may be
> developed against recorded output and never CLAIMED from it. Four instances.

> **A provider's documented surface is a LOWER BOUND on its actual surface.**
> Two undocumented capabilities have been found by looking: `--ephemeral` and
> `--disable shell_tool`.

> **Verify the DISTRIBUTION before you verify the capabilities.** A verdict was
> once reached against the wrong package entirely.

### About gates and privilege

> **When you loosen a gate, audit what GRANTS the thing it guarded.** The gate
> is rarely the only door.

> **A function that grants a privileged state verifies its own preconditions.**
> Not its caller. Callers multiply.

> **Control flow never depends on message text.** Codes, never prose. Matching a
> model's sentence has failed three times.

> **Chat steers, buttons authorize.** A note on a diff line cannot approve,
> ratify or ship anything.

> **When unsure, fail in the direction that costs least if you are wrong.**
> Unverifiable confinement refuses; unverifiable usage reporting degrades with
> the ceiling switched off and the person told.

### About instruments

> **An instrument that can only return one answer is not evidence.** Six
> instances — an absent-string assertion, a no-hazard confinement test, a
> shell-less preflight, a timer-based screenshot harness, a judge visible to the
> judged, five fixture-only UI passes.

> **A rig that measures something other than what you think is not evidence
> either.** Four instances — drvfs hiding file-mode failures, 9p inventing
> daemon timeouts, an rsync exclusion removing a fixture a test needed, and a
> superseded run's processes hanging the next one. **A platform result must come
> off that platform's native filesystem.**

> **A judge visible to the judged measures compliance with the judge.**

> **A word ban cannot express a structural rule.** Four instances, every one
> catching the prose that explains the rule. Constrain shapes; strip comments;
> and remember the fourth was rendered UI copy, which stripping comments does
> not reach.

> **A fixture is a claim about what the system's data looks like.** Three tests
> once asserted correct behaviour over a repository that cannot exist, all green
> while the feature did nothing at all.

### About the record

> **Anything worth tracking gets written to a file in the pass that creates
> it.** An unrecorded item is dropped; a *remembered* one is unfalsifiable — it
> cannot be verified, corrected or closed, and it competes for attention with
> work that can. Both directions cost the same, and this project has produced
> both: two real items that existed only in conversation, and one phantom
> backlog that was being prioritised against and had never existed.

> **A fix is not done when it is committed. It is done when it has run.** The
> calendar versioning was written, tested and committed, and could never
> execute: its config file was generated by the build hook that ran *after* the
> CLI had already required the file. Three passes of packaging work, all correct
> on paper, and the reported symptom never changed. **A build hook cannot
> produce the build's own arguments** — a generated input must exist before the
> tool that reads it starts.

---

## 5. Where to look next

| Question | File |
| --- | --- |
| Why is the client shaped like this? | `desktop/DESIGN-NOTES.md` |
| Why does Core behave like this? | `docs/DESIGN-NOTES.md` |
| What did each provider actually do? | `docs/PROVIDER-DISCOVERY.md` |
| What can each typed action reach? | `docs/m8-action-routing-audit.md` |
| What is left of the port? | `docs/CROSS-PLATFORM.md`, `docs/MACOS-CHECKLIST.md` |
| What did the benchmark not show? | `docs/BENCHMARK-STAGE1.md` |
| One closed finding, kept for its cause | `docs/AUDIT-FINDINGS.md` |
| Everything deferred, in one register | `Hivemind_Build_Progress.md` |

**There is no audit backlog beyond `AUDIT-FINDINGS.md`.** If a plan refers to
numbered findings above F-1, that list does not exist and never did.

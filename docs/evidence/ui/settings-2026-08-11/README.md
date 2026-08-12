# Settings and bring-your-own-agent — 2026-08-11

The last thing between a fresh install and a text editor. The screen this
replaces said *"Hivemind cannot read these from here yet"* beside three profile
paths; it now reads them, writes them, and verifies the agent behind them.

At 1440×900, replayed from **real captured state**: a scratch repository that
was really initialised with `project.init` and really connected with
`adapter.connect` against `codex-cli 0.147.0`. The probe capabilities shown are
what the provider reported back — see
`docs/evidence/adapter-probe-2026-08-11/`.

| # | What it shows |
| --- | --- |
| 01 | The three roles Core resolves by name, and the agent catalogue with its real status |
| 02 | The connect flow: every capability as **asked X · got Y** |
| 03 | Tier routing in plain language, both ceilings, concurrency, the test command, interruption level |

## What 01 is showing, which is the point

`planner` and `manager` read **"Installed before Hivemind could check it —
reconnect to verify what it can do."** Those are the profiles `initProject`
writes so a first prompt has something to resolve: declarations, pinned to the
flagship, that nothing has ever run. `worker` reads *"Checked when you connected
it"* with a mark, because it went through a probe.

That distinction is the whole build. Before it, all three looked identical.

## What 02 is showing

Six capabilities, each reported as a delta rather than as a claim:

- **Runs the one model you chose** — `asked gpt-5.6-terra · got gpt-5.6-terra`,
  read out of the provider's own session record.
- **Can write in this project** — `asked workspace-write · got workspace-write`,
  plus the file it was told to write actually being on disk.
- **Reports what it spent** — `asked codex-jsonl · got 42,032 tokens`, found in
  that run's own output.
- **Does not start agents of its own** — `asked off · got v2`, marked
  **unverified**: it reports a sub-agent capability and does not report whether
  it is switched off. Unverified never becomes supported.

## Honest about what works

Three Codex tiers are *Proven on real runs* — one harness, three models, which
is what tier routing needs. **Claude Code** is *Unverified* and cannot be
connected: its usage parsing has only been checked against recorded output, and
the profile it used to ship with carried a permission-bypass flag this build
refuses. **OpenCode** is *Not integrated*: no argv, no usage parsing, no run
ever. Both state the reason on screen rather than being hidden, because a
spending limit built on unverified usage numbers is worse than no integration.

## The number in 03 is measured, not guessed

"One agent call really costs 106,792–179,698 tokens on this project's own runs"
comes from Core, taken from the 2026-08-11 runs. A run ceiling below that stops
a run *after* the money is spent, so the field warns in amber when it is set
there.

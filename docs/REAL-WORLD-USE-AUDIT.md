# Real-world use review — 2026-09-05

Original review scope: follow-up to the approved conversation repair, especially interactions
that can satisfy tests while frustrating real development. Findings only: this
review does not authorize an architectural rewrite or weaken approval gates.
No paid providers were invoked. Source findings below are not presented as
installed reproductions; runtime observations are recorded separately.

## Remediation status — authorized 2026-09-05

The user has now requested fixes for all 17 findings. The historical findings
below retain their original evidence; a finding closes only after its own
acceptance evidence is recorded here. **1 of 17 is closed: U10.** The other 16
remain open; the next independent checkpoint is U3's project-owned draft state.

- **U10 closed:** updated only the existing `src/project-files.ts` reader and
  `test/project-files.test.ts`, with this ledger and STATE. Acceptance: actual
  content reads stay within 512 KiB, full size is stat-derived, short reads and
  UTF-8 boundaries are correct, errors/changes release the handle, and existing
  dispatcher/root-confinement regressions pass. Remove whole-file loading;
  keep the public action/response shape and all authorization checks unchanged.
- **U1 decision pending:** Overview's spec-ratification-before-planning rule
  conflicts with current Core's tentative-proposal-before-ratification rule.
  Neither rule is silently changed while that decision is unresolved.
- U2–U9 and U11–U17 remain open; independent fixes continue under the full goal.

### U3 in progress — project/conversation-owned unsent draft

The current change replaces WorkTab-local text, attachment and submission
ownership with an App-owned advisory session and Core `draft.inspect` / `draft.save`.
Persistence is a hash-named, 256 KiB-bounded record under the project's ignored
`.hivemind/ui/conversation-drafts/`, not global browser storage or an authority
record. The existing cross-process lock and atomic writer protect revision-
checked saves. Core derives conversation identity and submission receipts from
the full durable trail. The prior unconditional attachment clears and duplicate
conversation-boundary scan are removed. Saved old-conversation drafts remain
on disk; no archive restoration or execution authority is added in U3.

Targeted results: **9/9 Core draft tests** and **8/8 desktop draft-session
tests** pass. They cover round trips, delayed/concurrent saves, project and
conversation separation, full-trail acceptance reconciliation, retained next
drafts, errors, limits and idempotency. The shared attachment-selection owner
also prevents late native completions from being attached to another project.
Two stale desktop source-shape assertions were updated to follow the new owner
while retaining the same boundary checks. Normal Desktop validation passed
**390/390** across 43 files, Rust **65/65**, and production viewport checks
**52/52** including draft-load failure at all four window sizes. The build
passed with the existing large-bundle warning. The new draft tests plus existing
conversation-history regressions passed **28/28**. The first full Core run
reported **1,000 total, 997 passed, 1 failed, 2 skipped**: the new CLI test
incorrectly expected a result envelope, although the CLI returns its value
directly. After correcting the assertion, final full Core validation passed
**1,001 total, 999 passed, 2 skipped, 0 failed/cancelled**, exit 0, 716.733 seconds.
The skips remain the two live POSIX process-group checks on Windows.

A further desktop regression reproduced a provisional request identity being
retained after a save failed, even though no dispatch payload had been returned.
The corrected owner rolls back that provisional identity without discarding
new edits or an earlier genuinely uncertain send. The regression now passes;
the latest full Desktop suite still passes **390/390**. Attachment selection
also blocks submission until it completes. Source validation is complete;
commit, installation and installed tab/project/reload proof are pending.
**U3 remains open**. No paid calls.

### U10 fixed and installed — 416.29883.15117

The pre-fix instrumented regression failed as intended: `wholeFileReads: 1`,
`opened: 0`; the old reader attempted full-file loading. The corrected source
passed **18/18** file-reader tests. On the 64 MiB fixture, the isolated child
instrument records one opened/closed handle and exactly **524,288 content bytes
requested and returned**. This measures filesystem calls, not process RSS or
an inferred memory saving. The total file size is separately stat-derived.
Short-read, changing-file, injected-error and UTF-8-boundary checks also pass.
The whole-file import/path is removed, and the response/action shape is unchanged.

Normal Desktop tests passed **382/382** across 42 files; Rust passed **65/65**.
The production Desktop build/typecheck passed with the existing 706.88 kB
bundle warning. Static action/event checks and `git diff --check` passed;
10 pre-existing export leads remain unproven dead code. Full Core validation
passed **992 total, 990 passed, 2 skipped, 0 failed/cancelled**, exit 0,
641.90 seconds. The skips are the existing live POSIX process-group checks on
Windows. Installation evidence follows. No paid calls were made.

The same bounded-handle test was also executed from the installed `core`
directory, so its isolated child imported that installation's
`dist/src/project-files.js`. It failed on build **416.29838.49352** with
`wholeFileReads: 1`, `opened: 0`. This is an installed pre-fix negative control,
not a failing result for the corrected source. The identical invocation must
pass after replacement installation before U10 is closed.

Replacement `npm run ship` completed with build **416.29883.15117**, source
`cb9f1f9e8c7e6b961016ec73147b5849897e823c`, artifact
`f524e5f29824a2dd109b5b52ad2b80b856be4d0d2ff502152fa7a6826ef2dbc8`.
All 4,474 managed files and Core/shell/Node identities matched; all 48 viewport
checks passed and npm/RustSec reported zero vulnerabilities. The same installed
bounded-read check now passed, together with the short-read and error/change
handle checks: **3/3, exit 0**. The installed reader hash matches the tested
compiled module exactly. [Commands and artifact evidence](evidence/audit-u10-416.29883.15117/README.md).
U10 is closed on that evidence; no other finding is closed by these checks.

## Highest-priority workflow findings

### U1 — Having a spec disables conversational revision (High, confirmed code)

`src/workspace-actions.ts:608` selects answer-only whenever `active_spec_id` is
non-null. `src/spec-drafting.ts:157` then orders the provider to reply instead
of drafting, whatever the message says, and claims a plan is waiting. Existence
of a spec is not evidence that a plan is still awaiting review. After a prepared,
stopped or completed change, “now change this” cannot naturally produce a new
reviewable proposal. Core already has `plan.amend`, but this entry point cannot
reach it. Preserve explicit approval/execution gates; add an advisory proposal
route keyed to actual spec/plan/run state. Do not turn every chat into approval.

Acceptance for a future fix: request a revision after preparation and after a
completed run; see the proposed change in review, with zero execution before
the required approval.

### U2 — Chat cannot accurately explain the live run (High, confirmed input gap)

`src/workspace-actions.ts:603` fetches an inspection but passes only the
active-spec boolean into drafting. `src/spec-drafting.ts:145` accepts file
context and conversation history, not a typed run/check/plan snapshot. Thus
“what failed?”, “what are the workers doing?” and “is this ready?” ask a model
that is missing the authoritative facts Core already exposes. File contents
and earlier assistant text are not a substitute. Supply a small read-only,
provenance-bearing status context; never turn an answer into a gate verdict.

### U3 — Drafts belong to a tab instance, not the project (High, installed reproduction)

`desktop/src/App.tsx:681` mounts separate WorkTab instances for Work and Agents.
`desktop/src/components/ui/tabs.tsx:59` does not retain inactive tab content;
the installed Radix primitive uses `forceMount || isSelected`. Composer and
attachments are local state at `work-tab.tsx:239`. Changing tabs therefore has
no shared draft owner; reconnect/project transitions can also unmount that state.
The code comment describing these as “the same instances” is inaccurate.
Preserve a project/conversation-keyed draft above the tab lifecycle, separately
from authoritative Core state. Test tab switch, project switch and reload.

Installed build **416.29838.49352** reproduced this without a provider call:
`Keep this unsent draft while I inspect Agents.` became an empty composer after
Work → Agents → Work. The same run retained a newly typed draft across Stop,
so the tab-loss finding is distinct from the repaired operation-completion race.

### U4 — Reading history fights live autoscroll (High, confirmed code)

`desktop/src/components/ui/virtual-list.tsx:99` sets scrollTop to the end on
every measured total-height change. Work passes `followEnd={pageIndex === 0}`
at `work-tab.tsx:2646`; it never considers whether the reader scrolled up.
New rows and streamed wrapping can pull the user away from a message being read.
Follow only while pinned near the end; preserve the viewport anchor otherwise
and offer a “Latest” control. Test while output is arriving, not after it stops.

## Further usability and scale findings

### U5 — New conversation archives, but there is no named return path (Medium)

`src/spec-draft-action.ts:109` archives the active pointer and starts a boundary.
`desktop/src/lib/work-thread.ts:264` cuts the visible story at the latest boundary.
The user gets generic Older/Newer event pages, not a conversation list or a
resume action. Earlier work is durable but difficult to revisit as a coherent
conversation. Add an explicit read-only archive navigator first; restoring an
active request needs its own validated Core action, not client pointer edits.

### U6 — Live worker focus can remain on a finished task (Medium)

`desktop/src/hooks/use-workspace.ts:390` auto-selects output only when no task
is selected. `work-tab.tsx:893` shows that selected task's live output only if
it is still running. Once it finishes, later running workers do not automatically
replace it, so Work can appear quiet while work continues elsewhere. Distinguish
user-pinned inspection from automatic live focus; show other active workers and
their latest activity without duplicating every task card.

### U7 — Reconnect replays the whole activity log without delta deduplication (High)

`src/event-bus.ts:92` sends all output history on every subscription. The activity
client at `desktop/src/hooks/use-workspace.ts:338` appends answer deltas and
resets only on request/phase change, not record identity. A reconnect within the
same single request/phase can append the historical prefix again. When older
phases happen to reset it, that masks the defect. Use a durable cursor/record
identity with gap recovery; test dropping only the activity connection midway
through the first answer. This is a code-supported risk, not yet an installed
network-fault reproduction.

### U8 — Context omissions are largely invisible to the person (Medium)

`src/spec-draft-action.ts:457` tries at most 16 candidates, includes at most
8 files, 12 KiB per file and 48 KiB total; failed reads are silently skipped.
An attached folder can exceed that budget. A chip means selected, not read;
the context manifest is given to the model but is not returned as a user-visible
receipt. Show included/skipped/truncated items and reasons. Keep the bound; do
not “fix” this by loading the whole repository. In particular, a request to read
a specific omitted file should not look successfully attached and understood.

### U9 — Generic attachments do not support screenshots (Medium)

The menu at `work-tab.tsx:3108` says Files/Folder. Core attachments are only
project-relative file/folder references (`workspace-actions.ts:635`), and
`src/project-files.ts:223` rejects binary content. There is no image input path.
For UI development, attaching a screenshot is an ordinary expectation, but the
surface does not state this limitation. Label current support as project text
context; a later image path needs explicit size/type limits and provider support.

### U10 — The file read limit is applied after allocating the entire file (Medium; fixed above)

`src/project-files.ts:216` uses readFile on the complete file, then returns only
the first 512 KiB. A generated bundle, data dump or large binary can consume
memory and I/O far beyond the advertised returned-text bound. This is not a
measured out-of-memory event. Use a bounded file-handle read and stat-derived
total size; retain root confinement and truncation reporting.

### U11 — Long prompts are trapped in a fixed-height field (Medium)

`work-tab.tsx:3220` uses resize-none, fixed rows of 2 or 3 and no autosize logic.
The 180px maximum does not itself grow a textarea. A multi-paragraph development
request becomes a tiny internal scroll area. Use measured autosizing to a cap,
then explicit expansion, while keeping Send/Stop and attachments reachable.

### U12 — Answers are plain paragraphs, even when they contain code (Medium)

`work-tab.tsx:2801` renders the answer as text inside a paragraph. Newlines survive,
but Markdown lists, links and code fences have no structured rendering or copy
affordance. This is especially awkward when discussing code without an editor.
Use one safe Markdown renderer (no raw HTML), accessible links and code copy;
test long code lines, tables, focus and malicious markup without executing it.

### U13 — A missing roster is deliberately hidden (Medium)

`work-tab.tsx:342` explains why a configuration roster error renders nothing;
the comment explicitly prefers silence. A person cannot distinguish no agents
from failed inspection. Show a compact unavailable/retry state; do not infer
“disconnected” or “not installed” from a read failure.

### U14 — Durable history still has linear per-poll and reconnect work (Medium, scale risk)

The repair's `src/conversation-control.ts:35` scans events every cancellation
poll; `src/jsonl-trail.ts:288` copies cached records. Parsing is cached, so this
is NOT a claim that the file is re-parsed every 100ms. `src/event-bus.ts:110`
also builds a complete output-history response at reconnect, and the adapter
keeps all stdout/stderr buffers (`src/adapter.ts:606`). Long-lived projects and
verbose providers therefore scale with history size despite DOM virtualization.
Measure long-session heap, replay bytes and Stop latency; use rebuildable indexes,
cursor replay and bounded capture/spooling without discarding authoritative events.

### Verification finding U15 — Replay uses an obsolete history response shape

`desktop/tools/replay.tsx` returns a raw event array for `trail.inspect`, whereas
Core `src/events.ts:202` returns an EventPage with events and next_before. Work's
archive reader expects the latter. The newest events can still render through
the separate live projection, masking that mismatch. Existing viewport successes
therefore do not qualify older-page loading or its empty/loading states. Replace
the replay response with the current contract and test a multi-page trail whose
target message is outside the live event buffer. This is a verification gap,
not evidence that the installed Core endpoint returns the wrong shape.

### Verification finding U16 — The native spawn scan counts braces inside strings

`desktop/src-tauri/src/project.rs`, test
`no_production_spawn_bypasses_the_hidden_command_helper`, identifies test modules
by counting raw `{` and `}` characters per line. It does not tokenize comments
or string literals. During reconnect verification, a test string containing a
closing brace made it leave the test module early and flag an unchanged
non-Windows test spawn as production (64 tests passed, this one failed).
Changing that test's delimiter to a non-brace anchor restored 65/65; the scanner
was not fixed. This is a reproduced false-positive weakness, not evidence of a
production console flash. Use a Rust-aware scan or explicit per-function tests
before treating it as exhaustive production-spawn coverage.

### U17 — Failure details expose raw provider diagnostics twice (Medium, installed reproduction)

`src/adapter.ts:1262` builds the failure string from the complete stderr/stdout
and an absolute log path. `desktop/src/components/workspace/work-tab.tsx:2716`
renders operation detail directly; the action also populates composer feedback.
The installed forced-failure screenshot shows the path, provider JSON envelope
and exit detail both in the transcript and below the composer. The error is
visible, but this is not a usable explanation of what the person should do next.
Separate a concise, typed failure summary and recovery action from expandable
technical diagnostics. Retain the original log; do not silently discard evidence.
The fixture contains no private reasoning text, so this is not proof of a real
provider privacy leak. It does demonstrate that raw output bypasses the normal
readable-activity presentation on the failure path.

The review records 15 product/scale findings plus two verification findings.
Only the installed observations below should be called runtime reproductions.

## Installed observations and limits

[Build 416.29838.49352 evidence](evidence/conversation-repair-416.29838.49352-1788662305625/README.md)
contains exact prompts, output, process checks and six inspected screenshots.
U3 draft loss and U17 raw failure presentation were observed in that app.
The conversation-repair acceptance check passed; it does not mark any of the
findings in this document fixed. Other findings retain their stated source-only
or verification-harness provenance. No paid provider or large-project load test
was performed, and no exhaustive-bug-coverage claim is made.

## Recommended order, not implementation authorization

1. U1 + U2: define conversational proposals and truthful live-status answers.
   This is the significant product contract decision; approve its acceptance
   tests before implementation. Execution/ratification/ship remain explicit.
2. U3 + U4 + U6 + U11: project-owned drafts, stable scroll/focus, useful live
   worker selection and expandable composition. Test during active operations.
3. U7 + U8 + U9 + U12 + U13 + U17: reliable reconnect, honest attachment
   receipts, explicit supported inputs, structured answers and useful failures.
4. U5 + U10 + U14: coherent archives and measured long-project resource behavior.

Each future checkpoint needs scoped tests with negative controls, installed
behavioral evidence and cleanup of the replaced path. No count of findings is
a claim of exhaustive coverage. Closure is recorded only in the remediation ledger above.

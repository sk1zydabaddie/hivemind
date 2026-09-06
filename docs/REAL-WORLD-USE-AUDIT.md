# Real-world use review — 2026-09-05

Scope: follow-up to the approved conversation repair, especially interactions
that can satisfy tests while frustrating real development. Findings only: this
review does not authorize an architectural rewrite or weaken approval gates.
No paid providers were invoked. Source findings below are not presented as
installed reproductions; runtime observations are recorded separately.

## Highest-priority workflow findings

### U1 — Having a spec disables conversational revision (High, confirmed code)

`src/workspace-actions.ts:609` selects answer-only whenever `active_spec_id` is
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

### U3 — Drafts belong to a tab instance, not the project (High, confirmed code)

`desktop/src/App.tsx:681` mounts separate WorkTab instances for Work and Agents.
`desktop/src/components/ui/tabs.tsx:59` does not retain inactive tab content;
the installed Radix primitive uses `forceMount || isSelected`. Composer and
attachments are local state at `work-tab.tsx:237`. Changing tabs therefore has
no shared draft owner; reconnect/project transitions can also unmount that state.
The code comment describing these as “the same instances” is inaccurate.
Preserve a project/conversation-keyed draft above the tab lifecycle, separately
from authoritative Core state. Test tab switch, project switch and reload.

### U4 — Reading history fights live autoscroll (High, confirmed code)

`desktop/src/components/ui/virtual-list.tsx:99` sets scrollTop to the end on
every measured total-height change. Work passes `followEnd={pageIndex === 0}`
at `work-tab.tsx:2648`; it never considers whether the reader scrolled up.
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
is selected. `work-tab.tsx:889` shows that selected task's live output only if
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

The menu at `work-tab.tsx:3106` says Files/Folder. Core attachments are only
project-relative file/folder references (`workspace-actions.ts:635`), and
`src/project-files.ts:223` rejects binary content. There is no image input path.
For UI development, attaching a screenshot is an ordinary expectation, but the
surface does not state this limitation. Label current support as project text
context; a later image path needs explicit size/type limits and provider support.

### U10 — The file read limit is applied after allocating the entire file (Medium)

`src/project-files.ts:216` uses readFile on the complete file, then returns only
the first 512 KiB. A generated bundle, data dump or large binary can consume
memory and I/O far beyond the advertised returned-text bound. This is not a
measured out-of-memory event. Use a bounded file-handle read and stat-derived
total size; retain root confinement and truncation reporting.

### U11 — Long prompts are trapped in a fixed-height field (Medium)

`work-tab.tsx:3235` uses resize-none, fixed rows of 2 or 3 and no autosize logic.
The 180px maximum does not itself grow a textarea. A multi-paragraph development
request becomes a tiny internal scroll area. Use measured autosizing to a cap,
then explicit expansion, while keeping Send/Stop and attachments reachable.

### U12 — Answers are plain paragraphs, even when they contain code (Medium)

`work-tab.tsx:2815` renders the answer as text inside a paragraph. Newlines survive,
but Markdown lists, links and code fences have no structured rendering or copy
affordance. This is especially awkward when discussing code without an editor.
Use one safe Markdown renderer (no raw HTML), accessible links and code copy;
test long code lines, tables, focus and malicious markup without executing it.

### U13 — A missing roster is deliberately hidden (Medium)

`work-tab.tsx:339` catches the configuration roster error and renders nothing;
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

The review records 14 product/scale findings plus this verification finding.
Only the installed observations below should be called runtime reproductions.

## Recommended order, not implementation authorization

1. U1 + U2: define conversational proposals and truthful live-status answers.
   This is the significant product contract decision; approve its acceptance
   tests before implementation. Execution/ratification/ship remain explicit.
2. U3 + U4 + U6 + U11: project-owned drafts, stable scroll/focus, useful live
   worker selection and expandable composition. Test during active operations.
3. U7 + U8 + U9 + U12 + U13: reliable reconnect, honest attachment receipts,
   explicit supported inputs, structured answers and visible inspection failures.
4. U5 + U10 + U14: coherent archives and measured long-project resource behavior.

Each future checkpoint needs scoped tests with negative controls, installed
behavioral evidence and cleanup of the replaced path. No count of findings is
a claim of exhaustive coverage. No findings above are marked fixed by this audit.

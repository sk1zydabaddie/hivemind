# U4 minimum-window installed scroll qualification

`node e2e/phase6-conversation-remediation.mjs --scroll-only --minimum` in
`desktop` exited **0** at **790×610** on installed **416.30061.58188**, source
`c8ecdf0ae865f208d2a839aa4449541cd51acb24`. Exact artifact identity and common
test boundaries are in the [desktop-size report](../conversation-scroll-416.30061.58188-1788676826860/README.md).

The actual earlier question-23 anchor remains at **-97px** for all 24 live
samples: **0px maximum shift**. The mounted answer grows **255 → 850 characters**,
while the fixture log advances **3 → 11 chunks**. Provider-log and UI sampling
have separate clocks; these counts do not imply identical update timing.
Provider PID **40936** is alive during sampling. Latest's keyboard activation
restores log focus, with **0px** end distance in all 20 following samples while
text grows. Stop terminates the owned provider; one invocation, zero paid calls.
Both screenshots were inspected, and recent-project bytes were restored exactly.

## Separate observed limitation

The header's Checks, New conversation and Interruptions labels are visibly
clipped. The existing minimum-width rule constrains header buttons to 2rem
and sets font-size to zero; the installed screenshot still shows fragments.
`desktop/src/styles.css` and the RunHeader control implementation are unchanged
by U4. The precise style-cascade cause has not been instrumented yet.
This remains an open layout follow-up, not a successful visual qualification
of those controls. U4's Latest control itself is visible, hit-tested and
keyboard-operable. The scroll pass does not erase this separate observation.

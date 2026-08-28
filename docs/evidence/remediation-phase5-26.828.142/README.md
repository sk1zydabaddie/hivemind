# Remediation Phase 5 installed evidence — build 26.828.142

This directory is the no-paid installed-artifact proof for F4-05 through F4-10
and F4-12. `npm run ship` built and installed this exact version, then verified
the executable, bundled Core, shell, and pinned Node 22.23.2 identities.

`phase5-crash-recovery-remediation.json` records the exact installed Core
results: two distinct open round identities, a fully charged and settled
pre-bind orphan with zero active reservations, an actionable interrupted resume,
zero provider calls, zero severe WebView logs, and byte-identical restoration of
the user's recent-project registry.

`phase5-recovery-needs-you-26.828.142-1440x900.png` is the installed 1440x900
screen. The expanded Needs-you surface contains exactly one “Recorded work
stopped reporting” item, one “This run did not stop cleanly” item with “Retry
stopping,” and the recovered checkpoint action “Carry on.”

Validation for the phase:

- focused Core recovery matrix: 9 passed, 0 failed;
- full Core: 950 passed, 2 skipped, 952 total;
- Desktop: 335 passed, 0 failed;
- Rust: 47 passed, 0 failed;
- reachability: 30/30 surface and viewport combinations;
- production advisory gate: zero findings in both lockfiles;
- paid provider/model calls: zero.

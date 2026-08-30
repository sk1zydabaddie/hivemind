# Remediation Phase 14 evidence — build 416.20640.31640

Phase 14 closes F6-11 by replacing the disabled publication stub with one
draft-first, exact-artifact transaction. This directory records the installed
artifact, the offline failure/recovery rehearsal, the fail-closed production
trust boundary, and the read-only public-channel observation.

No GitHub release or draft was created. No production key or certificate was
available or substituted. Both Windows files are unsigned, so the production
signing gate refused the candidate as designed. The existing public release was
read only after the rehearsal and remained unchanged.

The native smoke exercised the installed executable. No screenshot is included
because this phase changes release infrastructure rather than a visual surface;
the complete 44-scenario production viewport/CSP check passed during `ship`.

Files:

- `installed-artifact.json` — exact installed artifact and receipt identity.
- `verification.json` — suite, admission, rehearsal, and negative-gate results.
- `public-channel.json` — read-only GitHub release observation after the run.

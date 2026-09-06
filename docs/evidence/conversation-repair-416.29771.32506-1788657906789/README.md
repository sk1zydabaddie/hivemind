# Failed strict streaming check — 416.29771.32506

No-paid fixture, 2026-09-05; source `b3293b8`. This run did **not** pass.
The original JSON is retained unchanged; no behavioral sections completed.

The stricter installed check required a nonempty proper prefix of the exact
expected answer in the live-answer element, while the provider was running.
It failed with `no genuine partial answer was observed before its completion`.
The old decoder waited for the complete structured JSON envelope. That is a
product streaming defect, not permission to weaken the assertion.

Recent-project data was restored byte-for-byte. No paid model was invoked and
the user's existing project/history was not altered.

# Failed installed attempt — 416.29771.32506

No-paid fixture, 2026-09-05; source `b3293b8`. This run did **not** pass.
The original JSON and screenshots are retained unchanged.

The complete expected reply appeared before provider exit. The operation row
showed 3 seconds and then 6 seconds elapsed. Project context included the
expected README/source content and only the untracked file's name.

The `scopedPartialAnswerWhileRunning: Thinking` field is **invalid streaming
evidence**: activity text was mistaken for a partial reply. The test was then
tightened to require a proper prefix of the exact expected answer. The later
duplicate-submit step also ran before Send was ready and timed out; the harness
now waits for the actual enabled control. No later checks ran in this attempt.

Recent-project data was restored byte-for-byte. This is deterministic plumbing
evidence, not a live-model response or model-quality qualification.

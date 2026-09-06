# Partial results; failed reload — 416.29801.33924

No-paid installed fixture, 2026-09-05; source `2e5474c`. This run failed and
does not qualify the whole repair. Original JSON and screenshots are retained.

Measured before the failure: a genuine live reply prefix (`This installed
fixture re`), the complete expected answer before provider exit, a single
conversation progress row with a neutral header, and its clock changing from
3 to 7 seconds. A read-only status call settled in 52ms. Two synchronous submits
produced one provider call and one durable user message. The actual second
provider input contained exactly the first user/assistant exchange, once.

After reloading during the next response, Stop failed to reappear within the
10-second test deadline. That failure had no diagnostic screenshot; later
attempts added failure-state capture. Subsequent Stop/attachment/planning/new
conversation/failure checks did not complete. Recent projects were restored
byte-for-byte. This is fixture plumbing evidence, not paid-provider quality.

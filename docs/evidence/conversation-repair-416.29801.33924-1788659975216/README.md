# Failed duplicate-row check — 416.29801.33924

No-paid installed fixture, 2026-09-05; source `2e5474c`. This run failed.
The captured screenshot shows two transcript progress rows for one operation,
not the previously removed header duplicate. Core inspection reported one
reading operation and the fixture recorded one provider process invocation.

The failure is intermittent because the initial durable history page can
overlap the live event stream. Later transport capture established that native
JSON reorders object keys; the old string-based merge treated those copies as
different events. Both rows therefore displayed the same answer. Original
JSON and screenshots are retained, including the exact assertion failure.

No later behavioral checks completed; empty result sections are not passes.
Recent projects were restored byte-for-byte and no paid provider was used.

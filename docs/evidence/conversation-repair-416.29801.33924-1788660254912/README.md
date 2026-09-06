# Reload/admission diagnosis — 416.29801.33924

No-paid installed fixture, 2026-09-05; source `2e5474c`. This run failed after
reload. The screenshot shows a connection error/setup screen, while the same
fixture's directly inspected Core operation is still in the reading phase.
The service is not absent: authenticated status and native history reads work.

Source tracing: native `select_project` unconditionally acquired mutation
admission before even attempting attachment; Core holds that admission across
the response. The native five-second admission deadline therefore prevented
reconnect and hid Stop. The correction permits read-only attachment only for
an already-registered project, while retaining admission for registration and
every possible daemon launch and all existing health/build/root checks.

This capture also records 20 durable events and the same 20 events returned
through the native bridge. Durable top-level keys are `ts,type,task_id,data`;
native keys are `data,task_id,ts,type`, with nested objects reordered too.
Replaying the old identity rule yielded 40 entries; key-normalized identity
yielded 20. That independently explains the preceding duplicate-row failure.

The initial streaming/history checks passed; later Stop, planning and new-thread
checks did not finish. The original JSON and screenshots remain unchanged.
Recent projects were restored byte-for-byte. No paid model was called.

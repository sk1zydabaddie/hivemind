# U3 first-message timing failure during concurrent validation

Installed candidate **416.29995.30514**, source
`b33049c8d841c08723d8476860ff58aa5ad4a737`, artifact
`fd62d2919d83269c989f49eeb821c14a213f0703891d504abaf433624e51330c`.
Installed executable SHA-256:
`d8c698d8cfbfc6c024b2e0645895b34327bfb0f6638ebed43ccf4c377183b65f`.

Both this run and the preceding `../conversation-repair-416.29995.30514-1788672555938/`
ran while the full eight-way Core suite was active. Both **failed**, exit 1,
at the unchanged four-second `conversation.message_recorded` deadline for the
first question. This does not qualify the candidate, and no provider-quality
or normal-load latency conclusion follows from it.

The first attempt captured a saved text/request identity and no provider yet.
This diagnostic attempt preserved the same failure but observed the request
for up to 15 further seconds before cleanup. It observed the durable message
**6,477 ms after the submission helper began** (the deadline failure was
recorded at 4,368 ms, including the helper's readiness/click work). Provider
PID 98684 then started. Thus this request was delayed, not permanently stuck.
The source of the delay was not profiled; concurrent validation is an observed
condition, not a proven causal attribution. The diagnostic observation cannot
convert the failed deadline into a pass.

The maintained test records this failure-only timing information and still
rethrows the original failure. Qualification requires a fresh strict run after
the concurrent suite finishes. All later draft/Stop/stream assertions remain
unchanged and were not reached in these two attempts.

Only generated fixture content and no-paid Node providers were used. The
recent-project registry was restored byte-for-byte; owned fixture processes
and directories were cleaned up. No paid provider, user-project edit, OS
preference change or public publication occurred.

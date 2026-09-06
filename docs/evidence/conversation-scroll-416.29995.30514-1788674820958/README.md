# U4 negative control: installed history is pulled to the bottom

This is a **failed** regression check on installed **416.29995.30514**, source
`b33049c8d841c08723d8476860ff58aa5ad4a737`. It does not qualify a scroll fix.
The installed identity is recorded in `phase6-conversation-remediation.json`:
artifact `fd62d2919d83269c989f49eeb821c14a213f0703891d504abaf433624e51330c`,
executable SHA-256
`d8c698d8cfbfc6c024b2e0645895b34327bfb0f6638ebed43ccf4c377183b65f`.

Command, from `desktop`, using the pinned Node 22.23.2 runtime:

`node e2e/phase6-conversation-remediation.mjs --scroll-only`

The check seeded 24 question/answer pairs through the installed event writer
in a disposable project **before** starting its daemon. Those rows are labeled
seeded history; they are not claimed as real model exchanges. It then submitted
`SCROLL_LIVE` through the actual installed composer. The no-paid provider emitted
a growing text reply rather than an app-injected placeholder.

At 1440x900 client pixels, the test scrolled 240px away from the end. The first
visible row was index 44, `Earlier question 22`, at **-165px** relative to the
log viewport. During 24 samples over approximately 2.4 seconds, emitted chunks
increased **3 → 11**, and the mounted answer increased **255 → 936 characters**.
The provider PID **76544** was checked alive while those samples were gathered.

The third sample already showed distance-to-end **0px**, with the anchor at
-428px. By the last sample it was at **-587px**: a measured **422px** shift.
The unchanged 2px retention assertion failed, exit 1. The inspected
`reading-history-416.29995.30514-1440x900.png` shows the list following the live
answer rather than retaining the earlier question. The JSON preserves every
sample and the failure; this check could not pass with the stream absent.

Only owned fixture processes/directories were cleaned. Recent-project bytes
were restored exactly (before/after SHA-256
`9f6c478f93cb98f488fc5e3a1f113abc746e4da228b62ef405a15970e0639d06`). No paid
provider, user-project edit, OS preference change or public release occurred.

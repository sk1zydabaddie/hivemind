# Quiet installed attempt: out-of-band conversation sequencing failure

Installed **416.29995.30514**, source `b33049c8d841c08723d8476860ff58aa5ad4a737`.
This attempt **failed**, exit 1, and is not an acceptance pass.

Before failure it passed the strict first-message deadline, actual partial
answer, duplicate submit, history, reload during a live response, saving the
next draft during that response, tab retention, response Stop, attachment
context and planning Stop. The captured JSON records those reached checks.

The test then called `conversation.new` directly on Core. Core returned the
new boundary before the UI had replaced its previous composer. The helper
typed `FAIL_VISIBLE` into that previous element; the next conversation render
replaced it. The captured screenshot shows the replacement empty composer;
the saved old-conversation draft still contains `This is my next unsent message.`
The following submit therefore timed out waiting for an enabled Send control.

This was an out-of-band harness sequencing error, not a reproduction using
the actual New conversation button. The harness now captures the old composer
before its direct Core action and waits for that element to become stale
before typing. It neither retypes lost text nor relaxes any save/deadline
assertion. The following run passes this sequence and separately tests the
actual UI New conversation button; see the
[passing qualification](../conversation-repair-416.29995.30514-1788673483480/README.md).

Only no-paid fixture providers were used. Recent projects were restored
byte-for-byte and only owned fixture processes/directories were cleaned up.

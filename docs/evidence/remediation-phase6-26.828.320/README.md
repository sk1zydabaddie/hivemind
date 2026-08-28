# Remediation Phase 6 installed evidence

Every artifact in this directory was produced by installed build
**26.828.320** at **1440x900** with no paid provider/model call.

- `phase6-live-conversation-26.828.320-1440x900.png` captures the durable user
  message, named in-flight planner progress, and named answer text while the
  delayed fixture provider was still alive.
- `phase6-visible-failure-26.828.320-1440x900.png` captures the scoped visible
  provider failure.
- `phase6-conversation-remediation.json` records the exact prompt/reply,
  duplicate-submit counts, concurrent read-only latency, current-tree and
  structured-attachment results, New-conversation archive result, failure
  durability, build identity, viewport, browser log result, and recent-project
  registry hashes.
- `driver.log` is the fixture driver log; it is empty because the driver emitted
  no diagnostic error.

The installed app was not verified from surrounding page text. The probe
sampled `conversation-progress` and `conversation-live-answer` while the
provider marker still existed, then inspected the exact durable trails and
adapter-call trace. The user's recent-project registry was restored
byte-for-byte.

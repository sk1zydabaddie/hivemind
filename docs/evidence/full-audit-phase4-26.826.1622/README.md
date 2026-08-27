# Full audit Phase 4 evidence — installed build 26.826.1622

This directory records the no-paid failure, recovery, interruption, and
persistence audit run against the installed application and the exact Core
bundle shipped beside it.

- `phase4-failure-recovery-audit.json` is the structured, assertion-backed
  result.
- `01-cancelled-session-still-active.png` is a 1440x900 installed-app capture
  taken after `scheduler.run_cancelled` was durable. The screen still presents
  the session as running and offers Stop again.
- `driver.log` is the WebDriver transport log. The structured result records
  zero severe browser-console entries.

The fixture used a local Node process in place of a provider. It made no paid
model call, stopped only the fixture daemon, and restored the real
recent-project registry byte-for-byte.

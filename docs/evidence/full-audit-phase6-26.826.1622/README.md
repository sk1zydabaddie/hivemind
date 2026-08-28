# Phase 6 evidence — installed build 26.826.1622

This directory records the no-cost security, packaging, and updater probes for
Phase 6 of `docs/AUDIT-2026-08-26.md`.

- `phase6-security-packaging-audit.json` is the structured result. Its scoped
  assertions require the unauthenticated daemon command to create its exact
  marker, the installed executable to execute the configured production Core
  override, the package to contain no Node runtime, the spoofed source tree to
  receive the source-update offer, both Windows artifacts to be unsigned, and
  the user's recent-project file to be restored byte-for-byte.
- `01-installed-without-node-1440x900.png` shows the installed app failing to
  open a valid project when Node is absent from `PATH` while Git and Windows
  remain available.
- `03-spoofed-own-source-offer-1440x900.png` shows an unrelated repository whose
  only product identity is a substring in an arbitrary JSON value receiving
  `A newer version is ready to build` and `Build and restart`. The button was
  not pressed.
- `driver.log` retains the WebDriver transport log. It is empty because both
  installed sessions completed without transport output.

The probe made zero provider/model calls and did not build, install, update,
sign in, sign, or publish a release. It stopped only fixture-owned daemon/app
processes and restored the real recent-project registry to SHA-256
`a3328357f4c39a68f1e9f087f6e170f9d0c67c076693124fbbc0db6235ee41b7`.

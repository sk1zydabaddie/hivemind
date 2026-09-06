# U4 installed scroll qualification

Installed **416.30061.58188**, source
`c8ecdf0ae865f208d2a839aa4449541cd51acb24`, artifact
`6829361a0553d5f6e955d639b48045c798d3d99e4ef521c612b3500ed5a45ff8`.
Executable SHA-256:
`24214d7e2db7b12c1798c8727797a50c034f5b3ce8a5eea799ddefa983c67df9`.
The local installation verified all 4,480 managed files and Core/shell/Node
identities. This is a local candidate, not a public release.

`node e2e/phase6-conversation-remediation.mjs --scroll-only` in `desktop`
exited **0** against the installed application at **1440×900**. The fixture
seeds 24 historical question/answer pairs before starting its local daemon,
then invokes one no-paid provider that emits growing text.

- Reading starts 240px above the end. The earlier question-22 row remains at
  -165px relative to the log viewport through 24 samples taken 100ms apart:
  **0px maximum shift**, within the unchanged 2px tolerance.
- During those samples the mounted answer grows **255 → 850 characters** and
  provider output advances **3 → 10 chunks**. The actual provider PID **93792**
  is checked alive; this is not an after-completion content assertion.
- Keyboard activation of the hit-tested Latest button returns focus to the
  log. During 20 subsequent live samples its distance from the end is always
  **0px**, and the mounted answer keeps growing. Latest disappears while pinned.
- Stop terminates that owned provider; exactly one fixture invocation occurred.
- Both screenshots were inspected. Recent-project bytes were restored exactly
  (`9f6c478f93cb98f488fc5e3a1f113abc746e4da228b62ef405a15970e0639d06`).
  No severe browser logs, paid calls, user-project edits or OS changes occurred.

The [old-installed negative control](../conversation-scroll-416.29995.30514-1788674820958/README.md)
measured **422px** movement under the same criterion. The
[minimum-size pass](../conversation-scroll-416.30061.58188-1788676886706/README.md)
also measures 0px; it records a separate header-label defect, not a claim that
the entire minimum-size interface is visually qualified.

Controlled browser checks additionally cover measured 90px row growth above
an anchor, append/prepend, viewport resizing, a 48px following boundary and
non-following Project-style lists. They use the actual shared VirtualList in
an isolated test-only controller, which is absent from the production bundle.
These finite fixture checks do not establish arbitrary long-session behavior
or live-model quality. No paid provider or gameplay automation is involved.

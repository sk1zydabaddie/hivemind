# U10 — bounded project file reads, installed verification

Verified 2026-09-05 America/Los_Angeles (2026-09-06 UTC). No paid model calls,
user-project content changes, OS preference changes or public release publication.
This is installed Core behavior, not an image-based UI qualification.

## Identity

- Source commit: `cb9f1f9e8c7e6b961016ec73147b5849897e823c`.
- Installed build: **416.29883.15117**.
- Artifact: `f524e5f29824a2dd109b5b52ad2b80b856be4d0d2ff502152fa7a6826ef2dbc8`.
- Executable SHA-256: `acd3b8f56e91463fd5dbb8822ae29a8a2dc36551fcfa44ea7f44d54b3f64fe9e`.
- Installed and workspace-compiled `project-files.js` both hash to
  `94c1bc71ffe537e6a6f4d8f0940672279fd85ca4631218400de7d5b30b4aef44`.
- `npm run ship` exited 0 and verified all 4,474 managed files, Core, shell and
  bundled Node identities. The installer is not a public release.

## Acceptance and negative control

The instrumented regression in `test/project-files.test.ts` intercepts actual
filesystem calls in an isolated child. Full-file loading of its target is
refused before allocating the payload. A 64 MiB fixture has a 512 KiB text
prefix; the test checks the full stat size, exactly 524,288 requested/returned
content bytes, one opened/closed handle, and zero whole-file reads. These are
API-level content measurements, not physical disk-I/O or process-RSS benchmarks.

Before the fix, the same check failed both in the workspace and against installed
build **416.29838.49352**. Its captured trace was:

```json
{"wholeFileReads":1,"opened":0,"closed":0,"readCalls":0,"requestedBytes":0,"returnedBytes":0,"result":{"ok":false,"reason":"file cannot be read"}}
```

The old installed reader hash was
`dad02eb8405e8bf44b2b114de3e9e7d3c7b526424309e070395f3b15a8c0e337`.
After installation, the bounded-read check passed, together with two checks
forcing short reads and file-change/read-error outcomes: **3/3, exit 0**.
Both injected failure paths check handle closure. Existing root confinement,
private-directory refusals, regular-file checks and the first-block binary
heuristic are retained; the whole-file implementation and import are removed.

The installed invocation reused the existing test, with the working directory
set to `C:\Users\ethan\AppData\Local\Hivemind AI\core`:

```powershell
& 'D:\Projects\Hivemind AI\desktop\runtime\node.exe' --test --test-name-pattern='bounded handle read|fills short reads|changing or failed' 'D:\Projects\Hivemind AI\dist\test\project-files.test.js'
```

The isolated child resolves `dist/src/project-files.js` from that working
directory: the measured reader is installed Core, not the test file's static
workspace imports. Test repository setup is a disposable local fixture.

## Source and build checks

- Focused file-reader tests: **18/18**. Additional source checks cover empty
  files, the exact limit, every cut position in 2/3/4-byte UTF-8 characters,
  root/private-directory confinement, CLI/HTTP routing and read-only behavior.
- Root `npm test` on bundled Node 22.23.2: **992 total, 990 passed, 2 skipped,
  0 failed/cancelled**, exit 0, 641.90 seconds. The skips are existing live
  POSIX process-group cases on Windows.
- Normal Desktop `npm test`, including replay/Core build: **382/382**, 42 files.
- Native `cargo test`: **65/65**. Core and Desktop production builds/typechecks
  passed. The existing 706.88 kB JavaScript chunk warning remains.
- `npm run ship`: **48/48** viewport cases; npm/RustSec zero vulnerabilities,
  with 483 Windows Rust dependencies scanned. These are existing UI regression
  checks, not proof that the other audit findings are fixed.
- Static action/event scan: zero missing consumers/producers. Ten pre-existing
  export leads remain unproven dead code. `git diff --check` passed.

The changed-file detection refuses observed size/mtime/ctime changes; it is
not a new immutable filesystem-snapshot guarantee. U10 is closed. The remaining
16 audit findings retain their own open status and required evidence.

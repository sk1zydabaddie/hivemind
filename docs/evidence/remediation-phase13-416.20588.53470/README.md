# Phase 13 release-trust gate proof

Build `416.20588.53470` was assembled from clean commit
`663629031cd85034fd86ffef88a088cde240382e` and admitted as artifact
`9ee6b26d9710463417ed24dc31becbefcb85ca23f1caaa36c3a82740ed9748df`.

`npm run ship` ran the shared npm and Rust advisory admission, all 44
production surface/viewport checks, the Windows x64 bundle, silent install,
and exact installed-byte verification. The installed root contains only the
three admitted directories plus `hivemind_desktop.exe` and `uninstall.exe`.
The accidentally bundled release-verification helper and six retired updater
files are absent. All 4,464 managed files and the Core, shell, and pinned Node
identities match the manifest.

Rust advisory admission used `cargo-audit-audit 0.22.2` with the official
RustSec database at commit `b331df68b3ed0e99594d259040bdcb9de3c7c8a4`.
It resolved 483 Windows x64 dependencies and found zero vulnerabilities. The
tool, database origin, database commit and date, lockfile hash, dependency
count, platform, and zero-result are embedded in the immutable artifact
manifest. Missing tooling, an unavailable/stale database, or any vulnerability
fails the shared admission graph used by both local ship and signed release.

The remote verifier now downloads bounded exact bytes, refuses redirects and
cross-origin assets, compares the release descriptor and both manifests,
compares installer and executable hashes and sizes, verifies the updater
signature with Minisign, and requires exact Authenticode publisher identities
and timestamps. Its verifier is a separate Cargo workspace tool, not a second
application binary.

Production signing remains intentionally fail closed. The trust policy has no
updater public key or Windows publisher identity, and the locally built
installer and installed executable both report `NotSigned`. Signing preflight
and remote verification each exited before network access with `production
updater public key is not configured`. No test key, self-signed certificate,
provider/model call, public release, or public-channel mutation was used.

Final no-paid validation passed Core (**965 passed, 3 skipped, 968 total**),
Desktop (**360/360**), Rust (**63/63**: 61 application plus 2 release-tool
tests), the **22/22** focused supply-chain regressions, both npm advisory
graphs with zero vulnerabilities, the Rust advisory gate with zero
vulnerabilities, and all **44/44** production surface/viewport combinations.
The exact installed executable was also started hidden as PID 27748, remained
responsive at version `416.20588.53470`, and only that verified process was
stopped after the smoke check.

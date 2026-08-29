# Phase 10 installed trust-perimeter evidence — build 26.829.1445

This directory records the no-paid installed proof for F6-04 and F6-13.

- `installed-1440x900.png` is the running installed app at 1440x900. It shows
  `Live` on the isolated spoof-identifier fixture and carries build number
  **26.829.1445** through this directory and `result.json`.
- The disposable Git project's package name and remote both contained
  `ai.hivemind.desktop`. Its valid `npm run build` command would write a marker.
- Installed invocations of `newer_version`, `take_newer_version`, and
  `build_and_install` all returned command-not-found. The marker remained
  absent and the exact update-control/status/alert query returned an empty
  array.
- The installed executable contained no retired public endpoint, updater crate
  name, or removed command name. Browser severe logs were empty.
- The active local key path was absent. The revoked 348-byte copy had ACL
  inheritance disabled and only owner, SYSTEM, and Administrators full-control
  entries, all non-inherited. No key bytes or signature material were read into
  evidence.
- The old-key bridge is forbidden. Legacy clients require a fresh
  publisher-signed installer from the future protected R2 pipeline.
- The public channel was read only and not changed. No provider/model call,
  signing action, publication, installer download, or paid operation ran.
- The fixture daemon was shut down, the fixture was removed, and the imported
  recent-project guard restored the user's registry exactly.

`result.json` is the structured installed assertion record. `driver.log`
contains only the native driver transport output.

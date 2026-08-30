# Phase 12 installed immutable-artifact proof

Build `416.20515.20713` was assembled from clean commit
`bb0690d8fa080360c5e6f31819cac64626f1e323` and admitted as artifact
`ac4799849c00621388b74226e9c73ace34b9e8cb09a3d84f8a851160047dd3e7`.

`npm run ship` created a fresh `npm ci --omit=dev` Core staging tree, generated
the payload and artifact manifests, built the NSIS installer, installed it, and
verified the installer, payload manifest, executable, all 4,464 managed files,
Core identity, shell identity, and pinned Node identity. TypeScript and
`@types/node` are absent from the installed Core.

The first installed comparison caught Tauri's deliberate NSIS transformation:
the executable in the installer differs from the restored build-tree executable
only where `__TAURI_BUNDLE_TYPE_VAR_UNK` becomes `..._NSS` (three bytes). The
final manifest binds both identities and the installed hash matches the NSIS
identity exactly.

The installed app was then launched at 1440x900 with ambient Node absent. It
reached the exact `Live` state on a disposable Git project, its daemon executable
was the installed pinned Node 22.23.2, severe browser logs were empty, and the
user's recent-project registry was restored byte-for-byte. No provider call ran.

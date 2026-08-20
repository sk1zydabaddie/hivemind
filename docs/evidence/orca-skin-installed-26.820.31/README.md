# Orca-derived installed UI evidence

- Installed build: `26.820.31`
- Inspection target: `C:\Users\ethan\AppData\Local\Hivemind AI\hivemind_desktop.exe`
- Viewport: 1440×900 client area (1442×932 window including the Windows frame)
- Source reference: official `stablyai/orca` commit
  `9d06b3ba938d3c5467de5b82b0bec322af2620a8`

`npm run ship` built the release bundle, installed it, and verified the version
against the executable on disk before these captures were taken. The Setup,
Work, and Settings images are from that running installed executable.

- `setup-1440x900.png`: setup shell, panel, outline action, and selection relief
- `work-1440x900.png`: full shell, flat navigation, workplane, and suggestions
- `settings-1440x900.png`: corrected dark scrim and opaque settings dialog

Build `26.820.24` was the rejected inspection pass: its light scrim washed the
shell gray when a dialog opened. That evidence was superseded and is not part of
the final record.

No paid provider or paid 21st generation call was used.

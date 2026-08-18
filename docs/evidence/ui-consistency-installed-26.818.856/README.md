# Rejected installed UI evidence — build 26.818.856

These captures are retained as evidence of the rejected implementation. They
come from the installed Windows application with a 1440x900
client area. `npm run ship` built the NSIS installer, installed it, and verified
26.818.856 against the binary on disk before the app was opened.

| Capture | What it proves | SHA-256 |
| --- | --- | --- |
| `01-work-buttons-background-26.818.856.jpg` | Work tabs, row actions, toolbar/icon controls, disabled primary action, and the atmospheric substrate all render in the installed app. | `A9EFD72FAE7A63A774035E65156D0794CCDE7E2CA253E994B03920D48830E761` |
| `02-settings-compact-controls-26.818.856.jpg` | The loaded Settings dialog renders the quiet outline Change control and repeated compact provider-role controls with the scaled relief system. | `53541230F5B9BAD135AA40EB9D722BBDEC9C0E4A51BAB82F6F3D03C4E945DD6C` |

The near-white faces and stacked shadow bands shown here were superseded by the
measured reference correction in build 26.818.931. Provider marks remain brand identity and intentionally do not receive an app
gradient, tint, shadow, or invented clickable tile. Windows window animation
and client-area animation were enabled and read back as enabled before these
captures. No paid provider call was made.

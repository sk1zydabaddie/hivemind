# Installed UI verification — 2026-08-17

All captures are from the installed Windows application with a 1440x900 client
area. They are not dev-server or component-test renders.

| File | Installed build | What it proves |
| --- | --- | --- |
| `01-provider-icons-checkboxes-choose-another-26.817.1309.jpg` | 26.817.1309 | All five provider assets decoded under the Tauri CSP; the compact checkbox relief is visible at native scale; the outline-only Choose another action remains flat. |
| `04-source-progress-reduced-motion-a-26.817.1309.jpg` | 26.817.1309 | With the existing Windows reduced-motion preference unchanged, the source route reports `Preparing the source build` and 8 seconds elapsed. |
| `05-source-progress-reduced-motion-b-26.817.1309.jpg` | 26.817.1309 | A later capture reports `Compiling the desktop shell` and 25 seconds elapsed. It differs from the first capture without depending on spinner motion. |
| `06-source-build-installed-26.817.1314.jpg` | 26.817.1314 | The source-build route completed the package, installed it, reopened the app, and the installed binary and on-screen version both read 26.817.1314. |
| `07-final-installed-26.817.1321.jpg` | 26.817.1321 | The final post-cleanup `npm run ship` install. The on-screen version is 26.817.1321 and the provider, relief, and outline-control results remain present. |

The two reduced-motion captures have different SHA-256 hashes:

```text
FE346C6DCC756E32BDEE4A620478C8949BC060D593D7D20137806B1B72E5528B  04-source-progress-reduced-motion-a-26.817.1309.jpg
FCF9503A967641DF8D9E11C8707449C8DD897008ED59E4B12F9DA4250F4C21AA  05-source-progress-reduced-motion-b-26.817.1309.jpg
```

No release was published solely to manufacture a download screenshot. The
release route's percentage is derived from the updater's real downloaded-byte
and total-byte callbacks and is covered by the updater regression tests; live
visual proof of that branch still requires a genuine offered release.

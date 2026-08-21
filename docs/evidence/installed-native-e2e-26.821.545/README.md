# Installed real-project workflow evidence

These captures came from the installed **26.821.545** desktop application,
driving the real Git repository at
`D:\Projects\Hivemind Installed E2E Final 26.821.453` through Selenium and the
native Tauri WebDriver. No browser mock, replay fixture, or Computer Use session
was used.

The workflow used Claude Opus for planning, Claude Sonnet for management, and
Grok 4.6 for worker and read-only review tasks. The harness placed a failing
`codex.cmd` ahead of the normal PATH; the workflow completed without invoking
it. `30-workflow-shipped.png` is the terminal workflow capture, and
`workflow-latest.txt` is its extracted visible text.

The project began at commit `51650f1` and Hivemind adopted the verified changes
as `a0e94bc`. Its seven deterministic project tests pass after adoption.

This folder proves the paid workflow and ship path. The later
`installed-native-e2e-26.821.647-postship` folder proves that the final repaired
and installed build can reopen the completed project without a browser error.

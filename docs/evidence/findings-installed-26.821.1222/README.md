# What this capture is evidence of — the finding, not the walk

`open-project-timeout.png` shows installed build 26.821.1222 opening
`D:\Projects\Hivemind Installed E2E Final 26.821.453` — the completed
real-workflow acceptance project — and stopping at "Hivemind's local service
did not start" after a restart attempt. The cause is not the service: the
project's `.hivemind/worktrees/T-003` still exists, left behind by the
completed read-only review task of the 2026-08-21 acceptance run, so
`daemon_work` reports one task workspace forever and the idleness proof never
opens. The restart gate and the auto-recovery are both (correctly) refusing;
what is wrong is the leftover they are refusing over.

Recorded in `docs/AUDIT-2026-08-17.md` as A-37. The adoption-coverage half of
read-only tasks was fixed in `d7766e7`; their worktree cleanup was not.

`a04-meter-timeout.png` is walk-rig iteration only (the idle composer hid the
whole meter row — fixed and verified in `findings-installed-26.821.1251/`).

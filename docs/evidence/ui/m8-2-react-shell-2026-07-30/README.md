# M8.2 React workspace shell evidence

`hivemind-react-shell-wide.png` is a window-only capture of the native Tauri
application connected to a project-bound daemon and a populated, no-paid
fixture. It is not a browser or static-HTML substitute.

The fixture contains nine tasks across two execution groups and exercises:

- running/failed, ready, checked, rejected, paused, and blocked-before-merge
  presentation;
- active file scopes, quota state, integration confidence, and durable events;
- selected-task output replay from the task-specific output stream;
- routing observations and quality-run evidence in dedicated supporting panels.

The shell was visually inspected at 1440 by 900. Sparse states use deliberate
empty-state copy, while the task rail scrolls independently for denser plans.
The capture predates two final presentation-only fixes made during critique:
worker output records now have line breaks, and the project field updates from
`.` to the canonical project root after the Rust shell resolves it. Those fixes
do not alter the layout or daemon/SSE behavior shown.

The renderer remains observation-only. Its only controls select a project, a
tab, or a task to inspect; it exposes no Hivemind mutation or approval action.

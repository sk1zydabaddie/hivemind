# M8.2 React workspace shell evidence

The captures are window-only screenshots of the native Tauri application
connected to a project-bound daemon and a populated, no-paid fixture. They are
not browser or static-HTML substitutes.

- `hivemind-react-shell-work-wide-final.png` shows the populated Work tab after
  project-path synchronization and newline-separated output were verified.
- `hivemind-react-shell-swarm-stub.png` shows the current Swarm destination.
- `hivemind-react-shell-memory-stub.png` shows the current Memory destination.
- `hivemind-react-shell-history-stub.png` shows the current History destination.
- `hivemind-react-shell-wide.png` is the earlier implementation-pass capture
  retained for visual comparison.

The fixture contains nine tasks across two execution groups and exercises:

- running/failed, ready, checked, rejected, paused, and blocked-before-merge
  presentation;
- active file scopes, quota state, integration confidence, and durable events;
- selected-task output replay from the task-specific output stream;
- routing observations and quality-run evidence in dedicated supporting panels.

The shell was visually inspected at 1440 by 900. Sparse states use deliberate
empty-state copy, while the task rail scrolls independently for denser plans.
The final Work capture shows the shell-resolved canonical project root, two
simultaneously running fixture tasks, and five distinct output records for the
selected task.

The renderer remains observation-only. Its only controls select a project, a
tab, or a task to inspect; it exposes no Hivemind mutation or approval action.

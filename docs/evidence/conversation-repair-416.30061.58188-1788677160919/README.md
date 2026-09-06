# Installed regression failure: repeated project-menu transition

Installed **416.30061.58188**, source `c8ecdf0ae865f208d2a839aa4449541cd51acb24`.
The normal no-paid conversation regression exited **1**, preserving its
10-second menu-open timeout. The immediately preceding attempts
`conversation-repair-416.30061.58188-1788676919168` and
`conversation-repair-416.30061.58188-1788677053236` failed at the same final
project-switch interaction. Their raw evidence and screenshots are retained.

This diagnostic adds element-scoped observations before and after each click.
The first four clicks begin with no old menu mounted and open the menu. The
fifth begins with the old menu still mounted in `data-state="closed"`, although
the project has switched and its draft is already available. The trigger is
closed, its center hits its own span, and body pointer events are enabled.
After that click the old menu is gone but the trigger remains closed; no new
menu arrives within the unchanged timeout. See `projectNavigation` in the JSON.
This identifies a closing-surface timing condition, not its complete internal
event-order cause. No claim is made that the scroll change caused it.

The test's next revision waits for the actual previous closed menu/dialog to
unmount before beginning another project-switch interaction. It does not retry
clicks, alter the 10-second opening deadline, retype lost drafts or change the
installed application. Settled-navigation qualification does not qualify
rapid clicking during the old closing transition; that remains an observed
interaction limitation for a separate bounded follow-up.

The failed runs passed earlier live-output, elapsed-clock, duplicate-submit,
history, attachment, draft/tab/reload and response/planning Stop assertions.
They are **not whole-regression passes**. Recent-project bytes were restored
exactly and only owned fixture processes/directories were cleaned. No paid
calls, OS preferences, actual user projects or public release assets changed.

# Installed regression: stale test handle during New conversation

The no-paid regression on **416.30061.58188** exited **1** after passing all
five project-menu openings. It used the preceding diagnostic's wait for the
actual prior closed surface to unmount. Each `projectNavigation` entry records
`previousSurfaceClosed: true` and `afterClick.expanded: true`; no click was
retried and no menu-open deadline changed.

The remaining failure was `StaleElementReferenceError` at the New conversation
composer predicate. It located the old composer, then used separate remote
calls to read its text and read-only state while the UI replaced that node.
Failure capture shows one replacement composer, empty and still read-only
during its load. This is not evidence that loading subsequently completed.

The corrected predicate samples the current `#work-composer` and both fields
atomically in the page, waiting for the same required result: an empty,
editable composer within 10 seconds. It does not catch a failed draft assertion,
retype lost input or change the installed application. A later complete run
must still pass that predicate and the remaining attachment/provider checks.

Recent-project bytes were restored exactly. No paid calls, user-project edits,
OS preference changes or public release publication occurred. This failed
attempt remains a failure, not a whole-regression qualification.

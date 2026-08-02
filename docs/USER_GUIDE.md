# Hivemind AI User Guide

## Desktop installation

Build the Windows installer from `desktop/` with `npm run tauri:build`, then run
the generated NSIS installer under `desktop/src-tauri/target/release/bundle/nsis/`.
Launch **Hivemind AI** from the Start Menu. The installed release uses the
Windows GUI subsystem, starts a missing project daemon on a dynamic loopback
port without opening a console, and leaves that daemon running when the window
closes so in-flight work is not orphaned.

The installed app includes the built Hivemind Core JavaScript and its package
dependencies. Node.js remains a runtime prerequisite for Core and provider
adapters. Child processes are started with no console window. Development via
`npm run tauri:dev` still requires the Vite/Tauri development terminal by
design; it is not the installed-app launch path.

## Provider mode safety

Use one provider process per Hivemind worker. Do not enable ultra, ultracode,
Dynamic Workflows, or another provider-owned multi-agent mode for a worker or
orchestrator. Hivemind rejects detectable profile settings, flags, and
environment variables for these modes because hidden subagents would violate
the one-worker, one-scope, one-lease, one-diff model.

The boundary is not complete. A provider mode selected outside the adapter
inputs, such as a session-level `/effort ultracode`, may be invisible to
Hivemind. Provider aggregate usage also is not proven to include every nested
subagent call, so an externally enabled multi-agent mode may cause token
ceilings to undercount real spend. Use fresh non-interactive profiles and check
the provider startup output before paid work. Hivemind cannot make an
undetectable provider-side mode safe.

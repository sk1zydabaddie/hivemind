# Hivemind AI User Guide

## Desktop installation

For a local source checkout, run `npm run ship` in `desktop/`. It runs admission
checks, builds the Windows installer, installs it and verifies the installed
artifact/version. Building with `tauri:build` alone does not install it. For a
downloaded beta, use only the official release installer and follow its exact
unsigned-beta/SmartScreen disclosure; do not disable Windows protection.

Launch **Hivemind AI** from the Start Menu. The installed release uses the
Windows GUI subsystem, starts a missing project daemon on a dynamic loopback
port without opening a console, and leaves that daemon running when the window
closes so in-flight work is not orphaned.

The installed app includes Hivemind Core, its dependencies and its pinned Node
runtime. A separate system Node installation is not required to run Core;
provider CLIs may have their own prerequisites. Child processes are started
with no console window. Development via
`npm run tauri:dev` still requires the Vite/Tauri development terminal by
design; it is not the installed-app launch path. See [current status](STATE.md)
for qualification limits and the difference between beta and production trust.

## First project

Choose a project with the native folder browser or enter its full path. Setup
can initialize Git after you review the proposed contents and exclusions. Set
up Hivemind's project folder, choose how to check the code, then connect the
coding-agent CLIs you use. A detected check command does not run until approved.

The supported CLI providers are Codex, Claude Code, Grok Build and OpenCode.
A provider's desktop app alone is not its CLI. A sign-in checkmark means the
CLI account is signed in; project capability verification is a separate check
that may consume provider quota. Settings and the composer's Agents selector
let you choose discovered models for the planner, manager and workers.

Use Work for questions and build requests, Agents for the team once work starts,
and Project for repository history. Conversation can propose work but cannot
approve or ship changes. Project switching does not cancel another project's
work. Start on a disposable, backed-up project while evaluating the beta.

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

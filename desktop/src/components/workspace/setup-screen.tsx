import { ArrowRight, Check, FolderGit2, Loader, Plug, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDismissed } from "@/lib/dismissible";
import { displayProjectPath, PROJECT_FAULT } from "@/lib/project-session";
import { REQUIRED_ROLES } from "@/lib/providers";
import type {
  CatalogueAgent,
  InspectedAdapter,
  ProjectConfigView,
  WorkspaceAction
} from "@/lib/workspace-actions";

/* The cold open, walked twice and rebuilt on what the walk found.
 *
 * Before this, an unconfigured folder produced "Project updates stopped" — an
 * error about a connection that had never been made — over an empty workspace
 * with no way forward. That was fixed. What the second walk found was worse,
 * because it looked finished:
 *
 *   - Step 2 said "setting up the folder writes these" of the agent profiles.
 *     Core deliberately writes NO adapter profile, and says why in its own
 *     comment: a profile written by setup is a declaration no probe has
 *     checked, which is the exact thing `adapter.connect` exists to replace.
 *     So the screen told a new person that the ONE step they must take
 *     themselves — the only one that costs money — was already done.
 *   - Both its buttons opened a dialog that instructed them to hand-write
 *     files that setup HAD written, while the actual connect UI lived behind
 *     the gear icon, unmentioned, with every control disabled and no reason
 *     given.
 *
 * So the steps now say what is true, and the third one CONNECTS rather than
 * pointing somewhere else. A step that describes an action should be the place
 * the action happens; sending someone to find it is where they stop.
 */
export function SetupScreen({
  projectPath,
  connectionCode,
  connectionDetail,
  connectionState,
  live,
  view,
  onChooseProject,
  onInitializeProject,
  onInitializeGit,
  onAction,
  onReload,
  initializing
}: {
  projectPath: string;
  /** Why the project is not open, as a CODE. Never matched as prose. */
  connectionCode: string;
  connectionDetail: string;
  connectionState: string;
  /** True once the daemon is answering: the project is set up and live. */
  live: boolean;
  /** The project's own configuration, or null until it has been read. */
  view: ProjectConfigView | null;
  onChooseProject: () => void;
  onInitializeProject: () => void;
  /* Turning an untracked folder into a repository. Separate from setting the
     project up, because they refuse for different reasons and one can succeed
     where the other cannot. */
  onInitializeGit: () => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onReload: () => Promise<void>;
  initializing: boolean;
}): React.JSX.Element {
  const connecting =
    connectionState === "connecting" ||
    connectionState === "daemon started" ||
    connectionState === "daemon found";
  const visiblePath = displayProjectPath(projectPath);
  const chosen = visiblePath !== "" && visiblePath !== ".";
  const problem = connecting ? null : plainConnectionProblem(connectionCode, connectionDetail);

  return (
    <ScrollArea className="min-h-0">
      <div className="px-6 py-8">
        <div className="max-w-[680px]">
          {connecting ? (
            <p className="m-0 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader aria-hidden="true" className="size-4 animate-spin text-navy" />
              Opening {visiblePath}…
            </p>
          ) : (
            <>
              <h2 className="m-0 text-[22px] leading-tight font-semibold tracking-tighter text-ink">
                {live ? "One thing left." : "Set up this project."}
              </h2>
              <p className="mt-2.5 mb-0 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
                Hivemind builds inside one project folder, using the coding agent
                you already pay for. Three steps, in order.
              </p>

              <WhatThisIs />

              {problem === null ? null : (
                <section className="mt-6 rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-4 py-3">
                  <strong className="block text-[13px] font-semibold text-ink">
                    {problem.title}
                  </strong>
                  <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted-foreground">
                    {problem.detail}
                  </p>
                  {problem.action === "initialize" ? (
                    <Button
                      className="mt-3"
                      disabled={initializing}
                      onClick={onInitializeProject}
                      type="button"
                    >
                      {initializing ? "Setting up…" : "Set up this folder"}
                    </Button>
                  ) : null}
                  {problem.action === "git" ? (
                    <Button
                      className="mt-3"
                      disabled={initializing}
                      onClick={onInitializeGit}
                      type="button"
                    >
                      {initializing ? "Starting to track it…" : "Start tracking this folder"}
                    </Button>
                  ) : null}
                  {problem.action === "choose" ? (
                    <Button className="mt-3" onClick={onChooseProject} type="button">
                      <FolderGit2 aria-hidden="true" />
                      Choose a folder
                    </Button>
                  ) : null}
                  {connectionDetail === "" || problem.detail === connectionDetail ? null : (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[12px] text-muted-foreground">
                        What Hivemind reported
                      </summary>
                      <code className="mt-2 block font-mono text-[12px] break-all text-muted-foreground">
                        {connectionDetail}
                      </code>
                    </details>
                  )}
                </section>
              )}

              <ol className="mt-7 mb-0 grid list-none gap-px overflow-hidden rounded-md border border-rule bg-rule p-0">
                <SetupStep
                  action={
                    <Button size="sm" type="button" variant="outline" onClick={onChooseProject}>
                      <FolderGit2 aria-hidden="true" />
                      {chosen ? "Choose another" : "Choose a folder"}
                    </Button>
                  }
                  detail={
                    chosen
                      ? visiblePath
                      : /* Not "pick a git repository" any more: an untracked
                           folder is now offered the step rather than turned
                           away, so asking for a repository up front rules out
                           the case the screen handles. */
                        "Pick the folder your project lives in."
                  }
                  done={chosen}
                  index={1}
                  title="Your project folder"
                />
                {/* What setup ACTUALLY writes. It writes the settings and the
                    cost tiers; `ensureTierGlobsRecorded` fills only the keys
                    that are absent, so re-running it never resets a list you
                    have edited. It does not write an agent profile. */}
                <SetupStep
                  action={
                    live ? null : (
                      <Button
                        disabled={!chosen || initializing}
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={onInitializeProject}
                      >
                        {initializing ? "Setting up…" : "Set it up"}
                      </Button>
                    )
                  }
                  detail={
                    live
                      ? "Done. Hivemind's settings and cost tiers are in this project, so ordinary work runs on a cheaper model than the one reserved for risky files."
                      : chosen
                        ? "Creates .hivemind in the project: settings, cost tiers, and the history every run is rebuilt from. Nothing is sent anywhere."
                        : "Choose a folder first — this writes into the folder you pick."
                  }
                  done={live}
                  index={2}
                  title="Set up the folder"
                />
                <ConnectStep
                  enabled={live}
                  view={view}
                  onAction={onAction}
                  onReload={onReload}
                />
              </ol>
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

/* The one piece of explanation on this screen, and it is dismissible.
 *
 * Everything else Hivemind has to say about plans, approval and phases is said
 * where those things appear, which is where explanation actually gets read. */
function WhatThisIs(): React.JSX.Element | null {
  const { dismissed, known, dismiss } = useDismissed("setup.what-this-is");
  if (!known || dismissed) return null;
  return (
    <section className="mt-5 rounded-md border border-rule bg-panel px-4 py-3">
      <div className="flex items-start gap-3">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
          Hivemind does not write code itself. It plans the work, runs your coding
          agent on each piece in an isolated copy of the project, checks what came
          back, and holds it all until you approve. Your own branch is not touched
          until you ship.
        </p>
        <Button
          aria-label="Dismiss"
          className="-mt-1 -mr-1.5 shrink-0"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={dismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

/* Roughly what a connect costs, from this project's own probes rather than from
   a vendor's table: three roles at about 40K tokens each. Stated ONCE, before
   anybody clicks, because the per-button figure is only ever read by somebody
   already committed to clicking that button. */
const TOKENS_PER_CONNECT = 40_000;

function ConnectStep({
  enabled,
  view,
  onAction,
  onReload
}: {
  enabled: boolean;
  view: ProjectConfigView | null;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onReload: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState("");

  const [chosenId, setChosenId] = useState<string | null>(null);

  const adapters: InspectedAdapter[] = view?.adapters ?? [];
  /* `connectable` means "Hivemind knows how to start this", NOT "you have it".
     Rendering them all as identical buttons said the opposite: the first walk
     of this screen offered Grok Build — which needs an account nobody has —
     looking exactly like the agent that works. Verified first, and every one
     carries its own status and caveat. */
  const catalogue: CatalogueAgent[] = [...(view?.catalogue ?? [])]
    .filter((agent) => agent.connectable)
    .sort((left, right) => rank(left.status) - rank(right.status));
  const chosen =
    catalogue.find((agent) => agent.id === chosenId) ??
    catalogue.find((agent) => agent.status === "supported") ??
    catalogue[0];
  const connectedRoles = new Set(
    adapters
      .filter((adapter) => adapter.connected_at !== null && adapter.problems.length === 0)
      .map((adapter) => adapter.role)
  );
  const remaining = REQUIRED_ROLES.filter((role) => !connectedRoles.has(role.tool));
  const done = enabled && remaining.length === 0;

  /* One role at a time, stopping at the first refusal. Continuing after one
     fails would spend on the next two to reach the same wall, and the roles
     that did connect stay connected — so the button simply asks for fewer next
     time rather than starting over. */
  const connectAll = async (): Promise<void> => {
    if (chosen === undefined) return;
    setFailure("");
    for (const role of remaining) {
      setBusy(role.tool);
      try {
        await onAction({
          type: "adapter.connect",
          payload: { role: role.tool, agent_id: chosen.id }
        });
      } catch (cause) {
        setFailure(
          `${role.tool}: ${cause instanceof Error ? cause.message : String(cause)}`
        );
        break;
      } finally {
        setBusy(null);
      }
    }
    await onReload();
  };

  return (
    <li className="grid gap-3 bg-panel px-4 py-3">
      <div className="flex items-center gap-3">
        <StepMark done={done} index={3} />
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-medium text-ink">
            Connect a coding agent
          </strong>
          <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
            {/* A disabled control that does not say what it is waiting for is
                indistinguishable from a broken one. */}
            {!enabled
              ? "Waiting on step 2 — connecting writes into the project, so the folder has to be set up first."
              : done
                ? "All three roles are connected and checked. You can start building."
                : "Setting up the folder does NOT do this, on purpose: a profile written by setup would be a claim nobody checked. Connecting runs the agent once and records what it can actually do."}
          </span>
        </div>
      </div>

      {enabled && !done ? (
        <p className="m-0 rounded-sm border-l-2 border-amber bg-amber-wash px-2.5 py-1.5 text-[12px] leading-snug text-ink">
          This costs money. Each connection runs your agent once — about{" "}
          {TOKENS_PER_CONNECT.toLocaleString()} tokens — and there are{" "}
          {REQUIRED_ROLES.length} roles to fill, so expect roughly{" "}
          <strong className="font-semibold">
            {(TOKENS_PER_CONNECT * REQUIRED_ROLES.length).toLocaleString()} tokens
          </strong>{" "}
          against your own subscription before a line of code is written. Nothing
          is spent until you click.
        </p>
      ) : null}

      {enabled ? (
        <div className="grid gap-2.5">
          {/* One agent, then all three roles — not eighteen buttons.
              Nearly everybody has exactly one coding agent, and asking which
              one they have is a question they can answer. Asking it once per
              role three times over is the same question wearing a disguise. */}
          {catalogue.length === 0 ? (
            <span className="text-[12px] text-muted-foreground">
              Hivemind knows how to start no agent on this machine. Install one
              and open the project again.
            </span>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {catalogue.map((agent) => (
                <AgentChoice
                  agent={agent}
                  key={agent.id}
                  selected={agent.id === chosen?.id}
                  onSelect={() => setChosenId(agent.id)}
                />
              ))}
            </div>
          )}

          <div className="grid gap-1">
            {REQUIRED_ROLES.map((role) => {
              const isConnected = connectedRoles.has(role.tool);
              return (
                <div className="flex items-baseline gap-2" key={role.tool}>
                  <span
                    aria-hidden="true"
                    className={`size-1.5 shrink-0 rounded-xs ${
                      isConnected ? "bg-navy" : "bg-rule"
                    }`}
                  />
                  <code className="font-mono text-[12px] text-ink">{role.tool}</code>
                  <span className="min-w-0 flex-1 text-[11px] break-words text-muted-foreground">
                    {role.purpose}
                  </span>
                  <span
                    className={`shrink-0 text-[11px] font-medium ${
                      isConnected ? "text-navy" : "text-muted-foreground"
                    }`}
                  >
                    {isConnected ? "Connected" : "Not connected"}
                  </span>
                </div>
              );
            })}
          </div>

          {chosen === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy !== null} type="button" onClick={() => void connectAll()}>
                {busy === null ? (
                  <Plug aria-hidden="true" />
                ) : (
                  <Loader aria-hidden="true" className="animate-spin" />
                )}
                {busy === null
                  ? `Connect ${chosen.label} for ${remaining.length === REQUIRED_ROLES.length ? "all " : ""}${remaining.length} role${remaining.length === 1 ? "" : "s"}`
                  : `Connecting ${busy}…`}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                ~{(TOKENS_PER_CONNECT * remaining.length).toLocaleString()} tokens
              </span>
            </div>
          )}

          {failure === "" ? null : (
            <p className="m-0 rounded-sm border-l-2 border-clay bg-clay-wash px-2.5 py-1.5 text-[12px] leading-snug break-words text-clay">
              {failure}
            </p>
          )}
        </div>
      ) : null}

      {done ? (
        <p className="m-0 flex items-center gap-1.5 text-[12px] text-navy">
          <ArrowRight aria-hidden="true" className="size-3.5" />
          Open Work and describe what you want built.
        </p>
      ) : null}
    </li>
  );
}

/** Verified first, then probed-but-unverified, then the rest. */
function rank(status: CatalogueAgent["status"]): number {
  if (status === "supported") return 0;
  return status === "unverified" ? 1 : 2;
}

function AgentChoice({
  agent,
  selected,
  onSelect
}: {
  agent: CatalogueAgent;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-pressed={selected}
      className={`cursor-pointer rounded-sm border px-3 py-2 text-left transition-colors ${
        selected ? "border-navy bg-navy-wash" : "border-rule bg-canvas hover:border-navy/40"
      }`}
      type="button"
      onClick={onSelect}
    >
      <div className="flex items-baseline justify-between gap-2">
        <strong className="text-[12px] font-semibold text-ink">{agent.label}</strong>
        <span
          className={`shrink-0 text-[11px] font-medium ${
            agent.status === "supported" ? "text-navy" : "text-amber"
          }`}
        >
          {agent.status === "supported" ? "Verified" : "Not verified yet"}
        </span>
      </div>
      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
        {agent.subscription}
      </span>
      {/* The reason it is not verified, said here rather than discovered by
          clicking. An agent needing an account nobody has must not look
          identical to the one that works. */}
      {agent.caveat === null ? null : (
        <span className="mt-1 block text-[11px] leading-snug break-words text-amber">
          {agent.caveat}
        </span>
      )}
    </button>
  );
}

function StepMark({ index, done }: { index: number; done: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5 shrink-0 place-items-center rounded-xs font-mono text-[11px] ${
        done ? "bg-navy text-white" : "bg-canvas text-muted-foreground"
      }`}
    >
      {done ? <Check className="size-3" /> : index}
    </span>
  );
}

function SetupStep({
  index,
  title,
  detail,
  action,
  done
}: {
  index: number;
  title: string;
  detail: string;
  action: React.ReactNode;
  done: boolean;
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-3 bg-panel px-4 py-3">
      <StepMark done={done} index={index} />
      <div className="min-w-0 flex-1">
        <strong className="block text-[13px] font-medium text-ink">{title}</strong>
        <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
          {detail}
        </span>
      </div>
      {action}
    </li>
  );
}

/**
 * What to tell a person, chosen by CODE.
 *
 * This used to take the connection's error message and match it with
 * `/not a git repository|git root/`. The shell actually says "selected
 * directory is not **inside** a git repository", which that pattern does not
 * match — so the "start tracking this folder" button was unreachable from the
 * day it was written, and the commonest first-run case there is fell through to
 * a generic failure with an internal sentence as its body.
 *
 * See `PROJECT_FAULT`: the codes are assigned in Rust where each failure is
 * created. An unrecognised code offers nothing, which is the safe direction.
 */
export function plainConnectionProblem(
  code: string,
  detail: string
): { title: string; detail: string; action?: "initialize" | "git" | "choose" } | null {
  if (code === "") return null;
  if (code === PROJECT_FAULT.noProjectSelected) {
    return {
      title: "No project is open",
      detail: "Choose the folder you want Hivemind to build in.",
      action: "choose"
    };
  }
  if (code === PROJECT_FAULT.notInitialized) {
    return {
      title: "This folder has not been set up yet",
      detail:
        "Hivemind keeps its plans, checks and history inside the project. It can create that now, along with the cost tiers a first run needs.",
      action: "initialize"
    };
  }
  if (code === PROJECT_FAULT.notAGitRepository) {
    /* This used to explain the requirement and stop, which is a dead end for
       the most ordinary first-run case there is: somebody who has been editing
       a folder without git. Explaining a requirement is not the same as
       offering the step. */
    return {
      title: "This folder is not tracked by git yet",
      detail:
        "Hivemind needs git to keep an agent's work separate from your own until you choose to ship it. It can start tracking this folder now — nothing is sent anywhere, and everything already here goes into the first commit.",
      action: "git"
    };
  }
  if (code === PROJECT_FAULT.daemonUnavailable) {
    return {
      title: "Hivemind's local service did not start",
      detail:
        "Nothing has been changed in your project. Try opening the project again; if it keeps failing, close any other copy of Hivemind that may be running.",
      action: undefined
    };
  }
  if (detail === "") return null;
  return { title: "Hivemind could not open this project", detail };
}

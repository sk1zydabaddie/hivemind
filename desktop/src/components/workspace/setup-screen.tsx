import { ArrowRight, Check, FolderGit2, Loader, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/pressable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionControl } from "@/components/ui/selection-control";
import { MultiplierDisclosure, ProviderListRow, providerRank } from "@/components/workspace/provider-list";
import { useDismissed } from "@/lib/dismissible";
import {
  displayProjectPath,
  PROJECT_FAULT,
  type GitReadiness,
  type GitSetupFailure
} from "@/lib/project-session";
import { plainActionError } from "@/lib/plain-language";
import { useProviderAuthentication } from "@/lib/provider-authentication";
import { REQUIRED_ROLES } from "@/lib/providers";
import { trialAffordance, verificationResolved } from "@/lib/workspace-actions";
import type { CheckKind, CheckTrialView, CheckTryResult } from "@/lib/workspace-actions";
import type {
  CatalogueModelView,
  CatalogueProvider,
  InspectedAdapter,
  ProjectConfigView,
  RoleRecommendation,
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
  actionError,
  gitReadiness,
  gitSetupFailure,
  gitSetupDone,
  live,
  view,
  onChooseProject,
  onInitializeProject,
  onInitializeGit,
  onRestartDaemon,
  onAction,
  onReload,
  initializing,
  runnable,
  onStartWorking
}: {
  projectPath: string;
  /** Why the project is not open, as a CODE. Never matched as prose. */
  connectionCode: string;
  connectionDetail: string;
  connectionState: string;
  actionError: string;
  gitReadiness: GitReadiness | null;
  gitSetupFailure: GitSetupFailure | null;
  /* Set once git setup succeeded for the open project, with the files its
     first commit contains. A success used to leave nothing on screen: the
     panel it was about disappears, so the only evidence was the absence of
     the button, which reads as the action having been undone. */
  gitSetupDone: { forProject: string; files: string[] } | null;
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
  /* Stops the previous version's background process and opens the project on
     the matching one. Refuses while anything is in flight. */
  onRestartDaemon: () => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onReload: () => Promise<void>;
  initializing: boolean;
  /* Whether Core would actually let work start. The steps above can all read
     complete while this is false -- a missing check command is the case that
     shipped -- and a screen that cannot say which term is unmet is a dead end. */
  runnable: boolean;
  onStartWorking: () => void;
}): React.JSX.Element {
  const connecting =
    connectionState === "connecting" ||
    connectionState === "daemon started" ||
    connectionState === "daemon found";
  const visiblePath = displayProjectPath(projectPath);
  const chosen = visiblePath !== "" && visiblePath !== ".";
  const problem = connecting ? null : plainConnectionProblem(connectionCode, connectionDetail);
  const checkingGit = problem?.action === "git" && gitReadiness === null && actionError === "";
  const gitRefusal = problem?.action === "git" ? gitReadiness?.refusal ?? null : null;
  const generatedIgnores = gitReadiness?.would_ignore ?? [];
  const startsEmpty = gitReadiness?.starts_empty ?? false;
  const gitBlocksSetup = problem?.action === "git";

  return (
    /* `min-h-0` alone gives this no HEIGHT, so it grew to fit its content and
       the app shell's `overflow-hidden` clipped the overflow with nothing to
       scroll. The provider restructure made this screen tall enough for that to
       cut the page off mid-way through the role assignment, which made the
       whole first run impossible to finish.
       `flex-1` is what bounds it: the setup screen is a flex child both as the
       whole window (before the daemon answers) and inside its tab (after), and
       in both cases it must take the space that is left rather than ask for the
       space it wants. Work and Project already did this with `h-full min-h-0`;
       this was the one surface that did not. */
    <ScrollArea className="min-h-0 flex-1">
      <div className="hivemind-identity-field px-6 py-8">
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
                you already pay for. Four steps, in order — and a fifth once
                there is an agent to tune.
              </p>

              {gitSetupDone !== null && gitSetupDone.forProject === projectPath ? (
                <p
                  className="mt-4 mb-0 rounded-sm border border-navy/25 border-l-2 border-l-navy bg-navy-wash px-3 py-2 text-[12px] leading-relaxed text-ink"
                  role="status"
                >
                  <strong className="font-medium">Git is set up.</strong>{" "}
                  {gitSetupDone.files.length === 0
                    ? "The first commit is in place."
                    : `The first commit tracks ${gitSetupDone.files.length} item${gitSetupDone.files.length === 1 ? "" : "s"}: ${gitSetupDone.files.slice(0, 6).join(", ")}${gitSetupDone.files.length > 6 ? ", and more" : ""}.`}{" "}
                  The next step below is a different one.
                </p>
              ) : null}

              <NotAnEditor />

              <WhatThisIs />

              {problem === null ? null : (
                <section className="mt-6 rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-4 py-3">
                  <strong className="block text-[13px] font-semibold text-ink">
                    {problem.title}
                  </strong>
                  <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted-foreground">
                    {problem.action === "git"
                      ? checkingGit
                        ? "Hivemind is checking what the first commit would contain."
                        : actionError !== ""
                          ? "Hivemind could not confirm that a first commit would be safe."
                          : gitRefusal ?? (startsEmpty
                              ? "Hivemind will create a Git repository and an empty first commit, ready for a new project."
                              : generatedIgnores.length > 0
                                ? `Hivemind will add ${generatedIgnores.join(", ")} to .gitignore, verify they are excluded, then create the repository and first commit.`
                                : problem.detail)
                      : problem.detail}
                  </p>
                  {actionError === "" ? null : (
                    <p className="mt-2 mb-0 text-[12px] font-medium text-clay" role="alert">
                      {/* "Nothing changed." is a claim about durable state, and
                          for one-click git setup it is now MEASURED: the shell
                          reports whether its rollback put the folder back, and
                          the copy branches on that code -- never on the message
                          (A-07). A failure whose rollback also failed names
                          exactly what remains instead of claiming cleanliness. */}
                      {gitSetupFailure === null || gitSetupFailure.code === "nothing_changed"
                        ? `Nothing changed. ${actionError}`
                        : gitSetupFailure.remaining.length > 0
                          ? `Setup stopped partway and could not put everything back. Still in the folder: ${gitSetupFailure.remaining.join(", ")}. ${actionError}`
                          : `Setup stopped partway, and Hivemind could not confirm the folder was put back. ${actionError}`}
                    </p>
                  )}
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
                  {problem.action === "git" && gitReadiness !== null && gitRefusal === null ? (
                    <Button
                      className="mt-3"
                      disabled={initializing}
                      onClick={onInitializeGit}
                      type="button"
                    >
                      {initializing ? "Setting up git…" : "Set up git for me"}
                    </Button>
                  ) : null}
                  {checkingGit ? (
                    <p className="mt-3 mb-0 text-[12px] font-medium text-muted-foreground" role="status">
                      Checking folder…
                    </p>
                  ) : null}
                  {problem.action === "git" && gitRefusal !== null ? (
                    <Button className="mt-3" onClick={onChooseProject} type="button" variant="outline">
                      <FolderGit2 aria-hidden="true" />
                      Choose another folder
                    </Button>
                  ) : null}
                  {problem.action === "restart_daemon" ? (
                    <Button
                      className="mt-3"
                      disabled={initializing}
                      type="button"
                      onClick={onRestartDaemon}
                    >
                      {initializing ? "Restarting…" : "Restart it"}
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
                        disabled={!chosen || initializing || gitBlocksSetup}
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={onInitializeProject}
                      >
                        {initializing
                          ? "Setting up…"
                          : gitBlocksSetup
                            ? "Waiting on git"
                            : "Set it up"}
                      </Button>
                    )
                  }
                  detail={
                    live
                      ? "Done. Hivemind's settings and cost tiers are in this project, so ordinary work runs on a cheaper model than the one reserved for risky files."
                      : gitBlocksSetup
                        ? checkingGit
                          ? "Waiting while Hivemind checks whether this folder can be tracked safely."
                          : "Resolve the git issue above before setting up Hivemind."
                      : chosen
                        ? "Creates .hivemind in the project: settings, cost tiers, and the history every run is rebuilt from. Nothing is sent anywhere."
                        : "Choose a folder first — this writes into the folder you pick."
                  }
                  done={live}
                  index={2}
                  title="Set up the folder"
                />
                <ChecksStep enabled={live} view={view} onAction={onAction} onReload={onReload} />
                <ConnectStep
                  enabled={live}
                  view={view}
                  onAction={onAction}
                  onReload={onReload}
                />
              </ol>

              <SetupExit
                live={live}
                runnable={runnable}
                view={view}
                onStartWorking={onStartWorking}
              />
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
/**
 * The self-selection sentence, and why it is not dismissible.
 *
 * Editor, terminal and preview are the three most visible features of every
 * comparable tool — Orca ships a Monaco editor, infinite terminal splits and a
 * Chromium window per worktree; Cursor, Windsurf, Zed and BridgeSpace all ship
 * the same three. Hivemind refuses all three on purpose, and no amount of
 * building changes that, because the thing those users want is the thing this
 * architecture exists to prevent.
 *
 * So somebody who wants an IDE will find this unfinished. That is a positioning
 * problem rather than a backlog item, and the only honest fix is to say it
 * before they invest an afternoon discovering it.
 *
 * NOT `useDismissed`, unlike everything else on this screen. A dismissible
 * notice is for something a person has understood and no longer needs; this is
 * the sentence that decides whether they should be here at all, and it costs
 * three lines. It is also deliberately not a boxed warning — this project has
 * already learned that a boxed repeat of a fact reads as a disclaimer rather
 * than as information.
 */
/**
 * What the last screen of onboarding offers, as a value rather than as JSX.
 *
 * Split out because the branch that matters is the one nobody sees in a happy
 * walk: every step ticked, `runnable` false, and -- before this existed --
 * nothing rendered at all. An end-to-end walk cannot reach it reliably, because
 * a healthy machine promotes straight to the work surface, so the branch is
 * pinned here instead and the walk proves the promotion.
 *
 * A typed kind rather than a message: the caller switches on the code and the
 * words live in one place, per the rule against deciding anything from text.
 */
export type SetupExitState =
  | { kind: "hidden" }
  | { kind: "ready" }
  | { kind: "blocked"; missing: string[] }
  | { kind: "disagreement" };

export function setupExitState(input: {
  live: boolean;
  runnable: boolean;
  adapters: readonly { role: string; connected_at: string | null; problems: readonly unknown[] }[];
  checkResolved: boolean;
}): SetupExitState {
  if (!input.live) return { kind: "hidden" };
  if (input.runnable) return { kind: "ready" };

  /* Which term is missing, computed from the same values `runnable` is built
     from so the two cannot disagree. Reported in the order somebody would fix
     them. */
  const connectedRoles = new Set(
    input.adapters
      .filter((adapter) => adapter.connected_at !== null && adapter.problems.length === 0)
      .map((adapter) => adapter.role)
  );
  const rolesLeft = REQUIRED_ROLES.filter((role) => !connectedRoles.has(role.tool));
  if (rolesLeft.length === 0 && input.checkResolved) return { kind: "disagreement" };
  return {
    kind: "blocked",
    missing: [
      ...(rolesLeft.length > 0
        ? [
            `${rolesLeft.map((role) => role.tool).join(" and ")} still ${
              rolesLeft.length === 1 ? "needs" : "need"
            } an agent`
          ]
        : []),
      ...(input.checkResolved ? [] : ["how this project is checked is unanswered"])
    ]
  };
}

/**
 * The way out of the last screen of onboarding.
 *
 * There was none. With every step checked, the connect step hides its own
 * Continue button (it has nothing left to connect) and nothing else offered an
 * exit, so a finished setup stood still. Automatic promotion covers the case
 * where Core agrees work can start; this covers the two cases it does not:
 *
 *  - it CAN start, and a person is still standing here -- give them the door
 *    rather than relying on an effect having fired.
 *  - it LOOKS finished and cannot start, which is the shape that shipped: every
 *    step ticked while `runnable` was false. Then the honest thing is to name
 *    the unmet term rather than render nothing.
 */
function SetupExit({
  live,
  runnable,
  view,
  onStartWorking
}: {
  live: boolean;
  runnable: boolean;
  view: ProjectConfigView | null;
  onStartWorking: () => void;
}): React.JSX.Element | null {
  const state = setupExitState({
    live,
    runnable,
    adapters: view?.adapters ?? [],
    checkResolved: verificationResolved(view?.config)
  });

  if (state.kind === "hidden") return null;

  if (state.kind === "ready") {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button type="button" onClick={onStartWorking}>
          Start working
          <ArrowRight aria-hidden="true" />
        </Button>
        <span className="text-[12px] text-muted-foreground">
          Everything this project needs is checked.
        </span>
      </div>
    );
  }

  if (state.kind === "blocked") {
    return (
      <p className="mt-4 mb-0 rounded-sm border-l-2 border-amber bg-amber-wash px-2.5 py-1.5 text-[12px] leading-relaxed text-ink">
        Work cannot start yet: {state.missing.join(", and ")}. The step above is
        where that is answered.
      </p>
    );
  }

  /* Everything this screen can see is satisfied and Core still says no. Saying
     so beats a blank space, and it is the state to report if it ever appears. */
  return (
    <p className="mt-4 mb-0 rounded-sm border-l-2 border-amber bg-amber-wash px-2.5 py-1.5 text-[12px] leading-relaxed text-ink">
      Every step here is complete, but this project is not reporting itself as
      ready to work. Reopening it re-reads its settings; if this persists it is
      worth reporting, because the steps and the project disagree.
    </p>
  );
}

function NotAnEditor(): React.JSX.Element {
  return (
    <p className="mt-3 mb-0 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
      <span className="font-medium text-ink">
        There is no editor, no terminal and no preview here, deliberately.
      </span>{" "}
      Hivemind checks what an agent did before it can reach your branch, and each
      of those three would be a way around the check. If you want to write the
      code yourself, you want an IDE — that is a better tool for it, and this is
      not trying to be one.
    </p>
  );
}

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
/* What one connection costs. Measured on this project's own probes, not from a
   vendor's table. Stated beside the button that spends it and nowhere else --
   a separate boxed warning repeating the same figure was two claims where one
   would do, and the second one read as a disclaimer rather than a price. */
const TOKENS_PER_CONNECT = 40_000;

export interface PlannedProviderConnection {
  role: string;
  agentId: string;
  providerId: string;
}

/**
 * Turn the two independent choices on this screen into the exact probes the
 * dispatcher will run. Kept pure so a regression cannot make the second
 * selected provider vanish behind the first while the source still says
 * "multi-select".
 */
export function planProviderConnections(input: {
  chosen: Set<string>;
  providers: CatalogueProvider[];
  models: CatalogueModelView[];
  recommendations: RoleRecommendation[];
  remainingRoles: string[];
}): PlannedProviderConnection[] {
  const runnableProviders = new Set(
    input.providers.filter((provider) => provider.connectable).map((provider) => provider.id)
  );
  const agentForRole = (role: string): string | null => {
    const fromChosen = input.models.filter(
      (model) => input.chosen.has(model.provider_id) && runnableProviders.has(model.provider_id)
    );
    const advice = input.recommendations.find((entry) => entry.role === role);
    if (advice !== undefined && fromChosen.some((model) => model.agent_id === advice.agent_id)) {
      return advice.agent_id;
    }
    return fromChosen[0]?.agent_id ?? null;
  };
  const agentForProvider = (providerId: string): string | null =>
    input.models.find((model) => model.provider_id === providerId)?.agent_id ?? null;

  /* Every recommendation for the role, not just the first.
     
     The worker role is a POOL and the tier floor REFUSES rather than
     downgrades, so a pool that does not span the tiers cannot run a High or
     Critical task at all -- and Core now recommends a cheap member and a
     strong member for exactly that reason. Taking only the first
     recommendation would connect half the advice and leave the other half
     invisible, which is how the suggested setup came to be one that could not
     add a dependency. Costs one extra probe per additional member, which the
     button already prices. */
  const roleConnections = input.remainingRoles.flatMap((role) => {
    const recommended = input.recommendations
      .filter((entry) => entry.role === role)
      .map((entry) => entry.agent_id)
      .filter((agentId) =>
        input.models.some(
          (model) =>
            model.agent_id === agentId &&
            input.chosen.has(model.provider_id) &&
            runnableProviders.has(model.provider_id)
        )
      );
    const agentIds = recommended.length > 0 ? recommended : [agentForRole(role)];
    return agentIds.flatMap((agentId) => {
      const model = input.models.find((entry) => entry.agent_id === agentId);
      return agentId === null || model === undefined
        ? []
        : [{ role, agentId, providerId: model.provider_id }];
    });
  });
  const covered = new Set(roleConnections.map((entry) => entry.providerId));
  const providerConnections = input.providers.flatMap((provider) => {
    if (
      !input.chosen.has(provider.id) ||
      provider.checked_here ||
      covered.has(provider.id) ||
      !provider.connectable
    ) {
      return [];
    }
    const agentId = agentForProvider(provider.id);
    return agentId === null ? [] : [{ role: "worker", agentId, providerId: provider.id }];
  });
  const unique = new Map<string, PlannedProviderConnection>();
  for (const entry of [...providerConnections, ...roleConnections]) {
    unique.set(`${entry.role}:${entry.agentId}`, entry);
  }
  return [...unique.values()];
}

/* Two questions, asked separately.
 *
 * Step 3 is WHICH PROVIDERS DO I HAVE. It is multi-select, because somebody
 * with both a ChatGPT and a Claude subscription has both — and the previous
 * single-select made the mixed-provider arrangement Core has always supported
 * unreachable from the interface. Selecting is not spending: the checkboxes
 * choose, and Continue builds a plan that covers every selected provider plus
 * every still-empty role. A selected provider must never disappear merely
 * because another provider happened to be first in the catalogue.
 *
 * Step 4 is WHICH MODEL FOR WHICH ROLE, and it only exists once something is
 * connected, because until a probe has run nothing knows whether a model can be
 * chosen at all.
 *
 * The chooser is a LIST, not a wall. Five cards carrying paragraph-long caveats
 * took half the screen and could not be scanned; each provider is now one row —
 * logo, name, subscription, status, chevron. The caveats are unchanged and move
 * behind the chevron: they are the most honest text on this screen and the only
 * place anybody is told "no whole piece of work has been built and shipped
 * through it yet". That is worth reading before trusting a provider, and it is
 * not what you need while picking one out of five.
 */
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
  const [busy, setBusy] = useState<{
    key: string;
    label: string;
    index: number;
    total: number;
    startedAt: number;
  } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const { standings: authenticationStandings, watchForCompletion } =
    useProviderAuthentication({ active: enabled, onAction });

  /* Windows reduced motion can stop the spinner, but it cannot stop the
     report. This is a discrete elapsed count, not decorative animation: two
     captures three seconds apart show different factual text. */
  useEffect(() => {
    if (busy === null) return undefined;
    const tick = (): void =>
      setElapsedSeconds(Math.floor((Date.now() - busy.startedAt) / 1_000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const providers = [...(view?.providers ?? [])].sort(
    (left, right) => providerRank(left.status) - providerRank(right.status)
  );
  const models = view?.models ?? [];
  const recommendations = view?.recommendations ?? [];
  const adapters = view?.adapters ?? [];

  /* Verified providers start ticked, because that is the answer for almost
     everybody and an empty form is a worse first impression than a sensible
     one. It is a pre-selection, not a decision: nothing is spent until
     Continue. */
  const chosen =
    picked ?? new Set(providers.filter((entry) => entry.status === "supported").map((e) => e.id));

  const connectedRoles = new Set(
    adapters
      .filter((adapter) => adapter.connected_at !== null && adapter.problems.length === 0)
      .map((adapter) => adapter.role)
  );
  const remaining = REQUIRED_ROLES.filter((role) => !connectedRoles.has(role.tool));
  const done = enabled && remaining.length === 0;

  const toggle = (id: string): void => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  /* One probe per selected provider, then whatever additional role profiles
     Core still needs. Worker is a pool, so a provider not used by the planner
     or manager can be checked as another real worker without inventing a
     provider-only record that runtime routing would never consume. */
  const connectionPlan = (): PlannedProviderConnection[] =>
    planProviderConnections({
      chosen,
      providers,
      models,
      recommendations,
      remainingRoles: remaining.map((role) => role.tool)
    });

  const plannedConnections = connectionPlan();

  const connectAll = async (): Promise<void> => {
    setFailure("");
    setNotice("");
    /* A Continue with no runnable provider is a dead end reached by pressing
       the button the screen told you to press. Say so instead. */
    const plan = connectionPlan();
    if (plan.length === 0) {
      setFailure(
        "Nothing ticked here can run a model, so there is nothing to check. Tick a provider you actually have."
      );
      return;
    }
    const startedAt = Date.now();
    const labelFor = (connection: PlannedProviderConnection): string =>
      providers.find((entry) => entry.id === connection.providerId)?.label ?? connection.role;

    /* CONCURRENT, grouped by harness.
     *
     * Serially this was one probe after another -- "Checking Codex — 2 of 3 ·
     * 11s" three times over, which is slow enough to read as broken. Each probe
     * is an independent provider process writing its own profile and its own
     * connection record, so different HARNESSES have nothing to contend over
     * and run together.
     *
     * Grouped rather than fully parallel because two connects for the SAME
     * harness are not independent: `ensureHarnessProjectConfig` writes that
     * harness's project file, and the worker pool's own retirement pass reads
     * and deletes profiles. Same harness stays in order; that is where the
     * unsafe overlap would be, and it is also the case a machine-scoped cached
     * verdict now usually answers without a call at all. */
    const byHarness = new Map<string, PlannedProviderConnection[]>();
    for (const connection of plan) {
      const existing = byHarness.get(connection.providerId);
      if (existing === undefined) byHarness.set(connection.providerId, [connection]);
      else existing.push(connection);
    }

    let finished = 0;
    const failures: string[] = [];
    setBusy({
      key: "all",
      label: [...byHarness.keys()]
        .map((id) => providers.find((entry) => entry.id === id)?.label ?? id)
        .join(", "),
      index: 0,
      total: plan.length,
      startedAt
    });

    await Promise.all(
      [...byHarness.values()].map(async (group) => {
        for (const connection of group) {
          try {
            await onAction({
              type: "adapter.connect",
              payload: { role: connection.role, agent_id: connection.agentId }
            });
          } catch (cause) {
            failures.push(
              `${labelFor(connection)}: ${cause instanceof Error ? cause.message : String(cause)}`
            );
            setOpened(connection.providerId);
            /* Its own harness stops; the others are independent and keep
               going, so one missing subscription does not cost the run. */
            return;
          }
          finished += 1;
          setBusy({
            key: "all",
            label: labelFor(connection),
            index: finished,
            total: plan.length,
            startedAt
          });
          /* Each completed probe becomes visible immediately. Waiting until the
             entire sequence ends made a real success look frozen behind the
             next provider's spinner. */
          await onReload();
        }
      })
    );
    if (failures.length > 0) setFailure(failures.join(" · "));
    setBusy(null);
  };

  const startAuthentication = async (provider: CatalogueProvider): Promise<void> => {
    setFailure("");
    setNotice("");
    setAuthBusy(provider.id);
    watchForCompletion(provider.id);
    try {
      await onAction({
        type: "provider.auth.start",
        payload: { provider_id: provider.id }
      });
      setNotice(
        `${provider.label} opened its own sign-in flow in a separate window. Finish there, then keep it ticked and press Continue to check it.`
      );
    } catch (cause) {
      watchForCompletion(null);
      setFailure(
        `${provider.label}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    } finally {
      setAuthBusy(null);
    }
  };

  return (
    <li className="grid gap-3 bg-panel/82 shadow-[var(--glass-edge)] px-4 py-3">
      <div className="flex items-center gap-3">
        <StepMark done={done} index={4} />
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-medium text-ink">
            Which providers do you have?
          </strong>
          <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
            {!enabled
              ? "Waiting on step 2 — connecting writes into the project, so the folder has to be set up first."
              : done
                ? "Every role is connected and checked."
                : "Tick the subscriptions you already pay for. Setting up the folder does NOT connect them: a profile written by setup would be a claim nobody checked."}
          </span>
        </div>
      </div>

      {enabled && !done ? (
        <>
          {providers.length === 0 ? (
            <span className="text-[12px] text-muted-foreground">
              Hivemind knows how to start no agent on this machine. Install one
              and open the project again.
            </span>
          ) : (
            <div className="overflow-hidden rounded-sm border border-rule">
              {providers.map((provider) => (
                <ProviderListRow
                  authenticationBusy={authBusy === provider.id}
                  authenticationStatus={authenticationStandings.get(provider.id)?.status ?? "unknown"}
                  checksBusy={busy !== null}
                  expanded={opened === provider.id}
                  key={provider.id}
                  reaches={authenticationStandings.get(provider.id)?.reaches ?? null}
                  leading={
                    <Checkbox
                      aria-label={`Use ${provider.label}`}
                      checked={chosen.has(provider.id)}
                      disabled={!provider.connectable}
                      onCheckedChange={() => toggle(provider.id)}
                    />
                  }
                  provider={provider}
                  selected={chosen.has(provider.id)}
                  onExpand={() => setOpened(opened === provider.id ? null : provider.id)}
                  onAuthenticate={() => void startAuthentication(provider)}
                />
              ))}
            </div>
          )}

          <MultiplierDisclosure
            busy={busy !== null || authBusy !== null}
            provider={providers.find((entry) => entry.support_tier === "multiplier") ?? null}
            standing={(() => {
              const multiplier = providers.find((entry) => entry.support_tier === "multiplier");
              return multiplier === undefined
                ? null
                : (authenticationStandings.get(multiplier.id) ?? null);
            })()}
            onAction={onAction}
            onSignInStarted={watchForCompletion}
            onReload={onReload}
          />

          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Button
              disabled={busy !== null || authBusy !== null || plannedConnections.length === 0}
              type="button"
              onClick={() => void connectAll()}
            >
              {busy === null ? (
                <Plug aria-hidden="true" />
              ) : (
                <Loader aria-hidden="true" className="animate-spin" />
              )}
              {busy === null
                ? "Continue"
                : busy.index === 0
                  ? `Checking ${busy.label} · ${elapsedSeconds}s`
                  : `Checked ${busy.index} of ${busy.total} — ${busy.label} · ${elapsedSeconds}s`}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Runs every selected provider at least once and fills the empty roles — about{" "}
              {(TOKENS_PER_CONNECT * plannedConnections.length).toLocaleString()} tokens on
              your own subscription.
            </span>
          </div>

        </>
      ) : null}

      {/* Outside both branches on purpose. Step 4 writes here too, and while
          this sat inside the `!done` arm a model change that failed set a
          message nothing rendered -- the surface would simply go quiet. */}
      {failure === "" ? null : (
        <p className="m-0 rounded-sm border-l-2 border-clay bg-clay-wash px-2.5 py-1.5 text-[12px] leading-snug break-words text-clay">
          {failure}
        </p>
      )}

      {notice === "" ? null : (
        <p className="m-0 rounded-sm border-l-2 border-navy bg-navy-wash px-2.5 py-1.5 text-[12px] leading-snug break-words text-ink" role="status">
          {notice}
        </p>
      )}

      {/* Every role that EXISTS, rather than only once they all do. Gating this
          on `done` made it unreachable from the one real capture there is --
          which has `worker` connected and the other two not -- and there is no
          reason to hide the model a connected role runs on while its siblings
          are still being set up. */}
      {enabled && connectedRoles.size > 0 ? (
        <ModelStep
          adapters={adapters}
          busy={busy?.key ?? null}
          models={models}
          recommendations={recommendations}
          onChange={async (role, agentId) => {
            const startedAt = Date.now();
            setBusy({ key: role, label: role, index: 1, total: 1, startedAt });
            setFailure("");
            try {
              await onAction({ type: "adapter.connect", payload: { role, agent_id: agentId } });
            } catch (cause) {
              setFailure(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(null);
            }
            await onReload();
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * Step 4 — which model runs which role.
 *
 * ## What "available models" means, per provider
 *
 * Three cases, and only two of them exist today:
 *
 * 1. **A known list.** The catalogue names the slugs a harness accepts, which
 *    for Codex is three. This is the only case with something to choose.
 * 2. **A provider that reports its own models.** Nothing does. The closest is
 *    Claude Code's per-model usage breakdown, and that reports which models
 *    RAN during one call — evidence about that run, not a menu. Treating it as
 *    a menu would be inventing a capability, so this case is left empty until a
 *    harness genuinely offers one.
 * 3. **No choice at all**, because the probe could not confirm the harness runs
 *    the model it was asked for. Then there is nothing to pick and saying so is
 *    the honest answer — `modelChoiceRefusal` in Core computes that sentence
 *    from the RECORDED probe, and it is carried here rather than rewritten.
 *
 * Changing a model reconnects. The model is baked into the profile's argv at
 * connect time, so pointing a role at a different one means writing a different
 * profile — and a profile whose capabilities were measured against a different
 * model is exactly the declaration the contract refuses. So it costs a probe,
 * and the button says so.
 */
function ModelStep({
  adapters,
  models,
  recommendations,
  busy,
  onChange
}: {
  adapters: InspectedAdapter[];
  models: CatalogueModelView[];
  recommendations: RoleRecommendation[];
  busy: string | null;
  onChange: (role: string, agentId: string) => Promise<void>;
}): React.JSX.Element {
  /* Connected roles only. A role with no adapter has no provider, so the
     branch below would have told somebody their provider publishes no models
     when the truth is that the role has not been connected yet. */
  const live = REQUIRED_ROLES.map((role) => ({
    role,
    connected: adapters.find(
      (adapter) => adapter.role === role.tool && adapter.connected_at !== null
    )
  })).filter((entry) => entry.connected !== undefined);

  return (
    <div className="grid gap-2.5 border-t border-rule pt-3">
      <div className="flex items-center gap-3">
        <StepMark done={false} index={5} />
        <div className="min-w-0 flex-1">
          <strong className="block text-[13px] font-medium text-ink">
            Which model runs which role
          </strong>
          <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
            Changing one runs that agent again to check what it can do — about{" "}
            {TOKENS_PER_CONNECT.toLocaleString()} tokens. The risk limit still
            wins: nothing here sends dangerous work to a cheaper model.
          </span>
        </div>
      </div>

      {live.map(({ role, connected }) => {
        const provider = models.find((m) => m.agent_id === connected?.agent_id)?.provider_id;
        /* Only models from the provider this role is already connected to.
           Offering another provider's model here would be a silent switch of
           subscription as well as model. */
        const choosable = models.filter(
          (model) => model.provider_id === provider && model.slug !== null
        );
        const advice = recommendations.find((entry) => entry.role === role.tool);
        return (
          <div className="grid gap-1 rounded-sm border border-rule bg-canvas px-3 py-2" key={role.tool}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <code className="font-mono text-[12px] text-ink">{role.tool}</code>
              <span className="min-w-0 flex-1 text-[11px] break-words text-muted-foreground">
                {role.purpose}
              </span>
              {busy === role.tool ? (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-navy">
                  <Loader aria-hidden="true" className="size-3 animate-spin" />
                  Running the check…
                </span>
              ) : null}
            </div>

            {/* Case 3: the probe could not confirm a pin, so there is nothing to
                choose. Core's sentence, not a second version of it. */}
            {connected?.model_choice_refusal != null ? (
              <span className="block text-[11px] leading-relaxed break-words text-amber">
                {connected.model_choice_refusal}
              </span>
            ) : choosable.length === 0 ? (
              <span className="block text-[11px] leading-relaxed text-muted-foreground">
                This provider does not publish a list of models Hivemind can pin,
                so work runs on whatever it chooses.
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {choosable.map((model) => {
                  const active = model.agent_id === connected?.agent_id;
                  return (
                    <SelectionControl
                      active={active}
                      disabled={busy !== null}
                      key={model.agent_id}
                      shape="chip"
                      onClick={() => {
                        if (!active) void onChange(role.tool, model.agent_id);
                      }}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <code className="font-mono text-[11px] text-ink">{model.slug}</code>
                        {advice?.agent_id === model.agent_id ? (
                          <span className="text-[10px] font-medium tracking-label text-navy uppercase">
                            Suggested
                          </span>
                        ) : null}
                        {/* On a multiplier, whose service this slug reaches is
                            part of the choice — said before it is picked. */}
                        {model.inner_provider != null && model.inner_provider.sanction !== "blessed" ? (
                          <span
                            className={`text-[10px] font-medium tracking-label uppercase ${model.inner_provider.sanction === "prohibited" ? "text-clay" : "text-amber"}`}
                            title={model.inner_provider.why}
                          >
                            {model.inner_provider.sanction}
                          </span>
                        ) : null}
                      </span>
                    </SelectionControl>
                  );
                })}
              </div>
            )}

            {/* The price, with where it came from and when it was checked. */}
            <ModelPrice model={models.find((m) => m.agent_id === connected?.agent_id) ?? null} />
          </div>
        );
      })}
    </div>
  );
}

function ModelPrice({ model }: { model: CatalogueModelView | null }): React.JSX.Element | null {
  if (model?.price == null) return null;
  return (
    <span className="block text-[11px] leading-snug text-muted-foreground">
      ${model.price.input_per_m.toFixed(2)} in / ${model.price.output_per_m.toFixed(2)} out per
      million · <span className="text-ink">API list price — not what you pay on a subscription</span>{" "}
      · {model.price.source.split("—")[0]?.trim()}, checked {formatChecked(model.price.checked)}
      {model.price_stale === true ? (
        <span className="text-amber"> · {model.price_age_days} days old, check it before relying on it</span>
      ) : null}
    </span>
  );
}

function formatChecked(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

/**
 * A-03, the one register finding that stopped a normal user: setup read
 * complete with an empty `test_command`, Work was enabled, and integration
 * rejected the project after planning and worker calls were already paid
 * for. First hour, ordinary projects, fail-open in a fail-closed product.
 *
 * The invariant this step carries: setup cannot read complete while a value
 * integration will later require is absent. Either detection found a
 * command, or the person supplies one, or the person states explicitly that
 * this project has no tests -- the same shape as a spec's "there is nothing
 * this should leave alone", so the absence is a recorded decision rather
 * than an unnoticed default. Core enforces the same rule at the first paid
 * call; this step is where the question gets asked, because a question here
 * is cheaper than a guess that costs real tokens before it fails.
 */
/**
 * How this project gets checked — three peer answers, none of them a trap.
 *
 * The defect this replaces: one text field, and a Continue button that only
 * appeared once something was in it. So the field got filled with whatever
 * unblocked it — `npm test` typed into a project with no tests — which then
 * failed every integration after the planning and worker money was spent. Two
 * things were wrong with that, and both are fixed here rather than explained:
 *
 *  - Nothing was VALIDATED. Any string was accepted, and the first time anybody
 *    found out it did not run was the last gate. Now the command is run once,
 *    here, and Core decides from what it did whether it can be stored. A string
 *    that never runs cannot be stored at all.
 *  - The honest answer was the HARDER answer. "No tests" sat below the field as
 *    a lesser-styled escape hatch under a paragraph about consequences, so the
 *    path of least resistance was to lie to the field. The three answers are now
 *    the same size, in the same list, and picking any of them finishes the step.
 *
 * And tests are not the only legitimate check. A typecheck or a build catches
 * real breakage and is what most projects arriving here actually have, so they
 * are offered by name, with the kind attached — accepting a build believing it
 * ran tests would be the same class of mistake as accepting a command that
 * never ran.
 */
function ChecksStep({
  enabled,
  view,
  onAction,
  onReload
}: {
  enabled: boolean;
  view: ProjectConfigView | null;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onReload: () => void;
}): React.JSX.Element {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [trial, setTrial] = useState<CheckTrialView | null>(null);
  const config = view?.config ?? null;
  const commandPresent = (config?.test_command ?? "").trim() !== "";
  const declared = config?.no_tests_declared === true;
  const done = enabled && config !== null && (commandPresent || declared);
  const candidates = view?.check_candidates ?? [];

  /* The recorded trial belongs to the command it ran. A later edit through
     Settings leaves it pointing at the older string, and reporting it against
     the new one would be a claim nobody measured. */
  const recorded = config?.test_command_trial ?? null;
  const recordedIsCurrent = recorded !== null && recorded.command === config?.test_command;

  /* Running a check means running the project's own suite, which can take
     minutes. The label says which command is running so a slow one does not
     look like a hung screen. */
  const tryCommand = async (candidate: string, acceptFailing: boolean): Promise<void> => {
    setBusy(candidate);
    setError("");
    try {
      const result = await onAction<CheckTryResult>({
        type: "checks.try",
        payload: acceptFailing ? { command: candidate, accept_failing: true } : { command: candidate }
      });
      setTrial(result?.trial ?? null);
      /* Core may have stored it, so the view has to be re-read either way. */
      onReload();
    } catch (cause) {
      setError(plainActionError(cause));
    } finally {
      setBusy(null);
    }
  };

  const declareAbsence = async (): Promise<void> => {
    setBusy("none");
    setError("");
    setTrial(null);
    try {
      await onAction({ type: "config.set", payload: { no_tests_declared: true } });
      onReload();
    } catch (cause) {
      setError(plainActionError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="grid gap-3 bg-panel px-4 py-3">
      <div className="flex items-center gap-3">
        <StepMark done={done} index={3} />
        <div className="min-w-0 flex-1">
          {/* The heading changes with the state, because the two states are
              different sentences: when a command was found this step REPORTS,
              and only when nothing was found does it ASK. It used to ask in
              both, in the product's own vocabulary ("how this project is
              checked"), which put a configuration question in front of someone
              whose project already answered it. */}
          <strong className="block text-[13px] font-medium text-ink">
            {commandPresent
              ? "How your code gets checked"
              : declared
                ? "You said there is nothing to run"
                : "How do you check your code works?"}
          </strong>
          <span className="mt-0.5 block text-[12px] leading-relaxed break-words text-muted-foreground">
            {!enabled || config === null
              ? "Waiting on step 2 — the check command lives in the project's settings."
              : commandPresent
                ? `${config.test_command} — run before any change can ship.${
                    recordedIsCurrent
                      ? recorded.outcome === "passed"
                        ? ` It ran clean here in ${(recorded.duration_ms / 1000).toFixed(1)}s.`
                        : ` It was failing when you set this up (exit ${recorded.exit_code}), and every change will be held until it passes.`
                      : " Nobody has run it yet, so whether it works here is unknown."
                  } Change it in Settings whenever you like.`
                : declared
                  ? "Every ship's record says so. Picking a command in Settings replaces the declaration."
                  : "A test suite, a typecheck or a build — any of them catch real breakage. Hivemind runs whatever you pick once, right now, so a command that does not work here is caught before it can block your work."}
          </span>
        </div>
      </div>

      {enabled && config !== null && !done ? (
        <div className="grid gap-2.5 pl-8">
          {/* Suggestions first, because a one-press answer that came from the
              project itself beats anything typed. Each names its kind: a build
              passing is not tests passing. */}
          {candidates.length === 0 ? null : (
            <div className="grid gap-1.5">
              {candidates.map((candidate) => (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1" key={candidate.command}>
                  <Button
                    disabled={busy !== null}
                    size="sm"
                    type="button"
                    onClick={() => void tryCommand(candidate.command, false)}
                  >
                    {busy === candidate.command ? "Running it…" : `Use ${candidate.command}`}
                  </Button>
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {CHECK_KIND_LABELS[candidate.kind]} — {candidate.source}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Check command"
              className="h-8 min-w-[200px] flex-1 rounded-sm border border-input bg-canvas px-2 font-mono text-[12px] text-ink focus-visible:border-navy/55"
              /* Not the first suggestion, which is already a button above -- a
                 placeholder repeating it reads as pre-filled. This field is for
                 the answer the project could not offer. */
              placeholder={candidates.length === 0 ? "npm test" : "or type another command"}
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <Button
              disabled={busy !== null || command.trim() === ""}
              size="sm"
              type="button"
              variant={candidates.length === 0 ? "default" : "outline"}
              onClick={() => void tryCommand(command.trim(), false)}
            >
              {busy === command.trim() ? "Running it…" : "Run it once"}
            </Button>
          </div>

          {/* A peer, not an escape hatch: same size, same list, one press, and
              no paragraph of consequences to read past. The consequence is one
              clause, because it is real and short. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Button
              disabled={busy !== null}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void declareAbsence()}
            >
              There is nothing to run
            </Button>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              Recorded as your decision, and named in every ship&rsquo;s record.
            </span>
          </div>

          {trial === null ? null : <TrialReport trial={trial} onAccept={() => void tryCommand(trial.command, true)} busy={busy !== null} />}

          {error === "" ? null : (
            <p className="m-0 text-[12px] break-words text-clay" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** What each kind actually proves, in the words a person would use. */
const CHECK_KIND_LABELS: Record<CheckKind, string> = {
  tests: "runs your tests",
  typecheck: "checks the types",
  build: "builds the project"
};

/**
 * What the one run did, and what is still open.
 *
 * Switched on the typed outcome rather than on anything in the text, and the
 * four branches are genuinely different situations: two of them offer a next
 * press, and two of them are a refusal with nothing to accept.
 */
function TrialReport({
  trial,
  onAccept,
  busy
}: {
  trial: CheckTrialView;
  onAccept: () => void;
  busy: boolean;
}): React.JSX.Element {
  const tone =
    trial.outcome === "passed"
      ? "border-moss bg-moss-wash"
      : trial.outcome === "failed"
        ? "border-amber bg-amber-wash"
        : "border-clay bg-clay-wash";
  return (
    <div className={`grid gap-2 rounded-sm border-l-2 px-2.5 py-2 ${tone}`} role="status">
      <p className="m-0 text-[12px] leading-relaxed text-ink">
        <span className="font-mono">{trial.command}</span> — {trial.detail}
        {trial.outcome === "not_runnable"
          ? " Fix the command or pick one above; a command that does not run is not a check, so it has not been saved."
          : trial.outcome === "timed_out"
            ? " It has not been saved, because an unfinished run is not a pass."
            : trial.outcome === "failed" && !trial.stored
              ? " Saved nothing yet: a check that is red now will hold every change until it passes."
              : ""}
      </p>
      {trial.output_tail === "" ? null : (
        <pre className="m-0 max-h-32 overflow-auto rounded-xs bg-canvas px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {trial.output_tail}
        </pre>
      )}
      {trialAffordance(trial) === "accept_or_replace" ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button disabled={busy} size="sm" type="button" variant="outline" onClick={onAccept}>
            Use it anyway
          </Button>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            It runs again once, so what it does is on the record.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function StepMark({ index, done }: { index: number; done: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5 shrink-0 place-items-center rounded-xs font-mono text-[11px] ${
        done ? "bg-navy text-panel" : "bg-canvas text-muted-foreground"
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
): { title: string; detail: string; action?: "initialize" | "git" | "choose" | "restart_daemon" } | null {
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
  if (code === PROJECT_FAULT.daemonBuildMismatch) {
    /* This was two 64-character hashes, the word "daemon", and an instruction
       naming an action no control performed -- on the first screen after every
       update. The check itself is untouched and stays exactly as strict: two
       runs against a stale build cost ~38K tokens and are why it exists. What
       it lacked was an exit. */
    return {
      title: "Hivemind was updated",
      detail:
        "The background process from the previous version is still running this project. It has to be stopped and started again on the new version — nothing in your project changes, and no work is lost.",
      action: "restart_daemon"
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

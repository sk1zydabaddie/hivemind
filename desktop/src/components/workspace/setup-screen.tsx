import { ArrowRight, Check, ChevronDown, FolderGit2, Loader, Plug, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDismissed } from "@/lib/dismissible";
import { displayProjectPath, PROJECT_FAULT } from "@/lib/project-session";
import { PROVIDER_MARKS } from "@/lib/provider-marks";
import { REQUIRED_ROLES } from "@/lib/providers";
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
  live,
  view,
  onChooseProject,
  onInitializeProject,
  onInitializeGit,
  onRestartDaemon,
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
  /* Stops the previous version's background process and opens the project on
     the matching one. Refuses while anything is in flight. */
  onRestartDaemon: () => void;
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
                you already pay for. Three steps, in order — and a fourth once
                there is an agent to tune.
              </p>

              <NotAnEditor />

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

/* Two questions, asked separately.
 *
 * Step 3 is WHICH PROVIDERS DO I HAVE. It is multi-select, because somebody
 * with both a ChatGPT and a Claude subscription has both — and the previous
 * single-select made the mixed-provider arrangement Core has always supported
 * unreachable from the interface. Selecting is not spending: the checkboxes
 * choose, and Continue is the act that runs a probe per role.
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
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

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

  /* The model each role connects AS. A provider is not enough to probe with --
     a probe runs one binary with one model pinned -- so the suggestion decides
     which, and step 4 is where that gets changed afterwards. */
  const agentFor = (roleTool: string): string | null => {
    const fromChosen = models.filter((model) => chosen.has(model.provider_id));
    const advice = recommendations.find((entry) => entry.role === roleTool);
    if (advice !== undefined && fromChosen.some((m) => m.agent_id === advice.agent_id)) {
      return advice.agent_id;
    }
    return fromChosen[0]?.agent_id ?? null;
  };

  const connectAll = async (): Promise<void> => {
    setFailure("");
    /* Every role skipped for want of a model is a Continue that appears to do
       nothing at all -- the same dead end as the build mismatch, arrived at by
       pressing the button the screen told you to press. Say so instead. */
    const unaimed = remaining.filter((role) => agentFor(role.tool) === null);
    if (unaimed.length === remaining.length) {
      setFailure(
        "Nothing ticked here can run a model, so there is nothing to check. Tick a provider you actually have."
      );
      return;
    }
    for (const role of remaining) {
      const agentId = agentFor(role.tool);
      if (agentId === null) continue;
      setBusy(role.tool);
      try {
        await onAction({
          type: "adapter.connect",
          payload: { role: role.tool, agent_id: agentId }
        });
      } catch (cause) {
        setFailure(`${role.tool}: ${cause instanceof Error ? cause.message : String(cause)}`);
        break;
      } finally {
        setBusy(null);
      }
    }
    await onReload();
  };

  return (
    <li className="grid gap-3 bg-panel/85 [backdrop-filter:var(--glass-mid)] shadow-[var(--glass-edge)] px-4 py-3">
      <div className="flex items-center gap-3">
        <StepMark done={done} index={3} />
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
                <ProviderRow
                  expanded={opened === provider.id}
                  key={provider.id}
                  picked={chosen.has(provider.id)}
                  provider={provider}
                  onExpand={() => setOpened(opened === provider.id ? null : provider.id)}
                  onToggle={() => toggle(provider.id)}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Button
              disabled={busy !== null || chosen.size === 0}
              type="button"
              onClick={() => void connectAll()}
            >
              {busy === null ? (
                <Plug aria-hidden="true" />
              ) : (
                <Loader aria-hidden="true" className="animate-spin" />
              )}
              {busy === null ? "Continue" : `Checking ${busy}…`}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Runs each agent once to record what it can do — about{" "}
              {(TOKENS_PER_CONNECT * remaining.length).toLocaleString()} tokens on
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

      {/* Every role that EXISTS, rather than only once they all do. Gating this
          on `done` made it unreachable from the one real capture there is --
          which has `worker` connected and the other two not -- and there is no
          reason to hide the model a connected role runs on while its siblings
          are still being set up. */}
      {enabled && connectedRoles.size > 0 ? (
        <ModelStep
          adapters={adapters}
          busy={busy}
          models={models}
          recommendations={recommendations}
          onChange={async (role, agentId) => {
            setBusy(role);
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

/** Verified first, then probed-but-unverified, then the rest. */
function providerRank(status: CatalogueProvider["status"]): number {
  if (status === "supported") return 0;
  return status === "unverified" ? 1 : 2;
}

/* One row, scannable: tick, mark, name, subscription, status, chevron. */
function ProviderRow({
  provider,
  picked,
  expanded,
  onToggle,
  onExpand
}: {
  provider: CatalogueProvider;
  picked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}): React.JSX.Element {
  return (
    <div className="border-b border-rule last:border-b-0">
      <div
        className={`flex items-center gap-2.5 px-2.5 py-2 ${picked ? "bg-navy-wash" : "bg-panel"}`}
      >
        <input
          aria-label={`Use ${provider.label}`}
          checked={picked}
          className="size-3.5 shrink-0 accent-navy"
          type="checkbox"
          onChange={onToggle}
        />
        <ProviderMark provider={provider.id} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {provider.label}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block">
          {provider.subscription}
        </span>
        <span
          className={`shrink-0 text-[11px] font-medium ${
            provider.status === "supported" ? "text-navy" : "text-amber"
          }`}
        >
          {provider.status === "supported" ? "Verified" : "Not verified yet"}
        </span>
        {provider.caveat === null ? (
          <span aria-hidden="true" className="size-5 shrink-0" />
        ) : (
          <button
            aria-expanded={expanded}
            aria-label={`What is unverified about ${provider.label}`}
            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-canvas hover:text-ink"
            type="button"
            onClick={onExpand}
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      {/* Unchanged text, moved out of the way. It is what to read before
          trusting a provider, not what to read while picking one. */}
      {expanded && provider.caveat !== null ? (
        <p className="m-0 border-t border-rule bg-canvas px-2.5 py-2 text-[11px] leading-relaxed break-words text-muted-foreground">
          {provider.caveat}
        </p>
      ) : null}
    </div>
  );
}

/* Real marks where one exists, a monogram where none does — rather than a
   generic glyph standing in for a brand, or an invented logo. */
function ProviderMark({ provider }: { provider: string }): React.JSX.Element {
  const mark = PROVIDER_MARKS[provider];
  if (mark === undefined) {
    return (
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-xs border border-rule text-[9px] font-semibold text-muted-foreground"
      >
        {provider.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <picture className="flex size-4 shrink-0 items-center">
      {mark.dark === undefined ? null : (
        <source media="(prefers-color-scheme: dark)" srcSet={mark.dark} />
      )}
      <img alt="" className="block size-4" draggable={false} src={mark.light} />
    </picture>
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
        <StepMark done={false} index={4} />
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
                    <button
                      aria-pressed={active}
                      className={`cursor-pointer rounded-sm border px-2 py-1 text-left transition-colors ${
                        active ? "border-navy bg-navy-wash" : "border-rule bg-panel hover:border-navy/40"
                      }`}
                      disabled={busy !== null}
                      key={model.agent_id}
                      type="button"
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
                      </span>
                    </button>
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

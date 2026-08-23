import { AlertTriangle, Check, ChevronDown, FolderGit2, Loader, Minus, Plug, RefreshCw, SlidersHorizontal } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionControl } from "@/components/ui/selection-control";
import { MultiplierDisclosure, ProviderListRow, ProviderMark, providerRank } from "@/components/workspace/provider-list";
import { list } from "@/lib/durable";
import { plainActionError } from "@/lib/plain-language";
import { displayProjectPath } from "@/lib/project-session";
import { useProviderAuthentication } from "@/lib/provider-authentication";
import { adapterModelText } from "@/lib/workspace-actions";
import type {
  AdapterConnectResult,
  AutonomyLevel,
  CapabilityStatus,
  CatalogueProvider,
  InspectedAdapter,
  ModelDiscoveryView,
  ProviderModelDiscovery,
  ProbedCapability,
  ProjectConfigView,
  WorkspaceAction,
  WorkspaceInspection
} from "@/lib/workspace-actions";

/* Everything that used to need a text editor.
 *
 * Hivemind is an agent development environment: a coding agent is a harness
 * that runs inside it, paid for by a subscription the person already has. So
 * the question this surface asks is "which coding agent do you have", never
 * "what is your API key" -- Hivemind holds no provider credential of its own.
 *
 * The honesty the old screen had is kept and made specific. It used to say
 * "Hivemind cannot read these from here yet" beside three file paths; it now
 * reads them, and where something is still unproven it says which capability
 * and why rather than hiding the gap.
 */

const LEVELS: Array<{ value: AutonomyLevel; label: string; detail: string }> = [
  {
    value: "auto",
    label: "Only what needs me",
    detail: "Work runs start to finish. You are asked when something is stuck, rejected, or out of budget."
  },
  {
    value: "review_plan",
    label: "The plan, then what needs me",
    detail: "You approve the plan before anything starts, then it runs as above."
  },
  {
    value: "review_everything",
    label: "Every step",
    detail: "Nothing advances without you. Slowest, and the most control."
  }
];

const ROLE_PURPOSE: Record<string, string> = {
  planner: "Turns what you type into a plan",
  manager: "Decides the next step when something is unexpected",
  worker: "Writes the code for each task"
};

/* Plain language for the four scopes. The words "tier" and "glob" appear
   nowhere a person reads. */
const SCOPES: Array<{ key: "low_globs" | "medium_globs" | "high_globs" | "critical_globs"; label: string; detail: string }> = [
  { key: "low_globs", label: "Simple", detail: "Docs and text. The cheapest agent you connected can take these." },
  { key: "medium_globs", label: "Ordinary", detail: "Source and tests. Your standard agent." },
  { key: "high_globs", label: "Risky", detail: "Build and dependency files. Only a strong agent." },
  { key: "critical_globs", label: "Dangerous", detail: "Auth, secrets, migrations, Hivemind's own files. Strongest only." }
];

export function SettingsDialog({
  open,
  inspection,
  projectPath,
  busy,
  onOpenChange,
  onChooseProject,
  onAction
}: {
  open: boolean;
  inspection: WorkspaceInspection | null;
  projectPath: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseProject: () => void;
  onConnectAgent?: () => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  /* Everything on this screen belongs to exactly one project (A-08: switching
     visibly offered the previous project's workers with the controls live).
     Every stored answer NAMES the project it belongs to, and the values the
     dialog renders are DERIVED: an answer for any other project is invisible.
     A read-time guard instead of a clear, so there is no clearing to forget,
     no render-time state write, and a late answer from the previous project
     lands carrying the previous project's name and is never shown. */
  const [loadedView, setLoadedView] = useState<{
    forProject: string;
    value: ProjectConfigView;
  } | null>(null);
  const [loadedModels, setLoadedModels] = useState<{
    forProject: string;
    value: ModelDiscoveryView;
  } | null>(null);
  const [problem, setProblem] = useState<{ forProject: string; message: string } | null>(null);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [working, setWorking] = useState(false);
  const level = inspection?.autonomy.configured_level ?? "auto";
  const view = loadedView !== null && loadedView.forProject === projectPath ? loadedView.value : null;
  const modelDiscovery =
    loadedModels !== null && loadedModels.forProject === projectPath ? loadedModels.value : null;
  const error = problem !== null && problem.forProject === projectPath ? problem.message : "";
  const setError = (message: string): void => {
    setProblem(message === "" ? null : { forProject: projectPath, message });
  };
  const setView = (value: ProjectConfigView): void => {
    setLoadedView({ forProject: projectPath, value });
  };

  /* Core owns every value on this screen. The client reads it, shows it, and
     sends changes back through the audited dispatcher; it decides nothing. */
  const refresh = async (): Promise<void> => {
    const requested = projectPath;
    try {
      const value = await onAction<ProjectConfigView>({ type: "config.inspect", payload: {} });
      setLoadedView({ forProject: requested, value });
      setProblem(null);
    } catch (cause) {
      setProblem({ forProject: requested, message: plainActionError(cause) });
    }
  };

  const refreshModels = async (): Promise<void> => {
    const requested = projectPath;
    setDiscoveringModels(true);
    setProblem(null);
    try {
      const value = await onAction<ModelDiscoveryView>({ type: "models.discover", payload: {} });
      setLoadedModels({ forProject: requested, value });
    } catch (cause) {
      setProblem({ forProject: requested, message: plainActionError(cause) });
    } finally {
      setDiscoveringModels(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    /* Keep the two reports ordered so a successful config read cannot erase a
       model-discovery error that completed a moment earlier. */
    void refresh().then(refreshModels);
  }, [open, projectPath]);

  const change = async (payload: Record<string, unknown>): Promise<void> => {
    const requested = projectPath;
    setWorking(true);
    setProblem(null);
    try {
      const value = await onAction<ProjectConfigView>({ type: "config.set", payload });
      setLoadedView({ forProject: requested, value });
    } catch (cause) {
      setProblem({ forProject: requested, message: plainActionError(cause) });
    } finally {
      setWorking(false);
    }
  };

  const config = view?.config ?? null;
  /* `view === null` is the project-identity half of the gate: after a switch,
     the previous project's controls must not accept a change against the new
     project before the new project's own `config.inspect` has landed. */
  const disabled = busy || working || inspection === null || view === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame className="grid h-[min(820px,calc(100vh-32px))] w-[min(940px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] sm:max-w-none">
        <DialogHeader frame>
          <DialogTitle className="text-[20px] leading-tight font-semibold tracking-tighter">
            Settings
          </DialogTitle>
          <DialogDescription>
            Simple choices first. Project rules and technical details stay under Advanced.
          </DialogDescription>
          <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-rule pt-2">
            <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {displayProjectPath(projectPath)}
            </span>
            <Button size="xs" type="button" variant="outline" onClick={onChooseProject}>
              Change folder
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="grid gap-3 px-5 py-4">
            {error === "" ? null : (
              <p
                className="m-0 rounded-md border border-clay/25 border-l-2 border-l-clay bg-clay-wash px-3 py-2 text-[12px] break-words text-clay"
                role="status"
              >
                {error}
              </p>
            )}

            {view !== null && !view.initialized ? (
              <div className="rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-3 py-2.5">
                <strong className="block text-[13px] font-semibold text-ink">
                  This folder is not set up yet
                </strong>
                <p className="mt-1 mb-2 text-[12px] leading-relaxed text-muted-foreground">
                  {view.config_problem ??
                    "Hivemind keeps its record inside the project. Setting it up writes that folder and nothing else."}
                </p>
                <Button
                  disabled={disabled}
                  size="sm"
                  type="button"
                  onClick={() => {
                    setWorking(true);
                    void onAction<ProjectConfigView>({ type: "project.init", payload: {} })
                      .then(setView)
                      .catch((cause: unknown) => setError(plainActionError(cause)))
                      .finally(() => setWorking(false));
                  }}
                >
                  Set this folder up
                </Button>
              </div>
            ) : null}

            <AgentSection
              disabled={disabled}
              discoveringModels={discoveringModels}
              modelDiscovery={modelDiscovery}
              view={view}
              onAction={onAction}
              onConnected={setView}
              onError={setError}
              onRefreshModels={() => void refreshModels()}
            />

            <Section title="Run limits" description="Guardrails for one run. The defaults are safe for most projects.">
              {config === null ? (
                <Waiting />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <NumberField
                      detail={`One agent call really costs ${view!.limits.observed_worker_call_tokens.low.toLocaleString()}Ã¢â‚¬â€œ${view!.limits.observed_worker_call_tokens.high.toLocaleString()} tokens on this project's own runs. A limit below that stops the run after you have paid for the call.`}
                      disabled={disabled}
                      label="Most one call may use"
                      value={config.run_ceiling_tokens}
                      warn={
                        config.run_ceiling_tokens !== null &&
                        config.run_ceiling_tokens < view!.limits.observed_worker_call_tokens.high
                      }
                      onCommit={(value) => void change({ run_ceiling_tokens: value })}
                    />
                    <NumberField
                      detail="Everything one run may spend before it stops and asks you."
                      disabled={disabled}
                      label="Most a run may use"
                      value={config.session_ceiling_tokens}
                      onCommit={(value) => void change({ session_ceiling_tokens: value })}
                    />
                    <NumberField
                      detail={`How many agents work at once. Between 1 and ${view!.limits.max_concurrent_workers_hard_max}.`}
                      disabled={disabled}
                      label="Agents at once"
                      value={config.max_concurrent_workers}
                      onCommit={(value) => void change({ max_concurrent_workers: value })}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section title="When Hivemind asks you" description="Choose how often work pauses for your approval.">
              <div className="grid gap-2">
                {LEVELS.map((entry) => (
                  <SelectionControl
                    active={entry.value === level}
                    disabled={disabled}
                    key={entry.value}
                    shape="card"
                    onClick={() => {
                      void onAction({ type: "autonomy.set", payload: { level: entry.value } });
                    }}
                  >
                    <strong className="block text-[13px] font-medium text-ink">{entry.label}</strong>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                      {entry.detail}
                    </span>
                  </SelectionControl>
                ))}
              </div>
            </Section>

            <AdvancedSettings
              adapters={view?.adapters ?? []}
              config={config}
              disabled={disabled}
              onChange={change}
            />

            <BuildLine />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/* Ã¢â€â‚¬Ã¢â€â‚¬ Bring your own agent Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

function AgentSection({
  view,
  disabled,
  modelDiscovery,
  discoveringModels,
  onAction,
  onConnected,
  onError,
  onRefreshModels
}: {
  view: ProjectConfigView | null;
  disabled: boolean;
  modelDiscovery: ModelDiscoveryView | null;
  discoveringModels: boolean;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onConnected: (view: ProjectConfigView) => void;
  onError: (message: string) => void;
  onRefreshModels: () => void;
}): React.JSX.Element {
  const [connecting, setConnecting] = useState<{ role: string; label: string; startedAt: number } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [probe, setProbe] = useState<{ role: string; result: ProbedCapability[]; ok: boolean } | null>(null);
  const { standings: authenticationStandings, watchForCompletion } =
    useProviderAuthentication({ active: view !== null, onAction });

  useEffect(() => {
    if (connecting === null) return undefined;
    const tick = (): void => setElapsedSeconds(
      Math.floor((Date.now() - connecting.startedAt) / 1_000)
    );
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [connecting]);

  const connect = async (role: string, providerId: string, modelSlug: string): Promise<void> => {
    const provider = view?.providers?.find((entry) => entry.id === providerId);
    setConnecting({
      role,
      label: `${provider?.label ?? providerId} · ${modelSlug}`,
      startedAt: Date.now()
    });
    setProbe(null);
    setNotice("");
    onError("");
    try {
      const result = await onAction<AdapterConnectResult>({
        type: "adapter.connect_model",
        payload: { role, provider_id: providerId, model_slug: modelSlug }
      });
      /* `result.probe.capabilities` was two unguarded levels, and the inline
         type that made it compile was invisible to the first version of the
         call-site check: its pattern stopped at the first `}`, so it never saw
         past `probe: {`. A rule that matches a spelling misses the spellings
         it did not think of. */
      setProbe({ role, result: [...list(result.probe?.capabilities)], ok: result.probe?.ok === true });
      if (result.config !== undefined) onConnected(result.config);
    } catch (cause) {
      onError(plainActionError(cause));
    } finally {
      setConnecting(null);
    }
  };

  const startAuthentication = async (provider: CatalogueProvider): Promise<void> => {
    setAuthBusy(provider.id);
    watchForCompletion(provider.id);
    setNotice("");
    onError("");
    try {
      await onAction({
        type: "provider.auth.start",
        payload: { provider_id: provider.id }
      });
      setNotice(
        `${provider.label} opened its own sign-in flow. Finish there, then refresh models or run a check here.`
      );
    } catch (cause) {
      watchForCompletion(null);
      onError(`${provider.label}: ${plainActionError(cause)}`);
    } finally {
      setAuthBusy(null);
    }
  };

  const providers = [...(view?.providers ?? [])].sort(
    (left, right) => providerRank(left.status) - providerRank(right.status)
  );

  return (
    <Section
      title="Your coding agents"
      description="Sign in to the provider subscriptions you already use, then choose a detected model for each job."
    >
      <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
        Hivemind runs the coding agent you already pay for. It never asks for a
        key of its own. Sign-in stays with the provider, and an Unverified agent
        is never presented as proven.
      </p>

      {view === null ? (
        <div className="mt-3">
          <Waiting />
        </div>
      ) : (
        <>
          <div className="mt-3 overflow-hidden rounded-sm border border-rule">
            {providers.map((provider) => (
              <ProviderListRow
                authenticationBusy={authBusy === provider.id}
                authenticationStatus={authenticationStandings.get(provider.id)?.status ?? "unknown"}
                checksBusy={connecting !== null}
                expanded={opened === provider.id}
                key={provider.id}
                reaches={authenticationStandings.get(provider.id)?.reaches ?? null}
                leading={
                  <span className="grid size-5 shrink-0 place-items-center" title={provider.checked_here ? "Checked in this project" : "Not checked in this project"}>
                    <StatusMark state={provider.checked_here ? "ok" : provider.connectable ? "unverified" : "none"} />
                  </span>
                }
                provider={provider}
                onAuthenticate={() => void startAuthentication(provider)}
                onExpand={() => setOpened(opened === provider.id ? null : provider.id)}
              />
            ))}
          </div>

          <div className="mt-2">
            {(() => {
              /* The multiplier row is found by its TIER, never by name — the
                 client does not know providers; Core's catalogue does. */
              const multiplier = providers.find((entry) => entry.support_tier === "multiplier") ?? null;
              return (
                <MultiplierDisclosure
                  busy={connecting !== null || authBusy !== null}
                  provider={multiplier}
                  standing={multiplier === null ? null : authenticationStandings.get(multiplier.id) ?? null}
                  onAction={onAction}
                  onReload={async () => onRefreshModels()}
                />
              );
            })()}
          </div>

          {notice === "" ? null : (
            <p className="mt-2 mb-0 rounded-sm border-l-2 border-navy bg-navy-wash px-2.5 py-1.5 text-[12px] text-ink" role="status">
              {notice}
            </p>
          )}

          <ModelDiscoverySummary
            discovering={discoveringModels}
            discoveries={modelDiscovery?.providers ?? []}
            providers={providers}
            onRefresh={onRefreshModels}
          />

          <div className="mt-4 border-t border-rule pt-3">
            <h4 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Models by job
            </h4>
            <p className="mt-1 mb-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Planner and manager each use one model. Workers may use a small pool so Hivemind can keep routine work away from an expensive model.
            </p>
            {connecting === null ? null : (
              <p className="mb-2.5 flex items-center gap-1.5 rounded-sm border-l-2 border-navy bg-navy-wash px-2.5 py-1.5 text-[11px] text-ink" role="status">
                <Loader aria-hidden="true" className="size-3 animate-spin" />
                Checking {connecting.label} for {connecting.role} · {elapsedSeconds}s
              </p>
            )}
            <div className="grid gap-px overflow-hidden rounded-sm border border-rule bg-rule">
              {list(view.roles).map((role) => (
                <RoleModelRow
                  adapters={list(view.adapters).filter((adapter) => adapter.role === role)}
                  connecting={connecting}
                  discoveries={modelDiscovery?.providers ?? []}
                  disabled={disabled}
                  elapsedSeconds={elapsedSeconds}
                  key={role}
                  providers={providers}
                  role={role}
                  onConnect={(providerId, modelSlug) => void connect(role, providerId, modelSlug)}
                />
              ))}
            </div>
          </div>

          {probe === null ? null : <ProbeReport ok={probe.ok} capabilities={probe.result} role={probe.role} />}
        </>
      )}
    </Section>
  );
}

function ModelDiscoverySummary({
  discoveries,
  providers,
  discovering,
  onRefresh
}: {
  discoveries: ProviderModelDiscovery[];
  providers: CatalogueProvider[];
  discovering: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const detected = discoveries.reduce((total, entry) => total + entry.models.length, 0);
  const needsAttention = discoveries.filter((entry) => entry.status !== "detected");
  return (
    <div className="mt-2.5 rounded-sm border border-rule bg-canvas px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {discovering
            ? "Asking the installed CLIs for modelsÃ¢â‚¬Â¦"
            : detected === 0
              ? "No model list is available yet. Sign in or configure a provider, then refresh."
              : `${detected} model slug${detected === 1 ? "" : "s"} detected from the installed CLIs without running a model.`}
        </span>
        <Button disabled={discovering} size="xs" type="button" variant="outline" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className={discovering ? "animate-spin" : ""} />
          Refresh models
        </Button>
      </div>
      {!discovering && needsAttention.length > 0 ? (
        <details className="mt-1.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none focus-visible:text-ink">
            {needsAttention.length} provider{needsAttention.length === 1 ? "" : "s"} returned no models
          </summary>
          <ul className="mt-1.5 mb-0 grid list-none gap-1 border-t border-rule pt-1.5 pl-0">
            {needsAttention.map((entry) => (
              <li className="flex gap-2" key={entry.provider_id}>
                <strong className="shrink-0 font-medium text-ink">
                  {providers.find((provider) => provider.id === entry.provider_id)?.label ?? entry.provider_id}
                </strong>
                <span>{entry.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function RoleModelRow({
  role,
  adapters,
  discoveries,
  providers,
  connecting,
  disabled,
  elapsedSeconds,
  onConnect
}: {
  role: string;
  adapters: InspectedAdapter[];
  discoveries: ProviderModelDiscovery[];
  providers: CatalogueProvider[];
  connecting: { role: string; label: string; startedAt: number } | null;
  disabled: boolean;
  elapsedSeconds: number;
  onConnect: (providerId: string, modelSlug: string) => void;
}): React.JSX.Element {
  const current = adapters.filter(
    (adapter) =>
      adapter.installed &&
      adapter.connected_at !== null &&
      adapter.problems.length === 0 &&
      adapter.model !== null
  );
  const primary = current[0];
  const options = discoveries.flatMap((discovery) =>
    discovery.status !== "detected"
      ? []
      : discovery.models.map((model) => ({
          providerId: discovery.provider_id,
          slug: model.slug,
          /* Carried so the choice can say, BEFORE it is picked, whose service
             a multiplier slug reaches and whether that vendor sanctions it. */
          inner: model.inner_provider ?? null,
          selectable: model.selectable !== false
        }))
  );
  const candidateCurrentKey =
    role === "worker" || primary?.provider_id == null || primary.model === null
      ? ""
      : choiceKey(primary.provider_id, primary.model);
  /* A previously connected model can disappear from a provider's live list.
     Keep showing it in the checked chip, but never give a select a value for
     an option the provider no longer publishes. */
  const currentKey = options.some(
    (option) => choiceKey(option.providerId, option.slug) === candidateCurrentKey
  )
    ? candidateCurrentKey
    : "";
  const [choice, setChoice] = useState(currentKey);
  useEffect(() => setChoice(currentKey), [currentKey]);
  const parsed = parseChoiceKey(choice);
  const alreadyConnected =
    parsed !== null &&
    current.some(
      (adapter) => adapter.provider_id === parsed.providerId && adapter.model === parsed.modelSlug
    );
  const working = connecting?.role === role;

  return (
    <div className="grid gap-2 bg-panel px-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:items-center">
      <div>
        <strong className="block text-[13px] font-medium text-ink capitalize">
          {role === "worker" ? "Workers" : role}
        </strong>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {ROLE_PURPOSE[role] ?? "Used by Hivemind by name"}
        </span>
      </div>
      <div className="min-w-0">
        {current.length === 0 ? (
          <span className="mb-1.5 block text-[11px] text-muted-foreground">Nothing checked yet</span>
        ) : (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {current.map((adapter) => (
              <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-rule bg-canvas px-1.5 py-0.5" key={adapter.tool ?? `${adapter.role}:${adapter.model}`}>
                {adapter.provider_id == null ? null : <ProviderMark provider={adapter.provider_id} />}
                {/* Requested vs confirmed: an unverified pin renders as what
                    was ASKED FOR, never as a fact the probe declined to state. */}
                <code
                  className={`truncate font-mono text-[10px] ${adapter.model_standing === "requested" ? "text-amber" : "text-ink"}`}
                  title={
                    adapter.model_standing === "requested"
                      ? "Requested, not confirmed: this agent does not report which model it loaded."
                      : undefined
                  }
                >
                  {adapterModelText(adapter)}
                </code>
              </span>
            ))}
          </div>
        )}
        <select
          aria-label={`Model for ${role}`}
          className="h-8 w-full rounded-sm border border-input bg-canvas px-2 font-mono text-[11px] text-ink focus-visible:border-navy/55 disabled:opacity-45"
          disabled={disabled || connecting !== null || options.length === 0}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="">Choose a detected model</option>
          {providers.map((provider) => {
            const providerOptions = options.filter((option) => option.providerId === provider.id);
            return providerOptions.length === 0 ? null : (
              <optgroup key={provider.id} label={provider.label}>
                {providerOptions.map((option) => (
                  <option
                    disabled={!option.selectable}
                    key={choiceKey(option.providerId, option.slug)}
                    value={choiceKey(option.providerId, option.slug)}
                  >
                    {option.slug}
                    {option.inner?.sanction === "prohibited"
                      ? " — not allowed here"
                      : option.inner?.sanction === "unchecked"
                        ? " — unchecked"
                        : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        {primary?.model_choice_refusal == null ? null : (
          <span className="mt-1 block text-[10px] leading-relaxed text-amber">
            {primary.model_choice_refusal}
          </span>
        )}
        {(() => {
          /* Said before the connect button is pressed, not after: an unchecked
             inner provider is a decision the person is making, and the reason
             it is unchecked belongs on screen while they can still not pick it. */
          const chosen = parsed === null
            ? null
            : options.find(
                (option) => option.providerId === parsed.providerId && option.slug === parsed.modelSlug
              );
          return chosen?.inner == null || chosen.inner.sanction === "blessed" ? null : (
            <span className="mt-1 block text-[10px] leading-relaxed text-amber">
              {chosen.inner.label} is {chosen.inner.sanction}: {chosen.inner.why}
            </span>
          );
        })()}
      </div>
      <div className="flex items-center gap-2 sm:flex-col sm:items-end">
        <Button
          disabled={disabled || connecting !== null || parsed === null || alreadyConnected}
          size="sm"
          type="button"
          onClick={() => {
            if (parsed !== null) onConnect(parsed.providerId, parsed.modelSlug);
          }}
        >
          {working ? <Loader aria-hidden="true" className="animate-spin" /> : <Plug aria-hidden="true" />}
          {working ? `Checking · ${elapsedSeconds}s` : role === "worker" ? "Add and check" : "Check and use"}
        </Button>
        <span className="text-right text-[10px] leading-snug text-muted-foreground">
          One real check · about 40K tokens
        </span>
      </div>
    </div>
  );
}

function choiceKey(providerId: string, modelSlug: string): string {
  return JSON.stringify([providerId, modelSlug]);
}

function parseChoiceKey(value: string): { providerId: string; modelSlug: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? { providerId: parsed[0], modelSlug: parsed[1] }
      : null;
  } catch {
    return null;
  }
}

/* The probe's answer, reported as a delta rather than as a claim. */
function ProbeReport({
  role,
  ok,
  capabilities
}: {
  role: string;
  ok: boolean;
  capabilities: ProbedCapability[];
}): React.JSX.Element {
  return (
    <section
      className={`mt-3 rounded-md border px-3 py-2.5 ${
        ok ? "border-navy/25 border-l-2 border-l-navy bg-navy-wash" : "border-clay/25 border-l-2 border-l-clay bg-clay-wash"
      }`}
    >
      <strong className="block text-[13px] font-semibold text-ink">
        {ok ? `Connected as your ${role}` : `Not connected as your ${role}`}
      </strong>
      <p className="mt-0.5 mb-2 text-[11px] leading-relaxed text-muted-foreground">
        Hivemind ran it once and compared what it reported against what was
        asked for. This is what it reported back.
      </p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {capabilities.map((entry) => (
          <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-2" key={entry.id}>
            <StatusMark state={capabilityMark(entry.status)} />
            <div className="min-w-0">
              <span className="text-[12px] font-medium text-ink">{entry.label}</span>
              {entry.requested === null && entry.reported === null ? null : (
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                  asked {entry.requested ?? "Ã¢â‚¬â€"} · got {entry.reported ?? "no answer"}
                </span>
              )}
              <span className="mt-0.5 block text-[11px] leading-relaxed break-words text-muted-foreground">
                {entry.detail}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusMark({ state }: { state: "ok" | "bad" | "unverified" | "none" }): React.JSX.Element {
  if (state === "ok") return <Check aria-hidden="true" className="mt-0.5 size-3.5 text-navy" />;
  if (state === "bad") return <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 text-clay" />;
  if (state === "unverified") return <Minus aria-hidden="true" className="mt-0.5 size-3.5 text-amber" />;
  return <Minus aria-hidden="true" className="mt-0.5 size-3.5 text-muted-foreground" />;
}

function AdvancedSettings({
  config,
  adapters,
  disabled,
  onChange
}: {
  config: ProjectConfigView["config"];
  adapters: InspectedAdapter[];
  disabled: boolean;
  onChange: (payload: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-md border border-rule bg-panel">
      <div className="px-2 py-2">
        <Button
          aria-expanded={open}
          className="w-full justify-start"
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => setOpen((current) => !current)}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span className="flex-1 text-left">Advanced project rules</span>
          <ChevronDown aria-hidden="true" className={open ? "rotate-180" : ""} />
        </Button>
        <p className="mt-1 mb-0 px-2 text-[11px] text-muted-foreground">
          File risk, project checks, and optional routing by kind of work.
        </p>
      </div>
      {open ? <div className="grid gap-5 border-t border-rule bg-canvas/55 px-4 py-4">
        {config === null ? (
          <Waiting />
        ) : (
          <>
            <div>
              <h4 className="m-0 mb-2 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
                Project checks
              </h4>
              <TextField
                detail="Runs after every change. If it fails, Hivemind cannot ship the work."
                disabled={disabled}
                label="Command"
                value={config.test_command}
                onCommit={(value) => void onChange({ test_command: value })}
              />
            </div>

            <div className="border-t border-rule pt-4">
              <h4 className="m-0 mb-1 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
                File risk
              </h4>
              <p className="mt-0 mb-2.5 text-[11px] leading-relaxed text-muted-foreground">
                These patterns keep sensitive files away from lower-cost models. Files matching nothing are treated as risky.
              </p>
              <div className="grid gap-px overflow-hidden rounded-sm border border-rule bg-rule">
                {SCOPES.map((scope) => (
                  <div className="grid gap-2 bg-panel px-3 py-2.5 sm:grid-cols-[132px_minmax(0,1fr)]" key={scope.key}>
                    <div>
                      <strong className="block text-[12px] font-medium text-ink">{scope.label}</strong>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                        {scope.detail}
                      </span>
                    </div>
                    <GlobList
                      disabled={disabled}
                      globs={config[scope.key]}
                      onChange={(next) => void onChange({ [scope.key]: next })}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <TaskTypeRouting
          adapters={adapters}
          config={config}
          disabled={disabled}
          onChange={onChange}
        />
      </div> : null}
    </section>
  );
}

/* Ã¢â€â‚¬Ã¢â€â‚¬ Fields Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

function GlobList({
  globs,
  disabled,
  onChange
}: {
  globs: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [text, setText] = useState(globs.join(", "));
  useEffect(() => setText(globs.join(", ")), [globs.join(", ")]);
  const commit = (): void => {
    const next = text.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (next.join(",") !== globs.join(",")) onChange(next);
  };
  return (
    <input
      aria-label="File patterns"
      className="h-8 w-full rounded-md border border-rule bg-canvas px-2.5 font-mono text-[12px] text-ink transition-colors focus-visible:border-navy/45 focus-visible:bg-panel"
      disabled={disabled}
      spellCheck={false}
      value={text}
      onBlur={commit}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function NumberField({
  label,
  detail,
  value,
  disabled,
  warn = false,
  onCommit
}: {
  label: string;
  detail: string;
  value: number | null;
  disabled: boolean;
  warn?: boolean;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  return (
    <label className="grid gap-1.5">
      <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">{label}</span>
      <input
        className={`h-8 rounded-md border bg-canvas px-2.5 font-mono text-[13px] text-ink transition-colors focus-visible:bg-panel ${
          warn ? "border-amber/50" : "border-rule focus-visible:border-navy/45"
        }`}
        disabled={disabled}
        inputMode="numeric"
        value={text}
        onBlur={() => {
          const parsed = Number(text.replace(/[^\d]/gu, ""));
          if (Number.isSafeInteger(parsed) && parsed > 0 && parsed !== value) onCommit(parsed);
        }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className={`text-[11px] leading-relaxed ${warn ? "text-amber" : "text-muted-foreground"}`}>
        {detail}
      </span>
    </label>
  );
}

function TextField({
  label,
  detail,
  value,
  disabled,
  onCommit
}: {
  label: string;
  detail: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="grid gap-1.5">
      <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">{label}</span>
      <input
        className="h-8 rounded-md border border-rule bg-canvas px-2.5 font-mono text-[13px] text-ink transition-colors focus-visible:border-navy/45 focus-visible:bg-panel"
        disabled={disabled}
        spellCheck={false}
        value={text}
        onBlur={() => {
          if (text.trim() !== "" && text !== value) onCommit(text.trim());
        }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="text-[11px] leading-relaxed text-muted-foreground">{detail}</span>
    </label>
  );
}

function Waiting(): React.JSX.Element {
  return (
    <p className="m-0 flex items-center gap-2 text-[12px] text-muted-foreground">
      <Loader aria-hidden="true" className="size-3.5 animate-spin text-navy" />
      Reading this project's settingsÃ¢â‚¬Â¦
    </p>
  );
}

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-rule bg-panel p-4">
      <div className="mb-2.5">
        <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          {title}
        </h3>
        {description === undefined ? null : (
          <p className="mt-1 mb-0 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/* `mismatched` and `unsupported` are not the same thing and must not share a
   mark. One means the agent reported doing something other than what it was
   told -- the state the whole probe exists to catch. The other means it has no
   such feature, which is a fact about the tool rather than a betrayal by it.

   Exhaustive on purpose, rather than an if-chain ending in a default. This
   file already shipped a bug of exactly that shape: the local `CapabilityStatus`
   still had three members after Core moved to four, so `mismatched` fell
   through to the neutral branch and the most dangerous state a probe can find
   drew as "not checked". A trailing `default` cannot fail. The `never`
   assignment below turns the next added member into a compile error here. */
function capabilityMark(status: CapabilityStatus): "ok" | "bad" | "unverified" {
  switch (status) {
    case "verified":
      return "ok";
    case "mismatched":
      return "bad";
    case "unverified":
    case "unsupported":
      return "unverified";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/* Which build is running, where a person can find it.
 *
 * The Start menu opened an eleven-day-old install and nothing anywhere said so
 * -- because the version was hardcoded `0.0.0`, so every build looked identical
 * to Windows, to the uninstall entry, and to the app. The version is a calendar
 * stamp now (`YY.MMDD.HHmm`), which makes "am I running what I just built" a
 * question with an answer.
 */
function BuildLine(): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        /* Running outside the shell, e.g. the replay harness. Nothing to say. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (version === null) return <span />;
  return (
    <p className="m-0 border-t border-rule pt-3 text-[11px] text-muted-foreground">
      This build is <span className="font-mono text-ink">{version}</span>. Installing a
      newer one replaces it; you should never have two.
    </p>
  );
}

/* Which agent handles which KIND of work.
 *
 * Routing already knew the task's TIER -- how dangerous the files are -- and a
 * promoted policy learned from outcomes. It did not know that a screen and a
 * data model are different work at the same tier, and none of it was reachable
 * from here.
 *
 * Three things this surface does NOT do, each enforced in Core rather than
 * here: it cannot lift the tier floor, it cannot stand in for a promoted
 * policy, and it cannot aim work at an agent that does not report which model
 * it loaded. The last one is why some agents appear greyed with a reason.
 */
const WORK_KINDS: Array<{ id: string; label: string; detail: string }> = [
  { id: "ui", label: "Screens and interfaces", detail: "Layout, components, anything judged by eye" },
  { id: "architecture", label: "Shape of the system", detail: "How the pieces fit together" },
  { id: "data_model", label: "Data and schemas", detail: "Records, migrations, storage shapes" },
  { id: "api", label: "Interfaces between things", detail: "Endpoints and contracts" },
  { id: "testing", label: "Tests", detail: "Checks over existing behaviour" },
  { id: "documentation", label: "Documentation", detail: "Prose, not code" },
  { id: "refactor", label: "Reshaping existing code", detail: "No behaviour change intended" },
  { id: "security", label: "Security-sensitive work", detail: "Auth, secrets, permissions" }
];

/* The visual-work suggestion. OFFERED, never applied: a default would spend
   money nobody asked to spend, and the belief that visual work benefits most
   from a stronger model is not something this project has measured on your
   work. Said plainly, so declining it is an informed choice. */
const VISUAL_SUGGESTION =
  "Screens are where a stronger model most often pays for itself Ã¢â‚¬â€ layout and spacing are judged by eye, and cheaper models tend to need more revisions. Hivemind will not do this on its own: it costs more per task, and this has not been measured on your project.";

function TaskTypeRouting({
  config,
  adapters,
  disabled,
  onChange
}: {
  config: ProjectConfigView["config"];
  adapters: InspectedAdapter[];
  disabled: boolean;
  onChange: (payload: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  if (config === null) return <span />;
  /* Absent, not empty. Core always sends this now, but a daemon older than the
     field does not -- and the shell and Core ship as separate binaries that are
     routinely at different versions on the same machine, which is the reason
     `daemon.json` already tolerates unknown fields. Indexing it directly threw
     on the first row and took the whole settings dialog down with it: the third
     time this session that `undefined` reached code written for `{}`. */
  const current = config.task_type_routing ?? {};

  /* An agent may only be AIMED at work if it reports which model it loaded.
     Anything else makes the choice unconfirmable, which is the same standard
     the rest of the capability contract uses. */
  const choosable = adapters.filter((adapter) => {
    if (!adapter.installed || adapter.tool === null) return false;
    if (adapter.capabilities_stale !== null) return false;
    return adapter.capabilities.some(
      (capability) => capability.id === "pins_one_model" && capability.status === "verified"
    );
  });

  const set = (kind: string, preference: string): void => {
    const next = { ...current };
    if (preference === "") delete next[kind];
    else if (preference === "strongest" || preference === "cheapest") {
      next[kind] = { tool: null, preference };
    } else {
      next[kind] = { tool: preference, preference: null };
    }
    void onChange({ task_type_routing: next });
  };

  return (
    <div className="border-t border-rule pt-4">
      <h4 className="m-0 mb-1 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        Routing by kind of work
      </h4>
      <p className="m-0 mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Optional. File risk still wins, so this can never weaken a safety limit.
      </p>

      {choosable.length === 0 ? (
        <p className="m-0 mb-3 rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-3 py-2 text-[12px] leading-relaxed text-amber">
          None of your connected agents reports which model it actually loaded, so
          choosing one for a kind of work would not be something Hivemind could
          confirm. Connect an agent that does, and these become available.
        </p>
      ) : null}

      <div className="grid gap-2">
        {WORK_KINDS.map((kind) => (
          <div className="flex items-baseline gap-3" key={kind.id}>
            <span className="min-w-0 flex-1">
              <strong className="block text-[13px] font-medium text-ink">{kind.label}</strong>
              <span className="block text-[11px] text-muted-foreground">{kind.detail}</span>
              {kind.id === "ui" ? (
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                  {VISUAL_SUGGESTION}
                </span>
              ) : null}
            </span>
            <select
              className="h-7 shrink-0 rounded-sm border border-rule bg-panel px-2 text-[12px] text-ink disabled:opacity-45"
              disabled={disabled || choosable.length === 0}
              value={
                current[kind.id]?.tool ?? current[kind.id]?.preference ?? ""
              }
              onChange={(event) => set(kind.id, event.target.value)}
            >
              <option value="">However it is routed today</option>
              <option value="strongest">Best available model</option>
              <option value="cheapest">Lowest-cost available model</option>
              {choosable.map((adapter) => (
                <option key={adapter.tool ?? adapter.role} value={adapter.tool ?? ""}>
                  {adapter.role}
                  {adapter.model === null ? "" : ` · ${adapterModelText(adapter)}`}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

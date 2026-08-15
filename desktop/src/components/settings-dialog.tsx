import { AlertTriangle, Check, FolderGit2, Loader, Minus, Plug } from "lucide-react";
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
import { plainActionError } from "@/lib/plain-language";
import { displayProjectPath } from "@/lib/project-session";
import type {
  CapabilityStatus,
  AutonomyLevel,
  CatalogueAgent,
  InspectedAdapter,
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
  const [view, setView] = useState<ProjectConfigView | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const level = inspection?.autonomy.configured_level ?? "auto";

  /* Core owns every value on this screen. The client reads it, shows it, and
     sends changes back through the audited dispatcher; it decides nothing. */
  const refresh = async (): Promise<void> => {
    try {
      setView(await onAction<ProjectConfigView>({ type: "config.inspect", payload: {} }));
      setError("");
    } catch (cause) {
      setError(plainActionError(cause));
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  const change = async (payload: Record<string, unknown>): Promise<void> => {
    setWorking(true);
    setError("");
    try {
      setView(await onAction<ProjectConfigView>({ type: "config.set", payload }));
    } catch (cause) {
      setError(plainActionError(cause));
    } finally {
      setWorking(false);
    }
  };

  const config = view?.config ?? null;
  const disabled = busy || working || inspection === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(800px,calc(100vh-40px))] w-[min(880px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule px-5 py-4">
          <DialogTitle className="text-[20px] leading-tight font-semibold tracking-tighter">
            Settings
          </DialogTitle>
          <DialogDescription>
            Settings belong to the project you have open, not to the app.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="grid gap-4 px-5 py-5">
            {error === "" ? null : (
              <p
                className="m-0 rounded-md border border-clay/25 border-l-2 border-l-clay bg-clay-wash px-3 py-2 text-[12px] break-words text-clay"
                role="status"
              >
                {error}
              </p>
            )}

            <Section title="Project">
              <div className="flex items-center gap-3">
                <code className="min-w-0 flex-1 font-mono text-[13px] break-all text-ink">
                  {displayProjectPath(projectPath)}
                </code>
                <Button size="sm" type="button" variant="outline" onClick={onChooseProject}>
                  <FolderGit2 aria-hidden="true" />
                  Change
                </Button>
              </div>
              {view !== null && !view.initialized ? (
                <div className="mt-3 rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash px-3 py-2.5">
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
            </Section>

            <AgentSection
              disabled={disabled}
              view={view}
              onAction={onAction}
              onConnected={setView}
              onError={setError}
            />

            <Section title="Which agent handles what">
              {config === null ? (
                <Waiting />
              ) : (
                <>
                  <p className="m-0 mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
                    Hivemind picks an agent by how risky the files a task touches
                    are. A file matching nothing counts as risky, so these lists
                    are what keep ordinary work off your most expensive agent.
                  </p>
                  <div className="grid gap-px overflow-hidden rounded-md border border-rule bg-rule">
                    {SCOPES.map((scope) => (
                      <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 bg-panel px-3 py-2.5" key={scope.key}>
                        <div>
                          <strong className="block text-[13px] font-medium text-ink">{scope.label}</strong>
                          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                            {scope.detail}
                          </span>
                        </div>
                        <GlobList
                          disabled={disabled}
                          globs={config[scope.key]}
                          onChange={(next) => void change({ [scope.key]: next })}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>

            <TaskTypeRouting
              config={config}
              disabled={disabled}
              adapters={view?.adapters ?? []}
              onChange={change}
            />

            <Section title="Spending limits">
              {config === null ? (
                <Waiting />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      detail={`One agent call really costs ${view!.limits.observed_worker_call_tokens.low.toLocaleString()}–${view!.limits.observed_worker_call_tokens.high.toLocaleString()} tokens on this project's own runs. A limit below that stops the run after you have paid for the call.`}
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
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <NumberField
                      detail={`How many agents work at once. Between 1 and ${view!.limits.max_concurrent_workers_hard_max}.`}
                      disabled={disabled}
                      label="Agents at once"
                      value={config.max_concurrent_workers}
                      onCommit={(value) => void change({ max_concurrent_workers: value })}
                    />
                    <TextField
                      detail="Run after every change. If this is wrong, nothing can be verified and nothing ships."
                      disabled={disabled}
                      label="Your project's checks"
                      value={config.test_command}
                      onCommit={(value) => void change({ test_command: value })}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section title="How often Hivemind interrupts you">
              <div className="grid gap-2">
                {LEVELS.map((entry) => (
                  <button
                    aria-pressed={entry.value === level}
                    className={`cursor-pointer rounded-md border p-3 text-left transition-colors ${
                      entry.value === level
                        ? "border-navy bg-navy-wash"
                        : "border-rule bg-panel hover:border-navy/40"
                    }`}
                    disabled={disabled}
                    key={entry.value}
                    type="button"
                    onClick={() => {
                      void onAction({ type: "autonomy.set", payload: { level: entry.value } });
                    }}
                  >
                    <strong className="block text-[13px] font-medium text-ink">{entry.label}</strong>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                      {entry.detail}
                    </span>
                  </button>
                ))}
              </div>
            </Section>

            <BuildLine />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/* ── Bring your own agent ─────────────────────────────────────────────────── */

function AgentSection({
  view,
  disabled,
  onAction,
  onConnected,
  onError
}: {
  view: ProjectConfigView | null;
  disabled: boolean;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  onConnected: (view: ProjectConfigView) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ role: string; result: ProbedCapability[]; ok: boolean } | null>(null);

  const connect = async (role: string, agent: CatalogueAgent): Promise<void> => {
    setConnecting(`${role}:${agent.id}`);
    setProbe(null);
    onError("");
    try {
      const result = await onAction<{ probe: { capabilities: ProbedCapability[]; ok: boolean }; config: ProjectConfigView }>({
        type: "adapter.connect",
        payload: { role, agent_id: agent.id }
      });
      setProbe({ role, result: result.probe.capabilities, ok: result.probe.ok });
      onConnected(result.config);
    } catch (cause) {
      onError(plainActionError(cause));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <Section title="Your coding agent">
      <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
        Hivemind runs the coding agent you already pay for. It never asks for a
        key of its own — you keep your subscription, and Hivemind starts the
        agent the same way you would.
      </p>

      {view === null ? (
        <div className="mt-3">
          <Waiting />
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-rule bg-rule">
            {view.adapters.map((adapter) => (
              <RoleRow adapter={adapter} key={adapter.role} />
            ))}
          </div>

          <h4 className="mt-4 mb-2 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
            Agents Hivemind can run
          </h4>
          <div className="grid gap-2">
            {view.catalogue.map((agent) => (
              <AgentCard
                agent={agent}
                busy={connecting !== null}
                connecting={connecting}
                disabled={disabled}
                key={agent.id}
                roles={view.roles}
                onConnect={(role) => void connect(role, agent)}
              />
            ))}
          </div>

          {probe === null ? null : <ProbeReport ok={probe.ok} capabilities={probe.result} role={probe.role} />}
        </>
      )}
    </Section>
  );
}

function RoleRow({ adapter }: { adapter: InspectedAdapter }): React.JSX.Element {
  const broken = adapter.problems.length > 0;
  return (
    <div className="grid grid-cols-[152px_minmax(0,1fr)_auto] items-center gap-3 bg-panel px-3 py-2.5">
      <div>
        <strong className="block text-[13px] font-medium text-ink capitalize">{adapter.role}</strong>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {ROLE_PURPOSE[adapter.role] ?? "Used by Hivemind by name"}
        </span>
      </div>
      <div className="min-w-0">
        {adapter.installed ? (
          <>
            <span className="font-mono text-[12px] break-all text-ink">
              {adapter.model ?? adapter.tool ?? adapter.role}
            </span>
            {broken ? (
              <span className="mt-0.5 block text-[11px] leading-snug break-words text-clay">
                {adapter.problems.join("; ")}
              </span>
            ) : adapter.connected_at === null ? (
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Installed before Hivemind could check it — reconnect to verify what it can do.
              </span>
            ) : (
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Checked when you connected it
              </span>
            )}
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground">Not connected</span>
        )}
      </div>
      <StatusMark state={adapter.installed && !broken ? (adapter.connected_at === null ? "unverified" : "ok") : adapter.installed ? "bad" : "none"} />
    </div>
  );
}

function AgentCard({
  agent,
  roles,
  disabled,
  busy,
  connecting,
  onConnect
}: {
  agent: CatalogueAgent;
  roles: string[];
  disabled: boolean;
  busy: boolean;
  connecting: string | null;
  onConnect: (role: string) => void;
}): React.JSX.Element {
  const tone =
    agent.status === "supported"
      ? "border-rule"
      : agent.status === "unverified"
        ? "border-amber/30 border-l-2 border-l-amber"
        : "border-rule border-l-2 border-l-rule";
  return (
    <article className={`rounded-md border bg-panel px-3 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <strong className="text-[13px] font-semibold text-ink">{agent.label}</strong>
        <span className="font-mono text-[11px] text-muted-foreground">{agent.harness}</span>
        <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
        <span className="text-[11px] text-muted-foreground">{agent.subscription}</span>
        <span className="ml-auto">
          <StatusWord status={agent.status} />
        </span>
      </div>
      {agent.caveat === null ? null : (
        <p className="mt-1.5 mb-0 text-[11px] leading-relaxed break-words text-muted-foreground">
          {agent.caveat}
        </p>
      )}
      {agent.connectable ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Use it for</span>
          {roles.map((role) => (
            <Button
              disabled={disabled || busy}
              key={role}
              size="xs"
              type="button"
              variant="outline"
              onClick={() => onConnect(role)}
            >
              {connecting === `${role}:${agent.id}` ? (
                <Loader aria-hidden="true" className="animate-spin" />
              ) : (
                <Plug aria-hidden="true" />
              )}
              {role}
            </Button>
          ))}
          <span className="text-[11px] text-muted-foreground">
            — connecting runs it once to check what it can actually do (about 40K tokens).
          </span>
        </div>
      ) : null}
    </article>
  );
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
                  asked {entry.requested ?? "—"} · got {entry.reported ?? "no answer"}
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

function StatusWord({ status }: { status: CatalogueAgent["status"] }): React.JSX.Element {
  const text =
    status === "supported" ? "Proven on real runs" : status === "unverified" ? "Unverified" : "Not integrated";
  const tone =
    status === "supported" ? "text-navy" : status === "unverified" ? "text-amber" : "text-muted-foreground";
  return <span className={`text-[11px] font-medium ${tone}`}>{text}</span>;
}

function StatusMark({ state }: { state: "ok" | "bad" | "unverified" | "none" }): React.JSX.Element {
  if (state === "ok") return <Check aria-hidden="true" className="mt-0.5 size-3.5 text-navy" />;
  if (state === "bad") return <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 text-clay" />;
  if (state === "unverified") return <Minus aria-hidden="true" className="mt-0.5 size-3.5 text-amber" />;
  return <Minus aria-hidden="true" className="mt-0.5 size-3.5 text-muted-foreground" />;
}

/* ── Fields ───────────────────────────────────────────────────────────────── */

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
      Reading this project's settings…
    </p>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-rule bg-panel p-4">
      <h3 className="m-0 mb-2.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        {title}
      </h3>
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
  "Screens are where a stronger model most often pays for itself — layout and spacing are judged by eye, and cheaper models tend to need more revisions. Hivemind will not do this on its own: it costs more per task, and this has not been measured on your project.";

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
  if (config === null) {
    return (
      <Section title="Which agent handles which kind of work">
        <Waiting />
      </Section>
    );
  }
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
    <Section title="Which agent handles which kind of work">
      <p className="m-0 mb-3 text-[12px] leading-relaxed text-muted-foreground">
        Work is already routed by how risky the files are. This adds the second
        question: what KIND of work it is. The risk limit still wins — nothing here
        can send dangerous work to a cheaper agent.
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
              <option value="strongest">The strongest agent available</option>
              <option value="cheapest">The cheapest agent available</option>
              {choosable.map((adapter) => (
                <option key={adapter.role} value={adapter.tool ?? ""}>
                  {adapter.role}
                  {adapter.model === null ? "" : ` · ${adapter.model}`}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </Section>
  );
}

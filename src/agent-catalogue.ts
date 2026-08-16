/**
 * The coding agents Hivemind can run, and what is actually true about each.
 *
 * Hivemind is an agent development environment: a coding agent is a *harness*
 * that runs inside it, paid for by whatever subscription the person already
 * has. Hivemind never holds a provider credential of its own, so this catalogue
 * describes binaries and flags, never keys.
 *
 * The status field is the honest part. `supported` means real runs have gone
 * through it end to end; anything else says what specifically is missing. A
 * picker implying five integrations would be a lie the first run exposes, and
 * a spending limit built on unverified usage numbers is worse than no
 * integration at all -- so an agent whose usage parsing has never been seen
 * live cannot be `supported`, however well it is fixture-tested.
 */

export type AgentStatus = "supported" | "unverified" | "unsupported";

export interface CatalogueAgent {
  /** Stable id used by `adapter.connect`, and the profile's `tool` name. */
  id: string;
  label: string;
  /** The harness binary, and the subscription that pays for it. */
  harness: string;
  subscription: string;
  status: AgentStatus;
  /** Required when status is not `supported`: what exactly is missing. */
  caveat: string | null;
  /** The model this profile pins. Compared against what the probe reads back. */
  model: string | null;
  routing_tier: "local" | "cheap" | "standard" | "strong";
  cost_rank: number;
  context_window: number;
  timeout_ms: number;
  usage_parser: "codex-jsonl" | "codex-text" | "claude-json" | "opencode-json" | null;
  /**
   * How this harness is kept out of a shell, which is now the PRIMARY
   * confinement mechanism rather than a fallback.
   *
   * Hivemind does not need the agent to have a shell: Core runs the project's
   * checks itself, captures the diff itself and decides admission itself. So
   * the strongest posture is simply not to grant one -- it turns confinement
   * and "does not commit" from properties of an OS sandbox nobody reports into
   * properties of the argv we are holding.
   *
   * `sandbox` means this harness has no tool-level deny and is bounded by an
   * OS sandbox instead; `none` means neither is available, which is a refusal.
   */
  shell_denial: {
    mechanism: "tool-allowlist" | "config-deny" | "agent-spec" | "sandbox" | "none";
    /** How the denial is confirmed to have TAKEN EFFECT, not merely accepted. */
    confirmed_by: "runtime-readback" | "resolved-config" | "behavioural-canary" | "unconfirmed";
    detail: string;
  };
  /**
   * How the probe reads back what took effect. `codex-rollout` reads the
   * session record the run writes; `none` means this agent reports nothing we
   * can compare a request against, and every capability that needs a readback
   * comes back `unverified` rather than `verified`.
   */
  readback: "codex-rollout" | "claude-init" | "opencode-permissions" | "none";
  /** Argv template. `{cwd}` is replaced with the project root at connect time. */
  invoke: string[] | null;
}

/* Windows spawns the CLI through cmd.exe because the installed entry points are
   .cmd shims; POSIX invokes the binary directly. */
function codexInvoke(model: string): string[] {
  const args = [
    "exec",
    "--model",
    model,
    "--sandbox",
    "workspace-write",
    "--config",
    'model_reasoning_effort="high"',
    /* Stated rather than inherited. `~/.codex/config.toml` on the machine this
       was measured on carries `approval_policy = "never"`, and `codex doctor`
       confirms it resolves -- so the policy a Hivemind worker ran under was
       whatever the person happened to have set. `never` is also the only
       workable value for a non-interactive `exec` run, since there is nobody to
       answer a prompt; what changes here is that it is Hivemind's choice and
       cannot move underneath us. Verified overridable:
       `codex doctor -c approval_policy='"on-request"'` reports `OnRequest`. */
    "--config",
    'approval_policy="never"',
    /* `notify` is a program path in user config that Codex runs on turn events.
       On this machine it holds two, chained -- one of them written by OpenAI's
       own installer rather than by a person -- so a worker with no shell caused
       two external programs to execute per turn.

       HONESTLY LABELLED: the override parses and is accepted, and its effect
       was NOT observed, because confirming it needs a real paid turn. That is
       the same "flag accepted without being applied" shape this project has
       shipped twice, so it is written down rather than assumed. The probe does
       not read `notify` back and nothing here claims it does. */
    "--config",
    "notify=[]",
    "--ephemeral",
    "--json",
    "-"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "codex.cmd", ...args]
    : ["codex", ...args];
}

/**
 * Claude Code with no shell at all.
 *
 * `--tools` is a positive allowlist of the built-in tools, so Bash is absent
 * rather than denied -- which is a stronger statement, and it is the thing that
 * makes Claude Code adaptable on native Windows at all. Its OS sandbox covers
 * the shell only, is unsupported on native Windows, and BY DEFAULT falls back
 * to running the command unsandboxed when it cannot start. That last one is the
 * exact silent-downgrade shape this project has shipped twice. Having no shell
 * sidesteps all three.
 *
 * `--permission-mode acceptEdits` rather than any of the bypass modes: it
 * auto-approves file edits, which is the only thing this profile can do, and
 * the modes that would approve more are the ones the preflight refuses.
 *
 * Deliberately NOT `--bare`, despite it being the documented recommendation for
 * scripted callers. Bare mode never reads OAuth credentials and requires an
 * ANTHROPIC_API_KEY, which would break the one positioning rule this product
 * has: Hivemind holds no provider credential and runs on the subscription the
 * person already pays for.
 */
function claudeInvoke(model = "sonnet"): string[] {
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    /* Hooks are user-supplied SHELL COMMANDS run at lifecycle points, and they
       run in a worker that has no shell. Measured on 2.1.233 against this exact
       argv: `init` reported `tools: ["Edit","Glob","Grep","Read","Write"]` and
       two hooks nevertheless executed `node` and wrote files to disk. A
       `UserPromptSubmit` hook also receives the full prompt and a path to the
       transcript, and can replace what the model reads -- we sent "say only:
       ok" and the model answered "ZEBRA-7714".

       `--safe-mode` disables hooks, CLAUDE.md, skills, plugins, MCP servers and
       custom agents while leaving auth, model selection, built-in tools and
       permissions working. Tested: with the injecting hook still on disk it
       answers "ok". `--bare` also disables hooks and is the documented choice
       for scripted callers, but it never reads OAuth and demands an
       ANTHROPIC_API_KEY -- which would break the rule that Hivemind holds no
       provider credential. So: safe-mode.

       WHAT THIS COSTS, because it is a real cost and not a free win: somebody
       whose workflow depends on a hook, a CLAUDE.md, a skill or an MCP server
       does not get it inside a Hivemind worker. That is a deliberate trade of
       capability for a contract that means what it says, and the connection
       reports it rather than leaving it to be discovered. */
    "--safe-mode",
    /* Detection behind the prevention, on the same argument as
       `--disallowedTools` sitting behind `--tools`. This emits `hook_started`
       and `hook_response` into the stream already being parsed, so a hook that
       runs despite safe-mode is visible rather than silent. Measured: zero
       events on a clean run, two with a hook and no defence, zero with a hook
       and safe-mode. */
    "--include-hook-events",
    /* Sessions are written to disk and resumable unless this is passed, which
       leaves state behind between invocations that are supposed to be
       one-shot. */
    "--no-session-persistence",
    /* Only MCP servers Hivemind passes, which is none. Without it the user's
       globally-configured servers are advertised to the model -- eight of them
       on the machine this was measured on. `--tools` still refuses to EXECUTE
       them (tested, including against a settings rule explicitly allowing
       one), so this removes an advertisement rather than a breach. */
    "--strict-mcp-config",
    /* The tools a worker needs to produce a diff, and nothing else. */
    "--tools",
    "Read,Write,Edit,Glob,Grep",
    /* Belt as well as braces: if a future version changes what `--tools`
       omits, an explicit deny still names the shell. */
    "--disallowedTools",
    "Bash",
    "--permission-mode",
    "acceptEdits"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "claude.cmd", ...args]
    : ["claude", ...args];
}


/**
 * OpenCode with no shell and no helper agents.
 *
 * The denial is not on the command line -- OpenCode takes it from the project's
 * own `opencode.json`, which `adapter.connect` writes when the project has none
 * (`harness-project-config.ts`). That is why this agent's readback reads the
 * resolved table rather than the run: the rule lives in config, so config is
 * where it has to be confirmed.
 *
 * This comment used to say `project.init` wrote that file. Nothing wrote it.
 * Measured in Hivemind's own repository, `opencode agent list` resolved
 * `* -> allow` with no rule for `bash` at all, so the shell was permitted on
 * every project Hivemind had ever set up. The contract did not lie -- the
 * readback reads the resolved table, found no denial and returned the
 * capability unverified, which refuses -- but OpenCode could never have passed
 * it. A comment describing a mechanism is not a mechanism.
 *
 * `--format json` streams events; every `step_finish` carries its own token
 * block, which is where the usage reader looks. Deliberately NOT `--auto`,
 * whose own help calls it "dangerous!" -- with the shell and helper agents
 * denied there is nothing left that needs blanket approval.
 */
function openCodeInvoke(model = "opencode/deepseek-v4-flash-free"): string[] {
  /* `--pure` is OpenCode's own word for "run without external plugins". The
     user-level config directory on the machine this was measured on carries its
     own `node_modules` tree beside `opencode.jsonc`, so plugins are not a
     hypothetical: they are npm packages a person installed, loaded into a run
     Hivemind is supposed to have bounded. */
  const args = ["run", "--pure", "--format", "json", "--model", model];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "opencode.cmd", ...args]
    : ["opencode", ...args];
}

/**
 * Grok Build, prepared but never run.
 *
 * Every flag below is doc-derived and, where noted in
 * `docs/PROVIDER-DISCOVERY.md`, confirmed present in the shipped binary. None
 * of it has been *exercised*, because the binary checks authentication before
 * it validates flags -- `grok --sandbox bogus -p "x"` answers "Not signed in"
 * rather than naming the valid profiles -- so every readback question needs an
 * account and nothing more can be learned for free.
 *
 * The posture matches the other three: deny the shell by ALLOWLIST rather than
 * by denylist, pin the model, refuse sub-agents, and read a documented wire
 * format rather than a bespoke one.
 *
 * OUTPUT FORMAT: `streaming-messages-json`, not `streaming-json`, and the trade
 * is worth stating. `streaming-json` is the agent's own ACP session updates and
 * is where an init event would appear if one exists -- the readback question.
 * `streaming-messages-json` is documented as **NDJSON in the Anthropic Messages
 * API wire format**, which means its usage block has a shape this project
 * already parses and has verified against that exact format.
 *
 * Usage decided it. An agent with an invocation and no usage reader refuses on
 * a capability nothing could ever satisfy, so a "prepared" probe with no parser
 * would never pass -- `config-actions.test.ts` says so and is right. Reusing
 * `claude-json` for a format the vendor documents AS that wire format is not a
 * guess; inventing a parser for an unmeasured shape would be.
 *
 * It fails in the safe direction either way: if Grok's stream differs, the
 * parser finds nothing, `reports_usage` comes back unverified, and the contract
 * ADMITS with spend ceilings switched off and the person told -- rather than
 * refusing. The readback question then needs a second probe against
 * `streaming-json`, which is a config change and not a design one.
 *
 * `--dangerously-skip-permissions` and `--permission-mode bypassPermissions`
 * are Claude-compatibility aliases it also ships; `findDangerousAdapterArgs`
 * already refuses both by name, and no invocation here may carry them.
 */
function grokInvoke(model = "grok-code-fast-1"): string[] {
  const args = [
    "--single",
    "--model",
    model,
    /* The shell is absent rather than denied: a positive allowlist of the
       built-in tools, which is the same shape as Claude Code's. */
    "--tools",
    "read,write,edit,glob,grep",
    "--no-subagents",
    /* An OS-level profile, not a promise. `workspace` is the narrowest profile
       that still permits the writes a worker must make. */
    "--sandbox",
    "workspace",
    "--output-format",
    "streaming-messages-json"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "grok.cmd", ...args]
    : ["grok", ...args];
}

export const agentCatalogue: CatalogueAgent[] = [
  {
    id: "codex-terra",
    label: "Codex — balanced",
    harness: "codex-cli",
    subscription: "ChatGPT Plus, Pro or Business",
    status: "supported",
    caveat: null,
    model: "gpt-5.6-terra",
    routing_tier: "standard",
    cost_rank: 8,
    context_window: 272_000,
    timeout_ms: 900_000,
    usage_parser: "codex-jsonl",
    shell_denial: {
      mechanism: "sandbox",
      confirmed_by: "runtime-readback",
      detail:
        "`--disable shell_tool` removes the shell, which its own feature list confirms is a stable flag rather than an experiment -- so the shell-less posture is available here too, and an earlier note in this file saying otherwise was wrong. This profile keeps its shell deliberately: Codex is the one harness that reports the sandbox it resolved, so its boundary is verified either way, and it is the control case for measuring what a shell is worth.",
    },
    readback: "codex-rollout",
    invoke: codexInvoke("gpt-5.6-terra")
  },
  {
    id: "codex-luna",
    label: "Codex — cheaper",
    harness: "codex-cli",
    subscription: "ChatGPT Plus, Pro or Business",
    status: "supported",
    caveat: null,
    model: "gpt-5.6-luna",
    routing_tier: "cheap",
    cost_rank: 4,
    context_window: 272_000,
    timeout_ms: 900_000,
    usage_parser: "codex-jsonl",
    shell_denial: {
      mechanism: "sandbox",
      confirmed_by: "runtime-readback",
      detail:
        "`--disable shell_tool` removes the shell, which its own feature list confirms is a stable flag rather than an experiment -- so the shell-less posture is available here too, and an earlier note in this file saying otherwise was wrong. This profile keeps its shell deliberately: Codex is the one harness that reports the sandbox it resolved, so its boundary is verified either way, and it is the control case for measuring what a shell is worth.",
    },
    readback: "codex-rollout",
    invoke: codexInvoke("gpt-5.6-luna")
  },
  {
    id: "codex-sol",
    label: "Codex — strongest",
    harness: "codex-cli",
    subscription: "ChatGPT Pro or Business",
    status: "supported",
    caveat: null,
    model: "gpt-5.6-sol",
    routing_tier: "strong",
    cost_rank: 20,
    context_window: 272_000,
    timeout_ms: 900_000,
    usage_parser: "codex-jsonl",
    shell_denial: {
      mechanism: "sandbox",
      confirmed_by: "runtime-readback",
      detail:
        "`--disable shell_tool` removes the shell, which its own feature list confirms is a stable flag rather than an experiment -- so the shell-less posture is available here too, and an earlier note in this file saying otherwise was wrong. This profile keeps its shell deliberately: Codex is the one harness that reports the sandbox it resolved, so its boundary is verified either way, and it is the control case for measuring what a shell is worth.",
    },
    readback: "codex-rollout",
    invoke: codexInvoke("gpt-5.6-sol")
  },
  {
    /* Fixture-tested and live-unverified. The checked-in profile was removed
       for carrying bypassPermissions, which is a refusal this build enforces at
       preflight -- so any profile written for it has to earn its flags again
       from scratch. Offered, but it cannot be connected until a probe passes,
       and the probe cannot pass while the usage readback is unknown. */
    id: "claude-code",
    label: "Claude Code",
    harness: "claude",
    subscription: "Claude Pro or Max",
    status: "unverified",
    caveat:
      "Hivemind runs this one in safe mode, which means your hooks, your CLAUDE.md, your skills, your plugins and your MCP servers are switched off inside a Hivemind worker. That is a real loss if you rely on them, and it is deliberate: a hook is a shell command, it runs even though this worker has no shell, and one that edits the prompt can replace the instructions before the model reads them — measured, not assumed. Its token reporting has only ever been checked against recorded output, never against a live run, and the profile it used to ship with carried a permission-bypass flag this build refuses. Connecting it runs the same probe as any other agent; anything the probe cannot confirm is reported as unverified rather than assumed.",
    model: null,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 200_000,
    timeout_ms: 900_000,
    usage_parser: "claude-json",
    readback: "claude-init",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "runtime-readback",
      detail:
        "`--tools` is a positive allowlist of built-in tools, so the shell is absent rather than denied. Confirmed by the tools array the run reports at startup -- which is why this cannot be claimed until one real run has been read.",
    },
    invoke: claudeInvoke()
  },
  {
    id: "opencode",
    label: "OpenCode",
    harness: "opencode",
    subscription: "whatever provider you point it at",
    status: "unverified",
    caveat:
      "A probe has been through it and it passed: it denies itself a shell and helper agents, it says so before it runs, and its token counts are read from its own output. What it does not report is which model actually answered, so Hivemind cannot send cheaper work to a cheaper model on this one. No whole piece of work has been built and shipped through it yet, which is what would make it proven.",
    model: null,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 200_000,
    timeout_ms: 900_000,
    usage_parser: "opencode-json",
    readback: "opencode-permissions",
    shell_denial: {
      mechanism: "config-deny",
      confirmed_by: "resolved-config",
      detail:
        "`permission.bash: \"deny\"` in the project's own config. `opencode agent list` prints the resolved table for free and shows the rule landing on every agent -- but the print does not establish which rule WINS, so the denial is corroborated by a run that is told to use a shell and does not.",
    },
    invoke: openCodeInvoke(),
  },
  {
    /* Refused as measured, not as an oversight, and the reason is specific
       enough to re-check when it changes. See docs/PROVIDER-DISCOVERY.md. */
    id: "grok-build",
    label: "Grok Build",
    harness: "grok",
    subscription: "an X.AI plan or an XAI_API_KEY",
    status: "unverified",
    caveat:
      "Its flags are the best shaped of any agent here -- a real sandbox, a positive tool allowlist, and a switch that turns off helper agents. What is unknown is whether it reports any of that back once it runs, and that cannot be found out without an account. Connecting it runs the same probe as any other agent.",
    model: null,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 256_000,
    timeout_ms: 900_000,
    /* UNVERIFIED-AGAINST-GROK.
       `streaming-messages-json` is documented as the Anthropic Messages wire
       format, and `claude-json` parses that format and is verified against it
       -- on CLAUDE's output. It has never seen Grok's stream. The match is a
       documentary claim about a format, not a measurement of this provider.

       Fourth instance of the recorded-output pattern, labelled BEFORE the probe
       rather than discovered during it: a reader is only verified against the
       output it has actually read. If Grok's stream differs, the parser finds
       nothing, `reports_usage` returns unverified, and the contract admits with
       spend ceilings off -- so the failure is bounded and named rather than
       silent. The label comes off when a run confirms it. */
    usage_parser: "claude-json",
    readback: "none",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "unconfirmed",
      detail:
        "`--tools` allows exactly the built-in tools named and `--no-subagents` turns off helper agents. Nothing is known about whether either is reported back, because reading its version is free and running it is not.",
    },
    /* Prepared 2026-08-14, never run. Connecting it runs the same probe as any
       other agent -- there is no Grok-specific path to write. */
    invoke: grokInvoke()
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    harness: "kimi",
    subscription: "a Kimi account or a Moonshot API key",
    status: "unverified",
    caveat:
      "It can be told to run with a fixed list of tools and no shell, and that list is enforced before a tool runs rather than only suggested to the model. What is unknown is whether its file tools stay inside the folder you point them at -- nothing it reports says so, and that cannot be found out without an account. Connecting it runs the same probe as any other agent.",
    model: null,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 256_000,
    timeout_ms: 900_000,
    usage_parser: null,
    readback: "none",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "unconfirmed",
      detail:
        "`[tools] enabled` in its own settings is a positive allowlist that its documentation says is enforced again before a tool executes, not merely shown to the model. Naming the file tools and omitting the shell also omits the two tools that start helper agents. Nothing reports back that it took effect.",
    },
    invoke: null
  }
];

export function findCatalogueAgent(id: string): CatalogueAgent | null {
  return agentCatalogue.find((agent) => agent.id === id) ?? null;
}

/* ── Providers and models, which is what a person actually chooses ──────────
 *
 * A catalogue entry is one (PROVIDER x MODEL) pair, because that pair is the
 * unit `adapter.connect` probes and writes a profile for. That is correct as a
 * connect unit and wrong as a question to ask somebody. It produced a picker
 * offering "Codex — balanced", "Codex — cheaper" and "Codex — strongest": three
 * rows that are one provider, labelled with `routing_tier`, which is Hivemind's
 * internal routing vocabulary and no part of what the person is deciding.
 *
 * So the catalogue is projected two ways. Neither is new data:
 *
 * - a PROVIDER is a harness and the subscription that pays for it. Its status
 *   and caveat are properties of the harness -- what its probe can and cannot
 *   confirm -- so they belong here and are the honest part of the screen.
 * - a MODEL is a slug the harness accepts, with a real price.
 *
 * A provider whose entries all carry `model: null` HAS no models to offer, and
 * that is a finding rather than an omission: Hivemind cannot pin a model on it,
 * so nobody can aim it at one deliberately. The surface says so.
 */

export interface CatalogueProvider {
  /** The harness id. Stable, and what a profile's invoke actually runs. */
  id: string;
  label: string;
  subscription: string;
  /** The best status any of its models reaches. */
  status: AgentStatus;
  /** Why it is not `supported`, verbatim from the entry that carries it. */
  caveat: string | null;
  /** Whether Hivemind can name a model for this harness at all. */
  pins_model: boolean;
}

export interface CatalogueModel {
  /** The connect unit. `adapter.connect` still takes this. */
  agent_id: string;
  provider_id: string;
  /** The value passed to the harness, or null when it pins nothing. */
  slug: string | null;
  /** What to call it on screen: the model, not the tier. */
  label: string;
  routing_tier: CatalogueAgent["routing_tier"];
  context_window: number;
}

/**
 * Which model to suggest for each role, and why.
 *
 * The table lives HERE, in the one file allowed to know a provider by name,
 * for the same reason the endpoint surface does: naming `codex-sol` is
 * provider knowledge, and `provider-knowledge.test.ts` fails a fourth place
 * rather than letting one accumulate through review. `role-recommendations.ts`
 * holds the mechanism and names nobody.
 *
 * These are advice, not defaults. Nothing here selects anything: the surface
 * pre-fills a picker and a person still presses the button, because connecting
 * runs the agent once for real on their own subscription. `routeTaskProvider`
 * never reads this.
 *
 * Dated because model rankings move faster than releases, and a considered
 * default presented as current when it is a quarter old is the same failure as
 * a stale price.
 */
export interface RoleRecommendation {
  role: AdapterRoleName;
  agent_id: string;
  /** One sentence a person can disagree with, not just a conclusion. */
  why: string;
  reviewed: string;
}

export const ROLE_RECOMMENDATIONS: RoleRecommendation[] = [
  {
    role: "planner",
    agent_id: "codex-sol",
    why: "Planning is where a weaker model costs the most: every task inherits the plan's mistakes, and a bad split is paid for again by each worker under it.",
    reviewed: "2026-08-14"
  },
  {
    role: "manager",
    agent_id: "codex-terra",
    why: "The manager decides what to do when something unexpected happens. It reasons over a small, well-described situation, which is the shape a mid-tier model handles well.",
    reviewed: "2026-08-14"
  },
  /* ONE worker, deliberately. Tier routing only does something with a pool of
     more than one, so there is a real argument for suggesting three up front.
     It loses to what that costs: each connection runs the agent once, so a
     three-model pool turns a first run into five probes before a line of code
     is written. Build the pool once somebody has seen a run finish. */
  {
    role: "worker",
    agent_id: "codex-terra",
    why: "Writing the code for one scoped task with the files named in advance. Start with one worker; add a cheaper model for routine work once you have seen a run finish.",
    reviewed: "2026-08-14"
  }
];

/** Human labels for a harness. The entry labels name the pair, not the tool. */
const PROVIDER_LABELS: Record<string, string> = {
  /* The harness id is `codex-cli`, not `codex` -- the same distinction that
     made `profile.tool` look like a harness when it was a role. */
  "codex-cli": "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  grok: "Grok Build",
  kimi: "Kimi Code"
};

/** Model labels, where a slug is too terse to read. */
const MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna"
};

function bestStatus(left: AgentStatus, right: AgentStatus): AgentStatus {
  const rank = (status: AgentStatus): number =>
    status === "supported" ? 0 : status === "unverified" ? 1 : 2;
  return rank(left) <= rank(right) ? left : right;
}

/** One row per harness, in the order the catalogue lists them. */
export function catalogueProviders(): CatalogueProvider[] {
  const byId = new Map<string, CatalogueProvider>();
  for (const agent of agentCatalogue) {
    const existing = byId.get(agent.harness);
    if (existing === undefined) {
      byId.set(agent.harness, {
        id: agent.harness,
        label: PROVIDER_LABELS[agent.harness] ?? agent.label,
        subscription: agent.subscription,
        status: agent.status,
        caveat: agent.caveat,
        pins_model: agent.model !== null
      });
      continue;
    }
    existing.status = bestStatus(existing.status, agent.status);
    existing.pins_model = existing.pins_model || agent.model !== null;
    /* Keep the caveat belonging to the status that survived, so a provider
       does not end up explaining why it is unverified while reporting that it
       is supported. */
    if (existing.status === agent.status && existing.caveat === null) {
      existing.caveat = agent.caveat;
    }
  }
  return [...byId.values()];
}

/** Every (provider, model) the catalogue holds, cheapest tier first. */
export function catalogueModels(providerId?: string): CatalogueModel[] {
  const tierOrder: Record<CatalogueAgent["routing_tier"], number> = {
    local: 0,
    cheap: 1,
    standard: 2,
    strong: 3
  };
  return agentCatalogue
    .filter((agent) => providerId === undefined || agent.harness === providerId)
    .map((agent) => ({
      agent_id: agent.id,
      provider_id: agent.harness,
      slug: agent.model,
      label:
        agent.model === null
          ? "Whatever the harness chooses"
          : (MODEL_LABELS[agent.model] ?? agent.model),
      routing_tier: agent.routing_tier,
      context_window: agent.context_window
    }))
    .sort((left, right) => tierOrder[left.routing_tier] - tierOrder[right.routing_tier]);
}

/**
 * The three names Core resolves by hand. `plan.prepare` sends `planner` and
 * `manager.start` sends `manager`; `worker` is never asked for by name but has
 * to exist on disk because routing searches for it.
 */
export const adapterRoleNames = ["planner", "manager", "worker"] as const;
export type AdapterRoleName = (typeof adapterRoleNames)[number];

export function isAdapterRoleName(value: unknown): value is AdapterRoleName {
  return typeof value === "string" && (adapterRoleNames as readonly string[]).includes(value);
}

/**
 * Which directory variable points each harness at one of its own logins.
 *
 * Lives here because this file is the one that knows **how to start a
 * provider**, and which home it starts against is part of that. It was briefly
 * its own module and `provider-knowledge.test.ts` correctly refused it: a
 * fourth file knowing providers by name is the thing that test exists to stop,
 * and the right answer was to put the knowledge where it belonged rather than
 * to widen the allowlist.
 *
 * **Measured, not assumed** — read out of the shipped artifacts on 2026-08-13:
 *
 * | Harness | Variable | Confirmed by |
 * | --- | --- | --- |
 * | `codex` | `CODEX_HOME` | `codex --help`: "Layer `$CODEX_HOME/<name>.config.toml`…" |
 * | `claude` | `CLAUDE_CONFIG_DIR` | present in the shipped `claude.exe` |
 * | `opencode` | `OPENCODE_CONFIG_DIR` | present in the shipped `opencode.exe` |
 *
 * A literal, deliberately: a configurable variable name would let a project
 * point a harness at `ANTHROPIC_API_KEY` and hand Hivemind a credential to
 * carry. Those names sit two entries away from these in the same binaries.
 */
export const ACCOUNT_HOME_VARIABLES: Record<string, string> = {
  "codex-cli": "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  opencode: "OPENCODE_CONFIG_DIR"
};

/**
 * The harness a connected role runs on.
 *
 * **A profile's `tool` is the ROLE**, not the harness — `worker.profile.json`
 * carries `tool: "worker"`, because Core resolves adapters by the name callers
 * send and callers send the role. Anything that needs the harness has to go
 * through the connection record's `agent_id` and this catalogue.
 *
 * That indirection was missed twice on 2026-08-14, in the account mechanism and
 * again in the endpoint check, and both times the unit tests passed because the
 * fixtures wrote `tool: "codex"` — a shape no real profile has. The tests were
 * measuring a repo that could not exist. Caught by `adapter-probe.test.ts`,
 * which builds its profile the way the product does.
 */
export function harnessForAgentId(agentId: string | null): string | null {
  if (agentId === null) return null;
  return findCatalogueAgent(agentId)?.harness ?? null;
}

/**
 * The endpoint-changing surface of each harness Hivemind knows.
 *
 * Measured from shipped artifacts on 2026-08-14, the same standard the account
 * variables were held to. A harness absent from this table is not assumed
 * safe — it is `unknown`, and `unknown` refuses.
 */
export const ENDPOINT_SURFACE: Record<
  string,
  {
    /** Environment variables that repoint the harness. */
    variables: string[];
    /** Argv flags that select a non-vendor provider. */
    flags: string[];
    /** Its own config file, relative to the home it runs against. */
    configFile: string | null;
    /** Keys in that file that carry a URL. */
    configKeys: string[];
    vendorHost: string;
  }
> = {
  claude: {
    variables: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
    flags: [],
    configFile: "settings.json",
    configKeys: ["ANTHROPIC_BASE_URL"],
    vendorHost: "api.anthropic.com"
  },
  "codex-cli": {
    variables: ["OPENAI_BASE_URL", "CODEX_BASE_URL"],
    /* `--oss` and `--local-provider` select a local backend outright. */
    flags: ["--oss", "--local-provider"],
    configFile: "config.toml",
    configKeys: ["base_url"],
    vendorHost: "api.openai.com"
  },
  opencode: {
    variables: ["OPENCODE_BASE_URL", "OPENCODE_API_KEY"],
    flags: [],
    configFile: "opencode.json",
    configKeys: ["baseURL", "base_url"],
    vendorHost: "the provider configured in OpenCode"
  }
};

/**
 * The project file a harness needs before its denial is a denial.
 *
 * Here rather than beside the code that writes it, for the reason this file
 * holds `ACCOUNT_HOME_VARIABLES` and `ENDPOINT_SURFACE`: which file a harness
 * reads its rules from is startup knowledge, and this is the file allowed to
 * know how to start a provider.
 *
 * One entry, and that is the point. Codex and Claude Code take their denial on
 * the command line where Hivemind holds it; a rule in a file somebody else can
 * edit is weaker, so a harness earns an entry here only when it offers nothing
 * stronger.
 */
export const HARNESS_PROJECT_CONFIG: Record<
  string,
  { file: string; contents: unknown; because: string }
> = {
  opencode: {
    file: "opencode.json",
    contents: {
      $schema: "https://opencode.ai/config.json",
      /* Verified against opencode 1.18.15 rather than taken from the schema:
         written into an empty directory, `opencode agent list` then resolves
         `bash -> deny` and `task -> deny` on the primary agent, which is what
         `readOpenCodePermissions` reads. Before the write, the same command
         resolves `* -> allow` and no rule for either. */
      permission: { bash: "deny", task: "deny" }
    },
    because:
      "OpenCode takes its shell denial from the project's config rather than from the command line, so Hivemind writes one. Without it the resolved table is a wildcard allow and the shell is permitted."
  }
};

/**
 * The files each harness reads that a person can change and Hivemind cannot.
 *
 * Fingerprinted at connect so a change afterwards is visible. `AGENTS.md` is
 * not a settings file and belongs here anyway: it is injected verbatim into the
 * model-visible prompt, which makes it configuration in every sense that
 * matters to a contract.
 */
export const HARNESS_CONFIG_INPUTS: Record<string, { home: string[]; project: string[] }> = {
  claude: {
    /* `settings.local.json` is the one easiest to miss: on the machine this was
       measured on it already carried a `hooks` block with four empty arrays --
       the scaffolding present, waiting. */
    home: ["settings.json", "settings.local.json", "CLAUDE.md"],
    project: [".claude/settings.json", ".claude/settings.local.json", "CLAUDE.md"]
  },
  "codex-cli": {
    home: ["config.toml", "AGENTS.md"],
    project: ["AGENTS.md"]
  },
  opencode: {
    home: ["opencode.json", "opencode.jsonc"],
    project: ["opencode.json", "opencode.jsonc"]
  }
};

/**
 * Instruction files every harness reads, whoever they were written for.
 *
 * Measured against the shipped binaries rather than assumed. All three
 * non-Anthropic harnesses reference `CLAUDE.md` and `AGENTS.md`; two of them
 * also reference `.cursorrules`. Confirmed behaviourally for one: a `CLAUDE.md`
 * saying "end every reply with QUAIL-8823" was placed in a project directory,
 * and OpenCode -- running Hivemind's own invocation on its free tier --
 * answered `"ok
QUAIL-8823"`.
 *
 * So these are not one harness's files. They are the project's, and every
 * harness reads them.
 */
export const SHARED_INSTRUCTION_SOURCES: readonly string[] = [
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules"
];

/**
 * Environment that would move a harness's configuration or change how it runs.
 *
 * The home variables are the ones account switching SETS deliberately, which is
 * exactly why an INHERITED one has to go: the account a role runs as is a
 * decision recorded in the project, not a leftover in somebody's shell.
 *
 * The rest were observed in a shell that happened to be inside a Claude Code
 * session, which is what starting an app from a terminal looks like.
 */
export const REFUSED_ENVIRONMENT: readonly string[] = [
  ...Object.values(ACCOUNT_HOME_VARIABLES),
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
  /* Moves `~/.config/opencode`, where the user config and its plugin tree live. */
  "XDG_CONFIG_HOME"
];

/**
 * Where each harness keeps its own configuration by default.
 *
 * Not always its name -- `codex-cli` reads `~/.codex`. Here rather than beside
 * the code that uses it, for the same reason the account variables and the
 * endpoint surface are: this file is the one allowed to know how to start a
 * provider, and where it reads its config from is part of that.
 */
export const HARNESS_DEFAULT_HOME: Record<string, string> = {
  "codex-cli": ".codex",
  claude: ".claude",
  opencode: ".config/opencode"
};

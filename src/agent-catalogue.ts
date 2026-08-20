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
  usage_parser: "codex-jsonl" | "codex-text" | "claude-json" | "opencode-json" | "grok-json" | "kimi-wire" | null;
  /** Whether the task prompt is written to stdin or appended to argv. */
  prompt_arg: "stdin" | "arg";
  /** Whether the desktop may offer a probe that can presently be admitted. */
  connectable: boolean;
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
  readback: "codex-rollout" | "claude-init" | "opencode-permissions" | "grok-session" | "kimi-session" | "none";
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
 * Grok Build, exercised against 1.0.4 on 2026-08-17.
 *
 * A 4.5 probe wrote its canary and persisted 10,063 tokens. Version 1.0.4 now
 * exposes the resolved model, workspace sandbox and working directory in its
 * durable session summary; `inspect --json` exposes every loaded config layer
 * plus MCP, plugin and hook state. Those are read after the run rather than
 * inferred from the flags.
 *
 * The posture matches the other three: deny the shell by ALLOWLIST rather than
 * by denylist, pin the model, refuse sub-agents, and read a documented wire
 * format rather than a bespoke one.
 *
 * The native `streaming-json` stream supplies its effective command list while
 * the durable updates file supplies completed-turn usage. Hivemind joins the
 * two by an explicit per-run session id. A corrected Grok 4.6 attempt reached
 * the service but did not finish, so 4.6 is still probeable rather than
 * promoted; the old 4.5 result is not silently transferred to the new model.
 *
 * `--dangerously-skip-permissions` and `--permission-mode bypassPermissions`
 * are Claude-compatibility aliases it also ships; `findDangerousAdapterArgs`
 * already refuses both by name, and no invocation here may carry them.
 */
function grokInvoke(model = "grok-4.6"): string[] {
  const args = [
    "--model",
    model,
    /* The shell is absent rather than denied: a positive allowlist of the
       built-in tools, which is the same shape as Claude Code's. */
    "--tools",
    "read_file,write,search_replace,list_dir,grep",
    "--deny",
    "Bash",
    "--no-subagents",
    "--no-memory",
    "--no-plan",
    "--disable-web-search",
    "--permission-mode",
    "dontAsk",
    "--allow",
    "Read",
    "--allow",
    "Write",
    "--allow",
    "Edit",
    "--allow",
    "Grep",
    "--allow",
    "Glob",
    /* An OS-level profile, not a promise. `workspace` is the narrowest profile
       that still permits the writes a worker must make. */
    "--sandbox",
    "workspace",
    "--output-format",
    "streaming-json",
    "--session-id",
    "{session_id}",
    /* `--single` takes the prompt as its value. It must be the final template
       argument so Adapter appends the prompt immediately after it. */
    "--single"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "grok.cmd", ...args]
    : ["grok", ...args];
}

function kimiInvoke(model = "kimi-code/kimi-for-coding"): string[] {
  const args = [
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--agent-file",
    ".hivemind/kimi-agent.md",
    "--prompt"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "kimi.cmd", ...args]
    : ["kimi", ...args];
}

export const agentCatalogue: CatalogueAgent[] = [
  {
    id: "codex-terra",
    label: "Codex · GPT-5.6 Terra",
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
    prompt_arg: "stdin",
    connectable: true,
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
    label: "Codex · GPT-5.6 Luna",
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
    prompt_arg: "stdin",
    connectable: true,
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
    label: "Codex · GPT-5.6 Sol",
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
    prompt_arg: "stdin",
    connectable: true,
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
    /* Probe-verified but not end-to-end proven. The checked-in profile was removed
       for carrying bypassPermissions, which is a refusal this build enforces at
       preflight -- so any profile written for it has to earn its flags again
       from scratch. Offered, but it cannot be connected until a probe passes,
       and the probe cannot pass while the usage readback is unknown. */
    id: "claude-code",
    label: "Claude Code · sonnet",
    harness: "claude",
    subscription: "Claude Pro or Max",
    status: "unverified",
    caveat:
      "A live Claude Code 2.1.233 probe verified all nine capability checks, including its model, file-only tool set, endpoint, per-model token reporting, no helper agents, and an unchanged branch. Hivemind still labels it unverified because no whole piece of work has been built, checked, and shipped through this harness. Safe mode also switches off your hooks, CLAUDE.md, skills, plugins, and MCP servers inside a Hivemind worker; that loss is deliberate because hooks are shell commands and can replace a prompt before the model reads it.",
    model: "sonnet",
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 200_000,
    timeout_ms: 900_000,
    usage_parser: "claude-json",
    prompt_arg: "stdin",
    connectable: true,
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
    label: "OpenCode · opencode/deepseek-v4-flash-free",
    harness: "opencode",
    subscription: "OpenCode's free model or a connected provider",
    status: "unverified",
    caveat:
      "A probe has been through it and it passed: it denies itself a shell and helper agents, it says so before it runs, and its token counts are read from its own output. What it does not report is which model actually answered, so Hivemind cannot send cheaper work to a cheaper model on this one. No whole piece of work has been built and shipped through it yet, which is what would make it proven.",
    model: "opencode/deepseek-v4-flash-free",
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 200_000,
    timeout_ms: 900_000,
    usage_parser: "opencode-json",
    prompt_arg: "stdin",
    connectable: true,
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
    status: "supported",
    caveat: null,
    model: "grok-4.6",
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 500_000,
    timeout_ms: 900_000,
    /* Native stream plus durable-session parser. A completed paid 4.6 probe on
       2026-08-17 verified all nine capabilities and reported 15,112 tokens;
       absence of a usage record still fails the probe closed. */
    usage_parser: "grok-json",
    prompt_arg: "arg",
    connectable: true,
    readback: "grok-session",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "runtime-readback",
      detail:
        "The native stream reports the resolved tool list. Hivemind requires the five file tools, the two inert MCP dispatchers only when `grok inspect` reports no MCP servers, and no terminal or agent-spawn tool; the session summary separately reports the resolved workspace sandbox.",
    },
    /* Kept probeable so the missing readbacks can be re-tested when the CLI or
       Core changes. A failed probe records nothing in the project. */
    invoke: grokInvoke()
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    harness: "kimi",
    subscription: "a Kimi account or a Moonshot API key",
    status: "unverified",
    caveat:
      "Kimi 0.36.1 now receives only Hivemind's project-bounded file server: its unsafe built-in file tools, shell, and helper agents are denied, and any other account-level MCP server causes a pre-launch refusal. It remains unverified until a hosted provider run confirms the exact runtime tool snapshot and real quota reporting; consumer Codex or Claude subscriptions cannot supply that provider credential.",
    model: "kimi-code/kimi-for-coding",
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 256_000,
    timeout_ms: 900_000,
    usage_parser: "kimi-wire",
    prompt_arg: "arg",
    connectable: true,
    readback: "kimi-session",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "runtime-readback",
      detail:
        "A launch-specific agent file allows only Hivemind's five project-bounded MCP file tools and denies Kimi's built-in file tools, shell, and helper agents. The session's profile and tool snapshot must report that exact set, while adapter startup refuses any additional account-level MCP server.",
    },
    invoke: kimiInvoke()
  }
];

const DISCOVERED_AGENT_PREFIX = "detected-model-";

/** A model id is data passed as one argv value, never executable syntax. */
export function validDiscoveredModelSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(slug);
}

function discoveredAgentId(providerId: string, slug: string): string {
  return `${DISCOVERED_AGENT_PREFIX}${Buffer.from(JSON.stringify([providerId, slug]), "utf8").toString("base64url")}`;
}

function decodedDiscoveredAgentId(id: string): { providerId: string; slug: string } | null {
  if (!id.startsWith(DISCOVERED_AGENT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(id.slice(DISCOVERED_AGENT_PREFIX.length), "base64url").toString("utf8")
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [providerId, slug] = parsed;
    return typeof providerId === "string" &&
      typeof slug === "string" &&
      MODEL_DISCOVERY_SPECS[providerId] !== undefined &&
      validDiscoveredModelSlug(slug)
      ? { providerId, slug }
      : null;
  } catch {
    return null;
  }
}

function invocationForDiscoveredModel(providerId: string, slug: string): string[] | null {
  switch (providerId) {
    case "codex-cli":
      return codexInvoke(slug);
    case "claude":
      return claudeInvoke(slug);
    case "opencode":
      return openCodeInvoke(slug);
    case "grok":
      return grokInvoke(slug);
    case "kimi":
      return kimiInvoke(slug);
    default:
      return null;
  }
}

/**
 * Build the same bounded profile shape for a slug the installed CLI published.
 *
 * A previously catalogued pair keeps its stable id and measured routing facts.
 * A newly detected pair gets conservative metadata: standard rather than
 * strong/cheap, and a 100K context ceiling. That can make it ineligible for
 * risky work or stop early; it cannot silently grant the model a stronger or
 * cheaper routing claim nobody measured.
 */
export function catalogueAgentForDiscoveredModel(
  providerId: string,
  slug: string
): CatalogueAgent | null {
  if (MODEL_DISCOVERY_SPECS[providerId] === undefined || !validDiscoveredModelSlug(slug)) {
    return null;
  }
  const known = agentCatalogue.find(
    (agent) => agent.harness === providerId && agent.model === slug
  );
  if (known !== undefined) return known;
  const base = agentCatalogue.find(
    (agent) => agent.harness === providerId && agent.connectable && agent.invoke !== null
  );
  const invoke = invocationForDiscoveredModel(providerId, slug);
  if (base === undefined || invoke === null) return null;
  return {
    ...base,
    id: discoveredAgentId(providerId, slug),
    label: `${PROVIDER_LABELS[providerId] ?? base.label} · ${slug}`,
    model: slug,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: Math.min(base.context_window, 100_000),
    invoke
  };
}

export function findCatalogueAgent(id: string): CatalogueAgent | null {
  const known = agentCatalogue.find((agent) => agent.id === id);
  if (known !== undefined) return known;
  const decoded = decodedDiscoveredAgentId(id);
  return decoded === null
    ? null
    : catalogueAgentForDiscoveredModel(decoded.providerId, decoded.slug);
}

/* ── Providers and models, which is what a person actually chooses ──────────
 *
 * A catalogue entry is one (PROVIDER x MODEL) pair, because that pair is the
 * unit `adapter.connect` probes and writes a profile for. That is correct as a
 * connect unit and wrong as a question to ask somebody. It once produced three
 * Codex rows labelled with Hivemind's internal routing tiers even though they
 * were one provider. That vocabulary is no part of what the person decides.
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
  /** Whether at least one catalogue entry has a complete, probeable argv. */
  connectable: boolean;
  /**
   * The provider-owned sign-in flow Hivemind may launch.
   *
   * This deliberately carries no status reader and no credential location.
   * The provider CLI and the browser remain the only credential owners;
   * Hivemind merely starts this fixed command in a separate terminal.
   */
  authentication: {
    experience: "browser" | "interactive" | "device_code";
    detail: string;
  };
}

/**
 * How the installed harness publishes the model names it can be asked to run.
 *
 * The commands live beside the provider invocations for the same reason the
 * sign-in commands do: this is provider knowledge, while `model-discovery.ts`
 * is only the bounded mechanism that runs and parses one of these shapes.
 * None of these commands starts a model turn or consumes model tokens.
 */
export type ModelDiscoverySpec =
  | {
      kind: "app-server";
      invocation: readonly [string, ...string[]];
      source: string;
      emptyDetail?: string;
    }
  | {
      kind: "help-aliases" | "line-list" | "headed-list" | "alias-config";
      invocation: readonly [string, ...string[]];
      source: string;
      emptyDetail?: string;
    };

export interface ProviderAuthentication {
  experience: CatalogueProvider["authentication"]["experience"];
  detail: string;
  /** Fixed provider-owned argv. No caller-supplied token reaches this array. */
  command: readonly [string, ...string[]];
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

/* Authentication belongs beside invocation because both are provider-specific
   executable knowledge. The command is intentionally fixed: the audited
   action accepts only a provider id and cannot turn this into a general shell.

   These flows own their own browser/device interaction and credential store.
   Hivemind does not inspect their login status afterwards; the capability
   probe remains the only evidence that a provider can actually run here. */
const PROVIDER_AUTHENTICATION: Record<string, ProviderAuthentication> = {
  "codex-cli": {
    command: [process.platform === "win32" ? "codex.cmd" : "codex", "login"],
    experience: "browser",
    detail: "Codex opens its ChatGPT sign-in in your browser. Finish there, then return to Hivemind and run the check."
  },
  claude: {
    command: [process.platform === "win32" ? "claude.cmd" : "claude", "auth", "login"],
    experience: "browser",
    detail: "Claude Code opens its own account sign-in. Finish there, then return to Hivemind and run the check."
  },
  opencode: {
    command: [process.platform === "win32" ? "opencode.cmd" : "opencode", "auth", "login"],
    experience: "interactive",
    detail: "OpenCode asks which model provider to use in its own terminal and stores that provider's credential itself."
  },
  grok: {
    command: [process.platform === "win32" ? "grok.cmd" : "grok", "login", "--oauth"],
    experience: "browser",
    detail: "Grok opens X.AI's OAuth sign-in in your browser. Finish there, then return to Hivemind and run the check."
  },
  kimi: {
    command: [process.platform === "win32" ? "kimi.cmd" : "kimi", "login"],
    experience: "device_code",
    detail: "Kimi starts its device-code sign-in in a separate terminal. The code and confirmation remain between Kimi and your browser."
  }
};

function readOnlyCliInvocation(
  executable: string,
  args: readonly string[]
): readonly [string, ...string[]] {
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", `${executable}.cmd`, ...args]
    : [executable, ...args];
}

/**
 * No-cost model discovery supported by each installed harness.
 *
 * These are deliberately the provider's own list/help surfaces. Hivemind does
 * not read an auth file or scrape a credential directory, and none starts a
 * model turn. The mechanism independently bounds runtime and output before it
 * trusts any returned slug.
 */
export const MODEL_DISCOVERY_SPECS: Record<string, ModelDiscoverySpec> = {
  "codex-cli": {
    kind: "app-server",
    invocation: readOnlyCliInvocation("codex", ["app-server", "--stdio"]),
    source: "Codex model/list for the selected ChatGPT account"
  },
  claude: {
    kind: "help-aliases",
    invocation: readOnlyCliInvocation("claude", ["--help"]),
    source: "Aliases advertised by the installed Claude Code CLI"
  },
  opencode: {
    kind: "line-list",
    invocation: readOnlyCliInvocation("opencode", ["models"]),
    source: "OpenCode models for its configured providers"
  },
  grok: {
    kind: "headed-list",
    invocation: readOnlyCliInvocation("grok", ["models"]),
    source: "Grok models for the selected X.AI account"
  },
  kimi: {
    kind: "alias-config",
    invocation: readOnlyCliInvocation("kimi", ["provider", "list", "--json"]),
    source: "Models configured in the installed Kimi Code CLI",
    emptyDetail: "Kimi Code has no configured model aliases yet. Add a provider in Kimi, then refresh this list."
  }
};

export function providerAuthentication(providerId: string): ProviderAuthentication | null {
  return PROVIDER_AUTHENTICATION[providerId] ?? null;
}

function providerAuthenticationPresentation(
  providerId: string
): CatalogueProvider["authentication"] {
  const authentication = providerAuthentication(providerId);
  if (authentication === null) {
    /* A provider with no sign-in flow would put a dead button on first run.
       This is catalogue corruption, not a state the client can repair. */
    throw new Error(`provider ${providerId} has no authentication flow`);
  }
  return {
    experience: authentication.experience,
    detail: authentication.detail
  };
}

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
        pins_model: agent.model !== null,
        connectable: agent.connectable,
        authentication: providerAuthenticationPresentation(agent.harness)
      });
      continue;
    }
    existing.status = bestStatus(existing.status, agent.status);
    existing.pins_model = existing.pins_model || agent.model !== null;
    existing.connectable = existing.connectable || agent.connectable;
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
  opencode: "OPENCODE_CONFIG_DIR",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME"
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
    /** Ask the harness which layered config files it actually resolved. */
    inspection?: "resolved-layers";
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
  },
  grok: {
    variables: ["XAI_API_KEY"],
    flags: [],
    configFile: null,
    configKeys: ["base_url"],
    inspection: "resolved-layers",
    vendorHost: "cli-chat-proxy.grok.com"
  },
  kimi: {
    variables: ["KIMI_MODEL_BASE_URL"],
    flags: [],
    configFile: "config.toml",
    configKeys: ["base_url"],
    vendorHost: "api.kimi.com"
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
  },
  kimi: {
    file: ".hivemind/kimi-agent.md",
    contents: `---
name: hivemind-worker
description: File-only worker governed by Hivemind
tools:
  - mcp__hivemind_files__read_file
  - mcp__hivemind_files__write_file
  - mcp__hivemind_files__replace_in_file
  - mcp__hivemind_files__list_files
  - mcp__hivemind_files__search_files
disallowedTools:
  - Bash
  - Agent
  - AgentSwarm
  - Read
  - Write
  - Edit
  - Grep
  - Glob
subagents: []
---

\${base_prompt}
`,
    because:
      "Kimi takes its launch-specific tool and sub-agent boundary from an agent file. Hivemind writes a profile that exposes only its project-bounded MCP file server and explicitly denies Kimi's built-in file, shell, and helper-agent tools."
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
  },
  kimi: {
    /* `mcp.json` is executable configuration: changing it can start another
       command before the model answers. The project agent file is the second
       half of the same boundary and must stale the verdict if edited. */
    home: ["config.toml", "mcp.json"],
    project: [".hivemind/kimi-agent.md"]
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
  opencode: ".config/opencode",
  grok: ".grok",
  kimi: ".kimi-code"
};

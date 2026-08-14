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
 * own `opencode.json`, which `project.init` writes. That is why this agent's
 * readback reads the resolved table rather than the run: the rule lives in
 * config, so config is where it has to be confirmed.
 *
 * `--format json` streams events; every `step_finish` carries its own token
 * block, which is where the usage reader looks. Deliberately NOT `--auto`,
 * whose own help calls it "dangerous!" -- with the shell and helper agents
 * denied there is nothing left that needs blanket approval.
 */
function openCodeInvoke(model = "opencode/deepseek-v4-flash-free"): string[] {
  const args = ["run", "--format", "json", "--model", model];
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
      "Its token reporting has only ever been checked against recorded output, never against a live run, and the profile it used to ship with carried a permission-bypass flag this build refuses. Connecting it runs the same probe as any other agent; anything the probe cannot confirm is reported as unverified rather than assumed.",
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

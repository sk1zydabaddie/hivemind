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
  usage_parser: "codex-jsonl" | "codex-text" | "claude-json" | null;
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
  readback: "codex-rollout" | "none";
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
        "Codex has no tool-level deny, so its boundary is the OS sandbox instead -- and it is the one harness here that reports the sandbox it resolved, which is why it is also the one that keeps its shell.",
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
        "Codex has no tool-level deny, so its boundary is the OS sandbox instead -- and it is the one harness here that reports the sandbox it resolved, which is why it is also the one that keeps its shell.",
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
        "Codex has no tool-level deny, so its boundary is the OS sandbox instead -- and it is the one harness here that reports the sandbox it resolved, which is why it is also the one that keeps its shell.",
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
    readback: "none",
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
    status: "unsupported",
    caveat:
      "It can be told to deny itself a shell and helper agents, and it will print the settings it resolved without being run -- which is more than any other agent here offers for free. What is missing is the reading of what it spends, because no run has ever gone through it, so nothing yet knows where its token counts appear. Connecting it runs the same probe as any other agent.",
    model: null,
    routing_tier: "standard",
    cost_rank: 10,
    context_window: 200_000,
    timeout_ms: 900_000,
    usage_parser: null,
    readback: "none",
    shell_denial: {
      mechanism: "config-deny",
      confirmed_by: "resolved-config",
      detail:
        "`permission.bash: \"deny\"` in the project's own config. `opencode agent list` prints the resolved table for free and shows the rule landing on every agent -- but the print does not establish which rule WINS, so the denial is corroborated by a run that is told to use a shell and does not.",
    },
    invoke: null
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
    usage_parser: null,
    readback: "none",
    shell_denial: {
      mechanism: "tool-allowlist",
      confirmed_by: "unconfirmed",
      detail:
        "`--tools` allows exactly the built-in tools named and `--no-subagents` turns off helper agents. Nothing is known about whether either is reported back, because reading its version is free and running it is not.",
    },
    invoke: null
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

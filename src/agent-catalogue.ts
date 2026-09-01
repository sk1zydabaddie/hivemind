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
  usage_parser: "codex-jsonl" | "codex-text" | "claude-json" | "opencode-json" | "grok-json" | null;
  /** Whether the task prompt is written to stdin or appended to argv. */
  prompt_arg: "stdin" | "arg" | "file";
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
  readback: "codex-rollout" | "claude-init" | "opencode-permissions" | "grok-session" | "none";
  /** Argv template. `{cwd}` is replaced with the project root at connect time. */
  invoke: string[] | null;
}

/* Windows spawns the CLI through cmd.exe because some installed entry points
   are .cmd shims. The command itself deliberately has no extension: cmd's
   PATHEXT resolution then accepts either a shim or a vendor .exe. */
/**
 * WHY THERE ARE NO `-c` OVERRIDES HERE ANY MORE. Measured 2026-08-23.
 *
 * This function used to carry three: `model_reasoning_effort="high"`,
 * `approval_policy="never"` and `notify=[]`. All three are gone, because the
 * `-c` form was measured INERT for this binary, and the way it failed is the
 * most dangerous shape a setting can have:
 *
 *   `-c model_reasoning_effort=low` was accepted by argv, reported as applied
 *   by `codex doctor`, and echoed as "low" in the JSON stream -- while
 *   producing 30x the reasoning tokens of the form that genuinely applies.
 *   Three independent readbacks agreed on a setting that was not in effect.
 *
 * So the rule this file already stated for flags now has a second half: a
 * readback confirms what the harness BELIEVES it resolved, not what it
 * applied. Behaviour is the only ground truth. Note what that costs us here:
 * we deliberately do NOT add an effort readback, because this rollout echoes
 * the request, so comparing them would manufacture a "verified" verdict for a
 * setting nothing has confirmed.
 *
 * MEASURED 2026-08-23, and it settles the per-key question this comment used to
 * leave open: `-c notify=[...]` DOES override the user's config on this path.
 * A canary program was passed through `-c notify` and it fired, receiving
 * codex's own `agent-turn-complete` payload, while the user's two-program chain
 * did not run. The same turn also proved the other half of the inference this
 * project had only ever read off a config file: notify DOES fire on
 * `codex exec`, so a worker really was executing two external programs per
 * turn. One turn, 21,137 input / 5 output tokens.
 *
 * So the `-c` form is per-key and now has three measured entries rather than
 * two: `sandbox_mode` works, `notify` works, `model_reasoning_effort` is inert.
 * That is why `notify=[]` is passed below and effort is not, and why the test
 * that forbids `-c` is written per key instead of as a blanket ban.
 *
 * What replaces each one:
 *
 * - EFFORT: nothing. `codex exec` has no effort flag (checked against the
 *   shipped 0.147.0 help: only `-c` and `--profile`), so a Hivemind worker
 *   runs at whatever effort Codex resolves for itself. This costs nothing
 *   measurable -- effort spans ~1.04x total cost because reasoning is 0.4-2.5%
 *   of a cached-input-dominated call -- but it does mean the depth of a worker
 *   turn is not ours to choose yet. The candidate mechanism is the form that
 *   was measured to work: `--profile <name>`, which layers
 *   `$CODEX_HOME/<name>.config.toml`. It is deliberately unimplemented until a
 *   monotonic reasoning-token gradient across low/medium/high proves it,
 *   because implementing it on this evidence would repeat exactly the mistake
 *   above. Corollary worth knowing: every past measurement labelled "pinned
 *   high", the 212K corpus call included, was actually taken at Codex's own
 *   default.
 * - APPROVAL POLICY: nothing, and nothing real is lost. The claim rested on
 *   `codex doctor` reporting `OnRequest` for an override -- the discredited
 *   evidence class. In a non-interactive `exec` run there is nobody to answer
 *   a prompt, and the boundary that actually holds is `--sandbox
 *   workspace-write`, which is proved behaviourally by a canary write rather
 *   than by anyone's report.
 * - NOTIFY: neutralised per spawn, which is what the measurement licenses.
 *   `notify` is a program path Codex runs on turn events; on this machine it
 *   held two chained entries, one written by OpenAI's own installer. Hivemind
 *   passes `notify=[]` so a worker runs neither, and does NOT touch the user's
 *   config to do it.
 *
 *   This replaced a connect-time REFUSAL, which was the wrong shape twice
 *   over: it blocked every Codex model on every project for a machine-wide
 *   setting, and the remedy it offered was hand-editing a file on the one flow
 *   that is supposed to need no terminal. A refusal is right when nothing can
 *   be done; here something could.
 *
 *   The residual, stated: what was observed is that OUR value replaces theirs.
 *   An empty array is the same mechanism carrying nothing, which is a short
 *   inference rather than a second observation -- there is no artifact to watch
 *   for when the correct behaviour is that no program runs.
 */
function codexInvoke(model: string): string[] {
  const args = [
    "exec",
    "--model",
    model,
    "--sandbox",
    "workspace-write",
    /* Measured to apply, unlike the effort key: see the comment above. */
    "-c",
    "notify=[]",
    "--ephemeral",
    "--json",
    "-"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "codex", ...args]
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
    ? ["cmd.exe", "/d", "/s", "/c", "claude", ...args]
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
    ? ["cmd.exe", "/d", "/s", "/c", "opencode", ...args]
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
    /* Windows limits the full command line to roughly 32K characters, while a
       scoped worker contract can legitimately exceed that. Grok owns this
       non-interactive file-input flag, and Adapter creates then removes the
       one-run file inside the confined worktree. */
    "--prompt-file",
    "{prompt_file}"
  ];
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "grok", ...args]
    : ["grok", ...args];
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
    id: "claude-opus",
    label: "Claude Code · opus",
    harness: "claude",
    subscription: "Claude Pro or Max",
    status: "unverified",
    caveat:
      "A live Claude Code 2.1.233 probe verified all nine capability checks, including its model, file-only tool set, endpoint, per-model token reporting, no helper agents, and an unchanged branch. Hivemind still labels it unverified because no whole piece of work has been built, checked, and shipped through this harness. Safe mode also switches off your hooks, CLAUDE.md, skills, plugins, MCP servers, and custom agents inside a Hivemind worker; that loss is deliberate because hooks are shell commands and can replace a prompt before the model reads it.",
    model: "opus",
    routing_tier: "strong",
    cost_rank: 20,
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
        "`--tools` is a positive allowlist of built-in tools, so the shell is absent rather than denied. Confirmed by the tools array the run reports at startup -- which is why this cannot be claimed until one real run has been read."
    },
    invoke: claudeInvoke("opus")
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
    prompt_arg: "file",
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
   * Which of the two support claims this harness may make. They are different
   * claims and the screen must not blur them: `integrated` is "probed here,
   * with routing and spend economics driven by its own answers"; `multiplier`
   * is "the gates hold and spending limits hold in tokens, while tier
   * routing, cost prediction and model provenance are honestly off, because
   * the model behind it cannot be confirmed."
   */
  support_tier: SupportTier;
  /** The claim itself, one sentence, written once here rather than per surface. */
  tier_claim: string;
  /** The vendor's documented install command, offered — never run. Null when unrecorded. */
  install: ProviderInstallGuidance | null;
  /**
   * For a multiplier: every inner provider it is known to reach, with each
   * one's recorded sanction — prohibited entries included, rendered as the
   * refusals they are. Empty on integrated harnesses.
   */
  reachable_providers: InnerProviderStanding[];
  /**
   * The provider-owned sign-in flow Hivemind may launch.
   *
   * This deliberately carries no credential location. The provider CLI and
   * browser remain the only credential owners; Hivemind merely starts this
   * fixed command in a separate terminal. Read-only status commands are kept
   * separately so none of their raw output becomes presentation data.
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

/**
 * A provider-owned, read-only command that reports login standing without
 * returning a credential or starting a model turn. Some CLIs do not publish
 * such a command; those remain `unknown` until a capability probe succeeds.
 */
export interface ProviderAuthenticationStatusSpec {
  kind: "login-text" | "logged-in-json" | "credential-count" | "headed-model-list";
  invocation: readonly [string, ...string[]];
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
  /**
   * For a multiplier harness, whose service this slug's requests go to, and
   * whether that vendor sanctions being reached this way. Null on integrated
   * harnesses, where the harness and the vendor are the same party.
   */
  inner_provider: InnerProviderStanding | null;
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
    agent_id: "claude-opus",
    why: "Planning is where a weaker model costs the most: every task inherits the plan's mistakes, and a bad split is paid for again by each worker under it.",
    reviewed: "2026-08-21"
  },
  {
    role: "manager",
    agent_id: "claude-code",
    why: "The manager decides what to do when something unexpected happens. It reasons over a small, well-described situation, which is the shape a mid-tier model handles well.",
    reviewed: "2026-08-21"
  },
  /* TWO workers, and the reason the previous ONE was wrong is a run-stopper
     rather than a preference.
     
     The old note here argued for a single worker to keep first-run probe cost
     down, and left the pool to be grown later. What it missed: the tier floor
     REFUSES rather than downgrades. `initProject`'s default globs put
     `package.json`, `tsconfig.json` and any dot-config file in High, and the
     CI, infra and auth directories in Critical, and anything no glob covers
     falls back to High -- and High and Critical both require a `strong`
     provider. (Written without the glob syntax on purpose: the patterns
     contain the sequence that ends a block comment, which silently truncated
     this comment into code the first time.) The
     single recommended worker was `grok-build`, which is `standard`. So the
     setup the product itself suggested could not run a task that touched
     `package.json`: routing returned "no eligible provider available" and the
     run stopped. Adding a dependency is not an exotic task.
     
     So the recommended pool now SPANS the tiers, which is also what makes the
     Medium floor fix worth anything -- routing can only choose cheap when a
     cheap member exists:
     
       - Low and Medium  -> codex-luna (cheap, cost_rank 4)
       - High and Critical -> codex-sol (strong, cost_rank 20)
     
     Measured 2026-08-23: model choice spans 3.9x effective rate (codex-terra
     runs 5.1x codex-luna at equal effort) while reasoning effort spans ~1.04x,
     so WHICH model serves a tier is the whole cost decision and effort is not
     part of it.
     
     The strong member is `claude-opus` rather than `codex-sol`, deliberately
     and for two reasons. It keeps this a MIXED-PROVIDER setup, which the
     previous single-worker line was reviewed as and which a Codex-only pool
     would have quietly ended. And it needs no subscription the advice does not
     already assume: `claude-opus` is the planner recommendation, while
     `codex-sol` would have added a ChatGPT Pro or Business requirement that
     nothing else here needs. State the cost honestly: Claude Code has not yet
     had a whole piece of work shipped through it AS A WORKER, so the strong
     member is the less-proven half of this pair. `grok-build` -- proven as a
     worker on a shipped run -- is the standard-tier alternative and a sound
     third member for redundancy when one provider hits a quota wall; it is not
     included here because it adds no tier COVERAGE, and coverage is what the
     floor demands. */
  {
    role: "worker",
    agent_id: "claude-opus",
    why: "The worker for High and Critical work -- config files, CI, anything touching auth -- because those tiers require a strong provider and refuse rather than downgrade, so a pool without one cannot run them at all.",
    reviewed: "2026-08-23"
  },
  {
    role: "worker",
    agent_id: "codex-luna",
    why: "The worker for routine source and docs work, which is most of a project. Measured at about a fifth the effective rate of the standard model for the same reasoning effort, and the tier floor keeps it away from risky paths.",
    reviewed: "2026-08-23"
  }
];

/** Human labels for a harness. The entry labels name the pair, not the tool. */
const PROVIDER_LABELS: Record<string, string> = {
  /* The harness id is `codex-cli`, not `codex` -- the same distinction that
     made `profile.tool` look like a harness when it was a role. */
  "codex-cli": "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  grok: "Grok Build"
};

/**
 * Documented per-user Windows CLI locations that are not reliably inherited
 * by a desktop-launched process. This belongs in the catalogue with the argv:
 * both are provider-specific executable knowledge, and the rest of Core must
 * remain provider-neutral.
 */
export const WINDOWS_PROVIDER_BIN_ENVIRONMENT: ReadonlyArray<{
  variable: string;
  suffix?: readonly string[];
}> = [
  { variable: "OPENCODE_INSTALL_DIR" },
  { variable: "GROK_BIN_DIR" }
];

export const WINDOWS_PROVIDER_EXECUTABLE_LOCATIONS: ReadonlyArray<{
  root: "user" | "local";
  segments: readonly string[];
  nestedExecutable?: string;
}> = [
  { root: "user", segments: [".opencode", "bin"] },
  { root: "user", segments: [".grok", "bin"] },
  {
    root: "local",
    segments: ["OpenAI", "Codex", "bin"],
    nestedExecutable: "codex.exe"
  }
];

/* Authentication belongs beside invocation because both are provider-specific
   executable knowledge. The command is intentionally fixed: the audited
   action accepts only a provider id and cannot turn this into a general shell.

   These flows own their own browser/device interaction and credential store.
   Where a CLI publishes a no-cost status command Hivemind may ask it for the
   boolean standing afterwards; the capability probe remains the only evidence
   that the provider can actually satisfy Hivemind's runtime contract. */
const PROVIDER_AUTHENTICATION: Record<string, ProviderAuthentication> = {
  "codex-cli": {
    command: ["codex", "login"],
    experience: "browser",
    detail: "Codex opens its ChatGPT sign-in in your browser. Finish there, then return to Hivemind and run the check."
  },
  claude: {
    command: ["claude", "auth", "login"],
    experience: "browser",
    detail: "Claude Code opens its own account sign-in. Finish there, then return to Hivemind and run the check."
  },
  opencode: {
    command: ["opencode", "auth", "login"],
    experience: "interactive",
    detail: "OpenCode asks which model provider to use in its own terminal and stores that provider's credential itself."
  },
  grok: {
    command: ["grok", "login", "--oauth"],
    experience: "browser",
    detail: "Grok opens X.AI's OAuth sign-in in your browser. Finish there, then return to Hivemind and run the check."
  }
};

function readOnlyCliInvocation(
  executable: string,
  args: readonly string[]
): readonly [string, ...string[]] {
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", executable, ...args]
    : [executable, ...args];
}

export const PROVIDER_AUTHENTICATION_STATUS_SPECS: Record<
  string,
  ProviderAuthenticationStatusSpec
> = {
  "codex-cli": {
    kind: "login-text",
    invocation: readOnlyCliInvocation("codex", ["login", "status"])
  },
  claude: {
    kind: "logged-in-json",
    invocation: readOnlyCliInvocation("claude", ["auth", "status", "--json"])
  },
  opencode: {
    kind: "credential-count",
    invocation: readOnlyCliInvocation("opencode", ["auth", "list"])
  },
  grok: {
    kind: "headed-model-list",
    invocation: readOnlyCliInvocation("grok", ["models"])
  }
};

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
  }
};

export function providerAuthentication(providerId: string): ProviderAuthentication | null {
  return PROVIDER_AUTHENTICATION[providerId] ?? null;
}

/**
 * The vendor's own documented install command, offered — never run.
 *
 * The provenance rule, applied: Hivemind does not download or execute another
 * vendor's installer. It shows the command the vendor documents, with the
 * page it was read from and the date, and the person runs it themselves in
 * their own terminal. The command below is the one OpenCode's own docs publish.
 */
export interface ProviderInstallGuidance {
  /** The vendor's documentation page the command was read from. */
  url: string;
  /** The documented command, verbatim, for the person to run themselves. */
  command: string;
  detail: string;
  checked: string;
}

const PROVIDER_INSTALL: Record<string, ProviderInstallGuidance> = {
  opencode: {
    url: "https://opencode.ai/docs",
    command: "npm install -g opencode-ai",
    detail:
      "OpenCode's own documented install command (their package, their docs). Run it yourself in a terminal — Hivemind does not install other vendors' software — then come back here.",
    checked: "2026-08-23"
  }
};

export function providerInstallGuidance(providerId: string): ProviderInstallGuidance | null {
  return PROVIDER_INSTALL[providerId] ?? null;
}

/**
 * Every inner provider a multiplier harness is known to reach, prohibited
 * ones included — a refusal that is hidden is indistinguishable from an
 * omission, and the surface renders it AS a refusal, by name.
 */
export function reachableInnerProviders(harness: string): InnerProviderStanding[] {
  return MULTIPLIER_HARNESSES.has(harness) ? [...INNER_PROVIDER_SANCTIONS] : [];
}

export interface InnerAuthentication {
  ok: true;
  command: readonly [string, ...string[]];
  standing: InnerProviderStanding;
  experience: ProviderAuthentication["experience"];
  detail: string;
}

/**
 * The provider-preselected sign-in for a multiplier harness.
 *
 * Measured on opencode 1.18.15: `auth login -p <provider>` skips the provider
 * selection while every prompt — method choice, browser consent, any key
 * paste — stays inside the harness's own terminal. The composed argv is the
 * fixed base command plus `-p <registry id>`: the id comes from the sanction
 * registry allowlist, never from caller text, so this cannot become a
 * general argument channel. Prohibited refuses by name; an id the registry
 * does not know refuses too — the person can still use the harness's own
 * interactive picker, which is the honest fallback for a provider Hivemind
 * cannot vouch for either way.
 */
export function providerAuthenticationForInner(
  providerId: string,
  innerProviderId: string
): InnerAuthentication | { ok: false; reason: string } {
  if (!MULTIPLIER_HARNESSES.has(providerId)) {
    return { ok: false, reason: `${PROVIDER_LABELS[providerId] ?? providerId} is not a multiplier harness, so it has no inner provider to sign in to` };
  }
  const base = PROVIDER_AUTHENTICATION[providerId];
  if (base === undefined) {
    return { ok: false, reason: `${providerId} has no sign-in flow Hivemind may launch` };
  }
  const standing = innerProviderStanding(innerProviderId);
  const recorded = INNER_PROVIDER_SANCTIONS.some((entry) => entry.id === standing.id);
  if (!recorded) {
    return {
      ok: false,
      reason: `Hivemind does not know the provider "${innerProviderId}", so it will not preselect it. Use the provider list inside ${PROVIDER_LABELS[providerId] ?? providerId}'s own sign-in instead.`
    };
  }
  if (standing.sanction === "prohibited") {
    return {
      ok: false,
      reason: `${standing.label} cannot be reached through ${PROVIDER_LABELS[providerId] ?? providerId}: ${standing.why}`
    };
  }
  return {
    ok: true,
    command: [...base.command, "-p", standing.id] as unknown as readonly [string, ...string[]],
    standing,
    experience: standing.access === "oauth" ? "browser" : base.experience,
    detail:
      standing.access === "api_key"
        ? `${standing.label} uses an API key. ${PROVIDER_LABELS[providerId] ?? providerId} asks for it in its own window — paste it there, never into Hivemind.`
        : `${PROVIDER_LABELS[providerId] ?? providerId} opens ${standing.label}'s own sign-in. Finish there, then return to Hivemind.`
  };
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

/* ── The multiplier tier ─────────────────────────────────────────────────
 *
 * Two support claims, kept apart on purpose. An INTEGRATED harness was probed
 * here and its economics work: routing, spend and attribution are driven by
 * its own answers. A MULTIPLIER harness is a verified cage around providers
 * Hivemind never integrated -- OpenCode reaches whatever its user signed it
 * into -- so the gates hold and token ceilings hold, while tier routing, cost
 * prediction and model provenance are honestly off, because nothing reports
 * which model actually answered (`readOpenCodePermissions` records the pin as
 * unverified for exactly that reason).
 *
 * The inner-provider table below is the compliance half of that claim. It
 * records, per vendor a multiplier can front, whether that vendor sanctions
 * being reached through a third-party harness -- with the source and the date
 * it was checked, because these positions have changed inside a year and a
 * sanction nobody dated is a sanction nobody can re-check. `unchecked` is the
 * honest default: it means "documented by the harness, never verified by us",
 * and the surface says so before anyone picks it.
 */

export type SupportTier = "integrated" | "multiplier";

export const TIER_CLAIMS: Record<SupportTier, string> = {
  integrated:
    "Integrated: probed here, and its economics work — routing, spending limits and per-model attribution are driven by the harness's own answers.",
  multiplier:
    "Supported via multiplier: the gates hold — confined writes, no shell, nothing committed, spending limits in tokens — while tier routing, cost prediction and model provenance are off, because the model behind it cannot be confirmed."
};

/** The harnesses whose job is reaching providers Hivemind never integrated. */
const MULTIPLIER_HARNESSES: ReadonlySet<string> = new Set(["opencode"]);

export function supportTierForHarness(harness: string): SupportTier {
  return MULTIPLIER_HARNESSES.has(harness) ? "multiplier" : "integrated";
}

export type InnerProviderSanction = "blessed" | "prohibited" | "unchecked";

export interface InnerProviderStanding {
  /** The slug's first path segment, lowercased: `openai/gpt-x` -> `openai`. */
  id: string;
  label: string;
  sanction: InnerProviderSanction;
  /** The evidence, with its primary source, written for a person. */
  why: string;
  /** When the sanction was last checked against the vendor's own words. */
  checked: string;
  /**
   * How the vendor's sign-in reaches the multiplier: an OAuth flow that
   * finishes in a browser, or an API key pasted into the HARNESS's own
   * terminal. Decides the instruction a person is shown, never a mechanism —
   * either way the credential stays with the harness and its vendor.
   */
  access: "oauth" | "api_key" | "unknown";
}

/**
 * What each vendor says about being reached through a third-party harness.
 *
 * Measured against primary sources on 2026-08-22 (see
 * docs/PROVIDER-DISCOVERY.md for the full compliance read). The slug grammar
 * matters: `openrouter/anthropic/claude-*` is OPENROUTER's API-key credential
 * reselling Anthropic models under OpenRouter's own commercial terms -- the
 * inner provider is the first segment, never the model's author.
 */
const INNER_PROVIDER_SANCTIONS: readonly InnerProviderStanding[] = [
  {
    id: "opencode",
    label: "OpenCode Zen",
    sanction: "blessed",
    why: "OpenCode's own hosted models, on OpenCode's own service and terms.",
    checked: "2026-08-22",
    /* Measured from OpenCode's own docs: /connect issues a key at
       opencode.ai/auth that is pasted into OpenCode's terminal. */
    access: "api_key"
  },
  {
    id: "openai",
    label: "OpenAI",
    sanction: "blessed",
    why: "OpenAI's Codex lead has said on the record, twice in 2026, that using a ChatGPT subscription through OSS clients — OpenCode named — is supported; the line they enforce is reselling subscription traffic as API access, which this is not.",
    checked: "2026-08-22",
    access: "oauth"
  },
  {
    id: "xai",
    label: "xAI",
    sanction: "blessed",
    why: "xAI ships a device-code OAuth flow with its own consent screen for third-party clients, and documents headless operation of its own CLI.",
    checked: "2026-08-22",
    access: "oauth"
  },
  {
    id: "moonshot",
    label: "Moonshot AI",
    sanction: "blessed",
    why: "Moonshot subscriptions issue API keys expressly for third-party tools, with named setup guides; the one stated violation is tampering with a client's identity, which running the real harness cannot do.",
    checked: "2026-08-22",
    access: "api_key"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    sanction: "prohibited",
    why: "Anthropic prohibits routing Claude subscription credentials through third-party apps, and OpenCode removed that sign-in under Anthropic's legal request in March 2026. Claude Code is a first-class integration here — connect it directly instead.",
    checked: "2026-08-22",
    access: "api_key"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    sanction: "unchecked",
    why: "An API-key marketplace, so no subscription is at stake — but its terms have not been read here.",
    checked: "2026-08-22",
    access: "api_key"
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    sanction: "unchecked",
    why: "Documented by OpenCode as a sign-in it supports; GitHub's own terms for that path have not been verified here.",
    checked: "2026-08-22",
    access: "oauth"
  },
  {
    id: "gitlab",
    label: "GitLab Duo",
    sanction: "unchecked",
    why: "Documented by OpenCode as a sign-in it supports; GitLab's own terms for that path have not been verified here.",
    checked: "2026-08-22",
    access: "unknown"
  },
  {
    id: "zai",
    label: "Z.AI",
    sanction: "unchecked",
    why: "Documented by OpenCode as a supported plan; Z.AI's own terms for that path have not been verified here.",
    checked: "2026-08-22",
    access: "api_key"
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    sanction: "unchecked",
    why: "Documented by OpenCode as a sign-in it supports; DigitalOcean's own terms for that path have not been verified here.",
    checked: "2026-08-22",
    access: "oauth"
  }
];

/* Auth-list and slug spellings that differ from the registry id. */
const INNER_PROVIDER_ALIASES: Record<string, string> = {
  "moonshotai": "moonshot",
  "z-ai": "zai",
  "github": "github-copilot",
  "githubcopilot": "github-copilot",
  "gitlabduo": "gitlab"
};

function normalisedInnerProviderId(raw: string): string {
  const lowered = raw.trim().toLowerCase().replaceAll(/\s+/gu, "-");
  return INNER_PROVIDER_ALIASES[lowered.replaceAll("-", "")] ?? INNER_PROVIDER_ALIASES[lowered] ?? lowered;
}

/** `openai/gpt-x` -> `openai`; a slug with no `/` names no inner provider. */
export function innerProviderIdForModelSlug(slug: string | null): string | null {
  if (slug === null) return null;
  const at = slug.indexOf("/");
  if (at <= 0) return null;
  return normalisedInnerProviderId(slug.slice(0, at));
}

/**
 * The standing for an inner provider id. Unknown ids come back `unchecked`
 * rather than being invented into either verdict — same direction as every
 * other unsure state here.
 */
export function innerProviderStanding(id: string): InnerProviderStanding {
  const normal = normalisedInnerProviderId(id);
  const known = INNER_PROVIDER_SANCTIONS.find((entry) => entry.id === normal);
  if (known !== undefined) return known;
  return {
    id: normal,
    label: id.trim(),
    sanction: "unchecked",
    why: "A provider configured in the harness that Hivemind has never checked. Its own terms decide whether this path is allowed.",
    checked: "2026-08-22",
    access: "unknown"
  };
}

/**
 * Match a provider NAME from a harness's own auth listing against the
 * registry. Returns null for anything unrecognised, so raw user-configured
 * strings never cross the auth-status boundary — callers count those instead.
 */
export function innerProviderStandingForAuthName(name: string): InnerProviderStanding | null {
  const normal = normalisedInnerProviderId(name);
  return INNER_PROVIDER_SANCTIONS.find((entry) => entry.id === normal) ?? null;
}

export interface InnerProviderJudgement {
  /** Null on an integrated harness, or when the slug names no provider. */
  standing: InnerProviderStanding | null;
  /** Non-null exactly when the connection must not be offered or made. */
  refusal: string | null;
}

/**
 * The one admission decision for a (harness, model) pair's inner provider.
 *
 * Control flow branches on the typed sanction, never on message text, and the
 * refusal is decided here so `adapter.connect` and every picker surface share
 * one verdict instead of three copies of it.
 */
export function judgeInnerProvider(
  harness: string,
  modelSlug: string | null
): InnerProviderJudgement {
  if (!MULTIPLIER_HARNESSES.has(harness)) return { standing: null, refusal: null };
  const providerId = innerProviderIdForModelSlug(modelSlug);
  if (providerId === null) return { standing: null, refusal: null };
  const standing = innerProviderStanding(providerId);
  if (standing.sanction !== "prohibited") return { standing, refusal: null };
  return {
    standing,
    refusal: `${standing.label} cannot be reached through ${PROVIDER_LABELS[harness] ?? harness}: ${standing.why}`
  };
}

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
        support_tier: supportTierForHarness(agent.harness),
        tier_claim: TIER_CLAIMS[supportTierForHarness(agent.harness)],
        install: providerInstallGuidance(agent.harness),
        reachable_providers: reachableInnerProviders(agent.harness),
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
      context_window: agent.context_window,
      inner_provider: judgeInnerProvider(agent.harness, agent.model).standing
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
  grok: "GROK_HOME"
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
 * Settings in a harness's own config that Hivemind cannot force off, and will
 * not run beside.
 *
 * This exists because of a measured failure, not a theory. The pattern it
 * replaces was: pass an override that turns the dangerous thing off, watch the
 * harness accept it, and treat acceptance as protection. On 2026-08-23 the
 * `-c` override form for one harness was shown to be accepted, self-reported
 * as applied, and echoed in its own event stream while having no effect. A
 * prevention that cannot be confirmed BEHAVIOURALLY is not a prevention.
 *
 * So where a hostile setting cannot be forced off, it is declared here and
 * connect REFUSES while it is present. That is a real boundary: the person is
 * told what to change and nothing runs until they change it. Refusing costs
 * nothing -- it happens before any provider call.
 *
 * `pattern` is matched against the file's text with comment lines removed, so
 * a documented-but-inactive example does not refuse a connection.
 */
export interface HostileHarnessSetting {
  /** Relative to the harness's own home directory. */
  file: string;
  /** Matches the setting only when it is actually assigned a value. */
  pattern: RegExp;
  /** What it does, in the words the person is shown. */
  why: string;
  /** What they can do about it. */
  remedy: string;
}

export const HOSTILE_HARNESS_SETTINGS: Record<string, readonly HostileHarnessSetting[]> = {
  /* EMPTY, deliberately, and the mechanism stays.

     Its first and only entry was Codex's `notify`, declared here when the
     override for it was unverified. It has since been MEASURED to apply (see
     `codexInvoke`), so the setting is neutralised per spawn instead: a
     machine-wide value no longer refuses every model on every project, and
     nobody is sent to a text editor.

     The lesson is worth more than the entry, and it is why this table survives
     with nothing in it: a refusal is the right answer only when nothing can be
     done, and "we could not confirm the override" is not the same claim as
     "the override does not work". The first is a reason to measure; only the
     second licenses a refusal. Anything genuinely unforceable belongs here. */
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
  grok: ".grok"
};

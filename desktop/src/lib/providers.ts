/* What Hivemind can actually run today, and what it needs from a coding agent.
 *
 * This is a catalogue, not an abstraction layer: adding a provider is an entry
 * here plus a profile template. Nothing in the UI knows Codex's shape.
 *
 * Hivemind reads adapter profiles from `.hivemind/adapters/<tool>.profile.json`.
 * The desktop asks for two roles by name, so those two files must exist before a
 * first run: see REQUIRED_ROLES.
 */

export type ProviderStatus = "supported" | "unverified" | "planned";

export interface ProviderCapability {
  id: "pin_model" | "confine_to_project" | "non_interactive" | "reports_usage" | "no_bypass";
  label: string;
  why: string;
}

export interface ProviderOption {
  id: string;
  label: string;
  status: ProviderStatus;
  /** What a person would recognise: what they pay for, and what it is called. */
  summary: string;
  /** Honest, specific reason when this is not something you can pick yet. */
  caveat: string | null;
  /** Command the profile drives, for the capability read-out. */
  capabilities: Record<ProviderCapability["id"], string | null>;
  profile: ((role: ProviderRole) => Record<string, unknown>) | null;
}

export interface ProviderRole {
  tool: string;
  purpose: string;
}

/* The desktop asks Core for these tools by name. Core resolves each to
   `.hivemind/adapters/<tool>.profile.json`, so both files must exist. */
export const REQUIRED_ROLES: ProviderRole[] = [
  { tool: "planner", purpose: "Turns what you type into a plan" },
  { tool: "manager", purpose: "Decides the next step when something is unexpected" }
];

export const CAPABILITIES: ProviderCapability[] = [
  {
    id: "pin_model",
    label: "Runs one exact model",
    why: "A run that quietly changes model is a run you cannot reason about."
  },
  {
    id: "confine_to_project",
    label: "Stays inside the project",
    why: "Agents write only inside the files their task owns."
  },
  {
    id: "non_interactive",
    label: "Runs without prompting",
    why: "Nothing can wait on a question nobody will see."
  },
  {
    id: "reports_usage",
    label: "Reports what it used",
    why: "Spending limits mean nothing if usage is guessed."
  },
  {
    id: "no_bypass",
    label: "Carries no bypass flags",
    why: "Hivemind refuses profiles that skip approvals or sandboxing."
  }
];

const CODEX_INVOKE_TAIL = [
  "exec",
  "--model",
  "gpt-5.6-sol",
  "--sandbox",
  "workspace-write",
  "--config",
  'model_reasoning_effort="high"',
  "--ephemeral",
  "--json",
  "-"
];

export const PROVIDERS: ProviderOption[] = [
  {
    id: "codex",
    label: "Codex",
    status: "supported",
    summary: "The OpenAI coding agent, from a ChatGPT plan or an API key.",
    caveat: null,
    capabilities: {
      pin_model: "--model gpt-5.6-sol",
      confine_to_project: "--sandbox workspace-write",
      non_interactive: "exec, prompt on stdin",
      reports_usage: "--json, read with the codex-jsonl parser",
      no_bypass: "no bypass or ultra flags"
    },
    profile: (role) => ({
      tool: role.tool,
      invoke:
        typeof navigator !== "undefined" && /windows/iu.test(navigator.userAgent)
          ? ["cmd.exe", "/d", "/s", "/c", "codex.cmd", ...CODEX_INVOKE_TAIL]
          : ["codex", ...CODEX_INVOKE_TAIL],
      prompt_arg: "stdin",
      verified_on: "configured-from-desktop",
      routing_tier: "strong",
      cost_rank: 20,
      context_window: 272_000,
      timeout_ms: 120_000,
      usage_parser: "codex-jsonl"
    })
  },
  {
    id: "claude-code",
    label: "Claude Code",
    status: "unverified",
    summary: "The Anthropic coding agent, from a Claude plan or an API key.",
    caveat:
      "Hivemind can read Claude's usage output, but that reading has only been tested against recorded fixtures, never against a live run. The profile that used to ship was withdrawn because it carried flags that skip approvals. Until a live run confirms the usage numbers, spending limits could not be trusted.",
    capabilities: {
      pin_model: null,
      confine_to_project: null,
      non_interactive: null,
      reports_usage: null,
      no_bypass: null
    },
    profile: null
  }
];

export function providerById(id: string): ProviderOption | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** The exact file a person needs to create, formatted the way Core reads it. */
export function profileFileFor(provider: ProviderOption, role: ProviderRole): string {
  if (provider.profile === null) return "";
  return `${JSON.stringify(provider.profile(role), null, 2)}\n`;
}

export function profilePathFor(role: ProviderRole): string {
  return `.hivemind/adapters/${role.tool}.profile.json`;
}

/* Cost defaults. With no tier globs configured, Core treats every path as
   high-risk, and high-risk work refuses anything below the strongest provider —
   so an unconfigured project runs everything on the most expensive model it has.
   These are ordinary, boring defaults for a typical repository. */
export const COST_DEFAULT_GLOBS = {
  low_globs: ["docs/**", "**/*.md", "**/*.txt"],
  medium_globs: ["src/**", "app/**", "lib/**", "test/**", "tests/**"],
  high_globs: ["package.json", "tsconfig.json", "**/*.config.*"],
  critical_globs: [".github/**", "infra/**", "**/auth/**"]
};

export function costDefaultsSnippet(): string {
  return `${JSON.stringify(COST_DEFAULT_GLOBS, null, 2)}\n`;
}

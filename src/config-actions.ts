import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  findDangerousAdapterArgs,
  validateAdapterProfile,
  type AdapterProfile
} from "./adapter.js";
import {
  adapterRoleNames,
  findCatalogueAgent,
  agentCatalogue,
  type AdapterRoleName,
  type CatalogueAgent
} from "./agent-catalogue.js";
import { probeAdapter, type AdapterProbeResult, type ProbeOptions } from "./adapter-probe.js";
import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  HARD_MAX_CONCURRENT_WORKERS,
  loadConfig,
  normalizeConfig,
  validateConfig,
  type HivemindConfig
} from "./config.js";
import { initProject } from "./init.js";
import { writeJsonAtomic } from "./atomic.js";

type ActionResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The settings surface, server-side.
 *
 * Everything a person previously had to open a text editor for is reachable
 * from here, and nothing here can widen a gate: `config.set` accepts a fixed
 * key list and re-validates through the same `validateConfig` the loader uses,
 * and `adapter.connect` refuses to record a profile that has not been probed.
 */

export interface InspectedAdapter {
  role: AdapterRoleName;
  installed: boolean;
  tool: string | null;
  agent_id: string | null;
  model: string | null;
  routing_tier: string | null;
  problems: string[];
  /** The probe result recorded when this profile was connected, if any. */
  connected_at: string | null;
  capabilities: AdapterProbeResult["capabilities"];
}

/**
 * `config.inspect` — read-only. The client cannot show what is configured
 * unless something tells it; this is that. No secret is involved, because
 * Hivemind never holds a provider credential.
 */
export async function inspectProjectConfig(repoRoot: string): Promise<ActionResult> {
  const loaded = await loadConfig(repoRoot);
  const config = loaded.ok ? loaded.config : null;
  const adapters: InspectedAdapter[] = [];

  for (const role of adapterRoleNames) {
    const file = path.join(repoRoot, ".hivemind", "adapters", `${role}.profile.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      adapters.push({
        role,
        installed: false,
        tool: null,
        agent_id: null,
        model: null,
        routing_tier: null,
        problems: [],
        connected_at: null,
        capabilities: []
      });
      continue;
    }
    const problems = validateAdapterProfile(raw, role);
    const profile = isRecord(raw) ? raw : {};
    const invoke = Array.isArray(profile.invoke)
      ? profile.invoke.filter((entry): entry is string => typeof entry === "string")
      : [];
    const dangerous = findDangerousAdapterArgs(invoke);
    if (dangerous.length > 0) problems.push(`carries a refused flag: ${dangerous.join(", ")}`);
    const record = await readConnectionRecord(repoRoot, role);
    adapters.push({
      role,
      installed: true,
      tool: typeof profile.tool === "string" ? profile.tool : null,
      agent_id: record?.agent_id ?? null,
      model: modelFromInvoke(invoke),
      routing_tier: typeof profile.routing_tier === "string" ? profile.routing_tier : null,
      problems,
      connected_at: record?.connected_at ?? null,
      capabilities: record?.capabilities ?? []
    });
  }

  return {
    ok: true,
    value: {
      initialized: loaded.ok,
      config_problem: loaded.ok ? null : loaded.reason,
      config: config === null ? null : publicConfig(config),
      /* The roles Core resolves by name, so the client stops hardcoding them. */
      roles: [...adapterRoleNames],
      adapters,
      catalogue: agentCatalogue.map((agent) => ({
        id: agent.id,
        label: agent.label,
        harness: agent.harness,
        subscription: agent.subscription,
        status: agent.status,
        caveat: agent.caveat,
        model: agent.model,
        routing_tier: agent.routing_tier,
        context_window: agent.context_window,
        connectable: agent.invoke !== null
      })),
      limits: {
        max_concurrent_workers_hard_max: HARD_MAX_CONCURRENT_WORKERS,
        max_concurrent_workers_default: DEFAULT_MAX_CONCURRENT_WORKERS,
        /* Measured, not guessed: one real worker call on the 2026-08-11 runs
           cost between 106,792 and 179,698 effective tokens. A run ceiling
           below that guarantees a run stops after the money is spent. */
        observed_worker_call_tokens: { low: 106_792, high: 179_698 }
      },
      writable_keys: [...WRITABLE_KEYS]
    }
  };
}

function publicConfig(config: HivemindConfig): Record<string, unknown> {
  return {
    test_command: config.test_command,
    base_branch: config.base_branch ?? null,
    allowed_globs: config.allowed_globs,
    forbidden_globs: config.forbidden_globs,
    low_globs: config.low_globs ?? [],
    medium_globs: config.medium_globs ?? [],
    high_globs: config.high_globs ?? [],
    critical_globs: config.critical_globs ?? [],
    run_ceiling_tokens: config.resource_policy?.run_ceiling?.tokens ?? null,
    session_ceiling_tokens: config.resource_policy?.session_ceiling?.tokens ?? null,
    max_concurrent_workers: config.execution?.max_concurrent_workers ?? null,
    verification_checks: (config.verification?.checks ?? []).map((check) => ({
      id: check.id,
      command: check.command
    }))
  };
}

/**
 * `config.set` — the whitelist IS the safety property. Anything outside it is
 * refused rather than merged, so no future caller can reach a gate through
 * this door, and every write goes back through `validateConfig` before it
 * lands.
 */
const WRITABLE_KEYS = [
  "low_globs",
  "medium_globs",
  "high_globs",
  "critical_globs",
  "test_command",
  "run_ceiling_tokens",
  "session_ceiling_tokens",
  "max_concurrent_workers"
] as const;

type WritableKey = (typeof WRITABLE_KEYS)[number];

export async function setProjectConfig(
  repoRoot: string,
  payload: Record<string, unknown>
): Promise<ActionResult> {
  const keys = Object.keys(payload);
  if (keys.length === 0) return { ok: false, reason: "config.set needs at least one setting" };
  const unsupported = keys.filter((key) => !(WRITABLE_KEYS as readonly string[]).includes(key));
  if (unsupported.length > 0) {
    return { ok: false, reason: `config.set cannot change: ${unsupported.join(", ")}` };
  }

  const configPath = path.join(repoRoot, ".hivemind", "config.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "this project has no readable .hivemind/config.json" };
  }
  if (!isRecord(raw)) return { ok: false, reason: "this project's config is not a JSON object" };

  const next: Record<string, unknown> = { ...raw };
  for (const key of keys as WritableKey[]) {
    const value = payload[key];
    if (key.endsWith("_globs")) {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        return { ok: false, reason: `${key} must be a list of glob strings` };
      }
      next[key] = value;
      continue;
    }
    if (key === "test_command") {
      if (typeof value !== "string" || value.trim() === "") {
        return { ok: false, reason: "test_command must be a non-empty string" };
      }
      next[key] = value.trim();
      continue;
    }
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      return { ok: false, reason: `${key} must be a whole number above zero` };
    }
    const amount = Number(value);
    if (key === "max_concurrent_workers") {
      const execution = isRecord(next.execution) ? { ...next.execution } : {};
      execution.max_concurrent_workers = amount;
      next.execution = execution;
      continue;
    }
    const policy = isRecord(next.resource_policy) ? { ...next.resource_policy } : {};
    if (key === "run_ceiling_tokens") {
      policy.run_ceiling = { ...(isRecord(policy.run_ceiling) ? policy.run_ceiling : {}), tokens: amount };
    } else {
      policy.session_ceiling = {
        ...(isRecord(policy.session_ceiling) ? policy.session_ceiling : {}),
        tokens: amount
      };
    }
    next.resource_policy = policy;
  }

  const problems = validateConfig(next);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
  await writeJsonAtomic(configPath, normalizeConfig(next));
  return inspectProjectConfig(repoRoot);
}

/**
 * `project.init` — set a folder up so it can take a first prompt.
 *
 * It is a thin wrapper on purpose, and does two things beyond calling
 * `initProject`: nothing.
 *
 * An earlier version also wrote its own tier globs, because DESIGN-NOTES
 * recorded that `initProject` wrote none and an unconfigured project routes
 * every task to the strongest model. Core has since fixed that itself —
 * `ensureTierGlobsRecorded` fills only the keys that are ABSENT — so the copy
 * here was both redundant and destructive: it overwrote whole lists, and
 * re-running setup on a project whose globs had been customised would have
 * silently reset them. Two sources of truth for one default, and the second one
 * clobbered the first.
 *
 * It also deliberately writes NO adapter profile. A profile written here would
 * be a declaration that no probe has checked, which is the exact thing
 * `adapter.connect` exists to replace.
 */
export async function initProjectForDesktop(repoRoot: string): Promise<ActionResult> {
  /* `initProject` is a CLI entry point: it returns an exit code and reports on
     the console. Anything non-zero is a refusal the desktop has to surface. */
  const code = await initProject(repoRoot);
  if (code !== 0) {
    return { ok: false, reason: "this folder could not be set up; it must be a git repository" };
  }
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok) {
    return { ok: false, reason: `this folder was set up but its settings cannot be read: ${loaded.reason}` };
  }
  return inspectProjectConfig(repoRoot);
}

interface ConnectionRecord {
  agent_id: string;
  connected_at: string;
  effective_tokens: number;
  readback_source: string | null;
  /* The harness version the capabilities below were verified against. These
     harnesses update themselves -- `claude doctor` reports auto-updates
     enabled -- so a run against a different version is stale and the person is
     asked to reconnect, rather than being quietly run against capabilities
     nobody checked on the binary that is actually there. */
  provider_version: string | null;
  capabilities: AdapterProbeResult["capabilities"];
}

function connectionRecordPath(repoRoot: string, role: AdapterRoleName): string {
  return path.join(repoRoot, ".hivemind", "adapters", `${role}.connection.json`);
}

async function readConnectionRecord(
  repoRoot: string,
  role: AdapterRoleName
): Promise<ConnectionRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(connectionRecordPath(repoRoot, role), "utf8"));
    return isRecord(parsed) ? (parsed as unknown as ConnectionRecord) : null;
  } catch {
    return null;
  }
}

export function buildProfileForAgent(agent: CatalogueAgent, role: AdapterRoleName): AdapterProfile | null {
  if (agent.invoke === null || agent.usage_parser === null) return null;
  return {
    /* Core resolves an adapter by the tool name the caller sends, and the
       callers send the role. The profile's tool must therefore BE the role. */
    tool: role,
    invoke: [...agent.invoke],
    prompt_arg: "stdin",
    verified_on: new Date().toISOString().slice(0, 10),
    context_window: agent.context_window,
    timeout_ms: agent.timeout_ms,
    routing_tier: agent.routing_tier,
    cost_rank: agent.cost_rank,
    usage_parser: agent.usage_parser,
    roles: role === "worker" ? ["worker"] : ["orchestrator"]
  };
}

/**
 * `adapter.connect` — write AND verify.
 *
 * The order matters and is the whole point: build, refuse anything dangerous,
 * probe, and only then record. Nothing is written when the probe fails, so a
 * project can never hold a profile whose capabilities were assumed.
 */
export async function connectAdapter(
  repoRoot: string,
  role: AdapterRoleName,
  agentId: string,
  options: ProbeOptions = {}
): Promise<ActionResult> {
  const agent = findCatalogueAgent(agentId);
  if (agent === null) return { ok: false, reason: `unknown coding agent: ${agentId}` };
  if (agent.invoke === null) {
    return {
      ok: false,
      reason: `${agent.label} cannot be connected yet: ${agent.caveat ?? "it has no working invocation"}`
    };
  }

  const profile = buildProfileForAgent(agent, role);
  if (profile === null) return { ok: false, reason: `${agent.label} has no usable profile shape` };

  const problems = validateAdapterProfile(profile, role);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };

  const probe = await probeAdapter(repoRoot, agent, profile, options);
  if (!probe.ok) {
    return {
      ok: false,
      reason: probe.refusal ?? "the probe did not pass",
      /* The delta is the useful part, so it travels with the refusal. */
      ...({ probe } as Record<string, unknown>)
    } as ActionResult;
  }

  const dir = path.join(repoRoot, ".hivemind", "adapters");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, `${role}.profile.json`), profile);
  const record: ConnectionRecord = {
    agent_id: agent.id,
    connected_at: new Date().toISOString(),
    effective_tokens: probe.effective_tokens,
    readback_source: probe.readback_source,
    provider_version: probe.provider_version,
    capabilities: probe.capabilities
  };
  await writeJsonAtomic(connectionRecordPath(repoRoot, role), record);

  const inspected = await inspectProjectConfig(repoRoot);
  return inspected.ok ? { ok: true, value: { probe, config: inspected.value } } : inspected;
}

function modelFromInvoke(invoke: string[]): string | null {
  const at = invoke.findIndex((arg) => arg === "--model" || arg === "-m");
  return at >= 0 && at + 1 < invoke.length ? invoke[at + 1]! : null;
}

export async function adapterDirectoryNames(repoRoot: string): Promise<string[]> {
  try {
    return await readdir(path.join(repoRoot, ".hivemind", "adapters"));
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeTextFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

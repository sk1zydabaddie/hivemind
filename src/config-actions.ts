import { isRecord } from "./json.js";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  findDangerousAdapterArgs,
  validateAdapterProfile,
  type AdapterProfile
} from "./adapter.js";
import {
  adapterRoleNames,
  catalogueModels,
  catalogueProviders,
  catalogueAgentForDiscoveredModel,
  findCatalogueAgent,
  harnessForAgentId,
  judgeInnerProvider,
  providerAuthentication,
  providerAuthenticationForInner,
  supportTierForHarness,
  type AdapterRoleName,
  type CatalogueAgent,
  type InnerProviderStanding,
  type SupportTier
} from "./agent-catalogue.js";
import { probeAdapter, type AdapterProbeResult, type ProbeOptions } from "./adapter-probe.js";
import { readAdapterVersion } from "./adapter-version.js";
import { readCachedVerdict, writeCachedVerdict } from "./verdict-cache.js";
import {
  discoverProviderModels,
  type ModelDiscoveryRunner,
  type ModelDiscoveryView
} from "./model-discovery.js";
import { configStanding, findHostileHarnessSettings, harnessConfigDigest } from "./harness-config-digest.js";
import { ensureHarnessProjectConfig } from "./harness-project-config.js";
import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  HARD_MAX_CONCURRENT_WORKERS,
  loadConfig,
  normalizeConfig,
  validateConfig,
  type HivemindConfig
} from "./config.js";
import { initProject } from "./init.js";
import { detectCheckCandidates } from "./check-candidates.js";
import { tryCheckCommand } from "./check-trial.js";
import { ACCOUNT_HOME_VARIABLES } from "./agent-catalogue.js";
import { parseTaskTypePreferences } from "./routing-preferences.js";
import { accountEnvironment, harnessForRole } from "./provider-accounts.js";
import { readAccounts, selectedAccount } from "./provider-accounts.js";
import { priceAgeDays, priceForModel, priceIsStale } from "./model-prices.js";
import { ROLE_RECOMMENDATIONS, modelChoiceAllowed, modelChoiceRefusal } from "./role-recommendations.js";
import {
  currentMachine,
  machineStanding,
  type MachineIdentity
} from "./verification-standing.js";
import { writeJsonAtomic } from "./atomic.js";
import { spawnEnvironment } from "./spawn-environment.js";
import { appendEvent } from "./events.js";
import { providerCommandAvailable } from "./provider-auth-status.js";

type ActionResult = { ok: true; value: unknown } | { ok: false; reason: string };

type AuthenticationLauncher = (
  invocation: readonly [string, ...string[]],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<void>;

/**
 * Put a fixed provider command in a terminal the provider owns.
 *
 * The daemon has no interactive console, so starting the CLI directly would
 * make OpenCode's provider picker invisible. Each platform wrapper therefore
 * opens an external terminal. The wrapped argv is
 * not supplied by the client: it comes only from `agent-catalogue.ts`.
 */
function externalTerminalInvocation(
  command: readonly [string, ...string[]]
): readonly [string, ...string[]] {
  if (process.platform === "win32") {
    /* `start` gives the inner cmd its own visible console. `/k` deliberately
       leaves the provider's final answer on screen so a failed sign-in does
       not flash and disappear. The person closes that provider-owned window. */
    return [
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "start",
      "",
      "cmd.exe",
      "/d",
      "/s",
      "/k",
      ...command
    ];
  }
  const shellCommand = command.map(posixQuote).join(" ");
  if (process.platform === "darwin") {
    const appleScriptCommand = shellCommand
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    return [
      "osascript",
      "-e",
      `tell application "Terminal" to do script "${appleScriptCommand}"`
    ];
  }
  return [
    "x-terminal-emulator",
    "-e",
    "sh",
    "-lc",
    `${shellCommand}; status=$?; printf '\\nYou can close this window.\\n'; read -r _; exit $status`
  ];
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const launchAuthentication: AuthenticationLauncher = async (command, options) => {
  const invocation = externalTerminalInvocation(command);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation[0], invocation.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

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
  provider_id: string | null;
  model: string | null;
  routing_tier: string | null;
  problems: string[];
  /** The probe result recorded when this profile was connected, if any. */
  connected_at: string | null;
  capabilities: AdapterProbeResult["capabilities"];
  /**
   * Why the recorded capabilities no longer describe what would run, or null.
   *
   * A probe result is evidence about the tool, the profile AND the account it
   * ran under. Switching accounts sets this, because a different plan can
   * change which models are available to pin and whether usage is reported at
   * all -- carrying the verification across would assert something nobody
   * measured.
   */
  capabilities_stale: string | null;
  /** The account this role runs as, where one has been chosen. */
  account: { id: string; label: string; harness: string } | null;
  /**
   * Why this role cannot be aimed at a chosen model, or null when it can.
   *
   * Computed by `modelChoiceRefusal` in Core rather than by the surface. The
   * client cannot import Core, so without carrying the sentence here every
   * surface would write its own version of a rule the capability contract
   * already owns — and the function that computes it sat on the unreached list
   * for exactly that reason.
   */
  model_choice_refusal: string | null;
  /**
   * Whether `model` is a CONFIRMED fact or only what was asked for. Derived
   * from the recorded probe by the same rule as `modelChoiceAllowed`: only a
   * verified pin makes the model a statement rather than a request. The label
   * a person reads must not assert what the probe recorded as unverified.
   */
  model_standing: "confirmed" | "requested" | null;
  /** Which support claim this connection's harness may make. Null when nothing identifies a harness. */
  support_tier: SupportTier | null;
  /**
   * For a multiplier connection, whose service the requests go to and whether
   * that vendor sanctions the path — as recorded at connect time, so a later
   * registry change does not silently rewrite what somebody was told.
   */
  inner_provider: InnerProviderStanding | null;
}

/**
 * `config.inspect` — read-only. The client cannot show what is configured
 * unless something tells it; this is that. No secret is involved, because
 * Hivemind never holds a provider credential.
 */
/**
 * Every adapter profile this project has, and which role each fills.
 *
 * `planner` and `manager` are one file each, named for the role, because Core
 * asks for them by name. `worker` is a POOL: routing searches the directory, so
 * there can be several and the tier floor picks among them. Enumerating only
 * the three role names -- which is what this used to do -- made a pool of more
 * than one invisible to every surface that reports what is connected.
 *
 * A role with no file on disk still gets one row, marked not installed, so the
 * setup screen can say what is missing rather than showing a shorter list.
 */
async function adapterProfileNames(
  repoRoot: string
): Promise<{ role: AdapterRoleName; name: string }[]> {
  const found: { role: AdapterRoleName; name: string }[] = [];
  for (const role of adapterRoleNames) {
    if (role !== "worker") {
      found.push({ role, name: role });
      continue;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(path.join(repoRoot, ".hivemind", "adapters"));
    } catch {
      /* No directory is the same answer as no pool members. */
    }
    const workers = entries
      .filter((entry) => entry.endsWith(".profile.json"))
      .map((entry) => entry.slice(0, -".profile.json".length))
      .filter((entry) => entry === "worker" || entry.startsWith("worker-"))
      .sort((left, right) => left.localeCompare(right));
    if (workers.length === 0) {
      found.push({ role, name: "worker" });
      continue;
    }
    for (const name of workers) found.push({ role, name });
  }
  return found;
}

export async function inspectProjectConfig(repoRoot: string): Promise<ActionResult> {
  const accountsFile = await readAccounts(repoRoot);
  const loaded = await loadConfig(repoRoot);
  const config = loaded.ok ? loaded.config : null;
  const adapters: InspectedAdapter[] = [];

  for (const { role, name } of await adapterProfileNames(repoRoot)) {
    const file = path.join(repoRoot, ".hivemind", "adapters", `${name}.profile.json`);
    let raw: unknown;
    let profileProblem: string | null = null;
    try {
      const text = await readFile(file, "utf8");
      try {
        raw = JSON.parse(text);
      } catch (cause) {
        raw = {};
        profileProblem = `profile is corrupt JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause;
      adapters.push({
        role,
        installed: false,
        tool: null,
        agent_id: null,
        provider_id: null,
        model: null,
        routing_tier: null,
        problems: [],
        connected_at: null,
      capabilities_stale: null,
      account: null,
        capabilities: [],
        /* "Nothing installed" and "nothing choosable" are different sentences,
           and Core owns both. */
        model_choice_refusal: modelChoiceRefusal({ capabilities: [], connected_at: null }),
        model_standing: null,
        support_tier: null,
        inner_provider: null
      });
      continue;
    }
    const problems = validateAdapterProfile(raw, name);
    if (profileProblem !== null) problems.unshift(profileProblem);
    const profile = isRecord(raw) ? raw : {};
    const invoke = Array.isArray(profile.invoke)
      ? profile.invoke.filter((entry): entry is string => typeof entry === "string")
      : [];
    const dangerous = findDangerousAdapterArgs(invoke);
    if (dangerous.length > 0) problems.push(`carries a refused flag: ${dangerous.join(", ")}`);
    const connectionStanding = await readConnectionRecordStanding(repoRoot, name);
    const record = connectionStanding.record;
    if (connectionStanding.problem !== null) problems.push(connectionStanding.problem);
    /* By HARNESS, resolved from the connection's recorded agent -- `profile.tool`
       is the role, and keying an account by it silently showed none. */
    const chosen = selectedAccount(accountsFile, await harnessForRole(repoRoot, name));
    adapters.push({
      role,
      installed: true,
      tool: typeof profile.tool === "string" ? profile.tool : null,
      agent_id: record?.agent_id ?? null,
      provider_id: findCatalogueAgent(record?.agent_id ?? "")?.harness ?? null,
      model: modelFromInvoke(invoke),
      routing_tier: typeof profile.routing_tier === "string" ? profile.routing_tier : null,
      problems,
      connected_at: record?.connected_at ?? null,
      capabilities: record?.capabilities ?? [],
      /* A stale marker already on the record wins -- an account switch is a
         fact somebody caused. Otherwise ask whether this verdict was even made
         here: a record that arrived by clone was never "switched", so it read
         as a valid connection and granted its capabilities to a machine that
         had measured nothing. This is the cheap half of the check; the version
         comparison costs a subprocess and runs where an adapter is used. */
      capabilities_stale:
        record?.capabilities_stale ??
        (record === null
          ? null
          : configStanding(
              record.config_digest,
              await harnessConfigDigest(repoRoot, (harness) =>
                selectedAccount(accountsFile, harness)?.home_dir ?? null
              )
            )) ??
        (record === null
          ? null
          : machineStanding(
              record.machine,
              currentMachine(
                selectedAccount(accountsFile, await harnessForRole(repoRoot, name))?.home_dir ??
                  null
              )
            ).stale),
      account:
        chosen === null
          ? null
          : { id: chosen.id, label: chosen.label, harness: chosen.harness },
      /* Whether this role may be pointed at a model, and the sentence for when
         it may not — from the recorded probe, never from the catalogue. */
      model_choice_refusal: modelChoiceRefusal({
        capabilities: record?.capabilities ?? [],
        connected_at: record?.connected_at ?? null
      }),
      /* Requested vs confirmed, by the same recorded-probe rule as the model
         picker. A model with no verified pin renders as what was ASKED FOR,
         never as an assertion the probe declined to make. */
      model_standing:
        modelFromInvoke(invoke) === null
          ? null
          : modelChoiceAllowed({ capabilities: record?.capabilities ?? [] })
            ? "confirmed"
            : "requested",
      support_tier: (() => {
        const harness = harnessForAgentId(record?.agent_id ?? null);
        return harness === null ? null : supportTierForHarness(harness);
      })(),
      /* From the RECORD, not re-judged: what somebody was told at connect
         time is the durable fact; the current registry is only the source for
         new connections. */
      inner_provider: record?.inner_provider ?? null
    });
  }

  /* A catalogue status is product-wide evidence (for example, Codex has gone
     through a complete Hivemind run). A connection record is different: it is
     proof that THIS project, account, machine and harness configuration passed
     the capability probe. Keep both facts instead of translating one into the
     other in React. */
  const checkedHarnesses = new Set(
    adapters
      .filter(
        (adapter) =>
          adapter.agent_id !== null &&
          adapter.connected_at !== null &&
          adapter.capabilities_stale === null &&
          adapter.problems.length === 0
      )
      .map((adapter) => findCatalogueAgent(adapter.agent_id!)?.harness)
      .filter((harness): harness is string => harness !== undefined)
  );

  return {
    ok: true,
    value: {
      initialized: loaded.ok,
      config_problem: loaded.ok ? null : loaded.reason,
      config: config === null ? null : publicConfig(config),
      /* The roles Core resolves by name, so the client stops hardcoding them. */
      roles: [...adapterRoleNames],
      adapters,
      /* What a person actually chooses, in the independent parts they are
         actually choosing between. The old flattened provider x model
         response is gone; dynamic ids remain a private connect-record detail. */
      providers: catalogueProviders().map((provider) => ({
        ...provider,
        checked_here: checkedHarnesses.has(provider.id)
      })),
      models: catalogueModels().map((model) => {
        const price = priceForModel(model.slug);
        return {
          ...model,
          price,
          /* Provenance travels with the number, and staleness is computed
             rather than assumed: a price that has quietly aged past the
             threshold says so instead of continuing to look authoritative.
             OpenAI cut Luna's input price 80% on 30 July 2026, a fortnight
             before this was written. */
          price_stale: price === null ? null : priceIsStale(price, new Date()),
          price_age_days: price === null ? null : priceAgeDays(price, new Date())
        };
      }),
      recommendations: ROLE_RECOMMENDATIONS,
      /* What this project could be checked with, for the surface that has to
         ask. Computed only while the question is still open, because a
         suggestion for a settled question is noise -- and because it reads the
         filesystem, which an inspect on every reload should not do for nothing.

         Tests are not the only entry: a typecheck or a build catches real
         breakage and is what most projects arriving here actually have. Each
         carries its kind, so nobody accepts one thinking it is another. */
      check_candidates:
        config !== null && config.test_command.trim() === "" && config.no_tests_declared !== true
          ? await detectCheckCandidates(repoRoot)
          : [],
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
    no_tests_declared: config.no_tests_declared === true,
    /* What happened the one time it was run, and for WHICH command -- a later
       edit through Settings leaves this pointing at the older string, which is
       how a surface can tell a proven command from a typed one. */
    test_command_trial: config.test_command_trial ?? null,
    base_branch: config.base_branch ?? null,
    allowed_globs: config.allowed_globs,
    forbidden_globs: config.forbidden_globs,
    task_type_routing: config.task_type_routing ?? {},
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
  /* The recorded decision that this project has no tests (A-03). Setting a
     real test_command through this same door removes it, so the two cannot
     contradict each other in the durable record. */
  "no_tests_declared",
  "run_ceiling_tokens",
  "session_ceiling_tokens",
  "max_concurrent_workers",
  /* Which agent handles which KIND of work. Validated by
     `parseTaskTypePreferences`, which refuses rather than repairs -- an
     unknown task type or a malformed entry is a mistake worth surfacing, not
     something to quietly drop. */
  "task_type_routing"
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
    if (key === "task_type_routing") {
      const parsed = parseTaskTypePreferences(value);
      if (!parsed.ok) return parsed;
      next[key] = parsed.value;
      continue;
    }
    if (key === "test_command") {
      if (typeof value !== "string" || value.trim() === "") {
        return { ok: false, reason: "test_command must be a non-empty string" };
      }
      next[key] = value.trim();
      /* A real command supersedes a recorded absence. */
      delete next.no_tests_declared;
      continue;
    }
    if (key === "no_tests_declared") {
      if (value !== true) {
        return { ok: false, reason: "no_tests_declared can only be set to exactly true; supply a test_command to replace it" };
      }
      next[key] = true;
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
 * `checks.try` — run a candidate check command once, and store it only if it
 * earned that.
 *
 * The setup field used to accept any string, so a field that blocked progress
 * got filled with whatever unblocked it: `npm test` typed into a project with
 * no tests, which then fails every integration after the planning and worker
 * money is spent. A declared absence is strictly better than that, and it was
 * the harder answer to give.
 *
 * The decision to store lives HERE rather than in the client, so no surface can
 * store a command by ignoring what the run said, and the recorded trial can
 * only be written by the code that watched it happen:
 *
 *   passed        -- stored, with the trial, and a recorded absence removed.
 *   failed        -- reported, and stored only when `accept_failing` is exactly
 *                    true, which is a second decision a person makes after
 *                    seeing the output. The trial is recorded either way, so
 *                    the same command typed again is visibly known-red.
 *   not_runnable  -- nothing stored, and no confirmation can change that: a
 *                    string that does not run is not a check.
 *   timed_out     -- nothing stored; an unknown outcome is not a pass.
 */
export async function tryProjectCheck(
  repoRoot: string,
  command: string,
  options: { acceptFailing?: boolean } = {}
): Promise<ActionResult> {
  if (command.trim() === "") return { ok: false, reason: "give a command to try" };
  const configPath = path.join(repoRoot, ".hivemind", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return { ok: false, reason: "this project has no readable .hivemind/config.json" };
  }
  if (!isRecord(raw)) return { ok: false, reason: "this project's config is not a JSON object" };

  const trial = await tryCheckCommand(repoRoot, command);
  const storable = trial.outcome === "passed" || trial.outcome === "failed";
  const stored = trial.outcome === "passed" || (trial.outcome === "failed" && options.acceptFailing === true);

  /* An unrunnable command must not survive because something else put it there.
   *
   * The trial was attached to the TYPED path, so detection walked straight past
   * it: `project.init` recorded whatever it found without running it, and the
   * default route was the unvalidated one. A detected `npm test` whose script
   * names a program nobody has installed then costs a plan and a worker call
   * before it fails, which is strictly worse than the declared absence a person
   * could have chosen -- the declared absence is honest.
   *
   * The general form, and this project's fourth instance of it: a mitigation
   * attached to the path where the problem was found leaves every other path
   * unmitigated. So this is attached to the COMMAND. Whatever recorded it, an
   * unrunnable one is removed here, and setup goes back to asking.
   */
  if (!storable && typeof raw.test_command === "string" && raw.test_command.trim() === trial.command) {
    const cleared: Record<string, unknown> = { ...raw };
    delete cleared.test_command;
    cleared.test_command = "";
    delete cleared.test_command_trial;
    const problems = validateConfig(cleared);
    if (problems.length === 0) {
      await writeJsonAtomic(configPath, normalizeConfig(cleared));
    }
  }

  if (storable) {
    const next: Record<string, unknown> = {
      ...raw,
      test_command_trial: {
        command: trial.command,
        outcome: trial.outcome,
        exit_code: trial.exit_code,
        at: new Date().toISOString(),
        duration_ms: trial.duration_ms
      }
    };
    if (stored) {
      next.test_command = trial.command;
      /* A real command supersedes a recorded absence, exactly as `config.set`
         does -- the two must not be able to disagree in the durable record. */
      delete next.no_tests_declared;
    }
    const problems = validateConfig(next);
    if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
    await writeJsonAtomic(configPath, normalizeConfig(next));
  }

  /* The refreshed view plus what the run did, so the surface that asked never
     has to infer the outcome from the config it got back. `stored` is reported
     rather than implied: a red command that was not adopted and a red command
     the person accepted look identical in the trial alone. */
  const inspected = await inspectProjectConfig(repoRoot);
  if (!inspected.ok) return inspected;
  return {
    ok: true,
    value: {
      ...(isRecord(inspected.value) ? inspected.value : {}),
      trial: { ...trial, stored }
    }
  };
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
  capabilities_stale?: string | null;
  connected_at: string;
  effective_tokens: number;
  readback_source: string | null;
  /* The harness version the capabilities below were verified against. These
     harnesses update themselves -- `claude doctor` reports auto-updates
     enabled -- so a run against a different version is stale and the person is
     asked to reconnect, rather than being quietly run against capabilities
     nobody checked on the binary that is actually there. */
  provider_version: string | null;
  /* A fingerprint of the settings this harness reads and Hivemind does not
     write -- hooks, instruction files, its own config. `provider_version`
     catches a binary that changed; this catches the ground changing underneath
     an unchanged binary, which is the commoner case and the one nothing could
     see. Optional: records written before it exists report "not recorded"
     rather than claiming a match. */
  config_digest?: string | null;
  /* WHERE the probe ran.
     Without this nothing could distinguish "verified here" from "verified
     somewhere", so no check could be written even if somebody wanted one --
     and a record arriving by clone read as a valid connection rather than as
     an unverified one. Optional because records written before it exists are a
     permanent input, and `machineStanding` reports their absence rather than
     pretending they match. */
  machine?: MachineIdentity;
  capabilities: AdapterProbeResult["capabilities"];
  /* For a multiplier harness: whose service the requests go to and whether
     that vendor sanctioned the path, AS JUDGED AT CONNECT TIME. Recorded so
     the person's screen keeps saying what they were actually told, even if
     the registry later changes its mind. Optional: records written before
     the field exists report nothing rather than a guess. */
  inner_provider?: InnerProviderStanding | null;
  /* Where this verdict came from. Absent means what it always meant: this
     project ran the probe itself. `machine_cache` means the same binary,
     account, version and configuration were measured on THIS machine for
     another project and the measurement was adopted rather than repeated --
     which is a different claim from "this project paid for a probe", so it is
     recorded rather than blurred. */
  verdict_source?: {
    kind: "machine_cache";
    measured_at: string;
  };
}

/* Keyed by the PROFILE name, not the role: a worker pool has several profiles
   and each was probed separately, so each carries its own verification. */
/**
 * Drop the unprobed default that this connection just replaced.
 *
 * `initProject` writes a three-member worker pool -- `worker` (strong),
 * `worker-standard`, `worker-cheap` -- so the tier floor has somewhere to land
 * on a project nobody has configured. They are DECLARATIONS: no probe has run
 * them, so nothing knows whether their flags take effect.
 *
 * Connecting a worker for the same model would otherwise leave two profiles
 * pinning it: one verified, one not, both in the pool, and routing free to pick
 * the unverified one. That is strictly worse than before the connection --
 * somebody paid for a probe and the thing it verified might not be what runs.
 *
 * So the default is retired, and ONLY when all three hold: it pins the same
 * model, it is not the profile just written, and it has never been probed. A
 * profile with a connection record is somebody's verified choice and is never
 * removed by a side effect of connecting something else.
 */
async function retireSupersededDefaultWorker(
  repoRoot: string,
  agent: CatalogueAgent,
  keep: string
): Promise<void> {
  if (agent.model === null) return;
  const dir = path.join(repoRoot, ".hivemind", "adapters");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".profile.json")) continue;
    const name = entry.slice(0, -".profile.json".length);
    if (name !== "worker" && !name.startsWith("worker-")) continue;
    if (name === keep) continue;
    if ((await readConnectionRecord(repoRoot, name)) !== null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(dir, entry), "utf8"));
    } catch {
      continue;
    }
    const invoke = isRecord(raw) && Array.isArray(raw.invoke)
      ? raw.invoke.filter((value): value is string => typeof value === "string")
      : [];
    if (modelFromInvoke(invoke) !== agent.model) continue;
    await rm(path.join(dir, entry), { force: true });
  }
}

function connectionRecordPath(repoRoot: string, profileName: string): string {
  return path.join(repoRoot, ".hivemind", "adapters", `${profileName}.connection.json`);
}

async function readConnectionRecord(
  repoRoot: string,
  profileName: string
): Promise<ConnectionRecord | null> {
  return (await readConnectionRecordStanding(repoRoot, profileName)).record;
}

async function readConnectionRecordStanding(
  repoRoot: string,
  profileName: string
): Promise<{ record: ConnectionRecord | null; problem: string | null }> {
  const file = connectionRecordPath(repoRoot, profileName);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return { record: null, problem: null };
    return { record: null, problem: `connection evidence could not be read: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { record: null, problem: `connection evidence is corrupt JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!isConnectionRecord(parsed)) {
    return { record: null, problem: "connection evidence is malformed and was not treated as a successful check" };
  }
  return { record: parsed, problem: null };
}

function isConnectionRecord(value: unknown): value is ConnectionRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.agent_id !== "string" ||
    typeof value.connected_at !== "string" ||
    typeof value.effective_tokens !== "number" ||
    !Number.isFinite(value.effective_tokens) ||
    value.effective_tokens < 0 ||
    !isNullableString(value.readback_source) ||
    !isNullableString(value.provider_version) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((entry) => isRecord(entry))
  ) {
    return false;
  }
  if (value.capabilities_stale !== undefined && !isNullableString(value.capabilities_stale)) return false;
  if (value.config_digest !== undefined && !isNullableString(value.config_digest)) return false;
  if (
    value.machine !== undefined &&
    (!isRecord(value.machine) ||
      typeof value.machine.host !== "string" ||
      typeof value.machine.platform !== "string" ||
      !isNullableString(value.machine.account_home))
  ) {
    return false;
  }
  if (value.inner_provider !== undefined && value.inner_provider !== null && !isRecord(value.inner_provider)) {
    return false;
  }
  if (
    value.verdict_source !== undefined &&
    (!isRecord(value.verdict_source) ||
      value.verdict_source.kind !== "machine_cache" ||
      typeof value.verdict_source.measured_at !== "string")
  ) {
    return false;
  }
  return true;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMissingFile(value: unknown): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === "ENOENT";
}

/**
 * The file a role's profile lives in.
 *
 * `planner` and `manager` are resolved BY NAME -- `plan.prepare` asks for
 * "planner" -- so their files must be named for the role and there can only be
 * one of each. `worker` is different: routing never asks for it by name, it
 * SEARCHES `.hivemind/adapters` and picks among everything admitting the worker
 * role. That search is what the tier floor and the task-type preference act on.
 *
 * Naming a worker profile `worker.profile.json` therefore capped the pool at
 * one member, and a pool of one leaves the tier floor nothing to choose
 * between. Every measurement behind tier routing came from hand-written files
 * with names like `codex-luna.profile.json` -- names no amount of clicking
 * could produce. See docs/AUDIT-FINDINGS.md F-2.
 *
 * So a worker profile is named for the (provider, model) it runs, and several
 * can coexist. Existing `worker.profile.json` files keep working untouched:
 * the search reads whatever is there.
 */
export function profileNameFor(role: AdapterRoleName, agentId: string): string {
  return role === "worker" ? `worker-${agentId}` : role;
}

export function buildProfileForAgent(agent: CatalogueAgent, role: AdapterRoleName): AdapterProfile | null {
  if (agent.invoke === null || agent.usage_parser === null) return null;
  return {
    /* Core resolves an adapter by the tool name the caller sends. Orchestrators
       are asked for by role, so their tool IS the role; workers are searched
       for, so theirs names the pool member. `validateAdapterProfile` checks
       this against the filename, and the quota ledger is keyed by it. */
    tool: profileNameFor(role, agent.id),
    invoke: [...agent.invoke],
    prompt_arg: agent.prompt_arg,
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
 * Start one provider CLI's own sign-in flow without crossing the credential
 * boundary.
 *
 * The only client input is a catalogue provider id. That id selects fixed argv
 * recorded beside the provider invocation; no executable, argument, URL,
 * token, or environment value can be supplied through the action. The child
 * receives the same selected provider home an ordinary probe would use, but
 * Hivemind never reads that directory. A separate read-only action may ask the
 * CLI for a boolean login standing, but this launcher receives no result.
 */
export async function startProviderAuthentication(
  repoRoot: string,
  providerId: string,
  options: { launcher?: AuthenticationLauncher; innerProviderId?: string } = {}
): Promise<ActionResult> {
  const authentication = providerAuthentication(providerId);
  if (authentication === null) {
    return { ok: false, reason: `unknown provider sign-in: ${providerId}` };
  }
  /* A multiplier sign-in may preselect WHICH provider the harness logs into.
     The composition lives in the catalogue (fixed base argv + `-p <registry
     id>` from the sanction allowlist), and it refuses — prohibited by name,
     unknown as unknown — BEFORE anything launches, so the refusal costs
     nothing and no terminal opens for a combination the product will not
     connect anyway. */
  let command = authentication.command;
  let experience = authentication.experience;
  let detail = authentication.detail;
  if (options.innerProviderId !== undefined) {
    const inner = providerAuthenticationForInner(providerId, options.innerProviderId);
    if (!inner.ok) return { ok: false, reason: inner.reason };
    command = inner.command;
    experience = inner.experience;
    detail = inner.detail;
  }
  const accounts = await readAccounts(repoRoot);
  const selected = selectedAccount(accounts, providerId);
  const started = await appendEvent(repoRoot, {
    type: "provider.setup_started",
    task_id: null,
    data: { provider_id: providerId, operation: "sign_in" }
  });
  if (!started.ok) return { ok: false, reason: `could not record provider sign-in start: ${started.reason}` };
  const authenticationEnvironment = spawnEnvironment(process.env, accountEnvironment(selected));
  if (options.launcher === undefined && !(await providerCommandAvailable(command[0], { env: authenticationEnvironment }))) {
    const failed = await appendEvent(repoRoot, {
      type: "provider.setup_failed",
      task_id: null,
      data: { provider_id: providerId, operation: "sign_in", reason_code: "provider_cli_missing" }
    });
    if (!failed.ok) return { ok: false, reason: `the provider CLI is missing, and that failure could not be recorded: ${failed.reason}` };
    return { ok: false, reason: `${providerId}'s command-line provider could not be found; no sign-in window was opened` };
  }
  try {
    await (options.launcher ?? launchAuthentication)(command, {
      cwd: repoRoot,
      env: authenticationEnvironment
    });
  } catch (cause) {
    const failed = await appendEvent(repoRoot, {
      type: "provider.setup_failed",
      task_id: null,
      data: { provider_id: providerId, operation: "sign_in", reason_code: "provider_cli_start_failed" }
    });
    if (!failed.ok) {
      return { ok: false, reason: `the provider sign-in window did not open, and that failure could not be recorded: ${failed.reason}` };
    }
    return {
      ok: false,
      reason: `could not open the provider's sign-in window: ${cause instanceof Error ? cause.message : String(cause)}`
    };
  }
  const completed = await appendEvent(repoRoot, {
    type: "provider.setup_completed",
    task_id: null,
    data: { provider_id: providerId, operation: "sign_in", outcome: "window_opened" }
  });
  if (!completed.ok) return { ok: false, reason: `the provider sign-in window opened, but that fact could not be recorded: ${completed.reason}` };
  return {
    ok: true,
    value: {
      provider_id: providerId,
      experience,
      detail
    }
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
  return connectCatalogueAgent(repoRoot, role, agent, options);
}

/**
 * Connect a model the selected provider's own no-cost list command returned.
 *
 * Discovery is repeated inside Core at action time. The client therefore
 * cannot turn an arbitrary string into a provider argument by forging an
 * option in the picker; the slug must be present in a fresh CLI-owned result.
 */
export async function connectDiscoveredAdapter(
  repoRoot: string,
  role: AdapterRoleName,
  providerId: string,
  modelSlug: string,
  options: { discoveryRunner?: ModelDiscoveryRunner; probe?: ProbeOptions } = {}
): Promise<ActionResult> {
  const discovered: ModelDiscoveryView = await discoverProviderModels(repoRoot, {
    runner: options.discoveryRunner
  });
  const provider = discovered.providers.find((entry) => entry.provider_id === providerId);
  if (
    provider?.status !== "detected" ||
    !provider.models.some((model) => model.slug === modelSlug)
  ) {
    return {
      ok: false,
      reason: `model ${modelSlug} is not in the current model list reported by ${providerId}`
    };
  }
  const agent = catalogueAgentForDiscoveredModel(providerId, modelSlug);
  if (agent === null) {
    return { ok: false, reason: `${providerId} cannot run the detected model ${modelSlug}` };
  }
  return connectCatalogueAgent(repoRoot, role, agent, options.probe ?? {});
}

async function connectCatalogueAgent(
  repoRoot: string,
  role: AdapterRoleName,
  agent: CatalogueAgent,
  options: ProbeOptions
): Promise<ActionResult> {
  if (agent.invoke === null) {
    return {
      ok: false,
      reason: `${agent.label} cannot be connected yet: ${agent.caveat ?? "it has no working invocation"}`
    };
  }

  /* The inner-provider gate, FIRST — before the project config write and
     before the probe — so a prohibited combination is refused while it still
     costs nothing: no file touched, no provider call made. Judged from the
     typed sanction, and it covers both connect doors, because the discovered
     path funnels through here too. */
  const innerProvider = judgeInnerProvider(agent.harness, agent.model);
  if (innerProvider.refusal !== null) {
    return { ok: false, reason: innerProvider.refusal };
  }

  /* Hostile settings in the harness's OWN config, refused before the probe.
     This replaces a `-c` override that was measured inert: passing a flag the
     harness accepts, self-reports as applied and echoes in its stream is not a
     prevention when behaviour disagrees. What cannot be forced off is detected
     and refused instead, which is a boundary that holds because nothing runs
     until the person changes it. Costs nothing: no file written, no call made. */
  const hostile = await findHostileHarnessSettings(
    agent.harness,
    selectedAccount(await readAccounts(repoRoot), agent.harness)?.home_dir ?? null
  );
  if (hostile.length > 0) {
    const first = hostile[0]!;
    return {
      ok: false,
      reason: `${agent.label} cannot be connected while its own ${first.file} carries a setting Hivemind cannot switch off. ${first.why} ${first.remedy}`
    };
  }

  const profile = buildProfileForAgent(agent, role);
  if (profile === null) return { ok: false, reason: `${agent.label} has no usable profile shape` };

  /* Checked against the profile's own name, which for a worker is the pool
     member rather than the role. */
  const problems = validateAdapterProfile(profile, profile.tool);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };

  /* Before the probe, because the probe reads the resolved table this creates.
     OpenCode's denial lives in a project file rather than in the argv, and
     nothing had ever written it -- so in every project Hivemind set up, the
     resolved table was a wildcard allow with no rule for the shell. */
  const projectConfig = await ensureHarnessProjectConfig(repoRoot, agent.harness);

  /* A first connection has no connection record, so adapter spawn cannot yet
     derive the harness from the role. Pass the selected home explicitly for
     the probe; after success the record makes ordinary role-based lookup
     authoritative. Without this, the UI could select one account and verify a
     different default login. */
  const accountsForProbe = await readAccounts(repoRoot);
  const accountForProbe = selectedAccount(accountsForProbe, agent.harness);

  /* A verdict this machine already measured, for this exact binary, account,
     version and harness configuration.

     A probe measures one binary, one account, one machine -- never a project --
     so re-probing those same three for a second project pays a real provider
     call to learn what is already known. That was the worst friction in the
     product: three providers on a new project meant three paid calls and about
     a minute of waiting, per project.

     Every input that could change the answer is part of the key, so a new
     binary version, a switched account or a changed instruction file misses and
     pays for a fresh probe. See `verdict-cache.ts` for why this cannot become a
     verdict inherited from somebody else's machine: it lives outside every
     repository and carries the machine identity that adoption re-checks.

     The version read is free -- `--version` on the installed binary, no model
     call -- which is what makes the lookup possible before deciding to probe. */
  const machine = currentMachine(accountForProbe?.home_dir ?? null);
  const configDigestNow = await harnessConfigDigest(repoRoot, (harness) =>
    selectedAccount(accountsForProbe, harness)?.home_dir ?? null
  );
  const versionNow =
    agent.invoke === null
      ? null
      : await readAdapterVersion(agent.invoke, repoRoot).catch(() => null);
  const cacheInputs = {
    agentId: agent.id,
    harness: agent.harness,
    providerVersion: versionNow,
    configDigest: configDigestNow,
    machine
  };
  /* A caller that supplies its own probe runner is testing the probe; adopting
     a cached verdict would silently skip the thing under test. */
  const mayUseCache = options.runner === undefined && options.readback === undefined;
  const cached = mayUseCache ? await readCachedVerdict(cacheInputs) : null;
  if (cached !== null) {
    const dir = path.join(repoRoot, ".hivemind", "adapters");
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, `${profile.tool}.profile.json`), profile);
    if (role === "worker") await retireSupersededDefaultWorker(repoRoot, agent, profile.tool);
    const adopted: ConnectionRecord = {
      agent_id: agent.id,
      connected_at: new Date().toISOString(),
      effective_tokens: cached.effective_tokens,
      readback_source: cached.readback_source,
      provider_version: cached.provider_version,
      machine,
      config_digest: configDigestNow,
      capabilities: cached.capabilities,
      inner_provider: innerProvider.standing,
      capabilities_stale: null,
      verdict_source: { kind: "machine_cache", measured_at: cached.measured_at }
    };
    await writeJsonAtomic(connectionRecordPath(repoRoot, profile.tool), adopted);
    const inspectedFromCache = await inspectProjectConfig(repoRoot);
    return inspectedFromCache.ok
      ? {
          ok: true,
          value: {
            probe: {
              agent_id: agent.id,
              tool: profile.tool,
              ok: true,
              refusal: null,
              capabilities: cached.capabilities,
              effective_tokens: 0,
              wall_time_ms: 0,
              readback_source: cached.readback_source,
              /* Zero tokens because this connection spent none. The figure the
                 measurement cost is on the record, not on this result. */
              adopted_from_machine_cache: cached.measured_at
            },
            config: inspectedFromCache.value,
            project_config: projectConfig
          }
        }
      : inspectedFromCache;
  }

  const probe = await probeAdapter(repoRoot, agent, profile, {
    ...options,
    accountEnv: accountEnvironment(accountForProbe)
  });
  if (!probe.ok) {
    return {
      ok: false,
      reason: probe.refusal ?? "the probe did not pass",
      /* The delta is the useful part, so it travels with the refusal. */
      ...({ probe } as Record<string, unknown>)
    } as ActionResult;
  }

  const accountsFileForDigest = await readAccounts(repoRoot);
  const dir = path.join(repoRoot, ".hivemind", "adapters");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, `${profile.tool}.profile.json`), profile);
  if (role === "worker") await retireSupersededDefaultWorker(repoRoot, agent, profile.tool);
  const record: ConnectionRecord = {
    agent_id: agent.id,
    connected_at: new Date().toISOString(),
    effective_tokens: probe.effective_tokens,
    readback_source: probe.readback_source,
    provider_version: probe.provider_version,
    /* Where this probe actually ran, so a later read can tell whether the
       verdict was made here or somewhere else. */
    machine: currentMachine(
      selectedAccount(await readAccounts(repoRoot), agent.harness)?.home_dir ?? null
    ),
    /* Taken from the same files `provider-endpoint.ts` already opened during
       this probe, so the timing hole closes for one extra read. */
    /* The whole project's inherited surface, not this harness's corner of it.
       Every harness reads every other harness's instruction files -- measured
       -- so a verdict scoped to one binary was scoped to the wrong thing. */
    config_digest: await harnessConfigDigest(repoRoot, (harness) =>
      selectedAccount(accountsFileForDigest, harness)?.home_dir ?? null
    ),
    capabilities: probe.capabilities,
    /* The standing the person was shown when they connected. */
    inner_provider: innerProvider.standing,
    /* A fresh probe is a fresh verification, so whatever made the previous one
       stale is answered by having run this one. */
    capabilities_stale: null
  };
  /* A worker is a pool member, not the generic role. Store its evidence next
     to the exact profile it proves; otherwise inspection and subsequent
     account lookup search for `worker-<agent>.connection.json` while connect
     silently writes `worker.connection.json`, making a passed probe invisible. */
  await writeJsonAtomic(connectionRecordPath(repoRoot, profile.tool), record);

  /* Remembered for this machine, so the next project does not pay for it
     again. Written after the record, so a cache write that fails leaves a
     project that is correctly connected rather than a connection that failed
     for a caching reason. */
  if (mayUseCache) {
    await writeCachedVerdict(cacheInputs, {
      capabilities: probe.capabilities,
      effective_tokens: probe.effective_tokens,
      readback_source: probe.readback_source,
      provider_version: probe.provider_version,
      measured_at: record.connected_at,
      machine,
      config_digest: configDigestNow
    });
  }

  const inspected = await inspectProjectConfig(repoRoot);
  /* The write travels with the result. Putting a file into somebody's project
     is a side effect of connecting, and a side effect nobody is told about is
     how `.hivemind/` ended up in a git history. */
  return inspected.ok
    ? { ok: true, value: { probe, config: inspected.value, project_config: projectConfig } }
    : inspected;
}

function modelFromInvoke(invoke: string[]): string | null {
  const at = invoke.findIndex((arg) => arg === "--model" || arg === "-m");
  return at >= 0 && at + 1 < invoke.length ? invoke[at + 1]! : null;
}

/**
 * Mark a role's recorded capabilities as no longer describing what will run.
 *
 * Deliberately does NOT delete them. The previous verification is still the
 * best available description of the tool and profile; what changed is that it
 * was measured under a different account, and the honest presentation is
 * "measured, but not for what is running now" rather than a blank. The client
 * renders it the same way it renders an unverified capability, which is the
 * pattern that already exists rather than a second one.
 */
export async function invalidateVerificationForHarness(
  repoRoot: string,
  harness: string,
  reason: string
): Promise<void> {
  /* Every profile, not every role: a worker pool holds several and each was
     probed under whichever account was selected at the time, so each one's
     verification goes stale independently. Iterating roles would have
     invalidated one member of the pool and left the rest asserting a
     verification nobody re-ran. */
  for (const { name } of await adapterProfileNames(repoRoot)) {
    /* Resolved through the connection record, NOT the profile's `tool` -- a
       profile's tool is the ROLE, so comparing it to a harness matched nothing
       and invalidated nothing. Same indirection the account and endpoint paths
       needed, missed in all three on the same day. */
    if ((await harnessForRole(repoRoot, name)) !== harness) continue;
    const record = await readConnectionRecord(repoRoot, name);
    if (record === null) continue;
    await writeJsonAtomic(connectionRecordPath(repoRoot, name), {
      ...record,
      capabilities_stale: reason
    });
  }
}

/**
 * Which accounts exist, which role runs as which, and what each has spent.
 *
 * Spend is NOT computed here: it comes from `routing.observed` in the trail,
 * which the client already sums for its usage panel. This action reports who
 * the accounts are; the trail reports what they cost. Keeping those apart is
 * what stops a second, disagreeing spend number from existing.
 */
export async function inspectProviderAccounts(repoRoot: string): Promise<ActionResult> {
  const file = await readAccounts(repoRoot);
  const config = await inspectProjectConfig(repoRoot);
  if (!config.ok) return config;
  const inspected = config.value as { adapters: InspectedAdapter[] };
  return {
    ok: true,
    value: {
      accounts: file.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        harness: account.harness,
        /* The directory, so a person can tell two accounts apart. It is a path,
           never a credential -- Hivemind does not read inside it. */
        home_dir: account.home_dir,
        added_at: account.added_at
      })),
      /* Which harnesses can be switched at all, and the one variable each is
         switched with. Reported so the surface never offers a control for a
         harness Hivemind cannot actually point anywhere. */
      switchable: ACCOUNT_HOME_VARIABLES,
      roles: inspected.adapters.map((adapter) => ({
        role: adapter.role,
        tool: adapter.tool,
        account: adapter.account,
        capabilities_stale: adapter.capabilities_stale,
        connected_at: adapter.connected_at
      }))
    }
  };
}

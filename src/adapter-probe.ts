import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  findDangerousAdapterArgs,
  findRefusedAdapterModes,
  parseAdapterProviderUsage,
  runAdapterProcess,
  type AdapterProfile
} from "./adapter.js";
import type { CatalogueAgent } from "./agent-catalogue.js";

/**
 * Verifying an agent instead of believing it.
 *
 * `validateAdapterProfile` checks fields and `findDangerousAdapterArgs` refuses
 * bypass flags at spawn. Neither has ever confirmed that a flag TOOK EFFECT,
 * and this project has been bitten by exactly that twice:
 *
 *   - `--ignore-user-config` silently forced a read-only sandbox, so a worker
 *     that could not write anything was reported as fine;
 *   - separately, a model pin was silently ignored for months and an older
 *     model ran while config said otherwise.
 *
 * Both were a flag being ACCEPTED without being APPLIED. So connecting an agent
 * runs it once and compares what the provider reports against what the profile
 * asked for. The result reports the delta, not the request.
 *
 * Where a provider reports nothing to compare against, the capability comes
 * back `unverified` — never `verified`. An unverified capability is a stated
 * gap, and a spending limit built on unverified usage numbers is worse than no
 * integration at all.
 */

export type CapabilityStatus = "verified" | "failed" | "unverified";

export interface ProbedCapability {
  id:
    | "no_bypass_flags"
    | "non_interactive"
    | "pins_one_model"
    | "confined_to_project"
    | "reports_usage"
    | "subagents_disabled";
  label: string;
  status: CapabilityStatus;
  /** What the profile asked for, where there is something to ask for. */
  requested: string | null;
  /** What the provider said it actually did. Null when it said nothing. */
  reported: string | null;
  detail: string;
  /** A failed required capability refuses the connection. */
  required: boolean;
}

export interface AdapterProbeResult {
  agent_id: string;
  tool: string;
  ok: boolean;
  /** Set when the probe could not be run at all, rather than run and failed. */
  refusal: string | null;
  capabilities: ProbedCapability[];
  effective_tokens: number;
  wall_time_ms: number;
  readback_source: string | null;
}

export interface ProbeRunner {
  (input: {
    repoRoot: string;
    profile: AdapterProfile;
    prompt: string;
    nonceFile: string;
  }): Promise<ProbeObservation>;
}

/** What one probe run observed, independent of which agent produced it. */
export interface ProbeObservation {
  ok: boolean;
  reason: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  wallTimeMs: number;
  effectiveTokens: number;
  /** True when the nonce file exists in the project with the expected content. */
  wroteNonceFile: boolean;
}

/** The startup facts a provider reports back, once normalised. */
export interface ProbeReadback {
  source: string;
  model: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
  workspaceRoots: string[];
  subagents: string | null;
}

const PROBE_DIR = path.join(".hivemind", "probe");

/**
 * The probe drops `--ephemeral` from the profile's own argv, and nothing else.
 *
 * That flag only decides whether the provider persists a session record, and
 * the session record is where the model and sandbox readback comes from. Every
 * other flag is the profile's, because probing a different invocation would
 * prove nothing about the one that will actually run work.
 */
export function probeInvocation(invoke: string[]): string[] {
  return invoke.filter((arg) => arg !== "--ephemeral");
}

export function probeProfile(profile: AdapterProfile): AdapterProfile {
  return { ...profile, invoke: probeInvocation(profile.invoke), timeout_ms: 240_000 };
}

function capability(
  id: ProbedCapability["id"],
  label: string,
  required: boolean,
  status: CapabilityStatus,
  detail: string,
  requested: string | null = null,
  reported: string | null = null
): ProbedCapability {
  return { id, label, status, requested, reported, detail, required };
}

/** The model the profile pins, taken from its own argv. */
export function requestedModel(invoke: string[]): string | null {
  const at = invoke.findIndex((arg) => arg === "--model" || arg === "-m");
  return at >= 0 && at + 1 < invoke.length ? invoke[at + 1]! : null;
}

export function requestedSandbox(invoke: string[]): string | null {
  const at = invoke.findIndex((arg) => arg === "--sandbox" || arg === "-s");
  return at >= 0 && at + 1 < invoke.length ? invoke[at + 1]! : null;
}

/**
 * Codex writes a rollout file per session whose `turn_context` record states
 * the model, the sandbox policy and the approval policy that were actually
 * resolved. The file is found by the `thread_id` the run prints on its own
 * stdout, so this never has to guess which file belongs to which run.
 *
 * Verified against codex-cli 0.147.0 on 2026-08-11. If the shape changes, the
 * readback returns null and the capabilities that depend on it come back
 * unverified — which is the correct failure, because an unrecognised record is
 * not evidence of anything.
 */
export async function readCodexRollback(stdout: string): Promise<ProbeReadback | null> {
  const threadId = /"thread_id"\s*:\s*"([0-9a-f-]+)"/iu.exec(stdout)?.[1];
  if (threadId === undefined) return null;
  const root = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const file = await findFileContaining(path.join(root, "sessions"), threadId);
  if (file === null) return null;

  let lines: string[];
  try {
    lines = (await readFile(file, "utf8")).split(/\r?\n/u);
  } catch {
    return null;
  }
  for (const line of lines) {
    if (line.trim() === "" || !line.includes('"turn_context"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "turn_context" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    const sandbox = isRecord(payload.sandbox_policy) ? payload.sandbox_policy.type : null;
    return {
      source: path.basename(file),
      model: typeof payload.model === "string" ? payload.model : null,
      sandbox: typeof sandbox === "string" ? sandbox : null,
      approvalPolicy: typeof payload.approval_policy === "string" ? payload.approval_policy : null,
      workspaceRoots: Array.isArray(payload.workspace_roots)
        ? payload.workspace_roots.filter((entry): entry is string => typeof entry === "string")
        : [],
      subagents:
        typeof payload.multi_agent_version === "string" ? payload.multi_agent_version : null
    };
  }
  return null;
}

async function findFileContaining(dir: string, needle: string, depth = 0): Promise<string | null> {
  if (depth > 6) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileContaining(full, needle, depth + 1);
      if (found !== null) return found;
    } else if (entry.name.includes(needle)) {
      return full;
    }
  }
  return null;
}

/** The default runner: one real call through the profile's own argv. */
export const liveProbeRunner: ProbeRunner = async ({ repoRoot, profile, prompt, nonceFile }) => {
  const started = Date.now();
  const result = await runAdapterProcess(repoRoot, profile, repoRoot, prompt, {
    usageSessionId: `probe-${profile.tool}`
  });
  const wrote = await nonceFileWritten(repoRoot, nonceFile);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      stdout: "",
      stderr: "",
      exitCode: result.exitCode ?? -1,
      timedOut: false,
      wallTimeMs: result.wallTimeMs ?? Date.now() - started,
      effectiveTokens: result.effectiveTokens ?? 0,
      wroteNonceFile: wrote
    };
  }
  return {
    ok: result.value.exitCode === 0 && !result.value.timedOut,
    reason: null,
    stdout: result.value.stdout,
    stderr: result.value.stderr,
    exitCode: result.value.exitCode,
    timedOut: result.value.timedOut,
    wallTimeMs: result.value.wallTimeMs,
    effectiveTokens:
      result.value.providerUsageCapture.status === "captured"
        ? (result.value.providerUsageCapture.usage.total_tokens ?? 0)
        : 0,
    wroteNonceFile: wrote
  };
};

async function nonceFileWritten(repoRoot: string, nonceFile: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(repoRoot, PROBE_DIR, nonceFile), "utf8");
    return text.includes(nonceFile.replace(/\.txt$/u, ""));
  } catch {
    return false;
  }
}

export interface ProbeOptions {
  runner?: ProbeRunner;
  readback?: (stdout: string) => Promise<ProbeReadback | null>;
  nonce?: string;
}

export async function probeAdapter(
  repoRoot: string,
  agent: CatalogueAgent,
  profile: AdapterProfile,
  options: ProbeOptions = {}
): Promise<AdapterProbeResult> {
  const capabilities: ProbedCapability[] = [];

  /* Preflight. A profile carrying a bypass flag or a refused orchestration
     mode is not probed at all -- running it would be the very thing the flag
     is refused for. */
  const dangerous = findDangerousAdapterArgs(profile.invoke);
  const refusedModes = findRefusedAdapterModes(profile, process.env);
  if (dangerous.length > 0 || refusedModes.length > 0) {
    const problems = [...dangerous, ...refusedModes].join(", ");
    return {
      agent_id: agent.id,
      tool: profile.tool,
      ok: false,
      refusal: `refused before running: this profile carries ${problems}`,
      capabilities: [
        capability(
          "no_bypass_flags",
          "Carries no permission-bypass flags",
          true,
          "failed",
          `Refused before it was run: ${problems}.`
        )
      ],
      effective_tokens: 0,
      wall_time_ms: 0,
      readback_source: null
    };
  }
  capabilities.push(
    capability(
      "no_bypass_flags",
      "Carries no permission-bypass flags",
      true,
      "verified",
      "Checked against the refused-flag list before the agent was started, and again every time it runs."
    )
  );

  const nonce = options.nonce ?? `probe-${Date.now().toString(36)}`;
  const nonceFile = `${nonce}.txt`;
  await mkdir(path.join(repoRoot, PROBE_DIR), { recursive: true });

  const prompt = [
    `Write the text ${nonce} into a new file called ${PROBE_DIR.replace(/\\/gu, "/")}/${nonceFile}.`,
    "Do not read anything else, do not verify it, and do not change any other file."
  ].join(" ");

  const runner = options.runner ?? liveProbeRunner;
  let observation: ProbeObservation;
  try {
    observation = await runner({ repoRoot, profile: probeProfile(profile), prompt, nonceFile });
  } finally {
    /* The probe leaves nothing behind in the person's project. */
  }

  const readbackFn =
    options.readback ?? (agent.readback === "codex-rollout" ? readCodexRollback : async () => null);
  const readback = observation.stdout === "" ? null : await readbackFn(observation.stdout);

  /* Runs without prompting: it exited on its own, inside the timeout, with
     nothing attached to stdin. Where the provider also states its approval
     policy, that is reported beside it. */
  capabilities.push(
    observation.timedOut
      ? capability(
          "non_interactive",
          "Runs without asking you anything",
          true,
          "failed",
          "It did not finish inside the timeout, which is what waiting for input looks like from outside.",
          "no prompts",
          "timed out"
        )
      : observation.ok
        ? capability(
            "non_interactive",
            "Runs without asking you anything",
            true,
            "verified",
            `It finished on its own in ${Math.round(observation.wallTimeMs / 1000)}s with nothing attached to its input.`,
            "no prompts",
            readback?.approvalPolicy ?? "exited on its own"
          )
        : capability(
            "non_interactive",
            "Runs without asking you anything",
            true,
            "failed",
            observation.reason ?? `It exited with code ${observation.exitCode}.`,
            "no prompts",
            `exit ${observation.exitCode}`
          )
  );

  /* Stays inside the project. Two independent proofs: the provider's own
     resolved sandbox policy, and whether the file it was asked to write is
     actually on disk. The second is what catches a silently read-only
     sandbox, because a read-only run reports success and writes nothing. */
  const wantedSandbox = requestedSandbox(profile.invoke);
  capabilities.push(
    observation.wroteNonceFile && readback?.sandbox === "workspace-write"
      ? capability(
          "confined_to_project",
          "Can write in this project, and only here",
          true,
          "verified",
          `It reported a ${readback.sandbox} sandbox rooted at this project, and the file it was asked to write is on disk.`,
          wantedSandbox,
          readback.sandbox
        )
      : observation.wroteNonceFile
        ? capability(
            "confined_to_project",
            "Can write in this project, and only here",
            true,
            "unverified",
            "The file it was asked to write is on disk, so it is not silently read-only — but this agent does not report which sandbox it applied, so the confinement itself is unconfirmed.",
            wantedSandbox,
            readback?.sandbox ?? null
          )
        : capability(
            "confined_to_project",
            "Can write in this project, and only here",
            true,
            "failed",
            "It was asked to write one file in this project and no file appeared. A sandbox that was silently downgraded to read-only looks exactly like this.",
            wantedSandbox,
            readback?.sandbox ?? "wrote nothing"
          )
  );

  /* Runs one exact model. The pin travels on the command line; the readback is
     the only evidence it took effect. */
  const wantedModel = requestedModel(profile.invoke);
  capabilities.push(
    readback?.model == null
      ? capability(
          "pins_one_model",
          "Runs the one model you chose",
          true,
          "unverified",
          "This agent does not report which model it loaded, so the pin was sent but cannot be read back. A pin that is silently ignored looks identical to one that worked.",
          wantedModel,
          null
        )
      : wantedModel !== null && readback.model !== wantedModel
        ? capability(
            "pins_one_model",
            "Runs the one model you chose",
            true,
            "failed",
            `It was asked for ${wantedModel} and reported running ${readback.model}.`,
            wantedModel,
            readback.model
          )
        : capability(
            "pins_one_model",
            "Runs the one model you chose",
            true,
            "verified",
            `It reported running ${readback.model}, which is what was asked for.`,
            wantedModel,
            readback.model
          )
  );

  /* Reports usage. The configured parser has to find real numbers in this
     run's own output -- not in a fixture, and not in a different run. */
  const parser = profile.usage_parser;
  const usage =
    parser === undefined
      ? null
      : parseAdapterProviderUsage(parser, observation.stdout, observation.stderr);
  const totalTokens = usage?.total_tokens ?? 0;
  capabilities.push(
    parser === undefined
      ? capability(
          "reports_usage",
          "Reports what it spent",
          true,
          "failed",
          "No usage parser is configured for this agent, so nothing it spends can be counted and no ceiling could hold.",
          null,
          null
        )
      : totalTokens > 0
        ? capability(
            "reports_usage",
            "Reports what it spent",
            true,
            "verified",
            `The ${parser} reader found ${totalTokens.toLocaleString()} tokens in this run's own output.`,
            parser,
            `${totalTokens.toLocaleString()} tokens`
          )
        : capability(
            "reports_usage",
            "Reports what it spent",
            true,
            "failed",
            `The ${parser} reader found no token counts in this run's output. Spending limits would be built on nothing.`,
            parser,
            "nothing found"
          )
  );

  /* Subagents. Hivemind owns concurrency: one worker, one scope. An agent that
     can spawn its own fan-out underneath us breaks that ownership, and no
     provider currently reports whether it is switched off. */
  capabilities.push(
    capability(
      "subagents_disabled",
      "Does not start agents of its own",
      false,
      readback?.subagents == null ? "unverified" : "unverified",
      readback?.subagents == null
        ? "This agent does not report whether it can start sub-agents, so it is neither confirmed nor ruled out. Hivemind decides concurrency itself, and a nested fan-out would sit outside that."
        : `It reports a sub-agent capability (${readback.subagents}). Whether it is switched off for this profile is not something it reports, so this stays unconfirmed.`,
      "off",
      readback?.subagents ?? null
    )
  );

  await rm(path.join(repoRoot, PROBE_DIR), { recursive: true, force: true }).catch(() => undefined);

  const failed = capabilities.filter((entry) => entry.required && entry.status === "failed");
  return {
    agent_id: agent.id,
    tool: profile.tool,
    ok: failed.length === 0,
    refusal:
      failed.length === 0
        ? null
        : `this agent could not be connected: ${failed.map((entry) => entry.label.toLowerCase()).join("; ")}`,
    capabilities,
    effective_tokens: Math.max(observation.effectiveTokens, totalTokens),
    wall_time_ms: observation.wallTimeMs,
    readback_source: readback?.source ?? null
  };
}

export async function probeDirectoryExists(repoRoot: string): Promise<boolean> {
  try {
    return (await stat(path.join(repoRoot, PROBE_DIR))).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

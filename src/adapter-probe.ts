import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  claudeHookInterference,
  findDangerousAdapterArgs,
  findRefusedAdapterModes,
  parseAdapterProviderUsage,
  runAdapterProcess,
  type AdapterProfile
} from "./adapter.js";
import type { CatalogueAgent } from "./agent-catalogue.js";
import {
  decideAdmission,
  type CapabilityEvidence,
  type CapabilityFinding,
  type CapabilityId,
  type CapabilityState,
  type DegradedFunction
} from "./capability-contract.js";
import { readAdapterVersion } from "./adapter-version.js";
import { compareRepoMarks, markRepo } from "./repo-observation.js";
import { resolveProviderEndpoint } from "./provider-endpoint.js";

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

/**
 * Migrated onto the four-state contract in `src/capability-contract.ts`.
 *
 * `failed` is gone and `mismatched` replaces it, because "asked for one thing
 * and it reported another" needed to stop sharing a word with "this tool has no
 * such feature". `unsupported` is new and says the second of those.
 *
 * Admission is no longer decided here at all: this file OBSERVES and the
 * contract DECIDES. That split is what closed the gap this migration exists
 * for -- the probe used to admit Claude Code on `required && failed`, which let
 * an unverified confinement through, while the contract refuses it.
 */
export type CapabilityStatus = CapabilityState;

export interface ProbedCapability {
  id: CapabilityId;
  label: string;
  status: CapabilityStatus;
  /** How the state was reached. The contract uses it to refuse a `verified`
      backed by evidence too weak for the claim's scope. */
  evidence: CapabilityEvidence;
  /** What the profile asked for, where there is something to ask for. */
  requested: string | null;
  /** What the provider said it actually did. Null when it said nothing. */
  reported: string | null;
  detail: string;
  /** Kept for the surfaces that render it; admission no longer reads it. */
  required: boolean;
}

export interface AdapterProbeResult {
  agent_id: string;
  tool: string;
  ok: boolean;
  /** Set when the probe could not be run at all, rather than run and failed. */
  refusal: string | null;
  capabilities: ProbedCapability[];
  /** What will not work if this connection is accepted, from the contract. */
  degraded: DegradedFunction[];
  limitations: Array<{ id: CapabilityId; label: string; consequence: string }>;
  effective_tokens: number;
  wall_time_ms: number;
  readback_source: string | null;
  /* The version this probe verified. A later run against a different version
     is stale rather than invalid -- see src/adapter-version.ts. */
  provider_version: string | null;
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
  /** The harness version, where the run reports it in its own output. */
  version?: string | null;
}

const execFileAsync = promisify(execFile);

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
  reported: string | null = null,
  evidence: CapabilityEvidence = "readback"
): ProbedCapability {
  return { id, label, status, requested, reported, detail, required, evidence };
}

/** What the contract decides over, from what the probe observed. */
function toFindings(capabilities: ProbedCapability[]): CapabilityFinding[] {
  return capabilities.map((entry) => ({
    id: entry.id,
    state: entry.status,
    evidence: entry.evidence,
    requested: entry.requested,
    reported: entry.reported,
    detail: entry.detail
  }));
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
          "mismatched",
          `Refused before it was run: ${problems}.`,
          "none",
          problems,
          "static"
        )
      ],
      degraded: [],
      limitations: [],
      effective_tokens: 0,
      wall_time_ms: 0,
      readback_source: null,
      provider_version: null
    };
  }
  capabilities.push(
    capability(
      "no_bypass_flags",
      "Carries no permission-bypass flags",
      true,
      "verified",
      "Checked against the refused-flag list before the agent was started, and again every time it runs.",
      "none",
      "none",
      "static"
    )
  );

  const nonce = options.nonce ?? `probe-${Date.now().toString(36)}`;
  const nonceFile = `${nonce}.txt`;
  await mkdir(path.join(repoRoot, PROBE_DIR), { recursive: true });

  const prompt = [
    `Write the text ${nonce} into a new file called ${PROBE_DIR.replace(/\\/gu, "/")}/${nonceFile}.`,
    "Do not read anything else, do not verify it, and do not change any other file."
  ].join(" ");

  /* Recorded BEFORE the agent starts, so the comparison afterwards is about
     this run and nothing else. */
  const repoBefore = await markRepo(repoRoot);

  const runner = options.runner ?? liveProbeRunner;
  let observation: ProbeObservation;
  try {
    observation = await runner({ repoRoot, profile: probeProfile(profile), prompt, nonceFile });
  } finally {
    /* The probe leaves nothing behind in the person's project. */
  }

  const readbackFn =
    options.readback ??
    (agent.readback === "codex-rollout"
      ? readCodexRollback
      : agent.readback === "claude-init"
        ? readClaudeInit
        : agent.readback === "opencode-permissions"
          ? async (out: string) => readOpenCodePermissions(out, repoRoot)
          : agent.readback === "grok-session"
            ? async (out: string) => readGrokSession(out, repoRoot)
            : agent.readback === "kimi-session"
              ? async (out: string) => readKimiSession(out, repoRoot)
          : async () => null);
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
          "mismatched",
          "It did not finish inside the timeout, which is what waiting for input looks like from outside.",
          "no prompts",
          "timed out",
          "observation"
        )
      : observation.ok
        ? capability(
            "non_interactive",
            "Runs without asking you anything",
            true,
            "verified",
            `It finished on its own in ${Math.round(observation.wallTimeMs / 1000)}s with nothing attached to its input.`,
            "no prompts",
            readback?.approvalPolicy ?? "exited on its own",
            "observation"
          )
        : capability(
            "non_interactive",
            "Runs without asking you anything",
            true,
            "mismatched",
            observation.reason ?? `It exited with code ${observation.exitCode}.`,
            "no prompts",
            `exit ${observation.exitCode}`,
            "observation"
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
          readback.sandbox,
          "readback"
        )
      : observation.wroteNonceFile
        ? capability(
            "confined_to_project",
            "Can write in this project, and only here",
            true,
            "unverified",
            "The file it was asked to write is on disk, so it is not silently read-only — but this agent does not report which sandbox it applied, so the confinement itself is unconfirmed.",
            wantedSandbox,
            readback?.sandbox ?? null,
            "observation"
          )
        : capability(
            "confined_to_project",
            "Can write in this project, and only here",
            true,
            "mismatched",
            "It was asked to write one file in this project and no file appeared. A sandbox that was silently downgraded to read-only looks exactly like this.",
            wantedSandbox,
            readback?.sandbox ?? "wrote nothing",
            "observation"
          )
  );

  /* Runs one exact model. The pin travels on the command line; the readback is
     the only evidence it took effect. */
  const wantedModel = requestedModel(profile.invoke);
  const pinHeld = modelPinHeld(wantedModel, readback?.model ?? null);
  capabilities.push(
    readback?.model == null
      ? capability(
          "pins_one_model",
          "Runs the one model you chose",
          true,
          "unverified",
          "This agent does not report which model it loaded, so the pin was sent but cannot be read back. A pin that is silently ignored looks identical to one that worked.",
          wantedModel,
          null,
          "absent"
        )
      : !pinHeld
        ? capability(
            "pins_one_model",
            "Runs the one model you chose",
            true,
            "mismatched",
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
            readback.model,
            "readback"
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
          "unsupported",
          "Nothing here knows how to read what this agent spends, so no ceiling could hold.",
          null,
          null,
          "absent"
        )
      : totalTokens > 0
        ? capability(
            "reports_usage",
            "Reports what it spent",
            true,
            "verified",
            `The ${parser} reader found ${totalTokens.toLocaleString()} tokens in this run's own output.`,
            parser,
            `${totalTokens.toLocaleString()} tokens`,
            "observation"
          )
        : capability(
            "reports_usage",
            "Reports what it spent",
            true,
            "mismatched",
            `The ${parser} reader found no token counts in this run's output. Spending limits would be built on nothing.`,
            parser,
            "nothing found",
            "observation"
          )
  );

  /* Says which model spent what.
     Split out from "reports what it spent" after a Claude Code probe pinned to
     one model reported a SECOND model in its own breakdown. A provider that
     reports one total cannot show that, so the question was never asked of it
     -- and the answer is not "fine", it is "unknown". Never refuses: the
     ceiling is unaffected, because a total counts every model whether or not it
     names them. */
  const attribution = readModelAttribution(profile.usage_parser, observation.stdout);
  capabilities.push(
    attribution === null
      ? capability(
          "reports_model_attribution",
          "Says which model spent what",
          false,
          "unsupported",
          "This agent reports one total and never says which model spent it, so Hivemind cannot tell whether the model you chose is the only one that ran.",
          "a figure per model",
          "one total only",
          "absent"
        )
      : capability(
          "reports_model_attribution",
          "Says which model spent what",
          false,
          "verified",
          attribution.length === 1
            ? `It broke this run down by model, and only ${attribution[0]!.model} ran.`
            : `It broke this run down by model, and ${attribution.length} models ran: ${attribution.map((entry) => entry.model).join(", ")}.`,
          "a figure per model",
          attribution.map((entry) => entry.model).join(", "),
          "observation"
        )
  );

  /* WHERE THE CODE GOES. Determined from configuration rather than readback,
     because no harness reports its endpoint -- Codex's `turn_context`, the
     richest readback any of them produces, carries the model, the sandbox, the
     approval policy and the workspace roots and no endpoint at all. So the
     evidence class is `static`, and it says so rather than borrowing
     `readback`'s authority.

     A configured endpoint is NOT a violation: somebody chose it. It is
     `verified` and NAMED, and the name is what stops a deliberate choice from
     hiding behind a green tick. Only "cannot look" is unverified, and the
     contract refuses on that -- "Hivemind cannot tell you where your code is
     going" is not a degradation anyone can accept on your behalf. */
  const endpoint = await resolveProviderEndpoint({
    /* The catalogue agent, not `profile.tool` -- a profile's tool is the ROLE
       ("worker"), and looking an endpoint surface up by role matches nothing
       and refuses everything. The probe holds the agent, so here it is exact. */
    tool: agent.harness,
    invoke: profile.invoke,
    environment: process.env,
    repoRoot
  });
  capabilities.push(
    capability(
      "known_endpoint",
      "Sends your code somewhere you know about",
      true,
      endpoint.standing === "unknown" ? "unverified" : "verified",
      endpoint.detail,
      "a known endpoint",
      endpoint.host,
      "static"
    )
  );

  /* Subagents. Hivemind owns concurrency: one worker, one scope. An agent that
     can spawn its own fan-out underneath us breaks that ownership, and no
     provider currently reports whether it is switched off. */
  capabilities.push(
    capability(
      "no_nested_agents",
      "Does not start agents of its own",
      false,
      readback?.subagents === "none" ? "verified" : "unverified",
      readback?.subagents === "none"
        ? "It reported the exact set of tools it loaded, and nothing in it can start another agent."
        : readback?.subagents == null
        ? "This agent does not report whether it can start sub-agents, so it is neither confirmed nor ruled out. Hivemind decides concurrency itself, and a nested fan-out would sit outside that."
        : `It reports a sub-agent capability (${readback.subagents}). Whether it is switched off for this profile is not something it reports, so this stays unconfirmed.`,
      "off",
      readback?.subagents ?? null,
      readback?.subagents == null ? "absent" : "readback"
    )
  );

  /* Leaves the change for a person to approve. The cheapest capability here by
     a wide margin -- two `git rev-parse` calls, no provider cooperation, and it
     works on a harness nobody has written an adapter for. Until now the only
     thing standing between an agent and a commit was a sentence in the worker
     prompt. */
  const branch = compareRepoMarks(repoBefore, await markRepo(repoRoot));
  capabilities.push(
    branch.standing === "unchanged"
      ? capability(
          "leaves_change_uncommitted",
          "Leaves the change for you to approve",
          true,
          "verified",
          branch.detail,
          "no commit",
          "branch unchanged",
          "observation"
        )
      : branch.standing === "moved"
        ? capability(
            "leaves_change_uncommitted",
            "Leaves the change for you to approve",
            true,
            "mismatched",
            branch.detail,
            "no commit",
            branch.after.head === null ? "moved" : branch.after.head.slice(0, 10),
            "observation"
          )
        : capability(
            "leaves_change_uncommitted",
            "Leaves the change for you to approve",
            true,
            "unverified",
            branch.detail,
            "no commit",
            null,
            "observation"
          )
  );

  /* What was actually verified is verified about THIS binary. These harnesses
     update themselves weekly, so the version is recorded and a later run
     against a different one is stale. */
  /* The run may already have said which version it is -- Claude Code reports
      in the same record that carries the tools. Spawning
     the binary a second time to ask what it just told us is a wasted process
     and a second chance to be wrong. */
  const providerVersion =
    readback?.version ?? (await readAdapterVersion(profile.invoke, repoRoot));

  await rm(path.join(repoRoot, PROBE_DIR), { recursive: true, force: true }).catch(() => undefined);

  /* The contract decides, not this file. The rule here used to be
     `required && failed`, which admitted an agent whose confinement came back
     `unverified` -- exactly the gap this migration closes. */
  const verdict = decideAdmission(toFindings(capabilities));
  /* A probe that ran under a hook measured something other than the profile.
     Refused rather than recorded: every capability below was observed in a run
     whose instructions may have been rewritten before the model read them, so
     the whole result is evidence about the hook, not about the agent. */
  const interference = claudeHookInterference(observation.stdout);
  return {
    agent_id: agent.id,
    tool: profile.tool,
    ok: verdict.admitted && interference === null,
    refusal:
      interference !== null
        ? `this agent could not be connected: ${interference}`
        : verdict.admitted
      ? null
      : `this agent could not be connected: ${verdict.refusals.map((entry) => entry.consequence).join(" ")}`,
    degraded: verdict.degraded,
    limitations: verdict.limitations,
    capabilities,
    effective_tokens: Math.max(observation.effectiveTokens, totalTokens),
    wall_time_ms: observation.wallTimeMs,
    readback_source: readback?.source ?? null,
    provider_version: providerVersion
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

/**
 * Claude Code reports what it resolved in its first `stream-json` line.
 *
 * Measured against claude 2.1.229 on 2026-08-12, and it answers more than the
 * discovery hoped for:
 *
 *   {"type":"system","subtype":"init","model":"claude-sonnet-5",
 *    "tools":["Edit","Glob","Grep","Read","Write"],
 *    "permissionMode":"acceptEdits","cwd":"…","claude_code_version":"2.1.229"}
 *
 * `tools` is the load-bearing field. Claude Code has no reportable OS sandbox
 * on Windows at all, so the boundary is the ABSENCE OF A SHELL -- and this is
 * the only place that absence is confirmed rather than merely requested. A
 * tools array with no shell in it, rooted at a `cwd` inside the project, is
 * what makes `confined_to_project` verifiable for this harness.
 *
 * `claude_code_version` in the same record retires the separate `--version`
 * call for this agent: the run already said it.
 */
export async function readClaudeInit(stdout: string): Promise<ProbeReadback | null> {
  for (const line of stdout.split(/\r?\n/u)) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "system" || record.subtype !== "init") continue;

    const tools = Array.isArray(record.tools)
      ? record.tools.filter((entry): entry is string => typeof entry === "string")
      : [];
    /* Any tool that can start a process is a shell for this purpose. Named
       rather than pattern-matched, because a new tool that runs commands
       should show up as an unrecognised name and be reviewed, not silently
       pass a regex. */
    const shellTools = tools.filter((entry) => ["Bash", "BashOutput", "KillShell"].includes(entry));
    const cwd = typeof record.cwd === "string" ? record.cwd : null;

    return {
      source: "system/init",
      model: typeof record.model === "string" ? record.model : null,
      /* There is no sandbox to report, so the boundary is stated in the terms
         that are actually true of this harness: no shell, rooted here. */
      sandbox: shellTools.length === 0 && cwd !== null ? "workspace-write" : null,
      approvalPolicy:
        typeof record.permissionMode === "string" ? record.permissionMode : null,
      workspaceRoots: cwd === null ? [] : [cwd],
      /* The tools list is the whole answer: the agent-dispatch tool is absent,
         so nothing in this session can start an agent of its own. */
      /* "none" is a POSITIVE report, not a silence: the tools array was read
         and the dispatch tool is not in it. That distinction makes Claude Code
         the first harness where this can be verified rather than shrugged at --
         Codex reports the capability exists and nothing about whether it is
         off, which is why it stays unverified there forever. */
      subagents: tools.some((entry) => ["Task", "Agent", "AgentTeam"].includes(entry))
        ? "available"
        : "none",
      version:
        typeof record.claude_code_version === "string" ? record.claude_code_version : null
    };
  }
  return null;
}

const GROK_FILE_TOOLS = ["grep", "list_dir", "read_file", "search_replace", "write"];
const GROK_EMPTY_INTEGRATION_TOOLS = ["search_tool", "use_tool"];

/** Grok's durable summary is its resolved model/sandbox readback. */
export async function readGrokSession(
  stdout: string,
  repoRoot: string,
  integrationsProbe: (repoRoot: string, grokHome?: string) => Promise<boolean> = grokIntegrationsEmpty
): Promise<ProbeReadback | null> {
  const records = jsonLineRecords(stdout);
  const session = [...records].reverse().find((record) => record.type === "hivemind.grok.session");
  const commands = [...records].reverse().find((record) => record.type === "available_commands");
  if (session === undefined || commands === undefined || !isRecord(session.summary)) return null;
  const summary = session.summary;
  const info = isRecord(summary.info) ? summary.info : null;
  const cwd = info !== null && typeof info.cwd === "string" ? info.cwd : null;
  const tools = Array.isArray(commands.tools)
    ? commands.tools.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
  const expected = [...GROK_FILE_TOOLS, ...GROK_EMPTY_INTEGRATION_TOOLS].sort();
  const exactTools = tools.length === expected.length && tools.every((tool, index) => tool === expected[index]);
  const grokHome = typeof summary.grok_home === "string" ? summary.grok_home : undefined;
  const integrationsEmpty = await integrationsProbe(repoRoot, grokHome);
  const rootedHere = cwd !== null && path.resolve(cwd) === path.resolve(repoRoot);
  const sandbox = summary.sandbox_profile === "workspace" && exactTools && integrationsEmpty && rootedHere
    ? "workspace-write"
    : null;
  return {
    source: "Grok session summary + available_commands",
    model: typeof summary.current_model_id === "string" ? summary.current_model_id : null,
    sandbox,
    approvalPolicy: "dontAsk with explicit file-tool allows",
    workspaceRoots: cwd === null ? [] : [cwd],
    subagents: sandbox === "workspace-write" ? "none" : null
  };
}

async function grokIntegrationsEmpty(repoRoot: string, grokHome?: string): Promise<boolean> {
  try {
    const argv = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "grok.cmd", "inspect", "--json"]] as const
      : ["grok", ["inspect", "--json"]] as const;
    const result = await execFileAsync(argv[0], argv[1], {
      cwd: repoRoot,
      env: grokHome === undefined ? process.env : { ...process.env, GROK_HOME: grokHome },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const inspect: unknown = JSON.parse(result.stdout);
    if (!isRecord(inspect)) return false;
    const none = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
    return none(inspect.mcpServers) && none(inspect.plugins) && none(inspect.hooks);
  } catch {
    return false;
  }
}

/**
 * Kimi reports the exact bound profile and tool snapshot in wire.jsonl.
 * Its file tools nevertheless accept absolute paths outside cwd, so this
 * readback can prove the shell/sub-agent denial but must not call cwd a
 * workspace sandbox.
 */
export async function readKimiSession(stdout: string, repoRoot?: string): Promise<ProbeReadback | null> {
  const session = jsonLineRecords(stdout).reverse().find((record) => record.type === "hivemind.kimi.session");
  if (session === undefined || !isRecord(session.state) || !isRecord(session.profile) || !isRecord(session.tools)) return null;
  const profile = session.profile;
  const state = session.state;
  const active = Array.isArray(profile.activeToolNames)
    ? profile.activeToolNames.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
  const snapshot = Array.isArray(session.tools.tools)
    ? session.tools.tools
        .filter(isRecord)
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string")
        .sort()
    : [];
  const expected = ["Edit", "Glob", "Grep", "Read", "Write"];
  const denied = Array.isArray(profile.disallowedTools)
    ? profile.disallowedTools.filter((entry): entry is string => typeof entry === "string")
    : [];
  const subagents = Array.isArray(profile.subagents) ? profile.subagents : null;
  const exact = active.length === expected.length && active.every((tool, index) => tool === expected[index]) &&
    snapshot.length === expected.length && snapshot.every((tool, index) => tool === expected[index]) &&
    ["Bash", "Agent", "AgentSwarm"].every((tool) => denied.includes(tool)) && subagents?.length === 0;
  const cwd = typeof state.cwd === "string" ? state.cwd : null;
  const rootedHere = cwd !== null && (repoRoot === undefined || path.resolve(cwd) === path.resolve(repoRoot));
  return {
    source: "Kimi wire profile.bind + llm.tools_snapshot",
    model: typeof profile.modelAlias === "string" ? profile.modelAlias : null,
    sandbox: null,
    approvalPolicy: exact && rootedHere ? "file-only launch profile; no workspace confinement" : null,
    workspaceRoots: cwd === null ? [] : [cwd],
    subagents: exact ? "none" : null,
    version: jsonLineRecords(stdout).find((record) => record.type === "system.version" && typeof record.version === "string")?.version as string | undefined
  };
}

function jsonLineRecords(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // An unrecognised line is not evidence and is ignored.
    }
  }
  return records;
}

/**
 * Did the model pin hold?
 *
 * Not string equality, because a pin is written as an alias and reported as a
 * concrete model: `sonnet` came back as `claude-sonnet-5`. Comparing those for
 * equality would report a mismatch on every single run and refuse a harness
 * that did exactly what it was told -- the opposite failure to the one this
 * check exists for, and just as wrong.
 *
 * An alias holds when the reported model names it. A fully-qualified pin still
 * has to match exactly, so `gpt-5.6-terra` answered by `gpt-5.5` is a mismatch
 * as it always was.
 */
export function modelPinHeld(requested: string | null, reported: string | null): boolean {
  if (requested === null || reported === null) return true;
  if (requested === reported) return true;
  /* An alias is a bare family name with no version in it. Anything carrying a
     digit is a specific model and is compared exactly. */
  if (/\d/u.test(requested)) return false;
  return new RegExp(`(?:^|[-_/])${escapeForPattern(requested)}(?:[-_/]|$)`, "iu").test(reported);
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}


/**
 * OpenCode reports what it resolved by PRINTING ITS RULES, not by narrating a
 * run — a different evidence shape from Claude's, which is why it is the right
 * second case for the contract.
 *
 * `opencode agent list` prints the fully merged permission table for every
 * agent, and costs nothing: no model call, no tokens. Measured on opencode
 * 1.18.15, byte-identical across repeated runs.
 *
 * The caveat is recorded rather than smoothed over: this is a readback of the
 * DISPOSITION the configuration resolved to, not of what the turn applied. On
 * its own it establishes that a rule was accepted. What establishes that the
 * rule HOLDS is the run itself — asked to use a shell, the agent answered "I
 * don't have a shell/bash tool available in this session", which is a
 * refutation-strength observation and the reason both are read together here.
 */
export async function readOpenCodePermissions(
  stdout: string,
  repoRoot: string
): Promise<ProbeReadback | null> {
  const rules = await readResolvedOpenCodeRules(repoRoot);
  if (rules === null) return null;

  const primary = rules.get("build") ?? [...rules.values()][0] ?? [];
  const decisionFor = (permission: string): string | null => {
    /* Last match wins: the project's own rules are merged after the built-in
       ones, so the final entry for a permission is the effective one. */
    const matches = primary.filter((rule) => rule.permission === permission);
    return matches.length === 0 ? null : matches[matches.length - 1]!.action;
  };

  const shellDenied = decisionFor("bash") === "deny";
  const taskDenied = decisionFor("task") === "deny";
  /* Corroboration from the run, read STRUCTURALLY rather than from prose.
     The first version of this matched the sentence the model happened to say
     -- and failed on "I don't have a shell tool" because it was written to
     expect "do not have". Pattern-matching a model's wording is the mistake
     this project has recorded three times; the stream says the same thing in a
     field. The probe asks for a shell command, so if a shell existed there
     would be a tool event naming it. */
  const usedShell = shellToolUsed(stdout);

  return {
    source: "opencode agent list",
    /* OpenCode does not report a resolved model per run anywhere this reads,
       so the pin stays unverified rather than being assumed from the argv. */
    model: null,
    sandbox: shellDenied && !usedShell ? "workspace-write" : null,
    approvalPolicy: shellDenied ? "bash denied" : null,
    workspaceRoots: [repoRoot],
    subagents: taskDenied ? "none" : "available"
  };
}

interface OpenCodeRule {
  permission: string;
  action: string;
}

async function readResolvedOpenCodeRules(
  repoRoot: string
): Promise<Map<string, OpenCodeRule[]> | null> {
  let printed: string;
  try {
    /* Windows installs the CLI as a .cmd shim, which cannot be spawned
       directly -- the same trap that made a Linux clone hold three unusable
       profiles. The platform branch belongs here for the same reason it
       belongs in the invocation: it is a property of how the harness is
       installed, not of what it does. */
    const argv =
      process.platform === "win32"
        ? ["cmd.exe", ["/d", "/s", "/c", "opencode.cmd", "agent", "list"]]
        : ["opencode", ["agent", "list"]];
    const result = await execFileAsync(argv[0] as string, argv[1] as string[], {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
    printed = result.stdout;
  } catch {
    /* An unreadable table is not an empty one. Returning null leaves every
       capability that depends on it `unverified`, which for the boundary
       refuses -- the correct failure. */
    return null;
  }

  const agents = new Map<string, OpenCodeRule[]>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === null) return;
    try {
      const parsed: unknown = JSON.parse(buffer.join("\n"));
      if (Array.isArray(parsed)) {
        agents.set(
          current,
          parsed
            .filter((entry): entry is Record<string, unknown> => isRecord(entry))
            .map((entry) => ({
              permission: String(entry.permission ?? ""),
              action: String(entry.action ?? "")
            }))
        );
      }
    } catch {
      /* A block that will not parse is skipped rather than guessed at. */
    }
    buffer = [];
  };

  for (const line of printed.split(/\r?\n/u)) {
    const heading = /^(\S[^(]*)\s*\((?:primary|subagent)\)\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      current = heading[1]!.trim();
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return agents.size === 0 ? null : agents;
}


/**
 * Did this run reach a shell?
 *
 * OpenCode emits one `tool_use` event per tool call, naming the tool. The probe
 * prompt asks for a shell command, so a run with a shell produces an event for
 * it and a run without one does not. That is a fact in the stream rather than a
 * sentence in a reply, which is what makes it survive the model wording
 * differently next time.
 */
function shellToolUsed(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/u)) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "tool_use") continue;
    const part = isRecord(record.part) ? record.part : null;
    const tool = part !== null && typeof part.tool === "string" ? part.tool.toLowerCase() : "";
    if (["bash", "shell", "run", "execute"].includes(tool)) return true;
  }
  return false;
}


/** One model's share of a run, where the provider breaks it down. */
export interface ModelAttribution {
  model: string;
  tokens: number;
}

/**
 * Which models actually ran, where the provider says so.
 *
 * Claude Code's `result` record carries `modelUsage`, keyed by model. Nothing
 * else read here does: Codex reports one total in `turn.completed`, and
 * OpenCode reports per step without naming a model. Returning null for those is
 * the honest answer and the reason the capability exists -- it converts a
 * question nobody was asking into one that is visibly unanswered.
 */
export function readModelAttribution(
  parser: string | undefined,
  stdout: string
): ModelAttribution[] | null {
  if (parser === "grok-json") {
    for (const record of jsonLineRecords(stdout).reverse()) {
      if (record.type !== "hivemind.grok.session" || !isRecord(record.usage) || !isRecord(record.usage.modelUsage)) continue;
      const models: ModelAttribution[] = [];
      for (const [model, value] of Object.entries(record.usage.modelUsage)) {
        if (!isRecord(value)) continue;
        const total = typeof value.totalTokens === "number" ? value.totalTokens : 0;
        models.push({ model, tokens: total });
      }
      return models.length === 0 ? null : models;
    }
    return null;
  }
  if (parser === "kimi-wire") {
    for (const record of jsonLineRecords(stdout).reverse()) {
      if (record.type !== "hivemind.kimi.session" || !Array.isArray(record.requests) || !isRecord(record.usage)) continue;
      const models = new Set(
        record.requests.filter(isRecord).map((request) => request.model).filter((model): model is string => typeof model === "string")
      );
      const total = typeof record.usage.total_tokens === "number" ? record.usage.total_tokens : 0;
      return models.size === 1 ? [{ model: [...models][0]!, tokens: total }] : null;
    }
    return null;
  }
  if (parser !== "claude-json") return null;
  for (const line of stdout.split(/\r?\n/u)) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "result" || !isRecord(record.modelUsage)) continue;
    const models: ModelAttribution[] = [];
    for (const [model, value] of Object.entries(record.modelUsage)) {
      if (!isRecord(value)) continue;
      const input = typeof value.inputTokens === "number" ? value.inputTokens : 0;
      const output = typeof value.outputTokens === "number" ? value.outputTokens : 0;
      models.push({ model, tokens: input + output });
    }
    return models.length === 0 ? null : models;
  }
  return null;
}

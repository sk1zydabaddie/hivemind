import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { explainMissingAdapterProgram, resolveAdapterInvocation } from "./adapter-command.js";
import { writeFileAtomic } from "./atomic.js";
import { loadAndValidateContract, TaskContract } from "./contract.js";
import { formatErrorDetail } from "./error-detail.js";
import { readJsonFile } from "./json.js";
import { terminateProcessTreeAndVerify, type DurableProcessIdentity } from "./process-control.js";
import { assembleAgentPrompt, buildAgentPromptFromContract } from "./prompt-cache.js";
import type { FailureCode } from "./failure-code.js";
import {
  adapterOutputIndicatesThrottle,
  bindMeteredCallProcess,
  currentMeteringRuntimeInstanceId,
  estimateTokens,
  releaseMeteredCallAfterSpawnFailure,
  recordQuotaUsage,
  reserveMeteredCall,
  settleMeteredCall,
  writeMeteredUsageArtifact,
  type LastQuotaRequest,
  type MeteredCallReservation,
  type ProviderReportedUsage,
  type ProviderUsageCapture
} from "./resource-ledger.js";

export type PromptArgMode = "stdin" | "arg";
export type ProviderRoutingTier = "local" | "cheap" | "standard" | "strong";
export type AdapterUsageParser = "codex-jsonl" | "codex-text" | "claude-json";

/**
 * What a profile may be *selected* for.
 *
 * - `worker` profiles are the pool `routeTaskProvider` searches when no tool is
 *   named. That search is the only place a provider is chosen rather than
 *   asked for by name.
 * - `orchestrator` profiles are resolved by name -- `planner`, `manager` -- by
 *   the caller that needs them, so they never need to win a search.
 *
 * The distinction exists because a profile that appears in the worker search
 * can be selected for work nobody chose it for. Two behaviours made that
 * concrete: a quota-walled worker rerouted to an orchestrator profile instead
 * of pausing, and a `strongest` preference outranked an operator's deliberately
 * configured provider.
 */
export const adapterRoles = ["worker", "orchestrator"] as const;
export type AdapterRole = (typeof adapterRoles)[number];

export interface AdapterProfile {
  tool: string;
  invoke: string[];
  prompt_arg: PromptArgMode;
  verified_on: string;
  context_window: number;
  timeout_ms?: number;
  routing_tier?: ProviderRoutingTier;
  cost_rank?: number;
  usage_parser?: AdapterUsageParser;
  roles?: AdapterRole[];
}

/**
 * Absence is not a statement. A profile written before this field existed made
 * no claim about what it may be selected for, and reading silence as a refusal
 * would reject providers that work today. Only a profile that names its roles
 * is narrowed by them -- which is why this can never turn an eligible provider
 * into an ineligible one without someone having said so.
 */
export function profileAdmitsRole(profile: AdapterProfile, role: AdapterRole): boolean {
  return profile.roles === undefined || profile.roles.includes(role);
}

export interface InvokeAgentResult {
  exitCode: number;
  logPath: string;
  wallTimeMs: number;
  timedOut: boolean;
  throttled: boolean;
  failureReason: string | null;
  effectiveTokens: number;
  selfMeasuredTokens: number;
  providerReportedTokens: number | null;
  accountingSource: "provider_reported" | "self_measured";
  cancelled?: boolean;
}

export interface InvokeAgentFailure {
  ok: false;
  reason: string;
  budget_exceeded?: true;
  /** Which ceiling was hit, when that distinction drives scheduling. */
  code?: FailureCode;
  exitCode?: number;
  wallTimeMs?: number;
  effectiveTokens?: number;
  metering?: AdapterFailureMetering;
}

export interface AdapterStreamChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface InvokeAgentOptions {
  allowDangerousAdapter?: boolean;
  onStreamChunk?: (chunk: AdapterStreamChunk) => void;
  usageSessionId?: string;
  shouldCancel?: () => Promise<boolean>;
  onProcessStart?: (identity: DurableProcessIdentity) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface AdapterProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  modelOutput: string;
  providerUsageCapture: ProviderUsageCapture;
  usageSessionId: string | null;
  reservationId: string | null;
  quotaRequest: LastQuotaRequest;
  wallTimeMs: number;
  timedOut: boolean;
  cancelled?: boolean;
  outputLogPath: string | null;
  reservedTokens: number | null;
  budgetOvershoot: AdapterBudgetOvershoot | null;
}

export interface AdapterBudgetOvershoot {
  enforcement: "post_completion_refusal";
  reserved_tokens: number;
  effective_tokens: number;
  overshoot_tokens: number;
}

export interface AdapterFailureMetering {
  providerUsageCapture: ProviderUsageCapture;
  quotaRequest: LastQuotaRequest;
  reservationId: string | null;
  outputLogPath: string | null;
  budgetOvershoot: AdapterBudgetOvershoot | null;
}

export interface AdapterProcessOptions {
  onStreamChunk?: (chunk: AdapterStreamChunk) => void;
  outputLogPath?: string;
  usageSessionId?: string;
  usageRunId?: string;
  usageTaskId?: string;
  shouldCancel?: () => Promise<boolean>;
  onProcessStart?: (identity: DurableProcessIdentity) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type AdapterProcessFailure = {
  ok: false;
  reason: string;
  budget_exceeded?: true;
  code?: FailureCode;
  exitCode?: number;
  wallTimeMs?: number;
  effectiveTokens?: number;
  metering?: AdapterFailureMetering;
};

type AdapterProcessExecutionResult = { ok: true; value: AdapterProcessResult } | AdapterProcessFailure;

const ADAPTER_PROFILE_FIELDS = new Set([
  "tool",
  "invoke",
  "prompt_arg",
  "verified_on",
  "context_window",
  "timeout_ms",
  "routing_tier",
  "cost_rank",
  "usage_parser",
  "roles"
]);

export async function invokeAgent(
  repoRoot: string,
  taskId: string,
  tool: string,
  options: InvokeAgentOptions = {}
): Promise<{ ok: true; value: InvokeAgentResult } | InvokeAgentFailure> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }

  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0 && options.allowDangerousAdapter !== true) {
    return {
      ok: false,
      reason: `adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); rerun with --allow-dangerous-adapter only for approved disposable gate runs`
    };
  }

  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  if (!(await exists(worktreePath))) {
    return { ok: false, reason: `worktree not found: .hivemind/worktrees/${taskId}` };
  }

  const promptResult = await assembleAgentPrompt(repoRoot, contractResult.contract);
  if (!promptResult.ok) {
    return promptResult;
  }
  const prompt = promptResult.value.full_prompt;
  const logPath = path.join(worktreePath, "agent.log");
  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, worktreePath, prompt, {
    onStreamChunk: options.onStreamChunk,
    outputLogPath: logPath,
    usageSessionId: options.usageSessionId,
    usageRunId: options.usageSessionId ?? taskId,
    usageTaskId: taskId,
    shouldCancel: options.shouldCancel,
    onProcessStart: options.onProcessStart
  });
  if (!processResult.ok) {
    return processResult;
  }
  const throttled = adapterOutputIndicatesThrottle(processResult.value.stdout, processResult.value.stderr, processResult.value.exitCode);
  const quota = processResult.value.quotaRequest;

  return {
    ok: true,
    value: {
      exitCode: processResult.value.exitCode,
      logPath,
      wallTimeMs: processResult.value.wallTimeMs,
      timedOut: processResult.value.timedOut,
      throttled,
      effectiveTokens: quota.effective_tokens,
      selfMeasuredTokens: quota.self_measured_tokens,
      providerReportedTokens: quota.provider_reported_tokens,
      accountingSource: quota.accounting_source,
      cancelled: processResult.value.cancelled === true,
      failureReason:
        processResult.value.exitCode === 0
          ? null
          : formatAdapterProcessFailure(profileResult.profile.tool, processResult.value, "worker")
    }
  };
}

export async function loadAdapterProfile(
  repoRoot: string,
  tool: string
): Promise<{ ok: true; profile: AdapterProfile } | { ok: false; reason: string }> {
  const profilePath = path.join(repoRoot, ".hivemind", "adapters", `${tool}.profile.json`);
  let raw: unknown;
  try {
    raw = await readJsonFile(profilePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `adapter profile not found: .hivemind/adapters/${tool}.profile.json` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in .hivemind/adapters/${tool}.profile.json` };
    }
    throw error;
  }

  const problems = validateAdapterProfile(raw, tool);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, profile: raw as AdapterProfile };
}

export function validateAdapterProfile(raw: unknown, expectedTool?: string): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return ["adapter profile must be a JSON object"];
  }

  for (const field of Object.keys(raw)) {
    if (!ADAPTER_PROFILE_FIELDS.has(field)) {
      problems.push(`unsupported adapter profile field: ${field}`);
    }
  }

  const refusedModes = findRefusedAdapterModes(raw);
  if (refusedModes.length > 0) {
    problems.push(`adapter profile enables a refused orchestration mode (${refusedModes.join(", ")})`);
  }

  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    problems.push("tool is required");
  } else if (expectedTool !== undefined && raw.tool !== expectedTool) {
    problems.push(`tool must match requested adapter "${expectedTool}"`);
  }

  if (
    !Array.isArray(raw.invoke) ||
    raw.invoke.length === 0 ||
    !raw.invoke.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    problems.push("invoke must be a non-empty array of non-empty strings");
  }

  if (raw.prompt_arg !== "stdin" && raw.prompt_arg !== "arg") {
    problems.push("prompt_arg must be stdin or arg");
  }

  if (typeof raw.verified_on !== "string" || raw.verified_on.trim() === "") {
    problems.push("verified_on is required");
  }

  if (typeof raw.context_window !== "number" || !Number.isInteger(raw.context_window) || raw.context_window <= 0) {
    problems.push("context_window must be a positive integer");
  }

  if (
    "timeout_ms" in raw &&
    (typeof raw.timeout_ms !== "number" || !Number.isInteger(raw.timeout_ms) || raw.timeout_ms <= 0)
  ) {
    problems.push("timeout_ms must be a positive integer when provided");
  }
  if ("routing_tier" in raw && !isProviderRoutingTier(raw.routing_tier)) {
    problems.push("routing_tier must be one of local, cheap, standard, strong when provided");
  }
  if ("cost_rank" in raw && (typeof raw.cost_rank !== "number" || !Number.isInteger(raw.cost_rank) || raw.cost_rank <= 0)) {
    problems.push("cost_rank must be a positive integer when provided");
  }
  if ("usage_parser" in raw && !isAdapterUsageParser(raw.usage_parser)) {
    problems.push("usage_parser must be one of codex-jsonl, codex-text, claude-json when provided");
  }
  if ("roles" in raw) {
    // An empty list would mean "selectable for nothing", which is a profile
    // that cannot be used at all. That is a mistake, not a decision, so it is
    // refused rather than silently honoured.
    if (
      !Array.isArray(raw.roles) ||
      raw.roles.length === 0 ||
      !raw.roles.every((entry) => isAdapterRole(entry)) ||
      new Set(raw.roles).size !== raw.roles.length
    ) {
      problems.push(
        `roles must be a non-empty array of unique values from ${adapterRoles.join(", ")} when provided`
      );
    }
  }

  return problems;
}

function isAdapterRole(value: unknown): value is AdapterRole {
  return typeof value === "string" && (adapterRoles as readonly string[]).includes(value);
}

export function normalizeProfileRoutingTier(profile: AdapterProfile): ProviderRoutingTier {
  return profile.routing_tier ?? "standard";
}

export function normalizeProfileCostRank(profile: AdapterProfile): number {
  return profile.cost_rank ?? 100;
}

export function findDangerousAdapterArgs(invoke: string[]): string[] {
  const dangerous = new Set<string>();
  for (const arg of invoke) {
    if (
      arg === "bypassPermissions" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--allow-dangerously-skip-permissions" ||
      arg.includes("bypassPermissions") ||
      arg.includes("dangerously")
    ) {
      dangerous.add(arg);
    }
  }
  return [...dangerous];
}

export function findRefusedAdapterModes(
  profile: unknown,
  environment: NodeJS.ProcessEnv = {}
): string[] {
  const refused = new Set<string>();
  collectRefusedModeValues(profile, "profile", refused);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !environmentCanEnableOrchestrationMode(key, value)) continue;
    refused.add(`environment ${key}`);
  }
  return [...refused].sort((left, right) => left.localeCompare(right));
}

export function buildAgentPrompt(contract: TaskContract): string {
  return buildAgentPromptFromContract(contract);
}

export async function runAdapterProcess(
  repoRoot: string,
  profile: AdapterProfile,
  cwd: string,
  prompt: string,
  options: AdapterProcessOptions = {}
): Promise<AdapterProcessExecutionResult> {
  const refusedModes = findRefusedAdapterModes(profile, process.env);
  if (refusedModes.length > 0) {
    return {
      ok: false,
      reason: `adapter invocation refused before spawn: ultra or dynamic-workflow orchestration would violate one-worker/one-scope ownership (${refusedModes.join(", ")})`
    };
  }
  const usageSessionId = options.usageSessionId ?? `standalone-${randomUUID()}`;
  const reservationResult = await reserveMeteredCall(repoRoot, {
    provider: profile.tool,
    session_id: usageSessionId,
    run_id: options.usageRunId ?? usageSessionId,
    task_id: options.usageTaskId ?? null,
    daemon_instance_id: currentMeteringRuntimeInstanceId(),
    estimated_input_tokens: estimateTokens(prompt)
  });
  if (!reservationResult.ok) return reservationResult;
  const reservation = reservationResult.value.reservation;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    /* HIVEMIND_<AGENT>_PATH, applied here rather than at profile load, so the
       profile on disk stays the platform-correct thing the probe verified and
       the override stays a property of where the app was started from. */
    const [command, ...baseArgs] = resolveAdapterInvocation(profile.invoke);
    const args = profile.prompt_arg === "arg" ? [...baseArgs, prompt] : baseArgs;
    // `detached` on POSIX calls setsid(), so the worker leads its own process
    // group and `kill(-pgid)` reaches the agent CLI's own children. Without it
    // there is no group to signal and only the named process dies.
    //
    // What else it changes, deliberately accepted:
    // - stdio is unaffected. `detached` only alters stdio when paired with
    //   `stdio: "ignore"`; with the default pipes, stdout/stderr/stdin behave
    //   exactly as before, which the streaming and prompt paths depend on.
    // - the child no longer receives signals sent to OUR group, so an
    //   interactive Ctrl-C no longer reaches it. Termination must go through
    //   terminateProcessTreeAndVerify -- which is the point: that path proves
    //   what it killed, and a stray Ctrl-C never did.
    // - the parent will not be held open by it, because we never unref() and
    //   already await the child.
    // - NOT set on Windows, where `detached` means a new console window and
    //   `taskkill /t` is already the correct tree primitive.
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, windowsHide: true, detached });
    const processIdentity: DurableProcessIdentity | null = child.pid === undefined
      ? null
      : {
          pid: child.pid,
          process_instance_id: randomUUID(),
          // setsid() makes the child a group leader, so its pgid is its pid.
          // Recorded rather than re-derived, because a reader of the durable
          // trail must not have to assume how it was spawned.
          process_group_id: detached ? child.pid : null
        };
    const processBinding = bindAdapterProcessReservation(repoRoot, reservation, processIdentity);
    const processStart = processBinding.then((bound) =>
      !bound.ok || processIdentity === null || options.onProcessStart === undefined
        ? bound
        : options.onProcessStart(processIdentity)
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failedToStart = false;
    let timedOut = false;
    let cancelled = false;
    let stdinError: NodeJS.ErrnoException | null = null;
    let terminationInProgress = false;
    const requestTermination = async (reason: string) => {
      if (terminationInProgress || processIdentity === null || child.exitCode !== null) return;
      terminationInProgress = true;
      const terminated = await terminateProcessTreeAndVerify(processIdentity);
      if (terminated.status !== "dead") {
        stderr.push(Buffer.from(`\n${reason}; ${terminated.reason}\n`, "utf8"));
        terminationInProgress = false;
      }
    };
    void processStart.then((recorded) => {
      if (!recorded.ok) void requestTermination("worker identity recording failed");
    });
    const timeout =
      profile.timeout_ms === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stderr.push(Buffer.from(`\nadapter timed out after ${profile.timeout_ms}ms\n`, "utf8"));
            void requestTermination("adapter timeout could not prove worker termination");
          }, profile.timeout_ms);
    let cancellationPoll: NodeJS.Timeout | undefined;
    const pollCancellation = async () => {
      if (options.shouldCancel === undefined || failedToStart || child.exitCode !== null) return;
      try {
        if (await options.shouldCancel()) {
          cancelled = true;
          stderr.push(Buffer.from("\nadapter cancelled by durable request\n", "utf8"));
          await requestTermination("adapter cancellation could not prove worker termination");
          return;
        }
      } catch {
        // Cancellation observation is advisory to the process; uncertain reads
        // do not kill work. The authoritative control path remains durable.
      }
      cancellationPoll = setTimeout(() => void pollCancellation(), 100);
    };
    if (options.shouldCancel !== undefined) {
      cancellationPoll = setTimeout(() => void pollCancellation(), 100);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options.onStreamChunk?.({ stream: "stdout", text: chunk.toString("utf8") });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      options.onStreamChunk?.({ stream: "stderr", text: chunk.toString("utf8") });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      stdinError = error;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failedToStart = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (cancellationPoll) clearTimeout(cancellationPoll);
      void (async () => {
        const release = reservation === null
          ? { ok: true as const }
          : await releaseMeteredCallAfterSpawnFailure(repoRoot, reservation.reservation_id);
        const suffix = release.ok ? "" : `; reservation release failed: ${release.reason}`;
        await resolveStartFailure(profile.tool, profile.invoke, error, options.outputLogPath, resolve, suffix);
      })();
    });
    child.on("close", (code) => {
      if (failedToStart) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      if (cancellationPoll) clearTimeout(cancellationPoll);
      void (async () => {
        const identityRecorded = await processStart;
        const capturedStderr = Buffer.concat(stderr).toString("utf8");
        const capturedStdout = Buffer.concat(stdout).toString("utf8");
        const exitCode = cancelled ? 130 : timedOut ? 124 : code ?? 1;
        const normalized = normalizeAdapterResult(resolveAdapterUsageParser(profile), capturedStdout, capturedStderr, exitCode);
        const quotaRequest = buildUnmeteredQuotaRequest(prompt, normalized.modelOutput, normalized.providerUsageCapture);
        const budgetOvershoot = reservation !== null && quotaRequest.effective_tokens > reservation.reserved_tokens
          ? {
              enforcement: "post_completion_refusal" as const,
              reserved_tokens: reservation.reserved_tokens,
              effective_tokens: quotaRequest.effective_tokens,
              overshoot_tokens: quotaRequest.effective_tokens - reservation.reserved_tokens
            }
          : null;
        const result: AdapterProcessResult = {
          exitCode,
          stdout: capturedStdout,
          stderr:
            capturedStderr !== "" || stdinError === null
              ? capturedStderr
              : formatErrorDetail(stdinError, "adapter stdin failed"),
          modelOutput: normalized.modelOutput,
          providerUsageCapture: normalized.providerUsageCapture,
          usageSessionId: reservation === null && options.usageSessionId === undefined ? null : usageSessionId,
          reservationId: reservation?.reservation_id ?? null,
          quotaRequest,
          wallTimeMs: Date.now() - startedAt,
          timedOut,
          cancelled,
          outputLogPath: options.outputLogPath ?? null,
          reservedTokens: reservation?.reserved_tokens ?? null,
          budgetOvershoot
        };
        void resolveProcessResult(
          repoRoot,
          profile.tool,
          prompt,
          reservation,
          processIdentity,
          result,
          resolve,
          identityRecorded.ok ? undefined : `worker process identity was not durably recorded: ${identityRecorded.reason}`
        );
      })();
    });

    if (profile.prompt_arg === "stdin") {
      child.stdin.end(prompt);
    }
  });
}

async function bindAdapterProcessReservation(
  repoRoot: string,
  reservation: MeteredCallReservation | null,
  identity: DurableProcessIdentity | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (reservation === null) return { ok: true };
  if (identity === null) {
    return {
      ok: false,
      reason: `metered adapter spawn did not expose a process identity; reservation ${reservation.reservation_id} retained`
    };
  }
  const bound = await bindMeteredCallProcess(repoRoot, reservation.reservation_id, identity);
  return bound.ok ? { ok: true } : bound;
}

function buildUnmeteredQuotaRequest(
  prompt: string,
  modelOutput: string,
  capture: ProviderUsageCapture
): LastQuotaRequest {
  const selfMeasuredTokens = estimateTokens(prompt) + estimateTokens(modelOutput);
  const reportedTokens = capture.status === "captured" ? capture.usage.total_tokens : null;
  return {
    self_measured_tokens: selfMeasuredTokens,
    provider_reported_tokens: reportedTokens,
    effective_tokens: reportedTokens ?? selfMeasuredTokens,
    accounting_source: reportedTokens === null ? "self_measured" : "provider_reported",
    provider_usage_status: capture.status
  };
}

function collectRefusedModeValues(value: unknown, location: string, refused: Set<string>): void {
  if (typeof value === "string") {
    if (containsRefusedModeMarker(value)) refused.add(`${location}=${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRefusedModeValues(entry, `${location}[${index}]`, refused));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (containsRefusedModeMarker(key) && entry !== false && entry !== null && entry !== undefined) {
      refused.add(`${location}.${key}`);
    }
    collectRefusedModeValues(entry, `${location}.${key}`, refused);
  }
}

function environmentCanEnableOrchestrationMode(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (["", "0", "false", "off", "disabled", "none"].includes(normalizedValue)) return false;
  if (/ultra|dynamic[_-]?workflows?/u.test(normalizedKey)) return true;
  if (!/(claude|anthropic|codex|openai|gpt|effort|workflow|agent)/u.test(normalizedKey)) return false;
  return containsRefusedModeMarker(normalizedValue);
}

function containsRefusedModeMarker(value: string): boolean {
  return /(?:^|[^a-z0-9])ultra(?:code)?(?:$|[^a-z0-9])|dynamic[_ -]?workflows?/iu.test(value);
}

export function parseAdapterProviderUsage(
  parser: AdapterUsageParser,
  stdout: string,
  stderr: string
): ProviderReportedUsage | null {
  if (parser === "codex-text") {
    const matches = [...stripAnsi(`${stdout}\n${stderr}`).matchAll(/tokens used\s*[\r\n]+\s*([\d,]+)/giu)];
    const total = matches.at(-1)?.[1];
    return total === undefined ? null : reportedUsage({ total_tokens: parseTokenInteger(total) });
  }

  if (parser === "claude-json") {
    const parsed = parseJsonObject(stdout);
    if (parsed === null) {
      return null;
    }
    const usage = isRecord(parsed.usage) ? parsed.usage : null;
    if (usage === null) {
      return null;
    }
    const input = tokenField(usage, "input_tokens");
    const cacheRead = tokenField(usage, "cache_read_input_tokens");
    const cacheCreation = tokenField(usage, "cache_creation_input_tokens");
    const output = tokenField(usage, "output_tokens");
    const cached = sumKnown(cacheRead, cacheCreation);
    const total = tokenField(usage, "total_tokens") ?? sumKnown(input, cached, output);
    return total === null
      ? null
      : reportedUsage({
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_tokens: tokenField(usage, "reasoning_tokens"),
          total_tokens: total
        });
  }

  const records = parseJsonLines(stdout);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = findUsageObject(records[index]);
    if (usage === null) {
      continue;
    }
    const input = tokenField(usage, "input_tokens");
    const cached =
      tokenField(usage, "cached_input_tokens") ??
      tokenField(isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {}, "cached_tokens");
    const output = tokenField(usage, "output_tokens");
    const reasoning =
      tokenField(usage, "reasoning_tokens") ??
      tokenField(usage, "reasoning_output_tokens") ??
      tokenField(isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}, "reasoning_tokens");
    const total = tokenField(usage, "total_tokens") ?? sumKnown(input, output);
    if (total !== null) {
      return reportedUsage({
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_tokens: reasoning,
        total_tokens: total
      });
    }
  }
  return null;
}

export function resolveAdapterUsageParser(profile: AdapterProfile): AdapterUsageParser | undefined {
  if (profile.usage_parser !== undefined) {
    return profile.usage_parser;
  }
  const invocation = profile.invoke.map((entry) => entry.toLowerCase());
  const invokesCodex = invocation.some((entry) => /(^|[\\/])codex(?:\.cmd|\.exe)?$/u.test(entry));
  if (invokesCodex) {
    return invocation.includes("--json") ? "codex-jsonl" : "codex-text";
  }
  const invokesClaude = invocation.some((entry) => /(^|[\\/])claude(?:\.cmd|\.exe)?$/u.test(entry));
  const outputFormatIndex = invocation.indexOf("--output-format");
  return invokesClaude && outputFormatIndex >= 0 && invocation[outputFormatIndex + 1] === "json"
    ? "claude-json"
    : undefined;
}

export function adapterRunLogPath(repoRoot: string, label: string): string {
  const safeLabel = label.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "adapter";
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".hivemind", "log", "runs", `${timestamp}-${safeLabel}-${randomUUID()}.adapter.log`);
}

export function formatAdapterProcessFailure(
  tool: string,
  result: AdapterProcessResult,
  role = "adapter"
): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no process output";
  const log = result.outputLogPath === null ? "" : `; output log: ${result.outputLogPath}`;
  const subject = role === "worker" ? `${role} ${tool}` : `${role} "${tool}"`;
  return `${subject} exited ${result.exitCode}${log}: ${detail}`;
}

async function resolveProcessResult(
  repoRoot: string,
  tool: string,
  prompt: string,
  reservation: MeteredCallReservation | null,
  processIdentity: DurableProcessIdentity | null,
  result: AdapterProcessResult,
  resolve: (value: AdapterProcessExecutionResult) => void,
  processStartFailure?: string
): Promise<void> {
  const failures: string[] = processStartFailure === undefined ? [] : [processStartFailure];
  let budgetExceeded = false;
  let budgetFailureCode: FailureCode | undefined;
  if (result.outputLogPath !== null) {
    try {
      await writeAdapterProcessLog(result.outputLogPath, tool, result);
    } catch (error: unknown) {
      failures.push(`failed to write adapter output log ${result.outputLogPath}: ${formatErrorDetail(error, "unknown log write error")}`);
    }
  }
  let settledResult = result;
  if (reservation === null) {
    const unmetered = await recordQuotaUsage(repoRoot, {
      provider: tool,
      input_text: prompt,
      model_output_text: result.modelOutput,
      wall_time_ms: result.wallTimeMs,
      throttled: adapterOutputIndicatesThrottle(result.stdout, result.stderr, result.exitCode),
      ...(result.usageSessionId === null ? {} : { session_id: result.usageSessionId }),
      provider_usage: result.providerUsageCapture
    });
    if (!unmetered.ok) {
      failures.push(unmetered.reason);
    } else if (unmetered.value.last_request !== null) {
      settledResult = { ...result, quotaRequest: unmetered.value.last_request };
    }
  } else {
    if (processIdentity === null) {
      failures.push(`metered reservation ${reservation.reservation_id} has no durable process identity; reservation retained`);
    } else {
      const usage = {
        input_tokens_estimated: estimateTokens(prompt),
        output_tokens_estimated: estimateTokens(result.modelOutput),
        wall_time_ms: result.wallTimeMs,
        throttled: adapterOutputIndicatesThrottle(result.stdout, result.stderr, result.exitCode),
        provider_usage: result.providerUsageCapture
      };
      const artifact = await writeMeteredUsageArtifact(repoRoot, reservation.reservation_id, processIdentity, usage);
      if (!artifact.ok) failures.push(artifact.reason);
      const settlement = await settleMeteredCall(repoRoot, reservation.reservation_id, processIdentity, usage);
      if (!settlement.ok) {
        failures.push(settlement.reason);
        budgetExceeded = settlement.budget_exceeded === true;
        budgetFailureCode = settlement.code;
      } else {
        const quotaRequest = settlement.value.entry.last_request;
        if (quotaRequest === null) {
          failures.push(`metered reservation ${reservation.reservation_id} settled without request accounting`);
        } else {
          settledResult = { ...result, quotaRequest };
        }
      }
    }
  }
  if (failures.length > 0) {
    resolve({
      ok: false,
      reason: failures.join("; "),
      metering: {
        providerUsageCapture: result.providerUsageCapture,
        quotaRequest: settledResult.quotaRequest,
        reservationId: result.reservationId,
        outputLogPath: result.outputLogPath,
        budgetOvershoot: result.budgetOvershoot
      },
      ...(budgetExceeded
        ? {
            budget_exceeded: true as const,
            ...(budgetFailureCode === undefined ? {} : { code: budgetFailureCode }),
            exitCode: result.exitCode,
            wallTimeMs: result.wallTimeMs,
            effectiveTokens:
              result.providerUsageCapture.status === "captured"
                ? result.providerUsageCapture.usage.total_tokens
                : estimateTokens(prompt) + estimateTokens(result.modelOutput)
          }
        : {})
    });
    return;
  }
  resolve({ ok: true, value: settledResult });
}

async function resolveStartFailure(
  tool: string,
  invoke: string[],
  error: NodeJS.ErrnoException,
  outputLogPath: string | undefined,
  resolve: (value: AdapterProcessExecutionResult) => void,
  suffix = ""
): Promise<void> {
  const reason = `${formatSpawnError(tool, invoke, error)}${suffix}`;
  if (outputLogPath !== undefined) {
    try {
      await writeFileAtomic(
        outputLogPath,
        [
          "# Hivemind Adapter Run Log",
          `tool: ${tool}`,
          "exit_code: not-started",
          "timed_out: false",
          "",
          "## stdout",
          "",
          "## stderr",
          reason
        ].join("\n")
      );
    } catch (logError: unknown) {
      resolve({
        ok: false,
        reason: `${reason}; failed to write adapter output log ${outputLogPath}: ${formatErrorDetail(logError, "unknown log write error")}`
      });
      return;
    }
  }
  resolve({
    ok: false,
    reason: outputLogPath === undefined ? reason : `${reason}; output log: ${outputLogPath}`
  });
}

async function writeAdapterProcessLog(logPath: string, tool: string, result: AdapterProcessResult): Promise<void> {
  await writeFileAtomic(
    logPath,
    [
      "# Hivemind Adapter Run Log",
      `tool: ${tool}`,
      `exit_code: ${result.exitCode}`,
      `timed_out: ${result.timedOut}`,
      `metering_enforcement: ${result.reservationId === null ? "unmetered" : "admission_reservation_then_post_completion_refusal"}`,
      `reserved_tokens: ${result.reservedTokens ?? "unmetered"}`,
      `effective_tokens: ${result.quotaRequest.effective_tokens}`,
      `post_completion_overshoot_tokens: ${result.budgetOvershoot?.overshoot_tokens ?? 0}`,
      "",
      "## stdout",
      result.stdout,
      "## stderr",
      result.stderr
    ].join("\n")
  );
}

function normalizeAdapterResult(
  parser: AdapterUsageParser | undefined,
  stdout: string,
  stderr: string,
  exitCode: number
): { modelOutput: string; providerUsageCapture: ProviderUsageCapture } {
  if (parser === undefined) {
    return {
      modelOutput: stdout,
      providerUsageCapture: {
        status: "not_available",
        parser: null,
        reason: "adapter profile does not request or expose a supported provider usage format"
      }
    };
  }
  const usage = parseAdapterProviderUsage(parser, stdout, stderr);
  return {
    modelOutput: extractModelOutput(parser, stdout),
    providerUsageCapture:
      usage !== null
        ? { status: "captured", parser, usage }
        : exitCode === 0
          ? {
              status: "expected_but_unparseable",
              parser,
              reason: "adapter exited successfully but emitted no parseable provider usage record"
            }
          : {
              status: "not_available",
              parser,
              reason: `adapter exited ${exitCode} before a parseable provider usage record was emitted`
            }
  };
}

function extractModelOutput(parser: AdapterUsageParser, stdout: string): string {
  if (parser === "codex-text") {
    return stdout;
  }
  if (parser === "claude-json") {
    const parsed = parseJsonObject(stdout);
    return parsed !== null && typeof parsed.result === "string" ? parsed.result : "";
  }

  const messages: string[] = [];
  for (const record of parseJsonLines(stdout)) {
    if (record.type !== "item.completed" || !isRecord(record.item)) {
      continue;
    }
    if (record.item.type === "agent_message" && typeof record.item.text === "string") {
      messages.push(record.item.text);
    }
  }
  return messages.join("\n");
}

function reportedUsage(
  value: Partial<ProviderReportedUsage> & Pick<ProviderReportedUsage, "total_tokens">
): ProviderReportedUsage {
  return {
    input_tokens: value.input_tokens ?? null,
    cached_input_tokens: value.cached_input_tokens ?? null,
    output_tokens: value.output_tokens ?? null,
    reasoning_tokens: value.reasoning_tokens ?? null,
    total_tokens: value.total_tokens
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonLines(value: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = parseJsonObject(line);
    if (parsed !== null) {
      records.push(parsed);
    }
  }
  return records;
}

function findUsageObject(record: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(record.usage)) {
    return record.usage;
  }
  if (isRecord(record.response) && isRecord(record.response.usage)) {
    return record.response.usage;
  }
  return null;
}

function tokenField(value: Record<string, unknown>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

function sumKnown(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

function parseTokenInteger(value: string): number {
  return Number.parseInt(value.replaceAll(",", ""), 10);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

/**
 * ENOENT here means the program itself was not found, not that some file it
 * wanted was missing -- so it is the one spawn failure that has a specific,
 * actionable explanation rather than a generic one. Every other errno keeps the
 * detail it came with, because guessing at those would be worse than quoting
 * them.
 */
function formatSpawnError(tool: string, invoke: string[], error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    const explanation = explainMissingAdapterProgram(invoke);
    if (explanation !== null) return explanation;
  }
  return `failed to start adapter "${tool}": ${formatErrorDetail(error, "unknown spawn error")}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderRoutingTier(value: unknown): value is ProviderRoutingTier {
  return value === "local" || value === "cheap" || value === "standard" || value === "strong";
}

function isAdapterUsageParser(value: unknown): value is AdapterUsageParser {
  return value === "codex-jsonl" || value === "codex-text" || value === "claude-json";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

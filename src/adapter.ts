import { versionStanding } from "./verification-standing.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explainMissingAdapterProgram, resolveAdapterInvocation } from "./adapter-command.js";
import { writeFileAtomic } from "./atomic.js";
import { loadAndValidateContract, TaskContract } from "./contract.js";
import { formatErrorDetail } from "./error-detail.js";
import { readJsonFile } from "./json.js";
import { terminateProcessTreeAndVerify, type DurableProcessIdentity } from "./process-control.js";
import { assembleAgentPrompt, buildAgentPromptFromContract } from "./prompt-cache.js";
import type { FailureCode } from "./failure-code.js";
import { ACCOUNT_HOME_VARIABLES } from "./agent-catalogue.js";
import { accountEnvironmentForTool, isCredentialVariable } from "./provider-accounts.js";
import { spawnEnvironment } from "./spawn-environment.js";
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

export type PromptArgMode = "stdin" | "arg" | "file";
export type ProviderRoutingTier = "local" | "cheap" | "standard" | "strong";
export type AdapterUsageParser = "codex-jsonl" | "codex-text" | "claude-json" | "opencode-json" | "grok-json" | "kimi-wire";

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
  /**
   * The conversation was summarised mid-run, oldest-first, and the contract is
   * the oldest thing in it.
   *
   * Reported rather than refused: compaction is how a long run survives its
   * context window, so failing on it would refuse work for something the
   * harness did right. But it means "the worker followed its contract" is no
   * longer supported by this run's evidence, which is a fact a gate is entitled
   * to before it decides anything.
   */
  contextCompacted?: ContextCompaction | null;
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
  /* Which of the harness's own homes to run against, as a single allowlisted
     directory variable. Built by `accountEnvironment` and refused here if it
     ever arrives carrying anything else -- see src/provider-accounts.ts. */
  accountEnv?: Record<string, string>;
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
  /* Which of the harness's own homes to run against, as a single allowlisted
     directory variable. Built by `accountEnvironment` and re-checked at the
     spawn -- see src/provider-accounts.ts. */
  accountEnv?: Record<string, string>;
  /* A provider-native response contract for JSON-producing orchestration
     calls. It is appended only to a measured Claude invocation; exact Core
     validation still runs after the provider returns. */
  structuredOutputSchema?: Record<string, unknown>;
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

export type AdapterProcessExecutionResult = { ok: true; value: AdapterProcessResult } | AdapterProcessFailure;

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

  /* Is the binary about to run still the one that was checked?
   *
   * `compareAdapterVersion` was built for exactly this and had NO CALLER --
   * written, unit-tested, and imported by nothing but its own test, so the
   * check it implements had never once run. That is an instrument instance in a
   * new shape: not one that can only return a single answer, but one that is
   * never asked. See docs/STATE.md.
   *
   * It matters on one machine, not only across two: these harnesses update
   * themselves, `claude doctor` reports auto-updates enabled, and a binary that
   * updates itself silently invalidates its own verdict.
   *
   * Here rather than on the settings read, because it costs a subprocess and
   * the settings surface polls. An adapter run takes minutes; one `--version`
   * against it is free by comparison.
   *
   * ADVISORY, never blocking. A version that moved is a reason to re-check, not
   * a reason to refuse work somebody asked for -- the same posture the contract
   * takes for an unverifiable pin. It marks the record and lets the surfaces
   * that read it say so. */
  await noteVersionDrift(repoRoot, tool, profileResult.profile);

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
      contextCompacted: claudeContextCompacted(processResult.value.stdout),
      /* Exit code zero is not the same as "the contract ran". A hook that
         blocked the prompt exits 0 and reports `subtype: "success"`, so this
         asks the second question before accepting the first answer. */
      failureReason:
        processResult.value.exitCode === 0
          ? claudeHookInterference(processResult.value.stdout)
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

  if (raw.prompt_arg !== "stdin" && raw.prompt_arg !== "arg" && raw.prompt_arg !== "file") {
    problems.push("prompt_arg must be stdin, arg, or file");
  }
  if (
    raw.prompt_arg === "file" &&
    Array.isArray(raw.invoke) &&
    raw.invoke.filter((entry) => entry === "{prompt_file}").length !== 1
  ) {
    problems.push("file prompt mode requires exactly one {prompt_file} invocation placeholder");
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
    problems.push("usage_parser must be one of codex-jsonl, codex-text, claude-json, opencode-json, grok-json, kimi-wire when provided");
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

/**
 * The last gate before a variable reaches a provider process.
 *
 * Accepts only names that are the registered home variable of some harness,
 * and drops anything credential-shaped even if it somehow reached the
 * allowlist. Two checks for one rule, because this one is worth stating twice.
 */
function safeAccountEnvironment(input: Record<string, string> | undefined): Record<string, string> {
  if (input === undefined) return {};
  const allowed = new Set(Object.values(ACCOUNT_HOME_VARIABLES));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key) || isCredentialVariable(key)) continue;
    if (typeof value !== "string" || value.trim() === "") continue;
    out[key] = value;
  }
  return out;
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
  if (options.structuredOutputSchema !== undefined && profile.usage_parser !== "claude-json") {
    return { ok: false, reason: "structured output is supported only by a measured Claude JSON adapter" };
  }
  const refusedModes = findRefusedAdapterModes(profile, process.env);
  if (refusedModes.length > 0) {
    return {
      ok: false,
      reason: `adapter invocation refused before spawn: ultra or dynamic-workflow orchestration would violate one-worker/one-scope ownership (${refusedModes.join(", ")})`
    };
  }
  /* Resolved once, here, rather than at each of the eight call sites: nothing
     that spawns a provider can forget to apply the account, and nothing can
     apply a different one. Re-checked at the spawn itself by
     `safeAccountEnvironment`, which is the last point before a variable
     reaches a provider process. */
  const resolvedAccountEnv = safeAccountEnvironment(
    options.accountEnv ?? (await accountEnvironmentForTool(repoRoot, profile.tool))
  );
  if (profile.usage_parser === "kimi-wire") {
    const boundary = await ensureBoundedFilesAccountConfig(resolvedAccountEnv);
    if (!boundary.ok) return boundary;
  }
  const usageSessionId = options.usageSessionId ?? `standalone-${randomUUID()}`;
  const providerSessionId = randomUUID();
  const promptFilePath = profile.prompt_arg === "file"
    ? path.join(cwd, `.hivemind-agent-prompt-${providerSessionId}.txt`)
    : null;
  if (promptFilePath !== null) {
    await writeFileAtomic(promptFilePath, prompt);
  }
  const reservationResult = await reserveMeteredCall(repoRoot, {
    provider: profile.tool,
    session_id: usageSessionId,
    run_id: options.usageRunId ?? usageSessionId,
    task_id: options.usageTaskId ?? null,
    daemon_instance_id: currentMeteringRuntimeInstanceId(),
    estimated_input_tokens: estimateTokens(prompt)
  });
  if (!reservationResult.ok) {
    if (promptFilePath !== null) await unlink(promptFilePath).catch(() => undefined);
    return reservationResult;
  }
  const reservation = reservationResult.value.reservation;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    /* HIVEMIND_<AGENT>_PATH, applied here rather than at profile load, so the
       profile on disk stays the platform-correct thing the probe verified and
       the override stays a property of where the app was started from. */
    const [command, ...templateArgs] = resolveAdapterInvocation(profile.invoke);
    const baseArgs = templateArgs.map((arg) => {
      if (arg === "{session_id}") return providerSessionId;
      if (arg === "{prompt_file}" && promptFilePath !== null) return promptFilePath;
      return arg;
    });
    const structuredArgs = options.structuredOutputSchema === undefined
      ? baseArgs
      : [...baseArgs, "--json-schema", JSON.stringify(options.structuredOutputSchema)];
    const args = profile.prompt_arg === "arg" ? [...structuredArgs, prompt] : structuredArgs;
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
    /* One allowlisted directory variable, or nothing. Re-checked at the spawn
       rather than trusted from the caller: this is the last point before a
       credential-shaped variable would reach a provider process, and the whole
       promise is that Hivemind never carries one. */
    const accountEnv = resolvedAccountEnv;
    /* Chosen, not inherited. `CLAUDE_CONFIG_DIR` alone relocates a harness's
       whole configuration directory -- credentials included -- so a variable
       left in somebody's shell could point a worker at a config that was never
       probed and never hashed. Always applied, even when no account is chosen:
       the refusal is about the environment this process happens to have, and
       that is there either way. */
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached,
      env: spawnEnvironment(process.env, accountEnv)
    });
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
        if (promptFilePath !== null) await unlink(promptFilePath).catch(() => undefined);
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
        if (promptFilePath !== null) await unlink(promptFilePath).catch(() => undefined);
        const identityRecorded = await processStart;
        const capturedStderr = Buffer.concat(stderr).toString("utf8");
        const rawStdout = Buffer.concat(stdout).toString("utf8");
        const capturedStdout = await enrichPersistedProviderOutput(
          resolveAdapterUsageParser(profile),
          rawStdout,
          providerSessionId,
          cwd,
          accountEnv
        );
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

/**
 * Kimi 0.36.1 auto-loads only its account-level `mcp.json`; its documented
 * per-launch MCP flag is not accepted by the released binary. That makes this
 * file part of the executable boundary, not cosmetic configuration. We create
 * it only when absent and otherwise require byte-for-meaning equality. An
 * existing or additional server is refused rather than merged because merely
 * starting an ambient MCP command would execute code outside Hivemind's scope.
 */
export async function ensureBoundedFilesAccountConfig(
  accountEnv: Record<string, string>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const home = accountEnv.KIMI_CODE_HOME ?? path.join(homedir(), ".kimi-code");
  const file = path.join(home, "mcp.json");
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const wanted = {
    mcpServers: {
      hivemind_files: {
        command: process.execPath,
        args: [cliPath, "files-mcp"]
      }
    }
  };
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (code !== "ENOENT") {
      return { ok: false, reason: `Kimi tool boundary refused: ${file} is unreadable or invalid JSON; Hivemind will not overwrite it.` };
    }
    try {
      await writeFileAtomic(file, `${JSON.stringify(wanted, null, 2)}\n`);
      return { ok: true };
    } catch (writeError: unknown) {
      return { ok: false, reason: `Kimi tool boundary could not be written: ${formatErrorDetail(writeError, "unknown write failure")}` };
    }
  }
  if (!isExactBoundedFilesConfig(existing, process.execPath, cliPath)) {
    return {
      ok: false,
      reason: `Kimi tool boundary refused: ${file} contains a different or additional MCP server. Use a dedicated Kimi account home containing only Hivemind's bounded file server.`
    };
  }
  return { ok: true };
}

function isExactBoundedFilesConfig(value: unknown, command: string, cliPath: string): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.mcpServers)) return false;
  if (Object.keys(value.mcpServers).length !== 1 || !isRecord(value.mcpServers.hivemind_files)) return false;
  const server = value.mcpServers.hivemind_files;
  return Object.keys(server).length === 2 &&
    server.command === command &&
    Array.isArray(server.args) &&
    server.args.length === 2 &&
    server.args[0] === cliPath &&
    server.args[1] === "files-mcp";
}

/**
 * Some harnesses keep the strongest run facts in their durable session trail
 * rather than duplicating them on stdout. The invocation carries a unique
 * session id where the harness permits one; Kimi prints its generated id in a
 * structural resume record. We copy only the bounded readback fields into the
 * adapter stream so the existing parser/probe path can assess the run that
 * just closed without guessing which session was newest.
 */
async function enrichPersistedProviderOutput(
  parser: AdapterUsageParser | undefined,
  stdout: string,
  requestedSessionId: string,
  cwd: string,
  accountEnv: Record<string, string>
): Promise<string> {
  if (parser === "grok-json") {
    const home = accountEnv.GROK_HOME ?? path.join(homedir(), ".grok");
    const sessionDir = await findDirectoryNamed(path.join(home, "sessions"), requestedSessionId);
    if (sessionDir === null) return stdout;
    const summary = await readJsonRecord(path.join(sessionDir, "summary.json"));
    const usage = await lastNestedRecord(path.join(sessionDir, "updates.jsonl"), "turn_completed", "usage");
    if (summary === null) return stdout;
    return appendJsonLine(stdout, {
      type: "hivemind.grok.session",
      session_id: requestedSessionId,
      cwd,
      summary,
      ...(usage === null ? {} : { usage })
    });
  }

  if (parser === "kimi-wire") {
    const sessionId = kimiSessionId(stdout);
    if (sessionId === null) return stdout;
    const home = accountEnv.KIMI_CODE_HOME ?? path.join(homedir(), ".kimi-code");
    const sessionDir = await findDirectoryNamed(path.join(home, "sessions"), sessionId);
    if (sessionDir === null) return stdout;
    const state = await readJsonRecord(path.join(sessionDir, "state.json"));
    const wirePath = path.join(sessionDir, "agents", "main", "wire.jsonl");
    const records = await readJsonLinesFile(wirePath);
    const profile = records.find((record) => record.type === "profile.bind") ?? null;
    const tools = records.find((record) => record.type === "llm.tools_snapshot") ?? null;
    const requests = records.filter((record) => record.type === "llm.request");
    const usageRecords = records.filter((record) => record.type === "usage.record" && isRecord(record.usage));
    if (state === null || profile === null || tools === null || requests.length === 0) return stdout;
    const usage = sumKimiUsage(usageRecords);
    return appendJsonLine(stdout, {
      type: "hivemind.kimi.session",
      session_id: sessionId,
      state,
      profile,
      tools,
      requests,
      ...(usage === null ? {} : { usage })
    });
  }
  return stdout;
}

function appendJsonLine(stdout: string, record: Record<string, unknown>): string {
  return `${stdout}${stdout.endsWith("\n") || stdout === "" ? "" : "\n"}${JSON.stringify(record)}\n`;
}

function kimiSessionId(stdout: string): string | null {
  for (const record of parseJsonLines(stdout)) {
    if (record.type === "session.resume_hint" && typeof record.session_id === "string") return record.session_id;
  }
  return null;
}

async function findDirectoryNamed(root: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 8) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === name) return full;
    const found = await findDirectoryNamed(full, name, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJsonLinesFile(file: string): Promise<Record<string, unknown>[]> {
  try {
    return parseJsonLines(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function lastNestedRecord(
  file: string,
  sessionUpdate: string,
  key: string
): Promise<Record<string, unknown> | null> {
  const records = await readJsonLinesFile(file);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const params = isRecord(record.params) ? record.params : null;
    const update = params !== null && isRecord(params.update) ? params.update : null;
    const nested = update !== null && update.sessionUpdate === sessionUpdate && isRecord(update[key]) ? update[key] : null;
    if (nested !== null) return nested;
  }
  return null;
}

function sumKimiUsage(records: Record<string, unknown>[]): Record<string, number> | null {
  let input = 0;
  let cached = 0;
  let output = 0;
  let found = false;
  for (const record of records) {
    const usage = isRecord(record.usage) ? record.usage : null;
    if (usage === null) continue;
    const other = tokenField(usage, "inputOther") ?? 0;
    const cacheRead = tokenField(usage, "inputCacheRead") ?? 0;
    const cacheCreation = tokenField(usage, "inputCacheCreation") ?? 0;
    const out = tokenField(usage, "output") ?? 0;
    input += other;
    cached += cacheRead + cacheCreation;
    output += out;
    found = true;
  }
  return found ? { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + cached + output } : null;
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

/* The `result` line of a stream-json document: the last record, carrying the
   run's own totals. Scanned newest-first so a resumed session's earlier result
   can never be mistaken for this run's. */
function findResultRecord(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === "" || !line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(record) && record.type === "result" && isRecord(record.usage)) {
      return record;
    }
  }
  return null;
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

  if (parser === "opencode-json") {
    /* OpenCode reports per STEP, not per run: every `step_finish` event carries
       its own `tokens` block and there is no run-level total anywhere. Measured
       on opencode 1.18.15 -- a two-step run emitted 6,075 then 6,122, and each
       figure is that step's own input + output + reasoning + cache read.
       Summing the steps is therefore the run's consumption. The discovery
       assumed this would need `opencode export`; it does not, which is one
       fewer process and one fewer thing to be wrong about. */
    let input: number | null = null;
    let output: number | null = null;
    let cached: number | null = null;
    let total: number | null = null;
    for (const line of stdout.split(/\r?\n/u)) {
      const text = line.trim();
      if (text === "" || !text.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(record) || record.type !== "step_finish") continue;
      const part = isRecord(record.part) ? record.part : null;
      const tokens = part !== null && isRecord(part.tokens) ? part.tokens : null;
      if (tokens === null) continue;
      const cache = isRecord(tokens.cache) ? tokens.cache : null;
      input = sumKnown(input, tokenField(tokens, "input"));
      output = sumKnown(output, tokenField(tokens, "output"), tokenField(tokens, "reasoning"));
      cached = sumKnown(
        cached,
        cache === null ? null : tokenField(cache, "read"),
        cache === null ? null : tokenField(cache, "write")
      );
      total = sumKnown(total, tokenField(tokens, "total"));
    }
    return total === null
      ? null
      : reportedUsage({
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: total
        });
  }

  if (parser === "grok-json") {
    for (const record of parseJsonLines(stdout).reverse()) {
      const usage = record.type === "hivemind.grok.session" && isRecord(record.usage)
        ? record.usage
        : record.type === "end" && isRecord(record.usage)
          ? record.usage
          : null;
      if (usage === null) continue;
      const input = tokenField(usage, "inputTokens") ?? tokenField(usage, "input_tokens");
      const cached = tokenField(usage, "cachedReadTokens") ?? tokenField(usage, "cached_input_tokens");
      const output = tokenField(usage, "outputTokens") ?? tokenField(usage, "output_tokens");
      const reasoning = tokenField(usage, "reasoningTokens") ?? tokenField(usage, "reasoning_tokens");
      const total = tokenField(usage, "totalTokens") ?? tokenField(usage, "total_tokens") ?? sumKnown(input, output);
      if (total !== null) {
        return reportedUsage({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_tokens: reasoning, total_tokens: total });
      }
    }
    return null;
  }

  if (parser === "kimi-wire") {
    for (const record of parseJsonLines(stdout).reverse()) {
      if (record.type !== "hivemind.kimi.session" || !isRecord(record.usage)) continue;
      const usage = record.usage;
      const total = tokenField(usage, "total_tokens");
      if (total === null) return null;
      return reportedUsage({
        input_tokens: tokenField(usage, "input_tokens"),
        cached_input_tokens: tokenField(usage, "cached_input_tokens"),
        output_tokens: tokenField(usage, "output_tokens"),
        total_tokens: total
      });
    }
    return null;
  }

  if (parser === "claude-json") {
    /* Two shapes, because the profile has to choose between them and only one
       of them carries the startup readback.
       `--output-format json` prints ONE object. `--output-format stream-json`
       prints JSONL whose last line is the result -- and only the streaming
       form emits the `system/init` record naming the model, the resolved tool
       set and the permission mode, which is what the probe compares against.
       So the profile uses streaming and this reads either.
       Measured on claude 2.1.229: this parser found nothing at all against a
       real streaming run, because it fed the whole JSONL document to a
       single-object parse. The capability came back `failed`, which was the
       correct refusal for a wrong reason. */
    const parsed = parseJsonObject(stdout) ?? findResultRecord(stdout);
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

/**
 * Whether something between Hivemind and the model changed the run.
 *
 * A blocked contract currently reads as a completed one. Measured on Claude
 * Code 2.1.233: a `UserPromptSubmit` hook returning `{"decision":"block"}`
 * stops the prompt before the model ever sees it, and the run reports
 *
 * ```
 * {"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,…}
 * ```
 *
 * `success`, `is_error: false`. Every gate downstream would treat that as a
 * worker that ran and produced nothing, which is a very different fact from a
 * worker whose instructions were replaced before it started.
 *
 * ## Why this reads an event and not a sentence
 *
 * The obvious check is the result text -- it says "UserPromptSubmit operation
 * blocked by hook". That is prose from a harness that can reword it in any
 * release, and matching a harness's wording is the mistake this project has
 * recorded four times. The structural fact is simpler and stronger: **a hook
 * event exists at all.**
 *
 * Every invocation carries `--safe-mode`, so no hook should run. If one does,
 * the prevention failed, and it does not matter whether that hook blocked the
 * prompt, rewrote it, or only logged something -- the run happened under
 * conditions nobody verified. So the presence of `hook_started` or
 * `hook_response` is the finding, and both the injecting and the blocking case
 * produce them.
 *
 * Measured three ways before being trusted, on this exact argv:
 *
 * | run | hook events | result |
 * | --- | --- | --- |
 * | no hooks configured | 0 | `"ok"` |
 * | injecting hook, no defence | 2 | `"ZEBRA-7714"` |
 * | injecting hook + `--safe-mode` | 0 | `"ok"` |
 *
 * The first row is the one that matters for an instrument: an assertion that
 * fires on a clean run would be refused into oblivion within a day.
 */
export function claudeHookInterference(stdout: string): string | null {
  let ran = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.subtype === "hook_started" || record.subtype === "hook_response") ran += 1;
  }
  if (ran === 0) return null;
  return `a lifecycle hook ran during this invocation (${String(ran)} hook events) despite --safe-mode. A hook is a shell command that can rewrite or block the contract before the model reads it, so what this run was asked to do is not what Hivemind sent. Re-run without the hook, or remove it from the settings that configure it.`;
}

/**
 * Whether the conversation was compacted while the contract was in it.
 *
 * The structural danger, stated plainly: **the contract is the first user
 * message, and compaction summarises oldest-first.** A long task therefore
 * erodes its own instructions before it erodes anything else, and every gate
 * downstream still assumes the contract was read in full. Nothing about that is
 * a malfunction — compaction is how a long run survives a context window at
 * all — which is exactly why it needs to be visible rather than prevented.
 *
 * Determined for free rather than by a paid long run. The shipped 2.1.233
 * bundle carries `compact_boundary` as a `system` subtype in the same event
 * enum as `assistant`, `user` and `progress`, serialised with `session_id`,
 * `uuid` and a `compact_metadata` block. So the harness announces it, on the
 * stream already being parsed, with no flag required.
 *
 * NOT a failure, and deliberately not wired to one. A run that compacted is a
 * run that was too long for its window; refusing it would refuse the work
 * somebody asked for, for something the harness did correctly. What it is, is a
 * fact that has to travel: after a compaction, "the worker followed its
 * contract" is no longer a claim this evidence supports.
 *
 * ## Measured, at a cost of $4.12
 *
 * A worker was given a two-line contract carrying an arbitrary rule id and an
 * arbitrary token, then told to read 393 KB of source. Three auto-compactions
 * fired, each dropping the conversation from ~75k tokens to ~18k and preserving
 * only 2-3 messages verbatim; `cumulative_dropped_tokens` reached **172,547**.
 * The run then completed cleanly -- `terminal_reason: "completed"`, exit 0 --
 * and answered:
 *
 * ```
 * FINAL-RULE-ID: QN-4471      <- exact
 * FINAL-TOKEN:   ZEBRA-7714   <- exact
 * FINAL-COUNT:   3            <- correct
 * FINAL-SOURCE:  SUMMARY      <- the model's own report
 * ```
 *
 * So the contract's CONTENT survived and its TEXT did not. The operative
 * instruction was carried into the summary faithfully enough to reproduce two
 * arbitrary strings character-exact after 172k tokens were discarded -- which
 * makes a long run degraded-but-honest rather than silently ungoverned, and
 * those are different products.
 *
 * Three things keep that from being reassuring:
 *
 * 1. **One observation, on a two-line contract.** A real contract carries
 *    scope, forbidden paths, acceptance criteria and a tier. Summarisation is
 *    lossy, and nothing establishes that every constraint of a long one
 *    survives the way a short rule did.
 * 2. **Adherence lapsed across a boundary even where the rule survived.** In
 *    the eight-file run the step immediately after the second compaction
 *    omitted the line the contract required, then emitted two of them later.
 * 3. **The stream says how much was dropped, never what.** 172,547 tokens is a
 *    quantity, not a list, and there is no way to ask which constraint went.
 *
 * Hence: reported, and reported WITH THE NUMBER, so a gate can weigh how much
 * of a run happened after the evidence stopped being complete.
 */
export interface ContextCompaction {
  /** How many times the conversation was summarised mid-run. */
  boundaries: number;
  /** Total tokens discarded, as the harness itself reports them. */
  droppedTokens: number;
}

export function claudeContextCompacted(stdout: string): ContextCompaction | null {
  let boundaries = 0;
  let droppedTokens = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.type !== "system" || record.subtype !== "compact_boundary") continue;
    boundaries += 1;
    /* Cumulative, so the last boundary carries the run total rather than the
       sum of the deltas. Read through a shape check because this is a durable
       stream: a field that is absent is a real value it will see. */
    const meta = record.compact_metadata;
    if (isRecord(meta) && typeof meta.cumulative_dropped_tokens === "number") {
      droppedTokens = Math.max(droppedTokens, meta.cumulative_dropped_tokens);
    }
  }
  return boundaries === 0 ? null : { boundaries, droppedTokens };
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
    modelOutput: extractAdapterModelOutput(parser, stdout),
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

export function extractAdapterModelOutput(parser: AdapterUsageParser, stdout: string): string {
  if (parser === "codex-text") {
    return stdout;
  }
  if (parser === "opencode-json") {
    /* OpenCode streams events rather than a final message, so the readable
       reply is the last  part it emitted. */
    let latest = "";
    for (const line of stdout.split(/\r?\n/u)) {
      const text = line.trim();
      if (text === "" || !text.startsWith("{")) continue;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(record) || record.type !== "text") continue;
      const part = isRecord(record.part) ? record.part : null;
      if (part !== null && typeof part.text === "string") latest = part.text;
    }
    return latest;
  }

  if (parser === "grok-json") {
    let latest = "";
    for (const record of parseJsonLines(stdout)) {
      if (record.type === "assistant" && typeof record.content === "string") latest = record.content;
      const update = isRecord(record.update) ? record.update : null;
      if (update !== null && update.sessionUpdate === "agent_message_chunk" && isRecord(update.content) && typeof update.content.text === "string") {
        latest += update.content.text;
      }
    }
    return latest;
  }

  if (parser === "kimi-wire") {
    let latest = "";
    for (const record of parseJsonLines(stdout)) {
      if (record.role === "assistant" && typeof record.content === "string") latest = record.content;
    }
    return latest;
  }

  if (parser === "claude-json") {
    /* Claude's `--output-format stream-json` writes one JSON record per line.
       The final `result` record is the same authoritative reply that the
       single-object format exposes, and is already what the usage parser
       reads. Keep output and usage normalization on the same record so a
       valid streamed reply cannot be metered and then silently discarded. */
    const parsed = parseJsonObject(stdout) ?? findResultRecord(stdout);
    if (parsed === null) return "";
    /* Claude's structured-output contract puts the validated value beside the
       ordinary result text. Planner profiles request an object schema so a
       syntactically broken JSON reply is repaired inside the same provider
       invocation instead of reaching Hivemind's deterministic parser or
       requiring a second paid call. The exact spec/plan shape remains owned
       and validated by Core; this serialization only preserves the provider's
       already-validated JSON value across the adapter boundary. */
    if (isRecord(parsed.structured_output)) return JSON.stringify(parsed.structured_output);
    return typeof parsed.result === "string" ? parsed.result : "";
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
  return (
    value === "codex-jsonl" ||
    value === "codex-text" ||
    value === "claude-json" ||
    value === "opencode-json" ||
    value === "grok-json" ||
    value === "kimi-wire"
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/* ── What a provider says is LEFT ──────────────────────────────────────────
   Kept in this file because this is the one allowed to know how to read what a
   provider spent, and what is left is the same question asked forward. It was
   briefly its own module and `provider-knowledge.test.ts` refused it, rightly.
*/
export interface QuotaWindow {
  /** What the provider called it: "primary", "secondary". */
  name: string;
  used_percent: number;
  /** The window's length, where the provider gives one. */
  window_minutes: number | null;
  /** When it resets, as the provider reported it. Never computed here. */
  resets_at: string | null;
}

export interface ProviderQuota {
  windows: QuotaWindow[];
  /** The plan the provider named, where it named one. */
  plan: string | null;
}

/**
 * Read a quota snapshot out of a run's own output.
 *
 * Returns null when the provider reported nothing — which is a fact worth
 * keeping distinct from "reported zero headroom", and is why this is nullable
 * rather than defaulting to an empty snapshot.
 */
export function parseProviderQuota(parser: string, stdout: string): ProviderQuota | null {
  if (!parser.startsWith("codex")) return null;

  /* Newest-first: a long run emits several token-count events and the last one
     is the only one that describes the state the next call will meet. */
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === "" || !line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const snapshot = findRateLimits(record, 0);
    if (snapshot === null) continue;
    const windows: QuotaWindow[] = [];
    for (const name of ["primary", "secondary"]) {
      const window = isRecord(snapshot[name]) ? (snapshot[name] as Record<string, unknown>) : null;
      if (window === null) continue;
      const used = quotaNumberField(window, "used_percent");
      if (used === null) continue;
      windows.push({
        name,
        used_percent: used,
        window_minutes:
          quotaNumberField(window, "window_minutes") ??
          quotaNumberField(window, "window_duration_mins"),
        resets_at: typeof window.resets_at === "string" ? window.resets_at : null
      });
    }
    if (windows.length === 0) continue;
    return {
      windows,
      plan: typeof snapshot.planType === "string" ? snapshot.planType : null
    };
  }
  return null;
}

/* The snapshot is nested under an event envelope whose exact shape has changed
   between Codex versions, so it is found by SHAPE rather than by path: the
   first object carrying a `rate_limits` key. Matching a path would break on the
   next envelope change and look like the provider having stopped reporting. */
function findRateLimits(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 6 || !isRecord(value)) return null;
  if (isRecord(value.rate_limits)) return value.rate_limits;
  for (const nested of Object.values(value)) {
    const found = findRateLimits(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function quotaNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Record that the harness version moved since it was verified.
 *
 * Marks the connection record and nothing else. It does not refuse, does not
 * retry and does not re-probe: re-probing costs a real provider call, and
 * spending somebody's tokens because a version string changed is a decision
 * they should make. Every surface that reads `capabilities_stale` already says
 * what it means and offers the reconnect.
 *
 * Failure here is silent by design. This is a check ABOUT the run, not part of
 * it, and a run that dies because a `--version` call failed would be a worse
 * outcome than one that proceeds on a verdict that is a version out of date.
 */
async function noteVersionDrift(
  repoRoot: string,
  tool: string,
  profile: AdapterProfile
): Promise<void> {
  try {
    const recordPath = path.join(repoRoot, ".hivemind", "adapters", `${tool}.connection.json`);
    const raw: unknown = await readJsonFile(recordPath);
    if (typeof raw !== "object" || raw === null) return;
    const record = raw as { provider_version?: unknown; capabilities_stale?: unknown };
    /* Already marked: nothing to add, and overwriting an account-switch reason
       with a version one would lose the more specific of the two. */
    if (typeof record.capabilities_stale === "string") return;
    const recorded =
      typeof record.provider_version === "string" ? record.provider_version : null;
    const standing = await versionStanding(profile, recorded, repoRoot);
    if (standing.stale === null) return;
    await writeFileAtomic(
      recordPath,
      `${JSON.stringify({ ...record, capabilities_stale: standing.stale }, null, 2)}
`
    );
  } catch {
    /* A missing or unreadable record is the "never connected" case, which the
       surfaces already report. */
  }
}

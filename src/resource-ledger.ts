import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";

export interface SelfMeasuredUsage {
  requests: number;
  input_tokens_estimated: number;
  output_tokens_estimated: number;
  wall_time_ms: number;
}

export interface ProviderReportedUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number;
}

export interface ProviderReportedTotals extends ProviderReportedUsage {
  reports: number;
  self_measured_tokens_for_reported_requests: number;
}

export type ProviderUsageCapture =
  | {
      status: "captured";
      parser: string | null;
      usage: ProviderReportedUsage;
    }
  | {
      status: "not_available";
      parser: string | null;
      reason: string;
    }
  | {
      status: "expected_but_unparseable";
      parser: string;
      reason: string;
    };

export interface ProviderUsageCaptureSummary {
  captured_requests: number;
  not_available_requests: number;
  expected_but_unparseable_requests: number;
  last_status: ProviderUsageCapture["status"];
  last_parser: string | null;
  last_reason: string | null;
}

export interface LastQuotaRequest {
  self_measured_tokens: number;
  provider_reported_tokens: number | null;
  effective_tokens: number;
  accounting_source: "provider_reported" | "self_measured";
  provider_usage_status: ProviderUsageCapture["status"];
}

export interface SessionTokenUsage {
  requests: number;
  self_measured_tokens: number;
  provider_reported_tokens: number;
  provider_reported_requests: number;
  effective_tokens: number;
}

export interface UsageReconciliation {
  self_measured_tokens_for_reported_requests: number;
  provider_reported_total_tokens: number | null;
  absolute_divergence_tokens: number | null;
  provider_to_self_ratio: number | null;
  accounting_source: "provider_reported" | "self_measured";
  routing_source: "observed_limit" | "profile_policy";
}

export interface ObservedLimit extends SelfMeasuredUsage {
  observed_at: string;
  reason: "throttle";
}

export interface QuotaLedgerEntry {
  self_measured: SelfMeasuredUsage;
  provider_reported: ProviderReportedTotals | null;
  provider_usage_capture: ProviderUsageCaptureSummary;
  last_request: LastQuotaRequest | null;
  session_usage: Record<string, SessionTokenUsage>;
  reconciliation: UsageReconciliation;
  observed_limit: ObservedLimit | null;
  resets_at: string | null;
  source: "dual-channel";
  updated_at: string;
  unmetered: boolean;
}

export type QuotaLedger = Record<string, QuotaLedgerEntry>;

export interface QuotaUsageRecord {
  provider: string;
  input_text: string;
  model_output_text: string;
  wall_time_ms: number;
  throttled: boolean;
  session_id?: string;
  provider_usage?: ProviderUsageCapture;
  provider_reported?: ProviderReportedUsage | null;
}

export type RecordQuotaUsageResult =
  | { ok: true; value: QuotaLedgerEntry }
  | { ok: false; reason: string; budget_exceeded?: true };

const ledgerLockRetryMs = 25;
const ledgerLockTimeoutMs = 2000;
const ledgerQueues = new Map<string, Promise<void>>();

export async function quotaCommand(cwd: string, args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "status" || rest.length > 0) {
    console.error("error: usage: hivemind quota status");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<QuotaLedger>(repoRoot, "/resource/quota", {});
  const result = daemonResult.routed ? daemonResult : await readQuotaLedger(repoRoot);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function readQuotaLedger(repoRoot: string): Promise<{ ok: true; value: QuotaLedger } | { ok: false; reason: string }> {
  let raw: unknown;
  try {
    raw = await readJsonFile(ledgerPath(repoRoot));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: {} };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/resource/ledger.json" };
    }
    throw error;
  }

  return normalizeQuotaLedger(raw);
}

export async function checkTokenBudgetPreflight(
  repoRoot: string,
  provider: string,
  sessionId?: string,
  estimatedInputTokens = 0
): Promise<{ ok: true } | { ok: false; reason: string; budget_exceeded: true }> {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === null) {
    return { ok: false, reason: "quota provider must be a non-empty identifier", budget_exceeded: true };
  }
  if (isUnmeteredProvider(normalizedProvider)) {
    return { ok: true };
  }
  const normalizedSession = normalizeSessionId(sessionId);
  if (sessionId !== undefined && normalizedSession === null) {
    return { ok: false, reason: "quota session_id must be a non-empty identifier", budget_exceeded: true };
  }
  if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) {
    return { ok: false, reason: "estimated input tokens must be a non-negative safe integer", budget_exceeded: true };
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return { ok: false, reason: config.reason, budget_exceeded: true };
  }
  const runTokens = config.config.resource_policy?.run_ceiling?.tokens;
  if (runTokens === 0) {
    return {
      ok: false,
      reason: `token budget exceeded: run token ceiling 0 forbids invoking metered provider ${normalizedProvider}`,
      budget_exceeded: true
    };
  }
  if (runTokens !== undefined && estimatedInputTokens >= runTokens) {
    return {
      ok: false,
      reason: `token budget exceeded: estimated input ${estimatedInputTokens} tokens leaves no output budget under run ceiling ${runTokens} for ${normalizedProvider}`,
      budget_exceeded: true
    };
  }
  const sessionTokens = config.config.resource_policy?.session_ceiling?.tokens;
  if (sessionTokens === undefined || normalizedSession === null) {
    return { ok: true };
  }
  const ledger = await readQuotaLedger(repoRoot);
  if (!ledger.ok) {
    return { ok: false, reason: ledger.reason, budget_exceeded: true };
  }
  const used = sessionEffectiveTokens(ledger.value, normalizedSession);
  return used + estimatedInputTokens >= sessionTokens
    ? {
        ok: false,
        reason: `token budget exceeded: manager session ${normalizedSession} used ${used} effective tokens with ${estimatedInputTokens} estimated input tokens against ceiling ${sessionTokens}`,
        budget_exceeded: true
      }
    : { ok: true };
}

export async function recordQuotaUsage(repoRoot: string, record: QuotaUsageRecord): Promise<RecordQuotaUsageResult> {
  const provider = normalizeProvider(record.provider);
  if (provider === null) {
    return { ok: false, reason: "quota provider must be a non-empty identifier" };
  }
  if (!Number.isSafeInteger(record.wall_time_ms) || record.wall_time_ms < 0) {
    return { ok: false, reason: "quota wall_time_ms must be a non-negative safe integer" };
  }
  const sessionId = normalizeSessionId(record.session_id);
  if (record.session_id !== undefined && sessionId === null) {
    return { ok: false, reason: "quota session_id must be a non-empty identifier" };
  }
  if (record.provider_usage !== undefined && record.provider_reported !== undefined) {
    return { ok: false, reason: "quota usage must provide provider_usage or legacy provider_reported, not both" };
  }
  const capture = normalizeUsageCapture(record);
  if (!capture.ok) {
    return capture;
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }

  return withInProcessLedgerQueue(repoRoot, () =>
    withLedgerLock(repoRoot, async () => {
      const ledgerResult = await readQuotaLedger(repoRoot);
      if (!ledgerResult.ok) {
        return ledgerResult;
      }

      const now = new Date().toISOString();
      const previous = ledgerResult.value[provider] ?? createEmptyEntry(provider, now);
      const measuredThisRequest: SelfMeasuredUsage = {
        requests: 1,
        input_tokens_estimated: estimateTokens(record.input_text),
        output_tokens_estimated: estimateTokens(record.model_output_text),
        wall_time_ms: record.wall_time_ms
      };
      const selfMeasured = addUsage(previous.self_measured, measuredThisRequest);
      const selfMeasuredTokens = measuredThisRequest.input_tokens_estimated + measuredThisRequest.output_tokens_estimated;
      const reportedThisRequest = capture.value.status === "captured" ? capture.value.usage : null;
      const providerReported = mergeProviderReported(
        previous.provider_reported,
        reportedThisRequest,
        selfMeasuredTokens
      );
      const effectiveTokens = reportedThisRequest?.total_tokens ?? selfMeasuredTokens;
      const lastRequest: LastQuotaRequest = {
        self_measured_tokens: selfMeasuredTokens,
        provider_reported_tokens: reportedThisRequest?.total_tokens ?? null,
        effective_tokens: effectiveTokens,
        accounting_source: reportedThisRequest === null ? "self_measured" : "provider_reported",
        provider_usage_status: capture.value.status
      };
      const nextEntry: QuotaLedgerEntry = {
        self_measured: selfMeasured,
        provider_reported: providerReported,
        provider_usage_capture: addUsageCapture(previous.provider_usage_capture, capture.value),
        last_request: lastRequest,
        session_usage:
          sessionId === null
            ? previous.session_usage
            : addSessionUsage(previous.session_usage, sessionId, selfMeasuredTokens, reportedThisRequest?.total_tokens ?? null),
        reconciliation: buildReconciliation(providerReported, record.throttled || previous.observed_limit !== null),
        observed_limit: record.throttled ? { ...selfMeasured, observed_at: now, reason: "throttle" } : previous.observed_limit,
        resets_at: previous.resets_at,
        source: "dual-channel",
        updated_at: now,
        unmetered: isUnmeteredProvider(provider)
      };
      const nextLedger: QuotaLedger = {
        ...ledgerResult.value,
        [provider]: nextEntry
      };
      await writeQuotaLedger(repoRoot, nextLedger);
      if (capture.value.status === "expected_but_unparseable") {
        return {
          ok: false,
          reason: `provider usage expected but unparseable for ${provider} (${capture.value.parser}): ${capture.value.reason}; self-measured fallback recorded`
        };
      }
      if (!nextEntry.unmetered) {
        const runTokenCeiling = config.config.resource_policy?.run_ceiling?.tokens;
        if (runTokenCeiling !== undefined && effectiveTokens > runTokenCeiling) {
          return {
            ok: false,
            reason: `token budget exceeded: ${provider} call used ${effectiveTokens} effective tokens against run ceiling ${runTokenCeiling}`,
            budget_exceeded: true
          };
        }
        const sessionTokenCeiling = config.config.resource_policy?.session_ceiling?.tokens;
        if (sessionId !== null && sessionTokenCeiling !== undefined) {
          const sessionTokens = sessionEffectiveTokens(nextLedger, sessionId);
          if (sessionTokens > sessionTokenCeiling) {
            return {
              ok: false,
              reason: `token budget exceeded: manager session ${sessionId} used ${sessionTokens} effective tokens against ceiling ${sessionTokenCeiling}`,
              budget_exceeded: true
            };
          }
        }
      }
      return { ok: true, value: nextEntry };
    })
  );
}

export function adapterOutputIndicatesThrottle(stdout: string, stderr: string, exitCode: number): boolean {
  if (exitCode === 0) {
    return false;
  }
  return /\b429\b|too many requests|rate[- ]?limit|throttl|quota exceeded|quota limit/i.test(`${stdout}\n${stderr}`);
}

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function createEmptyEntry(provider: string, updatedAt: string): QuotaLedgerEntry {
  const selfMeasured = emptyUsage();
  return {
    self_measured: selfMeasured,
    provider_reported: null,
    provider_usage_capture: emptyUsageCapture(),
    last_request: null,
    session_usage: {},
    reconciliation: buildReconciliation(null, false),
    observed_limit: null,
    resets_at: null,
    source: "dual-channel",
    updated_at: updatedAt,
    unmetered: isUnmeteredProvider(provider)
  };
}

function addUsage(left: SelfMeasuredUsage, right: SelfMeasuredUsage): SelfMeasuredUsage {
  return {
    requests: left.requests + right.requests,
    input_tokens_estimated: left.input_tokens_estimated + right.input_tokens_estimated,
    output_tokens_estimated: left.output_tokens_estimated + right.output_tokens_estimated,
    wall_time_ms: left.wall_time_ms + right.wall_time_ms
  };
}

function addSessionUsage(
  sessions: Record<string, SessionTokenUsage>,
  sessionId: string,
  selfMeasuredTokens: number,
  providerReportedTokens: number | null
): Record<string, SessionTokenUsage> {
  const previous = sessions[sessionId] ?? {
    requests: 0,
    self_measured_tokens: 0,
    provider_reported_tokens: 0,
    provider_reported_requests: 0,
    effective_tokens: 0
  };
  return {
    ...sessions,
    [sessionId]: {
      requests: previous.requests + 1,
      self_measured_tokens: previous.self_measured_tokens + selfMeasuredTokens,
      provider_reported_tokens: previous.provider_reported_tokens + (providerReportedTokens ?? 0),
      provider_reported_requests: previous.provider_reported_requests + (providerReportedTokens === null ? 0 : 1),
      effective_tokens: previous.effective_tokens + (providerReportedTokens ?? selfMeasuredTokens)
    }
  };
}

function sessionEffectiveTokens(ledger: QuotaLedger, sessionId: string): number {
  return Object.values(ledger).reduce(
    (sum, entry) => sum + (entry.unmetered ? 0 : (entry.session_usage[sessionId]?.effective_tokens ?? 0)),
    0
  );
}

function emptyUsage(): SelfMeasuredUsage {
  return {
    requests: 0,
    input_tokens_estimated: 0,
    output_tokens_estimated: 0,
    wall_time_ms: 0
  };
}

async function writeQuotaLedger(repoRoot: string, ledger: QuotaLedger): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(ledger).sort(([left], [right]) => left.localeCompare(right)));
  await writeJsonAtomic(ledgerPath(repoRoot), sorted);
}

async function withLedgerLock<T>(repoRoot: string, action: () => Promise<{ ok: true; value: T } | { ok: false; reason: string }>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const lockPath = ledgerLockPath(repoRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + ledgerLockTimeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await action();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error: unknown) {
      if (!isRetryableLockError(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        return { ok: false, reason: "could not acquire quota ledger lock" };
      }
      await sleep(ledgerLockRetryMs);
    }
  }
}

async function withInProcessLedgerQueue<T>(
  repoRoot: string,
  action: () => Promise<{ ok: true; value: T } | { ok: false; reason: string }>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const key = ledgerLockPath(repoRoot);
  const previous = ledgerQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => slot);
  ledgerQueues.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (ledgerQueues.get(key) === next) {
      ledgerQueues.delete(key);
    }
  }
}

function ledgerPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "resource", "ledger.json");
}

function ledgerLockPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "resource", "ledger.lock");
}

function normalizeProvider(provider: string): string | null {
  const trimmed = provider.trim();
  return trimmed === "" || /[\u0000-\u001f/\\]/.test(trimmed) ? null : trimmed;
}

function normalizeSessionId(sessionId: string | undefined): string | null {
  if (sessionId === undefined) {
    return null;
  }
  const trimmed = sessionId.trim();
  return trimmed === "" || /[\u0000-\u001f/\\]/u.test(trimmed) ? null : trimmed;
}

function isUnmeteredProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return normalized === "local" || normalized.startsWith("local-") || normalized === "ollama";
}

function normalizeQuotaLedger(value: unknown): { ok: true; value: QuotaLedger } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "quota ledger must be a JSON object" };
  }
  const normalized: QuotaLedger = {};
  for (const [provider, entry] of Object.entries(value)) {
    const providerResult = normalizeProvider(provider);
    if (providerResult === null) {
      return { ok: false, reason: "quota ledger provider keys must be non-empty identifiers" };
    }
    const entryResult = normalizeQuotaLedgerEntry(provider, entry);
    if (!entryResult.ok) {
      return entryResult;
    }
    normalized[provider] = entryResult.value;
  }
  return { ok: true, value: normalized };
}

function normalizeQuotaLedgerEntry(
  provider: string,
  value: unknown
): { ok: true; value: QuotaLedgerEntry } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `quota ledger entry for ${provider} must be a JSON object` };
  }

  const legacy = !("self_measured" in value) && "used" in value;
  const selfMeasuredRaw = legacy ? value.used : value.self_measured;
  const measuredResult = validateUsage(`${provider}.${legacy ? "used" : "self_measured"}`, selfMeasuredRaw);
  if (!measuredResult.ok) {
    return measuredResult;
  }
  const selfMeasured = selfMeasuredRaw as SelfMeasuredUsage;

  let providerReported: ProviderReportedTotals | null = null;
  if (!legacy && value.provider_reported !== null) {
    const reportedResult = validateProviderReportedTotals(`${provider}.provider_reported`, value.provider_reported);
    if (!reportedResult.ok) {
      return reportedResult;
    }
    providerReported = value.provider_reported as ProviderReportedTotals;
  }
  const captureResult = normalizeUsageCaptureSummary(provider, value.provider_usage_capture);
  if (!captureResult.ok) {
    return captureResult;
  }
  const lastRequestResult = normalizeLastRequest(provider, value.last_request);
  if (!lastRequestResult.ok) {
    return lastRequestResult;
  }
  const sessionUsageResult = normalizeSessionUsage(provider, value.session_usage);
  if (!sessionUsageResult.ok) {
    return sessionUsageResult;
  }

  if (value.observed_limit !== null) {
    const observedResult = validateObservedLimit(`${provider}.observed_limit`, value.observed_limit);
    if (!observedResult.ok) {
      return observedResult;
    }
  }
  if (value.resets_at !== null && (typeof value.resets_at !== "string" || Number.isNaN(Date.parse(value.resets_at)))) {
    return { ok: false, reason: `${provider}.resets_at must be an ISO timestamp string or null` };
  }
  if (legacy ? value.source !== "self-metered" : value.source !== "dual-channel") {
    return { ok: false, reason: `${provider}.source must be ${legacy ? "self-metered" : "dual-channel"}` };
  }
  if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) {
    return { ok: false, reason: `${provider}.updated_at must be an ISO timestamp string` };
  }
  if (typeof value.unmetered !== "boolean") {
    return { ok: false, reason: `${provider}.unmetered must be a boolean` };
  }
  const observedLimit = value.observed_limit as ObservedLimit | null;
  const expectedReconciliation = buildReconciliation(providerReported, observedLimit !== null);
  if (!legacy) {
    const reconciliationResult = validateReconciliation(`${provider}.reconciliation`, value.reconciliation);
    if (!reconciliationResult.ok) {
      return reconciliationResult;
    }
    if (JSON.stringify(value.reconciliation) !== JSON.stringify(expectedReconciliation)) {
      return { ok: false, reason: `${provider}.reconciliation must match the recorded usage channels` };
    }
  }
  return {
    ok: true,
    value: {
      self_measured: selfMeasured,
      provider_reported: providerReported,
      provider_usage_capture: captureResult.value,
      last_request: lastRequestResult.value,
      session_usage: sessionUsageResult.value,
      reconciliation: expectedReconciliation,
      observed_limit: observedLimit,
      resets_at: value.resets_at as string | null,
      source: "dual-channel",
      updated_at: value.updated_at as string,
      unmetered: value.unmetered as boolean
    }
  };
}

function normalizeUsageCapture(record: QuotaUsageRecord): { ok: true; value: ProviderUsageCapture } | { ok: false; reason: string } {
  if (record.provider_usage !== undefined) {
    const result = validateProviderUsageCapture("provider_usage", record.provider_usage);
    return result.ok ? { ok: true, value: record.provider_usage } : result;
  }
  if (record.provider_reported !== undefined && record.provider_reported !== null) {
    const result = validateProviderReportedUsage("provider_reported", record.provider_reported);
    return result.ok
      ? { ok: true, value: { status: "captured", parser: null, usage: record.provider_reported } }
      : result;
  }
  return {
    ok: true,
    value: {
      status: "not_available",
      parser: null,
      reason: "provider usage was not requested or reported"
    }
  };
}

function validateProviderUsageCapture(
  label: string,
  value: unknown
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  if (
    value.status !== "captured" &&
    value.status !== "not_available" &&
    value.status !== "expected_but_unparseable"
  ) {
    return { ok: false, reason: `${label}.status is invalid` };
  }
  if (value.parser !== null && (typeof value.parser !== "string" || value.parser.trim() === "")) {
    return { ok: false, reason: `${label}.parser must be a non-empty string or null` };
  }
  if (value.status === "captured") {
    return validateProviderReportedUsage(`${label}.usage`, value.usage);
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    return { ok: false, reason: `${label}.reason must be a non-empty string` };
  }
  if (value.status === "expected_but_unparseable" && value.parser === null) {
    return { ok: false, reason: `${label}.parser must identify the expected parser` };
  }
  return { ok: true };
}

function emptyUsageCapture(): ProviderUsageCaptureSummary {
  return {
    captured_requests: 0,
    not_available_requests: 0,
    expected_but_unparseable_requests: 0,
    last_status: "not_available",
    last_parser: null,
    last_reason: "no adapter requests recorded"
  };
}

function addUsageCapture(
  previous: ProviderUsageCaptureSummary,
  current: ProviderUsageCapture
): ProviderUsageCaptureSummary {
  return {
    captured_requests: previous.captured_requests + (current.status === "captured" ? 1 : 0),
    not_available_requests: previous.not_available_requests + (current.status === "not_available" ? 1 : 0),
    expected_but_unparseable_requests:
      previous.expected_but_unparseable_requests + (current.status === "expected_but_unparseable" ? 1 : 0),
    last_status: current.status,
    last_parser: current.parser,
    last_reason: current.status === "captured" ? null : current.reason
  };
}

function normalizeUsageCaptureSummary(
  provider: string,
  value: unknown
): { ok: true; value: ProviderUsageCaptureSummary } | { ok: false; reason: string } {
  if (value === undefined) {
    return { ok: true, value: emptyUsageCapture() };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${provider}.provider_usage_capture must be a JSON object` };
  }
  for (const field of ["captured_requests", "not_available_requests", "expected_but_unparseable_requests"] as const) {
    if (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0) {
      return { ok: false, reason: `${provider}.provider_usage_capture.${field} must be a non-negative safe integer` };
    }
  }
  if (
    value.last_status !== "captured" &&
    value.last_status !== "not_available" &&
    value.last_status !== "expected_but_unparseable"
  ) {
    return { ok: false, reason: `${provider}.provider_usage_capture.last_status is invalid` };
  }
  if (value.last_parser !== null && (typeof value.last_parser !== "string" || value.last_parser.trim() === "")) {
    return { ok: false, reason: `${provider}.provider_usage_capture.last_parser must be a non-empty string or null` };
  }
  if (value.last_reason !== null && (typeof value.last_reason !== "string" || value.last_reason.trim() === "")) {
    return { ok: false, reason: `${provider}.provider_usage_capture.last_reason must be a non-empty string or null` };
  }
  return { ok: true, value: value as unknown as ProviderUsageCaptureSummary };
}

function normalizeLastRequest(
  provider: string,
  value: unknown
): { ok: true; value: LastQuotaRequest | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${provider}.last_request must be a JSON object or null` };
  }
  for (const field of ["self_measured_tokens", "effective_tokens"] as const) {
    if (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0) {
      return { ok: false, reason: `${provider}.last_request.${field} must be a non-negative safe integer` };
    }
  }
  if (
    value.provider_reported_tokens !== null &&
    (!Number.isSafeInteger(value.provider_reported_tokens) ||
      typeof value.provider_reported_tokens !== "number" ||
      value.provider_reported_tokens < 0)
  ) {
    return { ok: false, reason: `${provider}.last_request.provider_reported_tokens must be a non-negative safe integer or null` };
  }
  if (value.accounting_source !== "provider_reported" && value.accounting_source !== "self_measured") {
    return { ok: false, reason: `${provider}.last_request.accounting_source is invalid` };
  }
  if (
    value.provider_usage_status !== "captured" &&
    value.provider_usage_status !== "not_available" &&
    value.provider_usage_status !== "expected_but_unparseable"
  ) {
    return { ok: false, reason: `${provider}.last_request.provider_usage_status is invalid` };
  }
  return { ok: true, value: value as unknown as LastQuotaRequest };
}

function normalizeSessionUsage(
  provider: string,
  value: unknown
): { ok: true; value: Record<string, SessionTokenUsage> } | { ok: false; reason: string } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${provider}.session_usage must be a JSON object` };
  }
  const normalized: Record<string, SessionTokenUsage> = {};
  for (const [sessionId, usage] of Object.entries(value)) {
    if (normalizeSessionId(sessionId) === null || !isRecord(usage)) {
      return { ok: false, reason: `${provider}.session_usage entries must use valid session identifiers and JSON objects` };
    }
    for (const field of [
      "requests",
      "self_measured_tokens",
      "provider_reported_tokens",
      "provider_reported_requests",
      "effective_tokens"
    ] as const) {
      if (!Number.isSafeInteger(usage[field]) || typeof usage[field] !== "number" || usage[field] < 0) {
        return { ok: false, reason: `${provider}.session_usage.${sessionId}.${field} must be a non-negative safe integer` };
      }
    }
    normalized[sessionId] = usage as unknown as SessionTokenUsage;
  }
  return { ok: true, value: normalized };
}

function validateObservedLimit(label: string, value: unknown): { ok: true } | { ok: false; reason: string } {
  const usageResult = validateUsage(label, value);
  if (!usageResult.ok) {
    return usageResult;
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object or null` };
  }
  if (typeof value.observed_at !== "string" || Number.isNaN(Date.parse(value.observed_at))) {
    return { ok: false, reason: `${label}.observed_at must be an ISO timestamp string` };
  }
  if (value.reason !== "throttle") {
    return { ok: false, reason: `${label}.reason must be throttle` };
  }
  return { ok: true };
}

function validateUsage(label: string, value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  for (const field of ["requests", "input_tokens_estimated", "output_tokens_estimated", "wall_time_ms"] as const) {
    const fieldValue = value[field];
    if (!Number.isSafeInteger(fieldValue) || typeof fieldValue !== "number" || fieldValue < 0) {
      return { ok: false, reason: `${label}.${field} must be a non-negative safe integer` };
    }
  }
  return { ok: true };
}

function mergeProviderReported(
  previous: ProviderReportedTotals | null,
  current: ProviderReportedUsage | null,
  selfMeasuredTokens: number
): ProviderReportedTotals | null {
  if (current === null) {
    return previous;
  }
  if (previous === null) {
    return {
      reports: 1,
      input_tokens: current.input_tokens,
      cached_input_tokens: current.cached_input_tokens,
      output_tokens: current.output_tokens,
      reasoning_tokens: current.reasoning_tokens,
      total_tokens: current.total_tokens,
      self_measured_tokens_for_reported_requests: selfMeasuredTokens
    };
  }
  return {
    reports: previous.reports + 1,
    input_tokens: addNullableReported(previous.input_tokens, current.input_tokens),
    cached_input_tokens: addNullableReported(previous.cached_input_tokens, current.cached_input_tokens),
    output_tokens: addNullableReported(previous.output_tokens, current.output_tokens),
    reasoning_tokens: addNullableReported(previous.reasoning_tokens, current.reasoning_tokens),
    total_tokens: previous.total_tokens + current.total_tokens,
    self_measured_tokens_for_reported_requests:
      previous.self_measured_tokens_for_reported_requests + selfMeasuredTokens
  };
}

function addNullableReported(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

function buildReconciliation(
  providerReported: ProviderReportedTotals | null,
  hasObservedLimit: boolean
): UsageReconciliation {
  const matchedSelf = providerReported?.self_measured_tokens_for_reported_requests ?? 0;
  const providerTotal = providerReported?.total_tokens ?? null;
  return {
    self_measured_tokens_for_reported_requests: matchedSelf,
    provider_reported_total_tokens: providerTotal,
    absolute_divergence_tokens: providerTotal === null ? null : Math.abs(providerTotal - matchedSelf),
    provider_to_self_ratio: providerTotal === null || matchedSelf === 0 ? null : providerTotal / matchedSelf,
    accounting_source: providerTotal === null ? "self_measured" : "provider_reported",
    routing_source: hasObservedLimit ? "observed_limit" : "profile_policy"
  };
}

function validateProviderReportedUsage(
  label: string,
  value: unknown
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== null && (!Number.isSafeInteger(fieldValue) || typeof fieldValue !== "number" || fieldValue < 0)) {
      return { ok: false, reason: `${label}.${field} must be a non-negative safe integer or null` };
    }
  }
  if (!Number.isSafeInteger(value.total_tokens) || typeof value.total_tokens !== "number" || value.total_tokens < 0) {
    return { ok: false, reason: `${label}.total_tokens must be a non-negative safe integer` };
  }
  return { ok: true };
}

function validateProviderReportedTotals(
  label: string,
  value: unknown
): { ok: true } | { ok: false; reason: string } {
  const usage = validateProviderReportedUsage(label, value);
  if (!usage.ok) {
    return usage;
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  for (const field of ["reports", "self_measured_tokens_for_reported_requests"] as const) {
    if (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0) {
      return { ok: false, reason: `${label}.${field} must be a non-negative safe integer` };
    }
  }
  return { ok: true };
}

function validateReconciliation(label: string, value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  if (
    value.accounting_source !== "provider_reported" &&
    value.accounting_source !== "self_measured"
  ) {
    return { ok: false, reason: `${label}.accounting_source is invalid` };
  }
  if (value.routing_source !== "observed_limit" && value.routing_source !== "profile_policy") {
    return { ok: false, reason: `${label}.routing_source is invalid` };
  }
  for (const field of [
    "self_measured_tokens_for_reported_requests",
    "provider_reported_total_tokens",
    "absolute_divergence_tokens",
    "provider_to_self_ratio"
  ] as const) {
    const fieldValue = value[field];
    if (fieldValue !== null && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0)) {
      return { ok: false, reason: `${label}.${field} must be a non-negative finite number or null` };
    }
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRetryableLockError(error: unknown): boolean {
  return isNodeError(error, "EEXIST") || isNodeError(error, "EPERM");
}

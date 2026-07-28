import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJsonAtomic } from "./atomic.js";
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
  provider_reported?: ProviderReportedUsage | null;
}

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

export async function recordQuotaUsage(repoRoot: string, record: QuotaUsageRecord): Promise<{ ok: true; value: QuotaLedgerEntry } | { ok: false; reason: string }> {
  const provider = normalizeProvider(record.provider);
  if (provider === null) {
    return { ok: false, reason: "quota provider must be a non-empty identifier" };
  }
  if (!Number.isSafeInteger(record.wall_time_ms) || record.wall_time_ms < 0) {
    return { ok: false, reason: "quota wall_time_ms must be a non-negative safe integer" };
  }
  if (record.provider_reported !== undefined && record.provider_reported !== null) {
    const providerUsage = validateProviderReportedUsage("provider_reported", record.provider_reported);
    if (!providerUsage.ok) {
      return providerUsage;
    }
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
      const providerReported = mergeProviderReported(
        previous.provider_reported,
        record.provider_reported ?? null,
        measuredThisRequest.input_tokens_estimated + measuredThisRequest.output_tokens_estimated
      );
      const nextEntry: QuotaLedgerEntry = {
        self_measured: selfMeasured,
        provider_reported: providerReported,
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
      reconciliation: expectedReconciliation,
      observed_limit: observedLimit,
      resets_at: value.resets_at as string | null,
      source: "dual-channel",
      updated_at: value.updated_at as string,
      unmetered: value.unmetered as boolean
    }
  };
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

import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJsonAtomic } from "./atomic.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";

export interface QuotaUsageTotals {
  requests: number;
  input_tokens_estimated: number;
  output_tokens_estimated: number;
  wall_time_ms: number;
}

export interface ObservedLimit extends QuotaUsageTotals {
  observed_at: string;
  reason: "throttle";
}

export interface QuotaLedgerEntry {
  used: QuotaUsageTotals;
  observed_limit: ObservedLimit | null;
  resets_at: string | null;
  source: "self-metered";
  updated_at: string;
  unmetered: boolean;
}

export type QuotaLedger = Record<string, QuotaLedgerEntry>;

export interface QuotaUsageRecord {
  provider: string;
  input_text: string;
  output_text: string;
  wall_time_ms: number;
  throttled: boolean;
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

  const validation = validateQuotaLedger(raw);
  return validation.ok ? { ok: true, value: raw as QuotaLedger } : validation;
}

export async function recordQuotaUsage(repoRoot: string, record: QuotaUsageRecord): Promise<{ ok: true; value: QuotaLedgerEntry } | { ok: false; reason: string }> {
  const provider = normalizeProvider(record.provider);
  if (provider === null) {
    return { ok: false, reason: "quota provider must be a non-empty identifier" };
  }
  if (!Number.isSafeInteger(record.wall_time_ms) || record.wall_time_ms < 0) {
    return { ok: false, reason: "quota wall_time_ms must be a non-negative safe integer" };
  }

  return withInProcessLedgerQueue(repoRoot, () =>
    withLedgerLock(repoRoot, async () => {
      const ledgerResult = await readQuotaLedger(repoRoot);
      if (!ledgerResult.ok) {
        return ledgerResult;
      }

      const now = new Date().toISOString();
      const previous = ledgerResult.value[provider] ?? createEmptyEntry(provider, now);
      const used = addUsage(previous.used, {
        requests: 1,
        input_tokens_estimated: estimateTokens(record.input_text),
        output_tokens_estimated: estimateTokens(record.output_text),
        wall_time_ms: record.wall_time_ms
      });
      const nextEntry: QuotaLedgerEntry = {
        used,
        observed_limit: record.throttled ? { ...used, observed_at: now, reason: "throttle" } : previous.observed_limit,
        resets_at: previous.resets_at,
        source: "self-metered",
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
  return {
    used: emptyUsage(),
    observed_limit: null,
    resets_at: null,
    source: "self-metered",
    updated_at: updatedAt,
    unmetered: isUnmeteredProvider(provider)
  };
}

function addUsage(left: QuotaUsageTotals, right: QuotaUsageTotals): QuotaUsageTotals {
  return {
    requests: left.requests + right.requests,
    input_tokens_estimated: left.input_tokens_estimated + right.input_tokens_estimated,
    output_tokens_estimated: left.output_tokens_estimated + right.output_tokens_estimated,
    wall_time_ms: left.wall_time_ms + right.wall_time_ms
  };
}

function emptyUsage(): QuotaUsageTotals {
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

function validateQuotaLedger(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "quota ledger must be a JSON object" };
  }
  for (const [provider, entry] of Object.entries(value)) {
    const providerResult = normalizeProvider(provider);
    if (providerResult === null) {
      return { ok: false, reason: "quota ledger provider keys must be non-empty identifiers" };
    }
    const entryResult = validateQuotaLedgerEntry(provider, entry);
    if (!entryResult.ok) {
      return entryResult;
    }
  }
  return { ok: true };
}

function validateQuotaLedgerEntry(provider: string, value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: `quota ledger entry for ${provider} must be a JSON object` };
  }
  const usedResult = validateUsage(`${provider}.used`, value.used);
  if (!usedResult.ok) {
    return usedResult;
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
  if (value.source !== "self-metered") {
    return { ok: false, reason: `${provider}.source must be self-metered` };
  }
  if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) {
    return { ok: false, reason: `${provider}.updated_at must be an ISO timestamp string` };
  }
  if (typeof value.unmetered !== "boolean") {
    return { ok: false, reason: `${provider}.unmetered must be a boolean` };
  }
  return { ok: true };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRetryableLockError(error: unknown): boolean {
  return isNodeError(error, "EEXIST") || isNodeError(error, "EPERM");
}

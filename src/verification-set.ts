import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TaskTier } from "./routing.js";
import { writeImmutableJsonArtifact } from "./immutable-artifact.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

export interface VerificationSetInput {
  task_id: string;
  contract_path: string;
  contract_sha256: string;
  patch_path: string;
  patch_sha256: string;
}

export interface VerificationSetOracleAssessment {
  coverage_configured: boolean;
  binding: boolean;
  task_tier: TaskTier;
  status: "unconfigured" | "strong" | "weak" | "unknown";
  decision: "proceed" | "proceed_low_confidence" | "block";
  diagnostic: string;
  uncovered_changed_lines: string[];
  uncovered_impact_files: string[];
  unknown_files: string[];
  unknown_reasons: string[];
  recommendation: string | null;
  automatic_generation_launched: false;
}

export interface VerificationSetEvidence {
  audit: unknown;
  checks: unknown;
  runtime_coverage: unknown;
  tests: "pass";
}

export interface VerificationSetManifest {
  version: 1;
  verification_id: string;
  created_at: string;
  base_branch: string;
  base_commit: string;
  task_ids: string[];
  inputs: VerificationSetInput[];
  changed_files: string[];
  result_tree: string;
  config_path: ".hivemind/config.json";
  config_sha256: string;
  verification: VerificationSetEvidence;
  oracle: VerificationSetOracleAssessment;
}

export interface StoredVerificationSet {
  manifest: VerificationSetManifest;
  manifest_path: string;
  manifest_sha256: string;
}

export async function captureVerificationInputs(
  repoRoot: string,
  taskIds: string[]
): Promise<{ ok: true; value: { inputs: VerificationSetInput[]; config_sha256: string } } | { ok: false; reason: string }> {
  try {
    const inputs: VerificationSetInput[] = [];
    for (const taskId of taskIds) {
      const contractPath = `.hivemind/tasks/${taskId}.contract.json`;
      const patchPath = `.hivemind/patches/${taskId}/diff.patch`;
      inputs.push({
        task_id: taskId,
        contract_path: contractPath,
        contract_sha256: await hashFile(path.join(repoRoot, ...contractPath.split("/"))),
        patch_path: patchPath,
        patch_sha256: await hashFile(path.join(repoRoot, ...patchPath.split("/")))
      });
    }
    return {
      ok: true,
      value: {
        inputs,
        config_sha256: await hashFile(path.join(repoRoot, ".hivemind", "config.json"))
      }
    };
  } catch (error: unknown) {
    return { ok: false, reason: `failed to bind verification inputs: ${errorMessage(error)}` };
  }
}

export async function writeVerificationSet(
  repoRoot: string,
  input: Omit<VerificationSetManifest, "version" | "verification_id" | "created_at">
): Promise<{ ok: true; value: StoredVerificationSet } | { ok: false; reason: string }> {
  const verificationId = `V-${randomUUID()}`;
  const manifest: VerificationSetManifest = {
    version: 1,
    verification_id: verificationId,
    created_at: new Date().toISOString(),
    ...input
  };
  const manifestPath = `.hivemind/resource/verification-sets/${verificationId}/manifest.json`;
  const absolutePath = path.join(repoRoot, ...manifestPath.split("/"));
  try {
    await writeImmutableJsonArtifact(absolutePath, manifest);
    return {
      ok: true,
      value: {
        manifest,
        manifest_path: manifestPath,
        manifest_sha256: await hashFile(absolutePath)
      }
    };
  } catch (error: unknown) {
    return { ok: false, reason: `failed to write verification-set manifest: ${errorMessage(error)}` };
  }
}

export async function loadVerificationSet(
  repoRoot: string,
  verificationId: string
): Promise<{ ok: true; value: StoredVerificationSet } | { ok: false; reason: string }> {
  if (!/^V-[0-9a-f-]{36}$/iu.test(verificationId)) {
    return { ok: false, reason: "verification_id is invalid" };
  }
  const manifestPath = `.hivemind/resource/verification-sets/${verificationId}/manifest.json`;
  const absolutePath = path.join(repoRoot, ...manifestPath.split("/"));
  try {
    const rawText = await readFile(absolutePath, "utf8");
    const raw: unknown = JSON.parse(rawText);
    // Version before shape. A manifest from a newer build would otherwise be
    // reported as "malformed", which is both wrong and unactionable.
    const gated = checkFormatVersion(raw, formatVersions.verificationSet, manifestPath);
    if (!gated.ok) {
      return { ok: false, reason: gated.reason };
    }
    if (!isVerificationSetManifest(raw) || raw.verification_id !== verificationId) {
      return { ok: false, reason: `verification-set manifest is malformed for ${verificationId}` };
    }
    return {
      ok: true,
      value: {
        manifest: raw,
        manifest_path: manifestPath,
        // THE HASH IS A PROPERTY OF THE FILE, NEVER OF THE PARSED OBJECT.
        // It is taken over the exact bytes read, before any parse or upcast,
        // because adoption binds to it and an upcast shape would not
        // round-trip to the same bytes. Anything that re-derives this from a
        // parsed manifest is a bug; test/verification-set.test.ts pins it.
        manifest_sha256: sha256(Buffer.from(rawText, "utf8"))
      }
    };
  } catch (error: unknown) {
    return { ok: false, reason: `verification-set manifest is unavailable for ${verificationId}: ${errorMessage(error)}` };
  }
}

export async function verificationInputsStillMatch(
  repoRoot: string,
  manifest: Pick<VerificationSetManifest, "inputs" | "config_sha256">
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const liveConfigHash = await hashFile(path.join(repoRoot, ".hivemind", "config.json"));
    if (liveConfigHash !== manifest.config_sha256) {
      return { ok: false, reason: "verified-then-stale: config hash changed since verification" };
    }
    for (const input of manifest.inputs) {
      const contractHash = await hashFile(path.join(repoRoot, ...input.contract_path.split("/")));
      if (contractHash !== input.contract_sha256) {
        return { ok: false, reason: `verified-then-stale: contract hash changed for ${input.task_id}` };
      }
      const patchHash = await hashFile(path.join(repoRoot, ...input.patch_path.split("/")));
      if (patchHash !== input.patch_sha256) {
        return { ok: false, reason: `verified-then-stale: patch hash changed for ${input.task_id}` };
      }
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: `verified-then-stale: could not re-hash verification inputs: ${errorMessage(error)}` };
  }
}

export function hashJson(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isVerificationSetManifest(value: unknown): value is VerificationSetManifest {
  if (!isRecord(value)) return false;
  if (typeof value.verification_id !== "string" || typeof value.created_at !== "string") return false;
  if (typeof value.base_branch !== "string" || !isHash(value.base_commit) || !isHash(value.result_tree)) return false;
  if (!Array.isArray(value.task_ids) || !value.task_ids.every(nonEmptyString)) return false;
  const taskIds: string[] = value.task_ids;
  if (!Array.isArray(value.changed_files) || !value.changed_files.every(nonEmptyString)) return false;
  if (value.config_path !== ".hivemind/config.json" || !isHash(value.config_sha256)) return false;
  if (!Array.isArray(value.inputs) || value.inputs.length !== taskIds.length) return false;
  if (!value.inputs.every((entry) => isRecord(entry) && nonEmptyString(entry.task_id) && nonEmptyString(entry.contract_path) && isHash(entry.contract_sha256) && nonEmptyString(entry.patch_path) && isHash(entry.patch_sha256))) return false;
  if (!isRecord(value.verification) || value.verification.tests !== "pass") return false;
  if (!isRecord(value.oracle) || !["proceed", "proceed_low_confidence"].includes(String(value.oracle.decision))) return false;
  return value.inputs.every((entry, index) => entry.task_id === taskIds[index]);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

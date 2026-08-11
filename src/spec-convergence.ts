import { createHash } from "node:crypto";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { loadSpecDocument, isNodeError, type SpecResult } from "./spec-format.js";

/**
 * The human half of ratification.
 *
 * Ratification needs two signatures and Core keeps them apart on purpose:
 * `convergence.orchestrator` may be written by whatever produced the document,
 * and `convergence.user` may only ever be written by a person. Once the app can
 * draft a spec from a prompt, that separation is the only thing standing
 * between "a person adopted these constraints" and "a model wrote constraints
 * and signed for them".
 *
 * A boolean parameter cannot carry that. Neither can a caller-supplied string:
 * the canon-promotion gate once accepted `reviewer: "human"` from its caller
 * and took two rounds to close. So this works the way adoption does -- the
 * system issues a challenge bound to exactly what is being signed, and the
 * signature is only valid against a durable record of that challenge:
 *
 *   1. `requestUserConvergence` records what the person is about to be shown,
 *      fingerprinted, and returns an id.
 *   2. `verifyUserConvergence` accepts that id only if the durable request
 *      exists, the document still matches the fingerprint, and the id has not
 *      already been spent.
 *
 * A caller that skips step 1 has nothing to present at step 2. A caller that
 * performs both has left a durable record saying so, under its own name.
 * Neither is a claim of humanity by itself -- that comes from the surfaces, and
 * is asserted in `test/spec-convergence.test.ts`: no orchestrator-proposable
 * action and no autonomy level can reach step 2.
 *
 * This lives beside the ideation state in `.hivemind/spec/<id>.convergence.json`
 * rather than in the event trail. Convergence is spec state, the ideation record
 * it belongs to is already a file, and the global trail is a record of what the
 * run did rather than of how its spec was signed.
 */

interface ConvergenceFile {
  version: 1;
  requests: Array<UserConvergenceRequest & { presented_by: string; requested_at: string }>;
  recorded: Array<UserConvergenceRequest & { authorized_by: string; recorded_at: string }>;
}

function convergencePath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, ".hivemind", "spec", `${specId}.convergence.json`);
}

async function readConvergence(repoRoot: string, specId: string): Promise<ConvergenceFile> {
  try {
    const raw = JSON.parse(await readFile(convergencePath(repoRoot, specId), "utf8")) as ConvergenceFile;
    return {
      version: 1,
      requests: Array.isArray(raw.requests) ? raw.requests : [],
      recorded: Array.isArray(raw.recorded) ? raw.recorded : []
    };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return { version: 1, requests: [], recorded: [] };
    throw error;
  }
}

export interface UserConvergenceRequest {
  pending_convergence_id: string;
  spec_id: string;
  spec_sha256: string;
}

export interface UserConvergenceAuthorization {
  pending_convergence_id: string;
  spec_id: string;
  spec_sha256: string;
}

export function specFingerprint(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/** Record that a person is being shown this exact document to sign. */
export async function requestUserConvergence(
  repoRoot: string,
  specId: string,
  presentedBy: string
): Promise<SpecResult<UserConvergenceRequest>> {
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) return spec;

  const request: UserConvergenceRequest = {
    pending_convergence_id: `UC-${specFingerprint(`${specId}:${Date.now()}:${Math.random()}`).slice(0, 32)}`,
    spec_id: specId,
    spec_sha256: specFingerprint(spec.value.markdown)
  };
  const file = await readConvergence(repoRoot, specId);
  file.requests.push({ ...request, presented_by: presentedBy, requested_at: new Date().toISOString() });
  await writeJsonAtomic(convergencePath(repoRoot, specId), file);
  return { ok: true, value: request };
}

/**
 * Accept a signature, or refuse it.
 *
 * Refuses an unissued id, a spec that changed after it was shown, and an id
 * that has already been spent. The middle one matters most: a person signs the
 * document they read, and a drafted spec whose non-goals moved afterwards is a
 * different set of constraints than the one they adopted.
 */
export async function verifyUserConvergence(
  repoRoot: string,
  authorization: UserConvergenceAuthorization
): Promise<SpecResult<UserConvergenceRequest>> {
  const file = await readConvergence(repoRoot, authorization.spec_id);
  const requested = file.requests.find(
    (entry) => entry.pending_convergence_id === authorization.pending_convergence_id
  );
  if (requested === undefined) {
    return {
      ok: false,
      reason: "user convergence authorization does not match a recorded request"
    };
  }
  if (requested.spec_id !== authorization.spec_id) {
    return { ok: false, reason: "user convergence authorization names a different spec" };
  }
  const spent = file.recorded.some(
    (entry) => entry.pending_convergence_id === authorization.pending_convergence_id
  );
  if (spent) {
    return { ok: false, reason: "this user convergence authorization was already used" };
  }

  const spec = await loadSpecDocument(repoRoot, authorization.spec_id);
  if (!spec.ok) return spec;
  const current = specFingerprint(spec.value.markdown);
  if (current !== requested.spec_sha256 || current !== authorization.spec_sha256) {
    return {
      ok: false,
      reason: "the spec changed after it was presented; review it again before signing"
    };
  }

  return {
    ok: true,
    value: {
      pending_convergence_id: authorization.pending_convergence_id,
      spec_id: authorization.spec_id,
      spec_sha256: current
    }
  };
}

/** Record that the signature was taken, so the id cannot be spent twice. */
export async function recordUserConvergence(
  repoRoot: string,
  request: UserConvergenceRequest,
  authorizedBy: string
): Promise<SpecResult<null>> {
  const file = await readConvergence(repoRoot, request.spec_id);
  file.recorded.push({ ...request, authorized_by: authorizedBy, recorded_at: new Date().toISOString() });
  await writeJsonAtomic(convergencePath(repoRoot, request.spec_id), file);
  return { ok: true, value: null };
}

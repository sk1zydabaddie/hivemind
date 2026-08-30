/** Verify downloaded release bytes before any publication can become public. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRemoteCandidate } from "./release-verification.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateUrl = process.argv[2] ?? process.env.HIVEMIND_RELEASE_CANDIDATE_URL;
if (typeof candidateUrl !== "string" || candidateUrl.trim() === "") {
  throw new Error("verify:release requires a candidate descriptor URL");
}
const trustPolicyPath = process.env.HIVEMIND_RELEASE_TRUST_POLICY ?? path.join(desktopRoot, "release", "trust-policy.json");
const result = await verifyRemoteCandidate({
  candidateUrl,
  localManifestBytes: await readFile(path.join(desktopRoot, "src-tauri", "gen", "artifact-manifest.json")),
  trustPolicy: JSON.parse(await readFile(trustPolicyPath, "utf8"))
});
console.log(`verified downloaded release ${result.version}: artifact ${result.artifact_id}, commit ${result.source_commit}, installer ${result.installer_sha256}`);

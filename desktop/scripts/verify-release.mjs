/** Verify downloaded release bytes before any publication can become public. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseTrustPolicy } from "./release-policy.mjs";
import { PRODUCTION_RELEASE_TIER, UNSIGNED_BETA_RELEASE_TIER, verifyRemoteCandidate } from "./release-verification.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { candidateUrl, releaseTier } = parseArguments(process.argv.slice(2), process.env.HIVEMIND_RELEASE_CANDIDATE_URL);
if (typeof candidateUrl !== "string" || candidateUrl.trim() === "") {
  throw new Error("verify:release requires a candidate descriptor URL");
}
const result = await verifyRemoteCandidate({
  candidateUrl,
  localManifestBytes: await readFile(path.join(desktopRoot, "src-tauri", "gen", "artifact-manifest.json")),
  trustPolicy: await loadReleaseTrustPolicy(desktopRoot),
  releaseTier,
  fetchImpl: githubAuthorizedFetch(process.env.GITHUB_TOKEN)
});
console.log(`verified downloaded ${result.release_tier} release ${result.version}: artifact ${result.artifact_id}, commit ${result.source_commit}, installer ${result.installer_sha256}`);

function parseArguments(argumentsList, environmentUrl) {
  if (argumentsList[0] === "--unsigned-beta") {
    if (argumentsList.length > 2) throw new Error("verify:release received unexpected arguments");
    return { candidateUrl: argumentsList[1] ?? environmentUrl, releaseTier: UNSIGNED_BETA_RELEASE_TIER };
  }
  if (argumentsList.length > 1) throw new Error("verify:release received unexpected arguments");
  return { candidateUrl: argumentsList[0] ?? environmentUrl, releaseTier: PRODUCTION_RELEASE_TIER };
}

function githubAuthorizedFetch(token) {
  return (url, options = {}) => {
    const parsed = new URL(url);
    const headers = new Headers(options.headers);
    if (typeof token === "string" && token !== "" && parsed.origin === "https://api.github.com") {
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    }
    return fetch(url, { ...options, headers });
  };
}

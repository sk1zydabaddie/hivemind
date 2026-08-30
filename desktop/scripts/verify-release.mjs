/** Verify downloaded release bytes before any publication can become public. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseTrustPolicy } from "./release-policy.mjs";
import { verifyRemoteCandidate } from "./release-verification.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateUrl = process.argv[2] ?? process.env.HIVEMIND_RELEASE_CANDIDATE_URL;
if (typeof candidateUrl !== "string" || candidateUrl.trim() === "") {
  throw new Error("verify:release requires a candidate descriptor URL");
}
const result = await verifyRemoteCandidate({
  candidateUrl,
  localManifestBytes: await readFile(path.join(desktopRoot, "src-tauri", "gen", "artifact-manifest.json")),
  trustPolicy: await loadReleaseTrustPolicy(desktopRoot),
  fetchImpl: githubAuthorizedFetch(process.env.GITHUB_TOKEN)
});
console.log(`verified downloaded release ${result.version}: artifact ${result.artifact_id}, commit ${result.source_commit}, installer ${result.installer_sha256}`);

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

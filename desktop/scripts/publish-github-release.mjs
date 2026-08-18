/** Publish the already-built and signed Windows updater as one atomic release.
 *
 * The release stays a draft until both assets exist. An interrupted upload is
 * therefore never selected by `/releases/latest`, and publishing refuses to
 * replace an existing tag or asset. The signing key remains outside GitHub;
 * only its detached signature inside latest.json is uploaded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(desktop, "updates", "latest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;
const platform = manifest.platforms?.["windows-x86_64"];
if (typeof version !== "string" || typeof platform?.url !== "string") {
  throw new Error("updates/latest.json is not a Windows updater manifest");
}

const endpoint = JSON.parse(
  readFileSync(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf8")
).plugins?.updater?.endpoints?.[0] ?? "";
const repoMatch = endpoint.match(
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/latest\.json$/u
);
if (!repoMatch) throw new Error(`Unsupported production updater endpoint: ${endpoint}`);
const [, owner, repo] = repoMatch;
const tag = `v${version}`;
const installerName = decodeURIComponent(new URL(platform.url).pathname.split("/").at(-1) ?? "");
const installerPath = path.join(desktop, "updates", installerName);

const credentialText = execFileSync("git", ["credential", "fill"], {
  cwd: desktop,
  encoding: "utf8",
  input: "protocol=https\nhost=github.com\n\n",
  stdio: ["pipe", "pipe", "inherit"]
});
const credential = Object.fromEntries(
  credentialText.trim().split(/\r?\n/u).map((line) => line.split(/=(.*)/su).slice(0, 2))
);
if (!credential.password) throw new Error("GitHub credential unavailable");

const apiHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${credential.password}`,
  "User-Agent": "Hivemind-Release-Publisher",
  "X-GitHub-Api-Version": "2022-11-28"
};
async function github(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...apiHeaders, ...init.headers } });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`GitHub ${init.method ?? "GET"} ${url} returned ${response.status}: ${detail}`);
  }
  return response;
}

const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: path.resolve(desktop, ".."),
  encoding: "utf8"
}).trim();
const created = await github(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tag_name: tag,
    target_commitish: head,
    name: `Hivemind ${version}`,
    body: `Installed Windows build ${version}.`,
    draft: true,
    prerelease: false
  })
}).then((response) => response.json());

const uploadBase = `https://uploads.github.com/repos/${owner}/${repo}/releases/${created.id}/assets`;
for (const [name, file, contentType] of [
  ["latest.json", manifestPath, "application/json"],
  [installerName, installerPath, "application/octet-stream"]
]) {
  await github(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: await readFile(file)
  });
}

await github(`https://api.github.com/repos/${owner}/${repo}/releases/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ draft: false })
});
console.log(`published ${tag} from ${head.slice(0, 7)} with latest.json and ${installerName}`);

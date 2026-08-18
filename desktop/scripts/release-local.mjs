/**
 * Publish a build to the local update endpoint.
 *
 * ## What this is, and what a real release replaces
 *
 * The updater needs three things: a signed installer, a manifest naming it, and
 * a URL the app can fetch the manifest from. This script produces all three on
 * one machine, so the whole mechanism — signature verification included — can be
 * exercised before there is anywhere to publish to.
 *
 * A real release changes exactly two of them and nothing else:
 *
 * | Dev, here | Real |
 * | --- | --- |
 * | manifest written to `updates/latest.json` | uploaded as a GitHub release asset |
 * | served by `npm run updater:serve` on `127.0.0.1:8787` | `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` |
 * | private key read from the app-data directory | a CI secret, and a password on the key |
 *
 * The `endpoints` array in `tauri.conf.json` takes several URLs and tries them
 * in order, so the real endpoint can be added ahead of the local one and both
 * keep working.
 *
 * ## The signature is the part that matters
 *
 * Tauri verifies an Ed25519 signature over the installer before it will run it,
 * against the public key compiled into the app. That is independent of
 * Authenticode: this stops somebody serving a different binary from the update
 * endpoint, and Authenticode stops SmartScreen warning about the installer.
 * Different threats, different keys, and only one of them costs money.
 *
 * **Losing the private key is the real risk**, and it is worse than it sounds:
 * the public key is baked into every installed copy, so a new key cannot update
 * them. They would have to be re-installed by hand. It lives outside the
 * repository for that reason — deleting the checkout must not delete it — and
 * `packaging.test.ts` fails if it ever appears inside.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const githubRelease = process.argv.includes("--github");
const keyDir = path.join(process.env.APPDATA ?? process.env.HOME ?? "", "Hivemind AI", "updater");
const privateKey = path.join(keyDir, "hivemind-updater.key");

if (!existsSync(privateKey)) {
  console.error(
    [
      `No signing key at ${privateKey}`,
      "",
      "Without it nothing can be published, and if the key is LOST rather than",
      "missing, installed copies can never be updated again — their public key",
      "is compiled in. Generate one with:",
      "",
      `  npx tauri signer generate --ci -p "" -w "${privateKey}"`,
      "",
      "then put the printed public key in tauri.conf.json under plugins.updater.pubkey."
    ].join("\n")
  );
  process.exit(1);
}

const version = readFileSync(
  path.join(desktop, "src-tauri", "gen", "app-version.txt"),
  "utf8"
).trim();

const installer = path.join(
  desktop,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Hivemind AI_${version}_x64-setup.exe`
);
if (!existsSync(installer)) {
  console.error(`No installer for ${version}. Run \`npm run tauri:build\` first.`);
  process.exit(1);
}

/* Sign it. The CLI writes `<installer>.sig`; the manifest carries the contents
   of that file rather than a path, because the app fetches the manifest and
   nothing else. */
/* The CLI's node entry point directly, NOT `npx` through a shell. Every path
   here contains a space -- "Hivemind AI" appears in the app data directory, the
   repository path and the installer name -- and `shell: true` on Windows splits
   them at the space, so the signer was handed `Hivemind` and `AI\...` as two
   arguments. It is the .cmd-shim trap this project already recorded for
   spawning agents, arriving from the other direction. */
execFileSync(
  process.execPath,
  [
    path.join(desktop, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "signer",
    "sign",
    "-f",
    privateKey,
    "-p",
    "",
    installer
  ],
  { cwd: desktop, stdio: "inherit" }
);
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

const updates = path.join(desktop, "updates");
mkdirSync(updates, { recursive: true });

/* `pub-date` must be RFC 3339 or the plugin refuses the manifest. The installer
   is copied rather than linked so the served directory is self-contained. */
const installerName = `Hivemind AI_${version}_x64-setup.exe`;
/* GitHub normalizes spaces in uploaded asset names to dots. Use a stable,
   space-free public name so the signed manifest names the asset GitHub
   actually serves; keep the human-readable local filename unchanged. */
const installerAssetName = githubRelease
  ? `Hivemind-AI_${version}_x64-setup.exe`
  : installerName;
let installerUrl = `http://127.0.0.1:8787/${encodeURIComponent(installerAssetName)}`;
if (githubRelease) {
  const config = JSON.parse(
    readFileSync(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const endpoint = config.plugins?.updater?.endpoints?.[0] ?? "";
  const match = endpoint.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download\/latest\.json$/u
  );
  if (!match) {
    console.error(`The production updater endpoint is not a GitHub latest-release URL: ${endpoint}`);
    process.exit(1);
  }
  installerUrl = `https://github.com/${match[1]}/${match[2]}/releases/download/v${version}/${installerAssetName}`;
}

const manifest = {
  version,
  notes: `Hivemind ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: installerUrl
    }
  }
};
writeFileSync(path.join(updates, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(
  path.join(updates, installerAssetName),
  readFileSync(installer)
);

console.log(`prepared ${githubRelease ? "GitHub" : "local"} release ${version}`);
console.log(`  manifest  ${path.join(updates, "latest.json")}`);
console.log(`  installer ${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`);
console.log("");
console.log("Serve it with: npm run updater:serve");

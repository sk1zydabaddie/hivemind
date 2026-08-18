/** Prove the anonymous endpoint an installed client uses is a usable release. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf8")
);
const endpoint = config.plugins?.updater?.endpoints?.[0];
if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
  throw new Error("No secure production updater endpoint is configured");
}

let response;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  response = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "Hivemind-Updater-Probe" },
    redirect: "follow"
  });
  if (response.ok) break;
  if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!response?.ok) throw new Error(`Updater manifest returned HTTP ${response?.status ?? "unknown"}`);

const manifest = await response.json();
const expectedVersion = (
  await readFile(path.join(desktop, "src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  throw new Error("Updater manifest has no valid version");
}
if (manifest.version !== expectedVersion) {
  throw new Error(
    `Updater manifest is stale: expected ${expectedVersion}, received ${manifest.version}`
  );
}
const windows = manifest.platforms?.["windows-x86_64"];
if (typeof windows?.signature !== "string" || windows.signature.length < 100) {
  throw new Error("Updater manifest has no usable Windows signature");
}
if (typeof windows.url !== "string" || !windows.url.startsWith("https://")) {
  throw new Error("Updater manifest has no secure Windows installer URL");
}
const installer = await fetch(windows.url, {
  method: "HEAD",
  headers: { "User-Agent": "Hivemind-Updater-Probe" },
  redirect: "follow"
});
if (!installer.ok) throw new Error(`Updater installer returned HTTP ${installer.status}`);
const bytes = Number(installer.headers.get("content-length") ?? 0);
if (!Number.isFinite(bytes) || bytes < 1_000_000) {
  throw new Error(`Updater installer size is not credible: ${bytes}`);
}
console.log(`verified anonymous updater release ${manifest.version} (${bytes} bytes)`);

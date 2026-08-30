/** Tauri custom signer: sign, verify, and retain the exact patched main PE. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "./artifact-integrity.mjs";
import { loadReleaseTrustPolicy } from "./release-policy.mjs";
import { assertAuthenticode, inspectWindowsSignature, validateTrustPolicy } from "./release-verification.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) await main();

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function findSignTool() {
  const kits = path.join(process.env["ProgramFiles(x86)"] ?? "", "Windows Kits", "10", "bin");
  const script = [
    `$root = '${kits.replaceAll("'", "''")}'`,
    "$found = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -File | Where-Object { $_.Directory.Name -eq 'x64' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName",
    "if (-not $found) { exit 1 }",
    "$found"
  ].join("\n");
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    throw new Error("Windows SDK x64 signtool.exe is unavailable");
  }
}

async function main() {
  const [thumbprint, timestampUrl, targetArgument] = process.argv.slice(2);
  if (!thumbprint || !timestampUrl || !targetArgument) throw new Error("Windows signer requires thumbprint, timestamp URL, and target");
  const target = path.resolve(targetArgument);
  const releaseRoot = path.resolve(desktopRoot, "src-tauri", "target");
  if (!target.toLowerCase().endsWith(".exe") || !isInside(releaseRoot, target)) {
    throw new Error(`refusing to sign a path outside the Tauri target directory: ${target}`);
  }
  const trust = validateTrustPolicy(await loadReleaseTrustPolicy(desktopRoot));
  if (thumbprint !== trust.publisherThumbprint) throw new Error("signing command thumbprint differs from release trust policy");
  execFileSync(findSignTool(), ["sign", "/sha1", thumbprint, "/fd", "SHA256", "/td", "SHA256", "/tr", timestampUrl, target], {
    stdio: "inherit",
    windowsHide: true
  });
  assertAuthenticode(path.basename(target), inspectWindowsSignature(target), trust);
  if (path.basename(target).toLowerCase() === "hivemind_desktop.exe") {
    await writeFileAtomically(path.join(desktopRoot, "src-tauri", "gen", "signed-hivemind_desktop.exe"), await readFile(target));
  }
}

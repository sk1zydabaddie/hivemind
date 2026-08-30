/** Fail-closed RustSec coverage for the Windows x64 native release graph. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, stableJson, writeFileAtomically } from "./artifact-integrity.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const expectedVersion = "cargo-audit-audit 0.22.2";
const version = command("cargo", ["audit", "--version"], tauriRoot).trim();
if (version !== expectedVersion) throw new Error(`Rust advisory tool is not pinned ${expectedVersion}: ${version}`);

const audit = spawnSync("cargo", ["audit", "--json", "--target-os", "windows", "--target-arch", "x86_64"], {
  cwd: tauriRoot,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024
});
if (audit.error || audit.status === null || audit.stdout.trim() === "") {
  throw new Error(`Rust advisory audit did not run${audit.error ? `: ${audit.error.message}` : ""}`);
}
let report;
try { report = JSON.parse(audit.stdout); } catch { throw new Error("Rust advisory audit did not return JSON"); }
const databaseCommit = report.database?.["last-commit"];
const databaseUpdated = report.database?.["last-updated"];
if (typeof databaseCommit !== "string" || !/^[a-f0-9]{40}$/u.test(databaseCommit) ||
    typeof databaseUpdated !== "string" || !Number.isFinite(Date.parse(databaseUpdated))) {
  throw new Error("Rust advisory database identity is unknown");
}
if (Date.now() - Date.parse(databaseUpdated) > 7 * 24 * 60 * 60 * 1_000) {
  throw new Error(`Rust advisory database is older than seven days: ${databaseUpdated}`);
}
const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.USERPROFILE ?? "", ".cargo");
const databasePath = path.join(cargoHome, "advisory-db");
const databaseHead = command("git", ["-C", databasePath, "rev-parse", "HEAD"], tauriRoot).trim();
const databaseOrigin = command("git", ["-C", databasePath, "remote", "get-url", "origin"], tauriRoot).trim();
if (databaseHead !== databaseCommit || !/^https:\/\/github\.com\/RustSec\/advisory-db(?:\.git)?$/iu.test(databaseOrigin)) {
  throw new Error("Rust advisory database does not match the fetched official RustSec identity");
}
if (audit.status !== 0 || report.vulnerabilities?.found !== false || report.vulnerabilities?.count !== 0) {
  const identifiers = (report.vulnerabilities?.list ?? []).map((entry) => entry.advisory?.id).filter(Boolean);
  throw new Error(`Rust advisory gate found ${report.vulnerabilities?.count ?? "unknown"} vulnerabilities${identifiers.length ? `: ${identifiers.join(", ")}` : ""}`);
}
const evidence = {
  schema_version: 1,
  kind: "hivemind-rust-advisory-evidence",
  platform: "windows-x86_64",
  tool: version,
  database: { origin: databaseOrigin, commit: databaseCommit, updated_at: databaseUpdated },
  lockfile_sha256: await sha256File(path.join(tauriRoot, "Cargo.lock")),
  dependency_count: report.lockfile?.["dependency-count"],
  vulnerability_count: 0
};
if (!Number.isSafeInteger(evidence.dependency_count) || evidence.dependency_count < 1) {
  throw new Error("Rust advisory audit reported no dependency count");
}
await writeFileAtomically(path.join(tauriRoot, "gen", "rust-advisory.json"), stableJson(evidence));
console.log(`Rust advisory gate: 0 vulnerabilities across ${evidence.dependency_count} Windows x64 dependencies; ${version}; RustSec ${databaseCommit}`);

function command(file, args, cwd) {
  try { return execFileSync(file, args, { cwd, encoding: "utf8", windowsHide: true }); }
  catch (error) { throw new Error(`required release command failed: ${file} ${args.join(" ")}`, { cause: error }); }
}

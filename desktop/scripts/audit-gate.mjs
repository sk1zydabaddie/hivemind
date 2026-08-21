/**
 * The dependency advisory gate. `npm run ship` runs this before anything is
 * built (A-29): a known-vulnerable production dependency must stop a release,
 * because every documented release check was green while four of them sat in
 * the production MCP path.
 *
 * The policy, decided 2026-08-21:
 *
 * - Production advisories at HIGH or above FAIL the ship, in either package —
 *   the root package ships inside the app as Core, so both lockfiles are the
 *   product.
 * - Dev-only advisories are REPORTED and never block. A build-toolchain issue
 *   is not a reason to withhold a release, and a gate that blocks for things
 *   nobody can act on gets removed by whoever it blocks.
 *
 * THE HONEST LIMIT: `npm audit` reads the LOCKFILE, not node_modules, and the
 * two can disagree — which is exactly how the four advisories this gate exists
 * for sat unnoticed: node_modules held patched versions while the lockfile
 * pinned vulnerable ones, so every suite ran green against code `npm ci` would
 * never install. This gate therefore certifies what a clean install would get,
 * and says nothing about the tree the suites just ran on.
 *
 * And it fails CLOSED: `npm audit` needs the registry, so an offline run fails
 * the gate rather than passing it. A check that goes green when it could not
 * run is the silent guard one level further down.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktop, "..");

/* npm's own JS entry point, run by the current node directly. Not `npm.cmd`
   through a shell: paths here contain spaces ("Hivemind AI"), and the
   .cmd-shim-with-shell route is the trap this repository has already recorded
   twice. `npm_execpath` is set on every `npm run`, which is the only way this
   script is meant to start. */
const npmCli = process.env.npm_execpath;
if (!npmCli || !npmCli.endsWith(".js")) {
  console.error(
    "audit gate: start this through npm (`npm run verify:advisories`) so npm_execpath names npm's JS entry point."
  );
  process.exit(1);
}

const audit = (cwd, args) =>
  spawnSync(process.execPath, [npmCli, "audit", ...args], {
    cwd,
    stdio: "inherit"
  });

let blocked = false;
for (const [label, cwd] of [
  ["root (Core, ships inside the app)", repoRoot],
  ["desktop", desktop]
]) {
  console.log(`\naudit gate: production dependencies, high and above — ${label}`);
  const result = audit(cwd, ["--omit=dev", "--audit-level=high"]);
  /* Non-zero is the tool's contractual failure signal — vulnerabilities found
     OR the audit itself could not run. Both block; only the first prints
     advisories, and the second is the fail-closed case described above. */
  if (result.status !== 0) {
    blocked = true;
    console.error(`audit gate: BLOCKED by ${label}${result.status === null ? " (audit did not run)" : ""}`);
  }
}

for (const [label, cwd] of [
  ["root", repoRoot],
  ["desktop", desktop]
]) {
  console.log(`\naudit gate: full report including dev dependencies — ${label} (report only, never blocks)`);
  audit(cwd, []);
}

if (blocked) {
  console.error(
    "\naudit gate: a production dependency carries a high-severity advisory (or the audit could not run). The ship stops here."
  );
  process.exit(1);
}
console.log("\naudit gate: no high-severity production advisories in either lockfile");

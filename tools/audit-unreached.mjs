/**
 * Mechanisms that exist and are never consulted.
 *
 * A distinct failure family, and the third one this project has named. It is
 * not the instrument family (an assertion that can only return one answer) and
 * not the rig family (a measurement of something other than what you think).
 * This one is:
 *
 *   > **The mechanism exists, is correct, is tested — and nothing asks it.**
 *
 * Three instances, all of which passed review looking finished:
 *
 * 1. `provider_version` — written onto every connection record and never
 *    compared, so a self-updating harness silently invalidated its own verdict.
 * 2. `daemon_instance_id` — recorded on every reservation and never filtered
 *    on.
 * 3. `compareAdapterVersion` — written, unit-tested, and imported by nothing
 *    but its own test, so the check it implements had never once run.
 *
 * Review cannot catch these. Every one of them looks right in a diff: the field
 * is populated, the function is covered, nothing is missing. The absence is
 * somewhere else entirely — in the call that was never written.
 *
 * ## What this can and cannot detect
 *
 * **Can:** an exported function that no production module imports and that is
 * not called inside its own file. That is a genuinely unreached mechanism, and
 * it is exactly instance 3.
 *
 * **Cannot:** an unread FIELD, which is instances 1 and 2. Property access in
 * TypeScript is dynamic — `record[key]`, destructuring, spreads, and
 * `JSON.parse` results that are read through an index signature — so "written
 * by one site and read by none" is not decidable by grep without both false
 * positives and false negatives. Where a field's absence would be dangerous,
 * the next-best guard is a test that asserts the field is NOT consulted, which
 * turns a silent gap into a stated decision: see
 * `daemon_instance_id is provenance, and scoping by it would break the ceiling`
 * in test/resource-ledger.test.ts.
 *
 * ## Why this reports rather than fails
 *
 * Measured before being trusted: on this tree it finds candidates that include
 * legitimate CLI entry points and public surface reached by dispatch rather
 * than by import. A check that fails the build on those would be an instrument
 * that cries wolf, and the first response to it would be to loosen it until it
 * stopped — which is how the word bans went wrong four times.
 *
 * So it prints, and the list is meant to be read by a person deciding whether
 * each entry is a mechanism nobody wired or an entry point reached another way.
 *
 * Usage: npm run audit:unreached
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const listTs = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => path.join(dir, file))
    : [];

const production = listTs("src");
const tests = listTs("test");
const body = new Map(
  [...production, ...tests].map((file) => [file, readFileSync(file, "utf8")])
);

/* Real import statements rather than word matches. A word match reports every
   function whose name appears in prose as "used", which is how the first
   version of this reported 445 dead exports including `invokeAgent`. */
function importedNames(text) {
  const names = new Set();
  const patterns = [
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["']/g,
    /* Dynamic imports. `cli.ts` reaches every subcommand this way --
       `const { cacheCommand } = await import("./cache.js")` -- so a parser that
       only reads static imports reports the entire CLI as unreached. Measured:
       it did, and that is why this second pattern exists. */
    /* `[^{}\n]` rather than `[^}]`: the loose version is greedy across
       newlines and swallows whole preceding blocks into the capture, so the
       "names" it extracts are chunks of source and match nothing. It reported
       9 hits on cli.ts and found none of the 9 command names. */
    /\{([^{}\n]*)\}\s*=\s*await\s+import\s*\(\s*["'][^"']+["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().replace(/^type\s+/u, "").split(/[\s:]+as[\s:]+|\s*:\s*/u)[0].trim();
        if (name !== "") names.add(name);
      }
    }
  }
  return names;
}

const importedByProduction = new Set();
const importedByTests = new Set();
for (const [file, text] of body) {
  const target = file.startsWith("test") ? importedByTests : importedByProduction;
  for (const name of importedNames(text)) target.add(name);
}

const unreached = [];
const exportedOnly = [];
for (const file of production) {
  const text = body.get(file);
  for (const match of text.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gmu)) {
    const name = match[1];
    if (importedByProduction.has(name)) continue;
    /* Called inside its own file? Then the FUNCTION is live and only the
       `export` is over-broad — a much weaker finding, and not this class.
       `plainReason` and `createDaemonServer` are both this. */
    const calls = [...text.matchAll(new RegExp(`\\b${name}\\s*\\(`, "gu"))].length;
    const entry = { name, file, testOnly: importedByTests.has(name) };
    if (calls > 1) exportedOnly.push(entry);
    else unreached.push(entry);
  }
}

console.log(`unreached in production: ${unreached.length}`);
for (const entry of unreached) {
  console.log(
    `  ${entry.name.padEnd(32)} ${entry.file.padEnd(36)} ${
      entry.testOnly ? "imported only by its own tests" : "imported by nothing"
    }`
  );
}
console.log(`\nexported more broadly than needed (function is live): ${exportedOnly.length}`);

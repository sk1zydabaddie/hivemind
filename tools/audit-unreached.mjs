/**
 * Reachability leads plus one exact action-consumer contract.
 *
 * This intentionally does not claim whole-program dead-code proof. The
 * production TypeScript build owns declarations the compiler can prove
 * unused. This report covers exported mechanisms with no named import,
 * same-module value reference, or package-script entrypoint.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceFilesBelow = (root) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory()
      ? sourceFilesBelow(full)
      : entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name)
        ? [full]
        : [];
  });
};

const coreFiles = sourceFilesBelow("src");
const testFiles = sourceFilesBelow("test");
const desktopFiles = sourceFilesBelow(path.join("desktop", "src"));
const textByFile = new Map(
  [...coreFiles, ...testFiles, ...desktopFiles].map((file) => [file, readFileSync(file, "utf8")])
);
const astByFile = new Map(
  [...textByFile].map(([file, text]) => [
    file,
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  ])
);

const importedByCore = new Set();
const importedByTests = new Set();
for (const [file, source] of astByFile) {
  const target = file.startsWith(`test${path.sep}`) ? importedByTests : importedByCore;
  const visit = (node) => {
    if (ts.isImportSpecifier(node)) target.add((node.propertyName ?? node.name).text);
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      for (const element of node.name.elements) {
        target.add((element.propertyName ?? element.name).getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const scripts = ["package.json", path.join("desktop", "package.json")]
  .map((file) => JSON.parse(readFileSync(file, "utf8")).scripts ?? {})
  .flatMap((record) => Object.values(record))
  .join("\n");

const leads = [];
const overExported = [];
for (const file of coreFiles) {
  const source = astByFile.get(file);
  const exported = source.statements.filter((node) =>
    ts.isFunctionDeclaration(node) &&
    node.name !== undefined &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
  for (const declaration of exported) {
    const name = declaration.name.text;
    let sameModuleValueReferences = 0;
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) sameModuleValueReferences += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    const productionImport = importedByCore.has(name);
    const packageEntrypoint = new RegExp(`\\b${name}\\b`, "u").test(scripts);
    const entry = { name, file, testOnly: importedByTests.has(name) };
    if (productionImport || packageEntrypoint) continue;
    if (sameModuleValueReferences > 0) overExported.push(entry);
    else leads.push(entry);
  }
}

console.log(`unreached export leads (not whole-program proof): ${leads.length}`);
for (const entry of leads) {
  console.log(`  ${entry.name.padEnd(34)} ${entry.file.padEnd(40)} ${entry.testOnly ? "tests only" : "no named consumer"}`);
}
console.log(`exported more broadly than their value flow requires: ${overExported.length}`);
console.log("handled false-positive classes: callback/value references, static or destructured dynamic imports, package-script entrypoints");

const literals = (body) => [...body.matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/gu)].map((match) => match[1]);
const coreActionSource = readFileSync(path.join("src", "workspace-actions.ts"), "utf8");
const actionStart = coreActionSource.indexOf("export const workspaceActionTypes");
const actionBlock = coreActionSource.slice(actionStart, coreActionSource.indexOf("] as const;", actionStart));
const actions = literals(actionBlock);
const consumers = new Set();
for (const file of desktopFiles) {
  for (const match of textByFile.get(file).matchAll(/\btype:\s*"([a-z_]+(?:\.[a-z_]+)+)"/gu)) {
    if (actions.includes(match[1])) consumers.add(match[1]);
  }
}
const queueSource = readFileSync(path.join("src", "workspace-inspection.ts"), "utf8");
for (const match of queueSource.matchAll(/\btype:\s*"([a-z_]+(?:\.[a-z_]+)+)"/gu)) {
  if (actions.includes(match[1])) consumers.add(match[1]);
}
const actionGaps = actions.filter((action) => !consumers.has(action));
console.log(`audited actions without a production consumer: ${actionGaps.length}`);
for (const action of actionGaps) console.log(`  ${action}`);
if (actionGaps.length > 0) process.exitCode = 1;

/* An event declaration with no producer is a more dangerous version of an
   unused export: the client can render it and tests can project it, while no
   real operation can ever place it in the durable trail. Restrict this check
   to object-literal `type` fields in production Core. It is intentionally
   narrower than a text search, so a comment, projection case or test fixture
   cannot make a producer look real. */
const eventSource = readFileSync(path.join("src", "events.ts"), "utf8");
const eventStart = eventSource.indexOf("export const eventTypes");
const eventBlock = eventSource.slice(eventStart, eventSource.indexOf("] as const;", eventStart));
const events = literals(eventBlock);
const producedEvents = new Set();
for (const file of coreFiles) {
  const source = astByFile.get(file);
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source).replaceAll('"', "") === "type" &&
      ts.isStringLiteral(node.initializer) &&
      events.includes(node.initializer.text)
    ) {
      producedEvents.add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
/* These producers choose between two audited event types or pass a narrow
   event-type union into one append helper. The AST check above deliberately
   does not pretend to do interprocedural data flow, so each exception names
   the production module where that bounded choice is made. Removing or
   renaming the literal there invalidates the exception. */
const indirectEventProducers = new Map([
  ["patch.accepted", path.join("src", "analyze.ts")],
  ["patch.rejected", path.join("src", "analyze.ts")],
  ["integration.passed", path.join("src", "integrate.ts")],
  ["integration.failed", path.join("src", "integrate.ts")],
  ["integration.blocked", path.join("src", "integrate.ts")],
  ["integration.low_confidence", path.join("src", "integrate.ts")],
  ["verification.completed", path.join("src", "verification.ts")],
  ["quality.draft_verified", path.join("src", "verification.ts")],
  ["scheduler.wave_completed", path.join("src", "manager.ts")],
  ["scheduler.wave_stopped", path.join("src", "manager.ts")],
  ["scheduler.run_cancelled", path.join("src", "manager.ts")],
  ["scheduler.run_cancel_failed", path.join("src", "manager.ts")]
]);
for (const [event, file] of indirectEventProducers) {
  if (textByFile.get(file)?.includes(`"${event}"`)) producedEvents.add(event);
}
const eventGaps = events.filter((event) => !producedEvents.has(event));
console.log(`declared durable events without a production producer: ${eventGaps.length}`);
for (const event of eventGaps) console.log(`  ${event}`);
if (eventGaps.length > 0) process.exitCode = 1;

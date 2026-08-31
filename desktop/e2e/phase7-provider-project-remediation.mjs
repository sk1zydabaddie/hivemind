/** No-cost installed-artifact proof for R5 provider and project lifecycle. */
import "./protect-recent-projects.mjs";

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedVersion = (await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")).trim();
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedAuth = path.join(installedRoot, "core", "dist", "src", "provider-auth-status.js");
const evidenceDir = path.resolve("..", "docs", "evidence", `remediation-phase7-${installedVersion}`);
const expectedInstalledProviders = (process.env.HIVEMIND_E2E_EXPECT_INSTALLED_PROVIDERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

let fixtureRoot;
let driver;
let tauriDriver;
const driverLog = [];
const evidence = {
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  providerDiscovery: {},
  expectedInstalledProviders,
  failedManualPath: {},
  nestedProject: {},
  secretRefusal: {},
  incompleteGit: {},
  explicitCheck: {},
  providers: {},
  projectMenuAttempts: [],
  screenshots: [],
  browserSevereLogs: []
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(installedAuth), `installed authentication module missing: ${installedAuth}`);
  assert.equal(await isProcessRunning("hivemind_desktop.exe"), false, "close Hivemind before this isolated proof");
  assert.equal(await isProcessRunning("tauri-driver.exe"), false, "another tauri-driver session is running");
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "hivemind-phase7-"));
  const fixtures = await createFixtures(fixtureRoot);

  const authScript = `const m=await import(${JSON.stringify(pathToFileURL(installedAuth).href)});console.log(JSON.stringify(await m.inspectProviderAuthentication(process.cwd())));`;
  const { stdout: authOutput } = await run(process.execPath, ["--input-type=module", "-e", authScript], {
    windowsHide: true,
    env: { ...process.env, PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") }
  });
  evidence.providerDiscovery = JSON.parse(authOutput);

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => driverLog.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => driverLog.push(`stderr ${chunk}`));
  await waitForDriver();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
  await driver.manage().window().setRect({ x: 40, y: 40, width: 1440, height: 900 });

  await openDialog();
  await setProjectInput(fixtures.invalid);
  await clickButton("Open project");
  /* The failure belongs to the selected project state behind this modal. The
     contract here is narrower and observable: a failed attempt must not close
     the modal or erase the path before the person can correct it. */
  await driver.wait(async () => {
    const inputs = await driver.findElements(By.id("project-path"));
    return inputs.length === 1 && (await inputs[0].getAttribute("value")) === fixtures.invalid;
  }, 30_000, "the failed path was not retained in the open dialog");
  const retained = await driver.findElement(By.id("project-path")).getAttribute("value");
  evidence.failedManualPath = { dialogStillOpen: true, retained };

  await setProjectInput(fixtures.nested);
  await clickButton("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the corrected project path did not close the dialog"
  );
  await waitForText("Exact first-commit set", 30_000);
  const nestedText = await bodyText();
  evidence.nestedProject = {
    sourceListed: nestedText.includes("src/index.js"),
    generatedExcluded: !nestedText.includes("packages/app/node_modules/dep.js"),
    projectFactsListed: nestedText.includes(".hivemind/config.json") && nestedText.includes(".hivemind/.gitignore")
  };
  await capture("01-nested-project-preview");

  await openProject(fixtures.secret);
  await waitForText(".env.production", 30_000);
  const secretText = await bodyText();
  evidence.secretRefusal = {
    namesSecret: secretText.includes(".env.production"),
    setupOffered: secretText.includes("Set up git for me")
  };
  await capture("02-secret-refusal");

  await openProject(fixtures.incompleteGit);
  await waitForText("incomplete or corrupt", 30_000);
  evidence.incompleteGit = { refused: true, setupOffered: (await bodyText()).includes("Set up git for me") };
  await capture("03-incomplete-git-refusal");

  await openProject(fixtures.checkProject);
  await waitForText("Set up this folder", 30_000);
  await clickButton("Set up this folder");
  await waitForText("Run detected check", 45_000);
  await driver.wait(
    async () => !(await bodyText()).includes("Not checked yet"),
    30_000,
    "provider standings did not settle from their initial unknown state"
  );
  evidence.explicitCheck = {
    markerBeforeControl: existsSync(path.join(fixtures.checkProject, "unexpected-auto-check.txt")),
    controlVisible: true
  };
  const selection = await driver.executeScript(`return [...document.querySelectorAll('[aria-label^="Include "]')].map((node)=>({label:node.getAttribute('aria-label'),checked:node.getAttribute('aria-checked'),disabled:node.hasAttribute('disabled'),rowText:node.closest('.border-b')?.innerText ?? null}));`);
  evidence.providers = {
    selection,
    noPreselection: selection.every((entry) => entry.checked === "false"),
    exactEstimate: (await bodyText()).includes("0 tokens on your own subscription")
  };
  await capture("04-explicit-check-and-provider-state");
  await driver.executeScript(`document.querySelector('[aria-label="Include Kimi Code when connecting"]')?.scrollIntoView({block:"end"});`);
  await capture("05-provider-selection");

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = browserLogs.filter((entry) => entry.level?.name === "SEVERE").map((entry) => entry.message);
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (fixtureRoot !== undefined) {
    await stopFixtureDaemons(fixtureRoot);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "phase7-provider-project-remediation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), driverLog.join(""), "utf8").catch(() => undefined);
}

const providerRows = Array.isArray(evidence.providerDiscovery.providers) ? evidence.providerDiscovery.providers : [];
assert.ok(providerRows.length >= 5);
for (const providerId of expectedInstalledProviders) {
  const row = providerRows.find((entry) => entry.provider_id === providerId);
  assert.equal(row?.installed, true, `${providerId} was not discovered from the installed app's minimal PATH`);
  assert.notEqual(row?.status, "missing", `${providerId} was still reported missing`);
}
assert.equal(evidence.failedManualPath.dialogStillOpen, true);
assert.equal(evidence.failedManualPath.retained.endsWith("does-not-exist"), true);
assert.deepEqual(evidence.nestedProject, { sourceListed: true, generatedExcluded: true, projectFactsListed: true });
assert.deepEqual(evidence.secretRefusal, { namesSecret: true, setupOffered: false });
assert.deepEqual(evidence.incompleteGit, { refused: true, setupOffered: false });
assert.deepEqual(evidence.explicitCheck, { markerBeforeControl: false, controlVisible: true });
assert.equal(evidence.providers.noPreselection, true);
assert.equal(evidence.providers.exactEstimate, true);
assert.deepEqual(evidence.browserSevereLogs, []);
assert.equal(evidence.paidProviderCalls, 0);
console.log(JSON.stringify(evidence, null, 2));

async function createFixtures(root) {
  const nested = path.join(root, "nested-source");
  await mkdir(path.join(nested, "src"), { recursive: true });
  await mkdir(path.join(nested, "packages", "app", "node_modules"), { recursive: true });
  await writeFile(path.join(nested, "src", "index.js"), "export const phaseSeven = true;\n", "utf8");
  await writeFile(path.join(nested, "packages", "app", "node_modules", "dep.js"), "generated\n", "utf8");

  const secret = path.join(root, "secret-variant");
  await mkdir(secret, { recursive: true });
  await writeFile(path.join(secret, "index.js"), "export default true;\n", "utf8");
  await writeFile(path.join(secret, ".env.production"), "NOT_A_REAL_SECRET=fixture\n", "utf8");

  const incompleteGit = path.join(root, "incomplete-git");
  await mkdir(path.join(incompleteGit, ".git"), { recursive: true });
  await writeFile(path.join(incompleteGit, "index.js"), "export default true;\n", "utf8");

  const checkProject = path.join(root, "explicit-check");
  await mkdir(path.join(checkProject, "scripts"), { recursive: true });
  await writeFile(path.join(checkProject, "index.js"), "export default true;\n", "utf8");
  await writeFile(path.join(checkProject, "package.json"), JSON.stringify({ name: "phase7-explicit-check", private: true, scripts: { test: "node scripts/check.mjs" } }, null, 2), "utf8");
  await writeFile(path.join(checkProject, "scripts", "check.mjs"), 'import { writeFileSync } from "node:fs";writeFileSync("unexpected-auto-check.txt","ran");\n', "utf8");
  await gitInitAndCommit(checkProject);
  return { nested, secret, incompleteGit, checkProject, invalid: path.join(root, "does-not-exist") };
}

async function gitInitAndCommit(root) {
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Fixture"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "fixture@invalid.local"], { cwd: root, windowsHide: true });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, windowsHide: true });
}

async function openDialog() {
  const trigger = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
  const beforeExpanded = await trigger.getAttribute("aria-expanded");
  await trigger.click();
  const deadline = Date.now() + 10_000;
  let entry = null;
  while (Date.now() < deadline) {
    const entries = await driver.findElements(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]'));
    if (entries.length > 0) {
      entry = entries[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const afterExpanded = await driver.findElement(By.css('button[aria-label^="Switch project"]')).getAttribute("aria-expanded");
  const attempt = { beforeExpanded, afterExpanded, itemLocated: entry !== null };
  evidence.projectMenuAttempts.push(attempt);
  if (entry === null) {
    const failureShot = `project-menu-failed-${evidence.projectMenuAttempts.length}-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    throw new Error(`project menu did not open: before=${beforeExpanded}, after=${afterExpanded}`);
  }
  await entry.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
}

async function setProjectInput(value) {
  await driver.executeScript(`const input=document.getElementById("project-path");const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;setter.call(input,arguments[0]);input.dispatchEvent(new Event("input",{bubbles:true}));`, value);
}

async function openProject(value) {
  await openDialog();
  await setProjectInput(value);
  await clickButton("Open project");
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
}

async function clickButton(label) {
  const button = await driver.wait(until.elementLocated(By.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`)), 15_000);
  await driver.wait(until.elementIsEnabled(button), 15_000);
  await button.click();
}

async function waitForText(text, timeout) {
  await driver.wait(async () => (await bodyText()).includes(text), timeout, `did not see ${text}`);
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function capture(name) {
  const file = `${name}-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, file), Buffer.from(await driver.takeScreenshot(), "base64"));
  evidence.screenshots.push({ item: name, build: installedVersion, file });
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) throw new Error(`tauri-driver exited early (${tauriDriver.exitCode})`);
    try { if ((await fetch(`${driverUrl}/status`)).ok) return; } catch { /* readiness poll */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready");
}

async function waitForBody() {
  await driver.wait(async () => (await bodyText()).trim() !== "", 30_000, "installed app rendered no text");
}

async function stopFixtureDaemons(root) {
  for (const entry of ["nested-source", "secret-variant", "incomplete-git", "explicit-check"]) {
    const state = path.join(root, entry, ".hivemind", "daemon.json");
    if (!existsSync(state)) continue;
    try {
      const daemon = JSON.parse(await readFile(state, "utf8"));
      await fetch(`${daemon.url}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${daemon.auth_token}` } });
    } catch { /* cleanup is best effort */ }
  }
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not exit`);
}

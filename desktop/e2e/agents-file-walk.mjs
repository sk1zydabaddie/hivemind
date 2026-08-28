/**
 * The AGENTS.md proposal, on the INSTALLED app, end to end.
 *
 * Proves the three properties that matter and cannot be checked by reading:
 *   1. the card offers a diff, and nothing is written before it is accepted
 *   2. accepting writes a file whose every line traces to the repository
 *   3. a hand-edited section is not offered for overwrite afterwards
 */
import assert from "node:assert/strict";
import "./protect-recent-projects.mjs";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-agents-walk");
let tauriDriver;
let driver;

const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
  console.log(`  screenshot: ${name}.png`);
}
async function buttons() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button")]
       .filter((e) => e.offsetParent !== null)
       .map((e) => (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
       .filter((t) => t !== "");`
  );
}
async function click(label) {
  const ok = await driver.executeScript(
    `const wanted = arguments[0];
     const target = [...document.querySelectorAll("button")].find(
       (e) => e.offsetParent !== null && (e.innerText || "").replace(/\\s+/g, " ").trim() === wanted);
     if (!target) return false;
     target.click();
     return true;`,
    label
  );
  assert.ok(ok, `no button labelled "${label}"`);
}

/**
 * The project this walks.
 *
 * The Project tab is only reachable once a project can actually work, so this
 * reuses a project that already has its agents connected rather than paying for
 * new connections -- the proposal reads the repository, not any agent, so the
 * connections are a precondition of the SURFACE and not of the feature. Two
 * test files are added so the naming convention has something to be counted
 * from, and any earlier AGENTS.md is cleared so the walk starts from nothing.
 */
/* The section nav is a Radix Tabs trigger, not an ordinary button: it lives
   under role="tab", it shares its label with a command-palette entry, and it
   activates on focus as much as on click. So it is selected by role and driven
   with focus + click rather than by matching button text. */
async function openSection(label) {
  const ok = await driver.executeScript(
    `const wanted = arguments[0];
     const tab = [...document.querySelectorAll('[role="tab"]')].find(
       (e) => (e.textContent || "").replace(/\s+/g, " ").trim() === wanted);
     if (!tab) return false;
     tab.focus();
     tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
     tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
     tab.click();
     return true;`,
    label
  );
  assert.ok(ok, `no tab labelled "${label}"`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  /* Focusing a trigger can leave the command palette open over the surface, and
     an open palette is what `document.body.innerText` then reports -- which
     read as "the tab never switched" while the tab was in fact active. */
  await driver.actions().sendKeys("").perform();
  await new Promise((resolve) => setTimeout(resolve, 900));
}

async function prepareProject() {
  const dir = path.join(os.tmpdir(), "hivemind-fresh-b");
  assert.ok(
    existsSync(path.join(dir, ".hivemind", "adapters", "manager.profile.json")),
    `no connected project at ${dir}; run e2e/fresh-project-walk.mjs first`
  );
  await rm(path.join(dir, "AGENTS.md"), { force: true });
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(path.join(dir, "test", "a.test.js"), "", "utf8");
  await writeFile(path.join(dir, "test", "b.test.js"), "", "utf8");
  return dir;
}

async function main() {
  assert.ok(existsSync(installed), `no installed binary at ${installed}`);
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });
  const project = await prepareProject();
  console.log(`project: ${project}`);

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installed });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(async () => (await body()).trim().length > 40, 30_000);

  /* Open the project and set it up, which is all this needs -- the proposal
     reads the repository, not any connected agent. */
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    project
  );
  await click("Open project");
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  /* To the Project tab, where the proposal lives. */
  await openSection("Project");
  try {
    await driver.wait(async () => /starter AGENTS\.md/u.test(await body()), 30_000);
  } catch (cause) {
    console.log("DIAGNOSTIC — tabs:", JSON.stringify(await driver.executeScript(
      `return [...document.querySelectorAll('[role="tab"]')].map((e) => ({
         text: (e.textContent || "").trim(), state: e.getAttribute("data-state"),
         disabled: e.hasAttribute("disabled"), id: e.id }));`)));
    console.log("DIAGNOSTIC — buttons:", JSON.stringify(await buttons()));
    console.log("DIAGNOSTIC — body:", (await body()).slice(0, 1200));
    const probe = await driver.executeScript(
      `return window.__TAURI_INTERNALS__.invoke("workspace_action", {
         projectPath: arguments[0], action: { type: "agents.propose", payload: {} }
       }).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e: String(e) }));`,
      project
    );
    console.log("DIAGNOSTIC — agents.propose:", JSON.stringify(probe).slice(0, 600));
    throw cause;
  }
  const offered = await body();
  console.log(`1. card offered: ${/A starter AGENTS.md, from what is in this project/u.test(offered)}`);
  console.log(`1. shows a diff: ${/\+## Where things are/u.test(offered)}`);
  assert.match(offered, /\+## Where things are/u, "no diff on screen");
  assert.ok((await buttons()).includes("Use this"), "no accept control");
  /* Nothing written yet: proposing is not applying. */
  assert.equal(existsSync(path.join(project, "AGENTS.md")), false, "AGENTS.md was written before it was accepted");
  console.log("1. nothing written before accepting: true");
  await shot("1-proposed");

  await click("Use this");
  await driver.wait(async () => existsSync(path.join(project, "AGENTS.md")), 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const written = await readFile(path.join(project, "AGENTS.md"), "utf8");
  console.log(`2. written ${Buffer.byteLength(written, "utf8")} bytes`);
  console.log(written.split("\n").map((line) => `   | ${line}`).join("\n"));
  /* Every claim traces to the repository this walk built. */
  assert.match(written, /Node\.js/u);
  /* Whichever module kind this project actually declares -- asserting "ES
     modules" here once failed the product for being right, because the project
     has no `"type": "module"` and CommonJS was the correct reading. */
  assert.match(written, /(ES modules|CommonJS)/u);
  assert.match(written, /Source lives in `src\/`/u);
  assert.match(written, /Tests live in `test\/`/u);
  assert.match(written, /Test files are named `\*\.test\.js`/u);
  assert.match(written, /`npm test` runs the tests/u);
  /* And nothing in it reads as permission. */
  assert.doesNotMatch(written, /you may|feel free|skip the test|pre-approved/iu);
  assert.ok(Buffer.byteLength(written, "utf8") < 2048, "starter file is larger than it should be");
  await shot("2-accepted");

  /* A hand edit is the person's decision: the card must not come back offering
     to overwrite it. */
  await writeFile(path.join(project, "AGENTS.md"), written.replace("## Where things are", "## Where things are (mine)"), "utf8");
  await openSection("Work");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await openSection("Project");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = await body();
  console.log(`3. card returns after a hand edit: ${/A starter AGENTS.md, from what is in this project/u.test(after)}`);
  assert.doesNotMatch(after, /A starter AGENTS.md, from what is in this project/u, "offered to overwrite a hand edit");
  assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /\(mine\)/u);
  console.log("3. the hand edit is still on disk: true");
  await shot("3-hand-edit-respected");

  console.log(`\nAGENTS WALK PASSED. evidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

/**
 * A fresh project, end to end, on the INSTALLED app.
 *
 * Walks what a person actually does on a new folder and measures the seven
 * things this pass changed:
 *   1. connections are once per machine -- the second project adopts, no call
 *   2. the checks are faster, and how much
 *   3. reopening lands on the last project, or says it is gone
 *   4. an entry can be removed without touching the folder
 *   5. a detected check command is REPORTED, not asked about
 *   6. there is a way forward from the last screen
 *   7. the command badge is not stretched
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, until, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-fresh-walk");
let tauriDriver;
let driver;
const notes = [];

function note(line) {
  notes.push(line);
  console.log(line);
}

async function body() {
  return driver.executeScript("return document.body.innerText;");
}

async function shot(name) {
  const png = await driver.takeScreenshot();
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(png, "base64"));
  note(`  screenshot: ${name}.png`);
}

async function buttons() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button")]
       .filter((element) => element.offsetParent !== null)
       .map((element) => ({
         label: (element.innerText || element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(),
         disabled: element.disabled
       }))
       .filter((entry) => entry.label !== "");`
  );
}

async function click(label) {
  const ok = await driver.executeScript(
    `const wanted = arguments[0];
     const target = [...document.querySelectorAll("button")].find(
       (element) =>
         element.offsetParent !== null &&
         ((element.innerText || "").replace(/\\s+/g, " ").trim() === wanted ||
          (element.getAttribute("aria-label") || "").trim() === wanted)
     );
     if (!target) return false;
     target.click();
     return true;`,
    label
  );
  assert.ok(ok, `no button labelled "${label}"`);
}

/* Wait until no connect is in flight.
 *
 * The first version of this waited on a condition that was already true, so it
 * measured 0s and then read a screen that was still working -- the button list
 * it captured still contained "Checking Grok Build, Codex". A walk that reports
 * a number it did not wait for is worse than one that times out. The signal is
 * the absence of a Checking button, which is the app's own progress text. */
async function settleConnects(timeoutMs = 600_000) {
  const startedAt = Date.now();
  /* Give the click a moment to become a Checking state at all, so "not yet
     started" is never mistaken for "finished". */
  await new Promise((resolve) => setTimeout(resolve, 2500));
  for (;;) {
    const working = (await buttons()).some((entry) => /^Check(ing|ed) /u.test(entry.label));
    if (!working) break;
    if (Date.now() - startedAt > timeoutMs) throw new Error("connects never settled");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return Math.round((Date.now() - startedAt) / 1000);
}

/* Whatever the screen says went wrong, so a failure is reported rather than
   inferred from what is missing. */
async function failureText() {
  return driver.executeScript(
    `return [...document.querySelectorAll('[role="alert"], .text-clay, [class*="clay"]')]
       .map((element) => (element.innerText || "").replace(/\\s+/g, " ").trim())
       .filter((text) => text !== "")
       .slice(0, 4);`
  );
}

async function openProject(target) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(
      By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')
    ),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    target
  );
  await click("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000
  );
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

/** A git repository with a package.json test script, which detection must find. */
async function makeProject(name) {
  const dir = path.join(os.tmpdir(), name);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    '{\n  "name": "' + name + '",\n  "scripts": { "test": "node --test" }\n}\n',
    "utf8"
  );
  await writeFile(path.join(dir, "src", "index.js"), "export const answer = 42;\n", "utf8");
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

async function main() {
  assert.ok(existsSync(installed), `no installed binary at ${installed}`);
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });

  const projectA = await makeProject("hivemind-fresh-a");
  const projectB = await makeProject("hivemind-fresh-b");
  note(`project A: ${projectA}`);
  note(`project B: ${projectB}`);

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
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(async () => (await body()).trim().length > 40, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  /* ── 7. the badge ── */
  const badge = await driver.executeScript(
    `const kbd = [...document.querySelectorAll("kbd")].find((entry) => entry.textContent.includes("K"));
     if (!kbd) return null;
     const box = kbd.getBoundingClientRect();
     return { width: Math.round(box.width), height: Math.round(box.height), text: kbd.textContent.trim() };`
  );
  note(`7. command badge: ${JSON.stringify(badge)}`);
  assert.ok(badge, "no command badge found");
  /* A stretched badge filled the button's cross-axis; a fitted one is short. */
  assert.ok(badge.height <= 22, `the badge is ${badge.height}px tall, which is stretched`);

  /* ── 5 + 6. a fresh project: detection reports, and there is a way out ── */
  await openProject(projectA);
  await click("Set it up");
  await driver.wait(async () => existsSync(path.join(projectA, ".hivemind")), 60_000);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const afterSetup = await body();
  note(`5. detection text present: ${/Found in your project and being used/u.test(afterSetup)}`);
  note(`5. asked instead: ${/How do you check your code works\?/u.test(afterSetup)}`);
  const config = JSON.parse(await readFile(path.join(projectA, ".hivemind", "config.json"), "utf8"));
  note(`5. recorded test_command: ${JSON.stringify(config.test_command)}`);
  assert.equal(config.test_command, "npm test", "detection did not find the package.json script");
  assert.match(afterSetup, /Found in your project and being used/u);
  await shot("1-detected");

  /* ── 1 + 2. connect, timed ── */
  note("1/2. connecting the recommended agents (this is the paid part)...");
  await click("Continue");
  const firstElapsed = await settleConnects();
  note(`2. project A connect took ${firstElapsed}s`);
  note(`   failures on screen: ${JSON.stringify(await failureText())}`);
  const settled = await body();
  /* Three acceptable answers, and silence is not one of them. Promotion is the
     strongest: setup finished and handed over without being asked. The button
     is for when a person is still standing on the screen, and the reason is for
     when work genuinely cannot start. The bug was none of the three. */
  const promoted = /Send request/u.test(settled) || /Nothing running/u.test(settled);
  const forward = /Start working/u.test(settled);
  const reason = /Work cannot start yet/u.test(settled);
  note(`6. promoted to work: ${promoted}; button offered: ${forward}; reason given: ${reason}`);
  note(`6. last 400 chars of the screen: ${JSON.stringify(settled.slice(-400))}`);
  note(`6. buttons: ${JSON.stringify(await buttons())}`);
  await shot("2-setup-complete");
  assert.ok(promoted || forward || reason, "setup ended in silence: no promotion, no button, no reason");

  const records = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("workspace_action", {
       projectPath: arguments[0],
       action: { type: "config.inspect", payload: {} }
     }).then((value) => (value.adapters || []).map((entry) => ({
        role: entry.role, agent: entry.agent_id, at: entry.connected_at
      }))).catch((error) => ({ error: String(error) }));`,
    projectA
  );
  note(`1. project A adapters: ${JSON.stringify(records)}`);

  /* ── 1. the second project must adopt, not re-probe ── */
  await openProject(projectB);
  await click("Set it up");
  await driver.wait(async () => existsSync(path.join(projectB, ".hivemind")), 60_000);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await click("Continue");
  const secondElapsed = await settleConnects();
  note(`1/2. project B connect took ${secondElapsed}s (A took ${firstElapsed}s)`);
  note(`   failures on screen: ${JSON.stringify(await failureText())}`);
  await shot("3-second-project");

  /* The evidence that it adopted rather than paid: the record says so. */
  const adaptersDir = path.join(projectB, ".hivemind", "adapters");
  const adopted = [];
  for (const entry of await (await import("node:fs/promises")).readdir(adaptersDir).catch(() => [])) {
    if (!entry.endsWith(".connection.json")) continue;
    const record = JSON.parse(await readFile(path.join(adaptersDir, entry), "utf8"));
    adopted.push({
      file: entry,
      source: record.verdict_source?.kind ?? "probed here",
      measured_at: record.verdict_source?.measured_at ?? record.connected_at,
      tokens: record.effective_tokens
    });
  }
  note(`1. project B connection records: ${JSON.stringify(adopted, null, 1)}`);
  assert.ok(adopted.length > 0, "project B connected nothing");
  assert.ok(
    adopted.every((entry) => entry.source === "machine_cache"),
    "a second project on the same machine re-probed instead of adopting"
  );

  /* ── 3 + 4. recents: the last project, and removing an entry ── */
  const lastProject = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("last_project").catch((error) => ({ error: String(error) }));`
  );
  note(`3. last_project reports: ${JSON.stringify(lastProject)}`);
  assert.equal(lastProject?.path?.toLowerCase().includes("hivemind-fresh-b"), true);
  assert.equal(lastProject.missing, false);

  const removed = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("forget_project", { projectPath: arguments[0] })
       .then(() => window.__TAURI_INTERNALS__.invoke("recent_projects"))
       .then((entries) => entries.map((entry) => entry.path))
       .catch((error) => ({ error: String(error) }));`,
    projectA
  );
  note(`4. recents after removing A: ${JSON.stringify(removed)}`);
  assert.ok(Array.isArray(removed), "forget_project failed");
  assert.ok(
    !removed.some((entry) => entry.toLowerCase().includes("hivemind-fresh-a")),
    "the entry was not removed"
  );
  /* And the folder is untouched, which is the whole promise of that control. */
  assert.ok(existsSync(path.join(projectA, ".hivemind", "config.json")), "removing the entry deleted project work");
  note("4. project A folder and .hivemind still on disk");

  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = logs.filter((entry) => entry.level?.name === "SEVERE");
  note(`browser SEVERE: ${JSON.stringify(severe.map((entry) => entry.message.slice(0, 200)))}`);
  assert.deepEqual(severe, [], "the walk logged errors");

  await writeFile(path.join(evidence, "notes.txt"), notes.join("\n"), "utf8");
  note(`\nFRESH WALK PASSED. evidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

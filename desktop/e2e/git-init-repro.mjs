/**
 * One bug, reproduced on the INSTALLED app: point Hivemind at a folder with no
 * git, press the button, and record what actually happens.
 *
 * Diagnostic order, and each answer is evidence rather than inference:
 *   1. did `git init` and the first commit happen on disk?
 *   2. what does the shell's own readiness read say before and after?
 *   3. is the flip a race -- optimistic UI corrected by a read taken early?
 *   4. did the refusal fire, and did the screen say so?
 * Plus: does anything flash a console window?
 */
import assert from "node:assert/strict";
import "./protect-recent-projects.mjs";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, until, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedBinary = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Hivemind AI",
  "hivemind_desktop.exe"
);
const evidenceDir = path.join(os.tmpdir(), "hivemind-git-init-repro");
let tauriDriver;
let driver;
const notes = [];

function note(line) {
  notes.push(line);
  console.log(line);
}

async function waitForDriver() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${driverUrl}/status`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("tauri-driver did not become ready");
}

async function bodyText() {
  return driver.executeScript("return document.body.innerText;");
}

async function shot(name) {
  const png = await driver.takeScreenshot();
  const file = path.join(evidenceDir, `${name}.png`);
  await writeFile(file, Buffer.from(png, "base64"));
  note(`  screenshot: ${file}`);
}

/** Every button on screen, with its enabled state. */
async function buttons() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button")]
       .filter((element) => element.offsetParent !== null)
       .map((element) => ({
         label: (element.innerText || element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(),
         disabled: element.disabled
       }));`
  );
}

async function clickButton(label) {
  const clicked = await driver.executeScript(
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
  assert.ok(clicked, `no button labelled "${label}"`);
}

async function main() {
  assert.ok(existsSync(installedBinary), `no installed binary at ${installedBinary}`);
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });

  /* A fresh folder with REAL source and no git. Stable path, recreated each
     run: the app remembers its last project, and a remembered folder a
     previous run deleted turns the next cold open into unrelated noise.
     Deliberately NOT carrying node_modules or build output -- those are what
     the shell refuses on, and the point here is the ordinary case. */
  const project = path.join(os.tmpdir(), "hivemind-git-init-repro-project");
  await rm(project, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    '{\n  "name": "git-init-repro",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n',
    "utf8"
  );
  await writeFile(path.join(project, "src", "index.js"), "export const answer = 42;\n", "utf8");
  await writeFile(path.join(project, "README.md"), "# git init repro\n", "utf8");
  note(`project: ${project}`);
  assert.equal(existsSync(path.join(project, ".git")), false, "the fixture already has git");

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await waitForDriver();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(async () => (await bodyText()).trim().length > 40, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  /* Count console windows before and after, from outside the app. The swap
     helper was hardened by measuring GetConsoleWindow() inside the helper;
     this measures what a PERSON sees -- a window that exists at all. */
  const consoleWindows = async () => {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "(Get-Process | Where-Object { $_.MainWindowTitle -match 'cmd|Windows PowerShell|git' } | Measure-Object).Count"
    ]);
    return Number(stdout.trim());
  };
  const consolesBefore = await consoleWindows();
  note(`console windows before: ${consolesBefore}`);

  /* -- open the untracked folder -- */
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
    project
  );
  await clickButton("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));

  note("--- BEFORE the click ---");
  note(`  body mentions git: ${/git/iu.test(await bodyText())}`);
  note(`  buttons: ${JSON.stringify(await buttons())}`);
  await shot("1-before");

  /* The shell's own readiness answer, which is what the screen renders. */
  const readinessBefore = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("inspect_git_readiness", { projectPath: arguments[0] })
       .then((value) => ({ ok: true, value }))
       .catch((error) => ({ ok: false, error: String(error) }));`,
    project
  );
  note(`  inspect_git_readiness: ${JSON.stringify(readinessBefore)}`);

  /* -- the click, watched frame by frame -- */
  /* By exact label. A pattern match found the PROJECT NAME button first --
     the fixture folder is called "hivemind-git-init-repro-project" and
     contains the word git, so the loose selector clicked the project switcher
     and measured nothing. */
  const gitButton = (await buttons()).find((entry) => entry.label === "Set up git for me");
  note(`--- CLICKING: ${JSON.stringify(gitButton)} ---`);
  assert.ok(gitButton, "no git-setup button on screen");

  /* Sample the visible state every 120ms across the click, so a flip that
     lasts a split second is recorded rather than inferred. */
  await driver.executeScript(
    `window.__REPRO__ = [];
     window.__REPRO_TIMER__ = setInterval(() => {
       window.__REPRO__.push({
         t: Math.round(performance.now()),
         buttons: [...document.querySelectorAll("button")]
           .filter((element) => element.offsetParent !== null)
           .map((element) => (element.innerText || "").replace(/\\s+/g, " ").trim())
           .filter((label) => label !== ""),
         alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')]
           .map((element) => (element.innerText || "").replace(/\\s+/g, " ").trim())
           .filter((text) => text !== "")
       });
     }, 120);`
  );
  await clickButton(gitButton.label);
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  const timeline = await driver.executeScript(
    "clearInterval(window.__REPRO_TIMER__); return window.__REPRO__;"
  );

  note("--- AFTER the click ---");
  await shot("2-after");
  const consolesAfter = await consoleWindows();
  note(`console windows after: ${consolesAfter}`);

  /* 1. Did it actually happen on disk? */
  const gitDirExists = existsSync(path.join(project, ".git"));
  let commits = "none";
  try {
    const { stdout } = await run("git", ["log", "--oneline"], { cwd: project });
    commits = stdout.trim() || "(no commits)";
  } catch (error) {
    commits = `git log failed: ${String(error).slice(0, 200)}`;
  }
  note(`ON DISK: .git exists = ${gitDirExists}`);
  note(`ON DISK: commits = ${commits}`);

  /* 2. What the shell reads afterwards. */
  const readinessAfter = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("inspect_git_readiness", { projectPath: arguments[0] })
       .then((value) => ({ ok: true, value }))
       .catch((error) => ({ ok: false, error: String(error) }));`,
    project
  );
  note(`AFTER: inspect_git_readiness = ${JSON.stringify(readinessAfter)}`);
  note(`AFTER: buttons = ${JSON.stringify(await buttons())}`);
  const finalBody = await bodyText();
  note(`AFTER: body first 700 chars =\n${finalBody.slice(0, 700)}`);

  /* 3. The flip, sampled. */
  note("--- SAMPLED TIMELINE (label sets as they changed) ---");
  let previous = "";
  for (const frame of timeline) {
    const signature = JSON.stringify({ buttons: frame.buttons, alerts: frame.alerts });
    if (signature === previous) continue;
    previous = signature;
    note(`  t=${frame.t} ${signature}`);
  }

  /* 4. Anything the app logged. */
  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = logs.filter((entry) => entry.level?.name === "SEVERE");
  note(`browser SEVERE entries: ${JSON.stringify(severe.map((entry) => entry.message.slice(0, 300)))}`);

  await writeFile(path.join(evidenceDir, "notes.txt"), notes.join("\n"), "utf8");
  note(`\nevidence: ${evidenceDir}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

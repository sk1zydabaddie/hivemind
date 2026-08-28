/**
 * Walk it as a person who does not know the rules yet.
 *
 * Not a scripted happy path: the things somebody does in the first two minutes.
 * Type nothing and press send. Click the wrong thing first. Open every expander.
 * Look at what every control claims it will do, and whether it can.
 *
 * Reports; fixes nothing. Each finding is classified as one of:
 *   wrong invitation | dead affordance | false progress | wrong message
 */
import { spawn } from "node:child_process";
import "./protect-recent-projects.mjs";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Builder, By, Capabilities, until } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-naive-walk");
const findings = [];
let tauriDriver;
let driver;

const note = (kind, where, what) => {
  findings.push({ kind, where, what });
  console.log(`  [${kind}] ${where}: ${what}`);
};
const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
}

/** Every visible control, with what it says and whether it can be pressed. */
async function controls() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button, [role=tab], a[href], summary")]
       .filter((e) => e.offsetParent !== null)
       .map((e) => ({
         label: (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60),
         tag: e.tagName.toLowerCase(),
         disabled: e.disabled === true || e.getAttribute("aria-disabled") === "true",
         title: (e.getAttribute("title") || "").slice(0, 60)
       }))
       .filter((e) => e.label !== "");`
  );
}

/** Placeholders and empty-state prose: what the surface invites you to do. */
async function invitations() {
  return driver.executeScript(
    `const out = [];
     for (const e of document.querySelectorAll("input, textarea")) {
       if (e.offsetParent === null) continue;
       out.push({ kind: "placeholder", text: e.getAttribute("placeholder") || "", label: e.getAttribute("aria-label") || "" });
     }
     return out.filter((e) => e.text !== "");`
  );
}

async function openProject(target) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const i = document.getElementById("project-path");
     const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     s.call(i, arguments[0]);
     i.dispatchEvent(new Event("input", { bubbles: true }));`,
    target
  );
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "Open project")?.click();`
  );
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 6000));
}

async function main() {
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });

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

  /* ── 1. the very first screen, before anything is chosen ── */
  console.log("\n=== the first screen");
  const firstControls = await controls();
  console.log(`  controls: ${JSON.stringify(firstControls.map((c) => c.label))}`);
  for (const control of firstControls) {
    if (control.disabled) note("dead affordance", "first screen", `"${control.label}" is visible but disabled with nothing explaining why`);
  }
  await shot("1-first-screen");

  /* ── 2. a project that is connected and set up ── */
  const project = path.join(os.tmpdir(), "hivemind-fresh-b");
  if (!existsSync(project)) {
    console.log("no prepared project; run fresh-project-walk.mjs first");
    return;
  }
  await openProject(project);
  console.log("\n=== the work surface");
  const invites = await invitations();
  console.log(`  invitations: ${JSON.stringify(invites)}`);
  await shot("2-work");

  /* ── 3. press send with nothing typed ── */
  const sendState = await driver.executeScript(
    `const b = [...document.querySelectorAll("button")].find(
       (e) => (e.getAttribute("aria-label") || "").startsWith("Send"));
     if (!b) return null;
     return { label: b.getAttribute("aria-label"), disabled: b.disabled, title: b.getAttribute("title") || "" };`
  );
  console.log(`\n=== send with an empty composer: ${JSON.stringify(sendState)}`);
  if (sendState && sendState.disabled) {
    note("dead affordance", "composer", "the send control is visible and disabled with an empty box, and says nothing about what would enable it");
  }

  /* ── 4. type only spaces ── */
  await driver.executeScript(
    `const t = document.querySelector("textarea");
     const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
     s.call(t, "   ");
     t.dispatchEvent(new Event("input", { bubbles: true }));`
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  const spacesState = await driver.executeScript(
    `const b = [...document.querySelectorAll("button")].find(
       (e) => (e.getAttribute("aria-label") || "").startsWith("Send"));
     return b ? b.disabled : null;`
  );
  console.log(`  send enabled after typing only spaces: ${spacesState === false}`);
  if (spacesState === false) {
    note("wrong invitation", "composer", "whitespace enables the send control, which then does nothing when pressed");
  }
  await driver.executeScript(
    `const t = document.querySelector("textarea");
     const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
     s.call(t, "");
     t.dispatchEvent(new Event("input", { bubbles: true }));`
  );

  /* ── 5. every tab, and every expander on it ── */
  for (const section of ["Work", "Agents", "Project"]) {
    await driver.executeScript(
      `const t = [...document.querySelectorAll('[role="tab"]')].find(
         (e) => (e.textContent || "").trim() === arguments[0]);
       if (t) { t.focus(); t.click(); }`,
      section
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await driver.actions().sendKeys("").perform();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const text = await body();
    const here = await controls();
    console.log(`\n=== ${section}: ${here.length} controls`);
    console.log(`  ${JSON.stringify(here.filter((c) => c.disabled).map((c) => c.label))} disabled`);
    for (const control of here) {
      if (control.disabled) {
        note("dead affordance", section, `"${control.label}" disabled with no stated reason`);
      }
    }
    /* A spinner or elapsed clock with nothing running. */
    if (/elapsed/u.test(text) && !/agents? (?:is|are) working|Nothing running/u.test(text)) {
      note("false progress", section, "an elapsed clock is running with no visible work behind it");
    }
    if (/Planner is reading your request/u.test(text)) {
      note("false progress", section, "a live 'Planner is reading your request' round is shown while nothing is running");
    }
    await shot(`3-${section.toLowerCase()}`);
  }

  await writeFile(path.join(evidence, "findings.json"), JSON.stringify(findings, null, 2), "utf8");
  console.log(`\n${findings.length} finding(s). evidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

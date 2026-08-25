/**
 * PAID (two planner calls). Screenshots the nine changes on the installed app.
 *
 * Each shot is named for the item it evidences. Where a change is an absence --
 * no "You" label, no duplicated card, no spend readout -- the assertion is the
 * absence, because a screenshot alone cannot prove something is gone.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, Key, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-nine");
let tauriDriver;
let driver;

const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
  console.log(`  shot: ${name}.png`);
}
async function labels() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button")]
       .filter((e) => e.offsetParent !== null)
       .map((e) => (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
       .filter((t) => t !== "");`
  );
}
async function type(text) {
  await driver.executeScript(
    `const t = document.querySelector("textarea");
     const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
     s.call(t, arguments[0]);
     t.dispatchEvent(new Event("input", { bubbles: true }));`,
    text
  );
}

async function main() {
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });
  const project = path.join(os.tmpdir(), "hivemind-fresh-b");
  assert.ok(existsSync(path.join(project, ".hivemind", "adapters", "planner.profile.json")), "no connected project");
  await rm(path.join(project, ".hivemind", "spec"), { recursive: true, force: true });
  await rm(path.join(project, ".hivemind", "plans"), { recursive: true, force: true });

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) break;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installed });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().window().setRect({ width: 1440, height: 900 });
  await driver.wait(async () => (await body()).trim().length > 40, 30_000);

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
    project
  );
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "Open project")?.click();`
  );
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 6000));

  /* ── #5 composer width, #6 footer, #1 the control ── */
  const idle = await body();
  console.log(`1. "New conversation" offered: ${(await labels()).includes("New conversation")}`);
  console.log(`6. old readout gone: ${!/held \/|calls ·|setup \d+ calls/u.test(idle)}`);
  const width = await driver.executeScript(
    `const f = document.querySelector("form");
     const t = document.querySelector("textarea");
     return f && t ? { form: Math.round(f.getBoundingClientRect().width), window: window.innerWidth } : null;`
  );
  console.log(`5. composer ${width?.form}px in a ${width?.window}px window`);
  await shot("idle-composer-and-controls");

  /* ── #7 Enter sends ── */
  /* A REAL keystroke through the driver, not a synthetic event: a dispatched
     KeyboardEvent is untrusted and does not exercise what a person's finger
     does. Typed character by character for the same reason. */
  const composer = await driver.findElement(By.css("textarea"));
  await composer.click();
  await composer.sendKeys("What files are in this project?");
  await composer.sendKeys("");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const afterEnter = await body();
  console.log(`7. Enter sent it: ${/What files are in this project\?/u.test(afterEnter)}`);
  console.log(`4. no "YOU" label: ${!/\bYOU\b/u.test(afterEnter)}`);

  /* Wait for a reply BELOW the question. Splitting on the question text failed
     because a reply can quote it -- the predicate has to be about position, not
     about the words. */
  await driver.wait(async () => {
    const now = await body();
    const at = now.lastIndexOf("What files are in this project?");
    return at !== -1 && /HIVEMIND/u.test(now.slice(at));
  }, 180_000);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await shot("enter-sends-and-no-you-label");
  const answered = await body();
  console.log(`4. answered, still no "YOU": ${!/\bYOU\b/u.test(answered)}`);

  /* ── #1 new conversation ── */
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((e) => (e.innerText||"").trim().startsWith("New conversation"))?.click();`
  );
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const fresh = await body();
  console.log(`1. thread cleared: ${!/What files are in this project\?/u.test(fresh)}`);
  console.log(`1. said what it kept: ${/still in the project's history/u.test(fresh)}`);
  await shot("new-conversation");

  /* ── #9 the hexagons ── */
  const hexes = await driver.executeScript(
    `return [...document.querySelectorAll("svg")]
       .map((e) => e.getAttribute("viewBox"))
       .filter((v) => v && /^0 0 1[0-9]/u.test(v))
       .slice(0, 4);`
  );
  console.log(`9. hexagon viewBoxes: ${JSON.stringify(hexes)}`);

  console.log(`\nevidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

/**
 * PAID. Does text appear WHILE the model is working?
 *
 * The predicate this replaces could not fail: it took `body.innerText` after the
 * indicator's label and asked whether more than 40 characters followed --
 * everything below the label in the DOM (composer, footer, rail) always is. It
 * would have passed with the stream unplugged, which is exactly what happened.
 *
 * This one samples the LIVE REGION ITSELF, every 400ms, from before the call
 * until after it, and reports what was on screen at each moment. It cannot pass
 * without text having been there while the work was going.
 */
import "./protect-recent-projects.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Builder, By, Capabilities, Key, until } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-streaming");
let tauriDriver;
let driver;

const body = async () => driver.executeScript("return document.body.innerText;");

/** The indicator and whatever text sits under it — the live region, nothing else. */
async function liveRegion() {
  return driver.executeScript(
    `const label = [...document.querySelectorAll("article")].find(
       (e) => /Planner is reading your request|is working/u.test(e.innerText || ""));
     if (!label) return null;
     const own = (label.innerText || "").replace(/\\s+/g, " ").trim();
     const pre = label.querySelector("pre, p:not(:first-child)");
     return { indicator: own.slice(0, 60), text: (pre?.innerText || "").replace(/\\s+/g, " ").trim() };`
  );
}

async function main() {
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });
  const project = path.join(os.tmpdir(), "hivemind-fresh-b");
  assert.ok(existsSync(path.join(project, ".hivemind", "adapters", "planner.profile.json")), "no project");

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

  const composer = await driver.findElement(By.css("textarea"));
  await composer.click();
  await composer.sendKeys("Describe what this project does, in one sentence.");
  await composer.sendKeys(Key.ENTER);

  /* Sample the live region until the indicator goes away. */
  const samples = [];
  const startedAt = Date.now();
  let sawIndicator = false;
  let shotTaken = false;
  while (Date.now() - startedAt < 120_000) {
    /* Diagnostic: what the surface actually contains at this moment, so a
       missing indicator is distinguishable from a wrong selector. */
    const seen = await driver.executeScript(
      `return {
         articles: [...document.querySelectorAll("article")].map(
           (e) => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50)).slice(-4),
         reading: /Planner is reading/u.test(document.body.innerText)
       };`
    );
    if (samples.length === 0 && Date.now() - startedAt < 4000) {
      console.log(`  probe t+${Math.round((Date.now() - startedAt) / 100) / 10}s ${JSON.stringify(seen)}`);
    }
    const region = await liveRegion();
    const at = Math.round((Date.now() - startedAt) / 100) / 10;
    if (region !== null) {
      sawIndicator = true;
      samples.push({ at, indicator: region.indicator, text: region.text });
      if (!shotTaken && region.text !== "") {
        await writeFile(
          path.join(evidence, "mid-stream.png"),
          Buffer.from(await driver.takeScreenshot(), "base64")
        );
        shotTaken = true;
      }
    } else if (sawIndicator) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`\nsamples while working (${samples.length}):`);
  for (const sample of samples) {
    console.log(`  t+${sample.at}s  [${sample.indicator}]  text: ${JSON.stringify(sample.text.slice(0, 70))}`);
  }

  const withText = samples.filter((sample) => sample.text !== "");
  console.log(`\nindicator seen while working: ${sawIndicator}`);
  console.log(`samples that had text on screen DURING the work: ${withText.length}`);
  console.log(`text grew during the call: ${new Set(withText.map((s) => s.text)).size > 1}`);
  await writeFile(path.join(evidence, "samples.json"), JSON.stringify(samples, null, 2), "utf8");

  assert.ok(sawIndicator, "no thinking indicator appeared at all");
  assert.ok(withText.length > 0, "the indicator appeared but no text was ever under it while working");

  await new Promise((resolve) => setTimeout(resolve, 2500));
  await writeFile(
    path.join(evidence, "after.png"),
    Buffer.from(await driver.takeScreenshot(), "base64")
  );
  console.log(`\nevidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

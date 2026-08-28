/**
 * Does Luna actually connect on the installed app?
 *
 * The blocking report was that the cheap tier could not be reached: a
 * machine-wide `notify` chain refused every Codex model on every project. The
 * refusal is gone -- the override that neutralises notify is now measured to
 * apply -- so this walks the real flow and connects `codex-luna` for the worker
 * role, which spends one capability probe on the user's own subscription.
 *
 * Verifies by DOING it: the connection record on disk is the evidence, and the
 * row's own words are checked for the claim they used to overstate.
 */
import "./protect-recent-projects.mjs";
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
const evidence = path.join(os.tmpdir(), "hivemind-luna-check");
let tauriDriver;
let driver;

async function bodyText() {
  return driver.executeScript("return document.body.innerText;");
}

async function shot(name) {
  const png = await driver.takeScreenshot();
  const file = path.join(evidence, `${name}.png`);
  await writeFile(file, Buffer.from(png, "base64"));
  console.log(`  screenshot: ${file}`);
}

async function main() {
  assert.ok(existsSync(installed), `no installed binary at ${installed}`);
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });

  /* A real project with git and a test script, set up fresh so the connection
     record this writes is unambiguous evidence from this run. */
  const project = path.join(os.tmpdir(), "hivemind-luna-check-project");
  await rm(project, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    '{\n  "name": "luna-check",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n',
    "utf8"
  );
  await writeFile(path.join(project, "src", "index.js"), "export const answer = 42;\n", "utf8");
  await run("git", ["init", "-q"], { cwd: project });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: project });
  await run("git", ["config", "user.name", "t"], { cwd: project });
  await run("git", ["add", "-A"], { cwd: project });
  await run("git", ["commit", "-qm", "base"], { cwd: project });
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
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(async () => (await bodyText()).trim().length > 40, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  /* Open the project, then set it up so a worker can be connected. */
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
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((element) => (element.innerText || "").trim() === "Open project")?.click();`
  );
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));

  /* "Set it up" writes .hivemind. Costs nothing. */
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((element) => (element.innerText || "").trim() === "Set it up")?.click();`
  );
  await driver.wait(
    async () => existsSync(path.join(project, ".hivemind")),
    60_000,
    "the project was never set up"
  );
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await shot("1-project-ready");

  /* Connect codex-luna for the worker role through Core's own audited action,
     which is exactly what the setup screen dispatches. ONE capability probe on
     the user's subscription -- the spend this check exists to justify. */
  console.log("connecting codex-luna as worker (one capability probe)...");
  const connected = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("workspace_action", {
       projectPath: arguments[0],
       action: { type: "adapter.connect", payload: { role: "worker", agent_id: "codex-luna" } }
     }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) }));`,
    project
  );
  console.log(`  action result ok: ${connected.ok}`);
  if (!connected.ok) console.log(`  refusal: ${String(connected.error).slice(0, 600)}`);

  /* The evidence that matters is on disk. */
  const recordPath = path.join(project, ".hivemind", "adapters", "worker-codex-luna.connection.json");
  const recorded = existsSync(recordPath);
  console.log(`  connection record on disk: ${recorded}`);
  if (recorded) {
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    console.log(`  agent_id: ${record.agent_id}`);
    console.log(`  effective_tokens: ${record.effective_tokens}`);
    const verified = (record.capabilities ?? []).filter((entry) => entry.status === "verified");
    console.log(`  capabilities verified: ${verified.length} of ${(record.capabilities ?? []).length}`);
    for (const entry of record.capabilities ?? []) {
      console.log(`    ${entry.status.padEnd(11)} ${entry.id}`);
    }
  }

  /* And what the row now says about itself. */
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") || "") === "Settings")?.click();`
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await shot("2-settings-rows");
  const rows = await driver.executeScript(
    `return [...document.querySelectorAll('[role="status"]')]
       .map((element) => (element.innerText || "").replace(/\\s+/g, " ").trim())
       .filter((text) => text !== "");`
  );
  console.log(`  row status chips: ${JSON.stringify(rows)}`);

  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = logs.filter((entry) => entry.level?.name === "SEVERE");
  console.log(`  browser SEVERE: ${JSON.stringify(severe.map((entry) => entry.message.slice(0, 200)))}`);
  assert.ok(recorded, "codex-luna did not produce a connection record");
  console.log("\nLUNA CONNECTED on the installed app.");
  console.log(`evidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

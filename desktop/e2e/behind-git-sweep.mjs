/**
 * The half of first run nobody has walked: past git, into connect.
 *
 * A real repo that passes the git gate and then fails later -- a provider that
 * is refused by name, a provider whose CLI is not installed, a check command
 * that does not exist. This is where a new person ends up after doing
 * everything right.
 *
 * Reports; fixes nothing.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-behind-git");
let tauriDriver;
let driver;

const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
  console.log(`  screenshot: ${name}.png`);
}
async function controls() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button")]
       .filter((e) => e.offsetParent !== null)
       .map((e) => ({
         label: (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 58),
         disabled: e.disabled === true,
         title: (e.getAttribute("title") || "").slice(0, 80)
       }))
       .filter((e) => e.label !== "");`
  );
}
async function click(label) {
  return driver.executeScript(
    `const wanted = arguments[0];
     const b = [...document.querySelectorAll("button")].find(
       (e) => e.offsetParent !== null &&
         ((e.innerText || "").replace(/\\s+/g, " ").trim() === wanted ||
          (e.getAttribute("aria-label") || "").trim() === wanted));
     if (!b) return false;
     b.click();
     return true;`,
    label
  );
}

/** A real repo with source, a git history, and a check command that is a lie. */
async function repoThatPassesGit() {
  const dir = path.join(os.tmpdir(), "behind-git-project");
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    '{\n  "name": "behind-git",\n  "type": "module",\n  "scripts": { "test": "this-command-does-not-exist --run" }\n}\n',
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
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });
  const project = await repoThatPassesGit();
  console.log(`project: ${project}\n  (a real repo whose test script names a command that does not exist)`);

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
  await new Promise((resolve) => setTimeout(resolve, 7000));

  /* ── past the git gate ── */
  console.log("\n=== 1. a repo that passes git");
  console.log((await body()).slice(0, 400));
  await shot("1-passes-git");

  console.log("\n=== 2. set the folder up");
  await click("Set it up");
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const afterSetup = await body();
  console.log(afterSetup.slice(0, 1400));
  await shot("2-after-setup");

  /* ── the check command that does not exist ── */
  console.log("\n=== 3. the detected check command names a program that is not installed");
  const config = JSON.parse(
    await readFile(path.join(project, ".hivemind", "config.json"), "utf8")
  );
  console.log(`  recorded test_command: ${JSON.stringify(config.test_command)}`);
  console.log(`  no_tests_declared: ${JSON.stringify(config.no_tests_declared ?? null)}`);

  /* ── the provider list: what is offered, refused, and pressable ── */
  console.log("\n=== 4. the provider step");
  const providerControls = await controls();
  console.log(JSON.stringify(providerControls, null, 1).slice(0, 2600));
  await shot("3-providers");

  /* ── a provider that is refused by name ── */
  console.log("\n=== 5. pressing a provider whose model is prohibited");
  for (const label of ["Use OpenCode", "Use Kimi Code"]) {
    if (await click(label)) {
      console.log(`  clicked ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const after = await body();
      const line = after.split("\n").find((entry) => /refus|prohibit|cannot|not check|unverified/iu.test(entry));
      console.log(`    -> ${line ?? "(nothing said)"}`);
      await shot(`4-${label.replace(/\s+/gu, "-").toLowerCase()}`);
    } else {
      console.log(`  ${label}: no such control on screen`);
    }
  }

  console.log(`\nevidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

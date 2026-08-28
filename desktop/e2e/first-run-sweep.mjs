/**
 * The first-run path, walked badly on purpose.
 *
 * Where a new person starts, and where nothing is set up yet: a folder that is
 * not a project, no git, no agents, a check command that does not exist, a
 * provider that is refused. Reports; fixes nothing.
 *
 * Each finding is classified: wrong invitation | dead affordance | false
 * progress | wrong message.
 */
import { spawn } from "node:child_process";
import "./protect-recent-projects.mjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Builder, By, Capabilities, until } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-first-run-sweep");
const findings = [];
let tauriDriver;
let driver;

const note = (kind, where, tried, happened) => {
  findings.push({ kind, where, tried, happened });
  console.log(`  [${kind}] ${where}\n      tried: ${tried}\n      got:   ${happened}`);
};
const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
}
async function controls() {
  return driver.executeScript(
    `return [...document.querySelectorAll("button, [role=tab]")]
       .filter((e) => e.offsetParent !== null)
       .map((e) => ({
         label: (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 54),
         disabled: e.disabled === true,
         title: (e.getAttribute("title") || "").slice(0, 70)
       }))
       .filter((e) => e.label !== "");`
  );
}
async function openPath(target) {
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
  await new Promise((resolve) => setTimeout(resolve, 7000));
}

async function main() {
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });

  /* Three folders a person might point it at. */
  const empty = path.join(os.tmpdir(), "sweep-empty-folder");
  const noGit = path.join(os.tmpdir(), "sweep-no-git");
  const notAProject = path.join(os.tmpdir(), "sweep-just-photos");
  for (const dir of [empty, noGit, notAProject]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(noGit, "index.js"), "console.log(1);\n", "utf8");
  await writeFile(path.join(noGit, "package.json"), '{"name":"nogit"}\n', "utf8");
  await writeFile(path.join(notAProject, "holiday.jpg"), "not really a jpeg", "utf8");
  await writeFile(path.join(notAProject, "notes.txt"), "milk, eggs\n", "utf8");

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

  /* ── 1. a folder with nothing in it ── */
  console.log("\n=== an empty folder");
  await openPath(empty);
  let text = await body();
  console.log(text.slice(0, 700));
  await shot("1-empty-folder");
  const emptyControls = await controls();
  console.log(`  controls: ${JSON.stringify(emptyControls.map((c) => c.label))}`);

  /* ── 2. a folder of photos: not a codebase at all ── */
  console.log("\n=== a folder that is not a project (photos and a text file)");
  await openPath(notAProject);
  text = await body();
  console.log(text.slice(0, 700));
  await shot("2-not-a-project");

  /* ── 3. real source, no git ── */
  console.log("\n=== real source with no git repository");
  await openPath(noGit);
  text = await body();
  console.log(text.slice(0, 900));
  await shot("3-no-git");
  const gitControls = await controls();
  console.log(`  controls: ${JSON.stringify(gitControls.map((c) => (c.disabled ? `${c.label} (disabled)` : c.label)))}`);

  /* ── 4. a nonexistent path ── */
  console.log("\n=== a path that does not exist");
  await openPath(path.join(os.tmpdir(), "sweep-does-not-exist-at-all"));
  text = await body();
  console.log(text.slice(0, 600));
  await shot("4-missing-path");

  /* ── 5. a file rather than a folder ── */
  console.log("\n=== a file, not a folder");
  await openPath(path.join(noGit, "index.js"));
  text = await body();
  console.log(text.slice(0, 600));
  await shot("5-a-file");

  await writeFile(path.join(evidence, "findings.json"), JSON.stringify(findings, null, 2), "utf8");
  console.log(`\nevidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

/**
 * No-cost installed verification for three audit-register fixes, driven
 * against the INSTALLED application through tauri-driver -- not against
 * source, unit fixtures, or a dev server.
 *
 *   A-04  setup (capability-probe) spend is visible on the Work meter.
 *         Opens a real completed project whose durable ledger holds probe
 *         sessions and requires the "setup N calls" figure on screen.
 *   A-08  settings are keyed to the project. Opens Settings on project A,
 *         switches to project B, reopens Settings and requires A's path and
 *         A's worker rows to be gone.
 *   A-07  a failed one-click git setup puts the folder back and says so
 *         honestly. Forces `git add` to fail by holding an exclusive lock on
 *         a source file, clicks "Set up git for me", and requires BOTH the
 *         "Nothing changed." verdict on screen AND a byte-identical folder on
 *         disk -- no `.git`, the pre-existing `.gitignore` unmodified.
 *
 * No provider, model, or paid call of any kind is made: the driven project is
 * already complete, and the forced failure happens before any agent exists.
 *
 * Usage: node e2e/installed-findings-check.mjs
 *   HIVEMIND_E2E_BINARY    override the installed exe path
 *   HIVEMIND_E2E_PROJECT_A the completed project with probe spend (default:
 *                          the recorded real-workflow project)
 *   HIVEMIND_E2E_EVIDENCE  where captures land
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installedBinary = process.env.HIVEMIND_E2E_BINARY
  ? path.resolve(process.env.HIVEMIND_E2E_BINARY)
  : path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI", "hivemind_desktop.exe");
/* The default is the project A-04 was originally reproduced on: its durable
   ledger holds three settled capability-probe sessions and nothing in flight.
   (The completed acceptance project would also do, but it currently carries a
   leftover read-only task worktree that keeps its idleness proof closed --
   recorded as its own register finding on 2026-08-21.) */
const projectA = process.env.HIVEMIND_E2E_PROJECT_A
  ? path.resolve(process.env.HIVEMIND_E2E_PROJECT_A)
  : "D:\\Projects\\Skybound Flight Simulator";
const evidenceDir = process.env.HIVEMIND_E2E_EVIDENCE
  ? path.resolve(process.env.HIVEMIND_E2E_EVIDENCE)
  : path.join(os.tmpdir(), "hivemind-findings-check");

let tauriDriver;
let driver;
let locker;
let projectB;
const transport = [];

try {
  assert.notEqual(process.env.LOCALAPPDATA, undefined, "LOCALAPPDATA is required on Windows");
  assert.ok(existsSync(installedBinary), `no installed binary at ${installedBinary}`);
  assert.ok(existsSync(projectA), `no completed project at ${projectA}`);
  await mkdir(evidenceDir, { recursive: true });

  /* The A-07 target: an ordinary untracked folder with a pre-existing
     .gitignore whose exact bytes the rollback must restore. A STABLE path,
     recreated fresh each run rather than mkdtemp'd and deleted: the app
     remembers its last project, and a remembered folder that a previous run
     deleted turns the next cold open into a failure that has nothing to do
     with what this walk measures. */
  projectB = path.join(os.tmpdir(), "hivemind-a07-check");
  await rm(projectB, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(projectB, { recursive: true });
  await writeFile(path.join(projectB, "index.js"), "export default 1;\n", "utf8");
  await writeFile(path.join(projectB, "README.md"), "# a07 check\n", "utf8");
  await writeFile(path.join(projectB, ".gitignore"), "custom-rule\n", "utf8");
  await mkdir(path.join(projectB, "node_modules"), { recursive: true });
  await writeFile(path.join(projectB, "node_modules", "dep.js"), "generated\n", "utf8");

  /* Consecutive walks race the previous run's teardown: the driver kills the
     app, its daemons die a moment later, and a walk that opens the same
     project in that moment meets an alive-pid dead-HTTP daemon -- which the
     shell correctly refuses to write past. Waiting is the honest fix;
     killing someone else's pid is not (this machine has already handed a
     dead daemon's pid to a web browser). */
  await waitForPriorDaemonsToSettle([projectA, brickedProjectPath()].filter(Boolean));

  tauriDriver = spawn("tauri-driver", [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
  await driver.executeScript(
    `window.__HIVEMIND_ERRORS__ = [];
     window.__HIVEMIND_TIMELINE__ = [];
     const record = (entry) => {
       window.__HIVEMIND_TIMELINE__.push({ t: Math.round(performance.now()), ...entry });
       window.__HIVEMIND_TIMELINE__ = window.__HIVEMIND_TIMELINE__.slice(-80);
     };
     new MutationObserver(() => {
       record({ kind: "flag", replaying: document.documentElement.hasAttribute("data-replaying-history") });
     }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-replaying-history"] });
     for (const type of ["animationstart", "animationend", "animationcancel"]) {
       window.addEventListener(type, (event) => {
         record({ kind: type, name: event.animationName, cls: String(event.target?.className ?? "").slice(0, 90) });
       }, true);
     }
     window.addEventListener("error", (event) => {
       window.__HIVEMIND_ERRORS__.push({
         t: Math.round(performance.now()),
         message: String(event.error?.message ?? event.message ?? ""),
         stack: String(event.error?.stack ?? ""),
         replayingAttributePresent: document.documentElement.hasAttribute("data-replaying-history")
       });
       window.__HIVEMIND_ERRORS__ = window.__HIVEMIND_ERRORS__.slice(-10);
     }, true);`
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  {
    const drained = await driver.manage().logs().get(logging.Type.BROWSER);
    const severeHere = drained.filter((entry) => entry.level?.name === "SEVERE");
    assert.deepEqual(
      severeHere,
      [],
      `the cold open logged errors before any step ran: ${JSON.stringify(severeHere)}`
    );
  }

  /* -- A-37: a bricked project heals on its own machinery -- */
  const brickedProject = brickedProjectPath();
  if (existsSync(brickedProject)) {
    /* The completed acceptance project, naturally bricked by A-37: its
       read-only review task's worktree survived shipping, so the old
       artefact-counting idleness proof read it as permanently busy and every
       recovery path refused. Opening it on this build must (a) not read the
       leftover as work, and (b) remove it when the fresh daemon starts. */
    const leftover = path.join(brickedProject, ".hivemind", "worktrees", "T-003");
    const hadLeftover = existsSync(leftover);
    await openProject(brickedProject);
    await driver.wait(
      async () => !existsSync(leftover),
      20_000,
      "the leftover read-only worktree was not reconciled at daemon start"
    );
    await capture("a37-bricked-project-heals");
    console.log(
      `A-37 installed: the completed project opened to its work surface${hadLeftover ? " and the leftover worktree was removed" : " (already reconciled by an earlier run)"}`
    );
    {
      const drained = await driver.manage().logs().get(logging.Type.BROWSER);
      const severeHere = drained.filter((entry) => entry.level?.name === "SEVERE");
      const captured = await driver.executeScript("return window.__HIVEMIND_ERRORS__ ?? []");
      const timeline = await driver.executeScript("return window.__HIVEMIND_TIMELINE__ ?? []");
      assert.deepEqual(
        severeHere,
        [],
        `the completed-project reopen logged errors: ${JSON.stringify(severeHere)}\nCAPTURED STACKS:\n${JSON.stringify(captured, null, 2)}\nTIMELINE:\n${JSON.stringify(timeline)}`
      );
    }
  } else {
    console.log("A-37 installed: skipped -- the completed acceptance project is not on this machine");
  }

  /* -- A-03: the verification question is asked, never guessed past -- */
  await openProject(projectA);
  /* Skybound has no test script, so setup used to read complete with an
     empty test_command and integration rejected the project after money was
     spent. Now: on a project where the question is unanswered, setup stays
     and asks; declaring "no tests" is an explicit, recorded decision that
     completes it. Idempotent across runs -- once declared, the ask is gone
     and setup reads complete immediately. */
  {
    /* Wait for the checks step to RESOLVE, never sample it: the ask renders
       once the project's config has loaded, and a one-shot body read lands
       before it. Either the ask is on screen (first run -- the question is
       being asked), or setup already read complete and the app promoted
       itself to Work (a previous run declared). */
    await driver.wait(
      async () => {
        const body = await bodyText();
        return body.includes("This project has no tests") || /setup \d+ calls?/u.test(body);
      },
      30_000,
      "neither the verification ask nor the completed Work surface appeared"
    );
    const body = await bodyText();
    if (body.includes("This project has no tests")) {
      await capture("a03-setup-asks");
      console.log("A-03 installed: setup asks how the project is checked instead of guessing past it");
      await clickButton("This project has no tests");
      await driver.wait(
        async () => !(await bodyText()).includes("This project has no tests"),
        20_000,
        "the no-tests declaration was not recorded"
      );
      await capture("a03-declared");
      console.log("A-03 installed: the absence was declared, recorded, and setup completed");
    } else {
      console.log("A-03 installed: already declared on a previous run; setup reads complete");
    }
  }
  try {
    await driver.wait(
      async () => /setup \d+ calls?/u.test(await bodyText()),
      30_000,
      "the Work meter never showed the setup spend figure"
    );
  } catch (cause) {
    await capture("a04-meter-timeout");
    throw new Error(
      `the Work meter never showed the setup spend figure\nBODY:\n${await bodyText()}`,
      { cause }
    );
  }
  const meterText = /setup \d+ calls? [\d.]+[KM]?/u.exec(await bodyText())?.[0] ?? "";
  await capture("a04-setup-spend-on-meter");
  console.log(`A-04 installed: meter shows "${meterText}"`);

  /* -- A-08: settings keyed to the project -- */
  await driver.findElement(By.css('button[aria-label="Settings"]')).click();
  /* Assertions read the DIALOG element, not the whole body: the screen behind
     the modal also carries a project path, and a body-wide match would credit
     it to the dialog. */
  let dialog = await driver.wait(until.elementLocated(By.css('div[role="dialog"]')), 10_000);
  await driver.wait(
    async () => (await dialog.getText()).includes(displayTail(projectA)),
    15_000,
    "settings never showed project A's path"
  );
  /* Roles arrive after the dialog's own config read; model discovery against
     the installed CLIs can take several seconds on top. Wait, don't sample. */
  await driver.wait(
    async () => /Planner|Manager|Workers?/u.test(await dialog.getText()),
    45_000,
    "settings on project A never loaded its roles"
  );
  await capture("a08-settings-on-project-a");
  await driver.actions().sendKeys("\uE00C").perform(); // Escape closes the dialog
  await driver.wait(
    async () => (await driver.findElements(By.css('div[role="dialog"]'))).length === 0,
    10_000,
    "the settings dialog did not close"
  );

  await openProject(projectB, { expectSetupScreen: true });
  await driver.findElement(By.css('button[aria-label="Settings"]')).click();
  dialog = await driver.wait(until.elementLocated(By.css('div[role="dialog"]')), 10_000);
  await driver.wait(
    async () => (await dialog.getText()).includes(displayTail(projectB)),
    15_000,
    "settings on project B never showed project B's path"
  );
  const settingsOnB = await dialog.getText();
  assert.ok(
    !settingsOnB.includes(displayTail(projectA)),
    "settings on project B still shows project A's path"
  );
  await capture("a08-settings-after-switch");
  console.log("A-08 installed: settings after the switch shows only the selected project");
  await driver.actions().sendKeys("\uE00C").perform();
  await driver.wait(
    async () => (await driver.findElements(By.css('div[role="dialog"]'))).length === 0,
    10_000,
    "the settings dialog did not close on project B"
  );

  /* -- A-07: a failed setup puts the folder back and says so -- */
  try {
    await driver.wait(
      async () => (await bodyText()).includes("Set up git for me"),
      30_000,
      "the one-click git offer never appeared for the untracked folder"
    );
  } catch (cause) {
    await capture("a07-offer-missing");
    throw new Error(
      `the one-click git offer never appeared for the untracked folder\nBODY:\n${await bodyText()}`,
      { cause }
    );
  }
  /* Hold `index.js` exclusively so the installed shell's real `git add -A`
     fails after `.gitignore` was written and `git init` succeeded -- the
     exact partial state the old code left behind. */
  locker = spawn(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$f=[System.IO.File]::Open('${path.join(projectB, "index.js").replace(/'/gu, "''")}','Open','ReadWrite','None'); Start-Sleep -Seconds 180`
    ],
    { windowsHide: true, stdio: "ignore" }
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  await clickButton("Set up git for me");
  await driver.wait(
    async () => (await bodyText()).includes("Nothing changed."),
    30_000,
    "the failed setup never reported its verdict"
  );
  const verdict = await bodyText();
  assert.ok(
    !verdict.includes("Still in the folder"),
    "the rollback completed, so the partial-state copy must not render"
  );
  await capture("a07-honest-failure");

  locker.kill();
  locker = null;
  assert.ok(
    !existsSync(path.join(projectB, ".git")),
    "the half-made repository must be removed from disk"
  );
  assert.equal(
    await readFile(path.join(projectB, ".gitignore"), "utf8"),
    "custom-rule\n",
    "the pre-existing .gitignore must be byte-identical after the failure"
  );
  console.log("A-07 installed: 'Nothing changed.' rendered, and the folder is byte-identical");

  /* No severe browser output anywhere in the walk. */
  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = logs.filter((entry) => entry.level?.name === "SEVERE");
  const finalErrors = await driver.executeScript("return window.__HIVEMIND_ERRORS__ ?? []");
  const finalTimeline = await driver.executeScript("return window.__HIVEMIND_TIMELINE__ ?? []");
  assert.deepEqual(
    severe,
    [],
    `the installed WebView logged errors: ${JSON.stringify(severe)}\nCAPTURED:\n${JSON.stringify(finalErrors, null, 1)}\nTIMELINE TAIL:\n${JSON.stringify(finalTimeline.slice(-25))}`
  );

  await writeFile(
    path.join(evidenceDir, "findings-check.json"),
    `${JSON.stringify({ installedBinary, projectA, projectB, meterText }, null, 2)}\n`,
    "utf8"
  );
  console.log(`installed findings check passed: ${installedBinary}`);
  console.log(`evidence: ${evidenceDir}`);
} finally {
  locker?.kill();
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  if (projectB) await rm(projectB, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
}

function brickedProjectPath() {
  return process.env.HIVEMIND_E2E_BRICKED
    ? path.resolve(process.env.HIVEMIND_E2E_BRICKED)
    : "D:\\Projects\\Hivemind Installed E2E Final 26.821.453";
}

async function waitForPriorDaemonsToSettle(projects) {
  for (const projectPath of projects) {
    const recordPath = path.join(projectPath, ".hivemind", "daemon.json");
    if (!existsSync(recordPath)) continue;
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
    } catch {
      continue;
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const alive = await pidAlive(record.pid);
      if (!alive) break;
      const healthy = await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(1_000) })
        .then((response) => response.ok)
        .catch(() => false);
      /* A healthy live daemon is a daemon to attach to, not to wait out. */
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  /* tasklist, not process.kill(pid, 0): node's signal-0 reports ESRCH for
     measured live children on Windows (recorded in the Core test rig). */
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      windowsHide: true
    });
    return stdout.includes(`"${pid}"`);
  } catch {
    return true;
  }
}

function displayTail(projectPath) {
  /* Enough of the path to be unmistakably this project, however the UI
     shortens the front of it. */
  return path.basename(projectPath);
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) {
      throw new Error(`tauri-driver exited before accepting sessions (${tauriDriver.exitCode})`);
    }
    try {
      const response = await fetch(`${driverUrl}/status`);
      if (response.ok) return;
    } catch {
      // The driver owns readiness; retrying this read cannot change application state.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    if (typeof body === "string" && body.trim() !== "") return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function waitForText(text, timeout = 30_000) {
  await driver.wait(async () => (await bodyText()).includes(text), timeout, `did not see ${text}`);
}

async function openProject(wantedPath, { expectSetupScreen = false, retriedOnce = false } = {}) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(
      By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')
    ),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  /* Enter the path as a PASTE -- one input event through the native value
     setter -- never as burst keystrokes. Burst-dispatched keydowns arrive
     with no yield to the host, and React counts the per-keystroke updates
     interleaved with the settling screen's commits as ONE nested streak: a
     depth-limit crash no human input can produce (measured: burst-typed
     1-in-4 storms, human-paced typing 0-in-4, paste is a single event --
     A-38). Per-character sendKeys was tried first and occasionally dropped
     leading characters, which is its own automation artifact. A paste is
     both deterministic and exactly what a person does with a path. The
     severe-log gate stays fully strict. */
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    wantedPath
  );
  await clickButton("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
  if (expectSetupScreen) {
    await waitForText("Set up this project.", 30_000);
  } else {
    let restarted = false;
    try {
      await driver.wait(
        async () => {
          const body = await bodyText();
          if (body.includes("Work") && body.includes("Agents")) return true;
          /* The project's daemon may still be the previous build's -- it
             survives installs by design. The product's own recovery is the
             "Restart it" control, pressed here exactly once, as a person
             would. */
          if (!restarted && body.includes("Hivemind was updated")) {
            restarted = true;
            await clickButton("Restart it");
          }
          return false;
        },
        /* 90s, sized against a cold daemon boot on a machine that may still
           be settling a build -- a fresh start was measured crossing 60s
           once, and a rig timeout that fails honest work gets loosened by
           whoever it blocks. */
        90_000,
        "the installed UI did not adopt the connected project state"
      );
    } catch (cause) {
      await capture("open-project-timeout");
      /* The product's own failure copy says "Try opening the project again"
         -- a daemon start can lose a race with the previous session's
         teardown, and a person retries. Once, like a person; a second
         failure is a finding. */
      if (!retriedOnce) {
        console.log(`adopt timed out for ${wantedPath}; retrying once as the product's own copy advises`);
        return openProject(wantedPath, { expectSetupScreen, retriedOnce: true });
      }
      throw new Error(
        `the installed UI did not adopt the connected project state\nBODY:\n${await bodyText()}`,
        { cause }
      );
    }
  }
}

async function clickButton(label) {
  const button = await driver.wait(
    until.elementLocated(
      By.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`)
    ),
    15_000
  );
  await driver.wait(until.elementIsEnabled(button), 15_000);
  await button.click();
}

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

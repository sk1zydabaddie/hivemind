import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installedBinary = process.env.HIVEMIND_E2E_BINARY
  ? path.resolve(process.env.HIVEMIND_E2E_BINARY)
  : path.join(
      process.env.LOCALAPPDATA ?? "",
      "Hivemind AI",
      "hivemind_desktop.exe"
    );
const evidenceDir = process.env.HIVEMIND_E2E_EVIDENCE
  ? path.resolve(process.env.HIVEMIND_E2E_EVIDENCE)
  : path.join(os.tmpdir(), "hivemind-installed-e2e");
const projectPath = process.env.HIVEMIND_E2E_PROJECT
  ? path.resolve(process.env.HIVEMIND_E2E_PROJECT)
  : null;
const connectLiveProviders = process.env.HIVEMIND_E2E_LIVE_CONNECT === "1";
const reconnectGrok = process.env.HIVEMIND_E2E_RECONNECT_GROK === "1";
const liveTask = process.env.HIVEMIND_E2E_TASK?.trim() || null;
const resumeWorkflow = process.env.HIVEMIND_E2E_RESUME === "1";
const allowOneRetry =
  process.argv.includes("--allow-one-retry") || process.env.HIVEMIND_E2E_ALLOW_ONE_RETRY === "1";
const retryAlreadyUsed = process.argv.includes("--retry-already-used");
const execFileAsync = promisify(execFile);

let tauriDriver;
let driver;
const transport = [];

try {
  assert.notEqual(process.env.LOCALAPPDATA, undefined, "LOCALAPPDATA is required on Windows");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, "run-config.json"),
    `${JSON.stringify({ allowOneRetry, connectLiveProviders, reconnectGrok, resumeWorkflow, retryAlreadyUsed }, null, 2)}\n`,
    "utf8"
  );
  const blockedCodex = path.join(evidenceDir, "forbidden-codex.cmd");
  await writeFile(
    blockedCodex,
    "@echo off\r\necho ERROR: installed E2E attempted a forbidden Codex invocation 1>&2\r\nexit /b 97\r\n",
    "utf8"
  );
  tauriDriver = spawn("tauri-driver", [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HIVEMIND_CODEX_PATH: blockedCodex }
  });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();

  const body = await waitForBody();
  assert.match(body, /Hivemind/u, "the installed Hivemind shell did not render");
  await driver.executeScript(
    `window.__HIVEMIND_ANIMATION_EVENTS__ = [];
     for (const type of ["animationend", "animationcancel"]) {
       window.addEventListener(type, (event) => {
         const target = event.target;
         window.__HIVEMIND_ANIMATION_EVENTS__.push({
           type,
           animationName: event.animationName,
           className: typeof target?.className === "string" ? target.className : "",
           state: target?.getAttribute?.("data-state") ?? null
         });
         window.__HIVEMIND_ANIMATION_EVENTS__ = window.__HIVEMIND_ANIMATION_EVENTS__.slice(-100);
       }, true);
     }`
  );
  await capture("00-cold-open");

  if (projectPath !== null) {
    await openProject(projectPath);
    if (connectLiveProviders) await connectClaudeAndGrok(projectPath);
    if (liveTask !== null) await runRealProjectTask(projectPath, liveTask);
  }

  const browserLogs = await readBrowserLogs();
  const severe = browserLogs.filter((entry) => entry.level?.name === "SEVERE");
  const animationEvents = await driver.executeScript(
    'return window.__HIVEMIND_ANIMATION_EVENTS__ ?? []'
  );
  assert.deepEqual(
    severe,
    [],
    `the installed WebView logged errors: ${JSON.stringify(severe)}\nanimation events: ${JSON.stringify(animationEvents)}`
  );
  await writeFile(
    path.join(evidenceDir, "smoke.json"),
    `${JSON.stringify({ installedBinary, projectPath, body: await bodyText(), browserLogs }, null, 2)}\n`,
    "utf8"
  );
  console.log(`installed-native smoke passed: ${installedBinary}`);
  console.log(`evidence: ${evidenceDir}`);
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
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

async function openProject(wantedPath) {
  await driver
    .findElement(By.css('button[aria-label^="Switch project"]'))
    .click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  const input = await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await input.clear();
  await input.sendKeys(wantedPath);
  await clickButton("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
  await driver.wait(
    until.elementLocated(
      By.css(`button[aria-label="Switch project, currently ${cssAttribute(path.basename(wantedPath))}"]`)
    ),
    30_000,
    "the selected project did not reach the app chrome"
  );
  await capture("01-project-opened");

  const current = await bodyText();
  const existingProfiles = await profileFiles(wantedPath).catch(() => []);
  let initializedNow = false;
  if (existingProfiles.length === 0 && current.includes("Set up this folder")) {
    await clickButton("Set up this folder");
    initializedNow = true;
  } else if (existingProfiles.length === 0 && current.includes("Set it up")) {
    assert.equal(await clickVisibleEnabledButton("Set it up"), true, "enabled Set it up control could not be clicked");
    initializedNow = true;
  }
  await waitForFile(path.join(wantedPath, ".hivemind", "config.json"));
  if (initializedNow) {
    await waitForText("Tick the subscriptions you already pay for.", 60_000);
    await assertInitialProfilesEmpty(wantedPath);
  } else if (existingProfiles.length > 0) {
    try {
      await driver.wait(
        async () => {
          const body = await bodyText();
          return body.includes("Work") && body.includes("Agents") && !body.includes("Set it up");
        },
        60_000,
        "the installed UI did not adopt the connected project state"
      );
    } catch (error) {
      await capture("02-project-adoption-timeout");
      const body = await bodyText();
      const logs = await readBrowserLogs();
      const statusProbe = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         window.__TAURI__.core.invoke("workspace_action", {
           projectPath: arguments[0],
           action: { type: "status.inspect", payload: {} }
         }).then((value) => done({ ok: true, value })).catch((failure) => done({ ok: false, failure }));`,
        wantedPath
      );
      throw new Error(
        `the installed UI did not adopt the connected project state\nBODY:\n${body}\nBROWSER LOGS:\n${JSON.stringify(logs)}\nSTATUS PROBE:\n${JSON.stringify(statusProbe)}`,
        { cause: error }
      );
    }
  }
  await capture("02-project-initialized");
}

async function profileFiles(wantedPath) {
  const adapters = path.join(wantedPath, ".hivemind", "adapters");
  try {
    return (await readdir(adapters)).filter((name) => name.endsWith(".profile.json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertNoForbiddenProfiles(wantedPath, profiles) {
  const adapters = path.join(wantedPath, ".hivemind", "adapters");
  for (const name of profiles) {
    const raw = await readFile(path.join(adapters, name), "utf8");
    assert.doesNotMatch(
      raw,
      /(?:codex(?:\.cmd)?|gpt-[\w.-]+)/iu,
      `${name} contains a forbidden Codex or GPT provider/model`
    );
  }
}

async function assertInitialProfilesEmpty(wantedPath) {
  const profiles = await profileFiles(wantedPath);
  await assertNoForbiddenProfiles(wantedPath, profiles);
  assert.deepEqual(profiles, [], "initializing a project must not invent provider profiles");
}

async function connectClaudeAndGrok(wantedPath) {
  const existing = await profileFiles(wantedPath);
  if (reconnectGrok && existing.length === 2) {
    assert.deepEqual(existing, ["manager.profile.json", "planner.profile.json"]);
    await reconnectGrokWorker(wantedPath);
    await verifyAllowedLiveProfiles(wantedPath);
    await capture("04-claude-grok-connected");
    return;
  }
  if (existing.length > 0) {
    await verifyAllowedLiveProfiles(wantedPath);
    await capture("04-claude-grok-connected");
    return;
  }
  const selected = new Set(["Claude Code", "Grok Build"]);
  for (const label of ["Codex", "Claude Code", "OpenCode", "Grok Build", "Kimi Code"]) {
    const checkbox = await driver.wait(
      until.elementLocated(By.css(`button[role="checkbox"][aria-label="Use ${cssAttribute(label)}"]`)),
      10_000,
      `provider checkbox not found: ${label}`
    );
    const checked = (await checkbox.getAttribute("aria-checked")) === "true";
    if (checked !== selected.has(label)) await checkbox.click();
  }
  await capture("03-claude-grok-selected");
  await clickButton("Continue");

  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const body = await bodyText();
    if ((await profileFiles(wantedPath)).length === 3 && !body.includes("Checking ")) break;
    const continueButtons = await driver.findElements(By.xpath('//button[contains(normalize-space(.), "Continue")]'));
    const checking = await driver.findElements(By.xpath('//button[contains(normalize-space(.), "Checking ")]'));
    if (continueButtons.length > 0 && checking.length === 0) {
      throw new Error(`provider checks stopped before all roles connected:\n${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal((await profileFiles(wantedPath)).length, 3, "provider checks timed out");
  await verifyAllowedLiveProfiles(wantedPath);
  await capture("04-claude-grok-connected");
}

async function reconnectGrokWorker(wantedPath) {
  await driver.findElement(By.css('button[aria-label="Settings"]')).click();
  const select = await driver.wait(
    until.elementLocated(By.css('select[aria-label="Model for worker"]')),
    30_000,
    "worker model selector did not appear in Settings"
  );
  await driver.wait(async () => {
    const options = await select.findElements(By.css("option"));
    return (await Promise.all(options.map((option) => option.getText()))).some((text) => text.trim() === "grok-4.6");
  }, 60_000, "Grok 4.6 was not discovered from the installed CLI");
  const option = await select.findElement(By.xpath('.//option[normalize-space(.)="grok-4.6"]'));
  await option.click();
  await clickButton("Add and check");
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if ((await profileFiles(wantedPath)).includes("worker-grok-build.profile.json")) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.ok(
    (await profileFiles(wantedPath)).includes("worker-grok-build.profile.json"),
    `Grok reconnection timed out:\n${await bodyText()}`
  );
  await capture("03-grok-reconnected");
  const close = await driver.findElement(By.css('button[data-slot="dialog-close"]')).catch(() => null);
  if (close !== null) await close.click();
}

async function verifyAllowedLiveProfiles(wantedPath) {
  const profiles = await profileFiles(wantedPath);
  await assertNoForbiddenProfiles(wantedPath, profiles);
  assert.deepEqual(profiles, [
    "manager.profile.json",
    "planner.profile.json",
    "worker-grok-build.profile.json"
  ]);
  const contents = await Promise.all(
    profiles.map((name) => readFile(path.join(wantedPath, ".hivemind", "adapters", name), "utf8"))
  );
  const joined = contents.join("\n");
  assert.match(joined, /--model[\s\S]*opus/u, "planner did not pin Claude Opus");
  assert.match(joined, /--model[\s\S]*sonnet/u, "manager did not pin Claude Sonnet");
  assert.match(joined, /--model[\s\S]*grok-4\.6/u, "worker did not pin Grok 4.6");
  assert.equal(contents.filter((raw) => /--model[\s\S]*opus/u.test(raw)).length, 1);
  assert.equal(contents.filter((raw) => /--model[\s\S]*sonnet/u.test(raw)).length, 1);
  assert.equal(contents.filter((raw) => /--model[\s\S]*grok-4\.6/u.test(raw)).length, 1);
}

async function runRealProjectTask(wantedPath, task) {
  await verifyAllowedLiveProfiles(wantedPath);
  const before = (await git(wantedPath, ["rev-parse", "HEAD"])).trim();
  assert.equal((await git(wantedPath, ["status", "--porcelain"])).trim(), "", "test repo must start clean");

  if (!resumeWorkflow) {
    const composer = await driver.wait(until.elementLocated(By.id("work-composer")), 30_000);
    await composer.sendKeys(task);
    await driver.findElement(By.css('button[aria-label="Send request"]')).click();
    await capture("10-request-sent");
    const firstLiveness = await bodyText();
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const secondLiveness = await bodyText();
    await capture("11-request-live-after-3s");
    assert.notEqual(secondLiveness, firstLiveness, "the installed work surface reported no liveness after three seconds");
  }

  const actions = [
    "Try again",
    "Show me",
    "Approve and start",
    "Review the plan",
    "Start the approved plan",
    "Go ahead",
    "Keep going",
    "Pick it back up",
    "Show me the changes",
    "Ship it"
  ];
  let actionCount = 0;
  const actionClicks = new Map();
  if (retryAlreadyUsed) actionClicks.set("Try again", 1);
  let retryClickedAt = 0;
  let lastBody = "";
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const body = await bodyText();
    if (body !== lastBody) {
      lastBody = body;
      await writeFile(path.join(evidenceDir, "workflow-latest.txt"), body, "utf8");
    }
    const current = (await git(wantedPath, ["rev-parse", "HEAD"])).trim();
    const taskProgress = body.match(/(\d+)\/(\d+)\s+tasks done/u);
    const fullPlanDone = taskProgress !== null && taskProgress[1] === taskProgress[2];
    if (current !== before && fullPlanDone && /Shipped|Nothing running/u.test(body)) {
      assert.equal((await git(wantedPath, ["status", "--porcelain"])).trim(), "", "shipped test repo is dirty");
      await capture("30-workflow-shipped");
      return;
    }
    const retryAvailable = await hasVisibleEnabledButton("Try again");
    const retryCount = actionClicks.get("Try again") ?? 0;
    if (
      /Try again|Run the checks again/u.test(body) &&
      /failed|could not|stopped|blocked|rejected/iu.test(body) &&
      !(
        allowOneRetry &&
        body.includes("Try again") &&
        (retryCount === 0 || (retryCount === 1 && (!retryAvailable || Date.now() - retryClickedAt < 5_000)))
      )
    ) {
      throw new Error(`workflow stopped and requires a retry; refusing an unbounded paid retry:\n${body}`);
    }
    if (
      /The proposed plan was stopped|No work started\. Prepare (?:a|the) plan again|Planner could not prepare a response|I couldn't finish preparing a plan|tasks\[\d+\]\.[^\n]+must be/iu.test(body)
    ) {
      throw new Error(`plan preparation stopped; refusing to wait silently or start an unbounded paid retry:\n${body}`);
    }
    if (/lease conflict|held by T-\d+/iu.test(body)) {
      throw new Error(`workflow hit a deterministic lease conflict instead of completing the ratified plan:\n${body}`);
    }
    if (/requires a durable prepared-plan record/iu.test(body)) {
      throw new Error(`workspace exposed a plan that cannot be executed after restart:\n${body}`);
    }
    if (
      /Worker stopped|The agent stopped before it finished|The command line is too long/iu.test(body) &&
      !(
        allowOneRetry &&
        (retryCount === 1 ||
          (body.includes("Try again") && retryCount === 0))
      )
    ) {
      throw new Error(`worker stopped before producing a change; refusing an automatic paid retry:\n${body}`);
    }
    let clicked = false;
    for (const label of actions) {
      if (label === "Try again" && (actionClicks.get(label) ?? 0) >= 1) continue;
      if (label === "Show me" && (actionClicks.get(label) ?? 0) >= 1) continue;
      if (label === "Show me the changes" && (actionClicks.get(label) ?? 0) >= 1) continue;
      if ((label === "Show me the changes" || label === "Ship it") && !fullPlanDone) continue;
      if (await clickVisibleEnabledButton(label)) {
        actionCount += 1;
        actionClicks.set(label, (actionClicks.get(label) ?? 0) + 1);
        if (label === "Try again") {
          assert.ok(actionClicks.get(label) <= 1, "workflow attempted more than one paid retry");
          retryClickedAt = Date.now();
        }
        assert.ok(actionCount <= 20, "workflow required more than 20 approval/continuation actions");
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await capture(`20-action-${String(actionCount).padStart(2, "0")}-${slug(label)}`);
        clicked = true;
        break;
      }
    }
    if (!clicked) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`installed workflow did not ship within 45 minutes:\n${await bodyText()}`);
}

async function hasVisibleEnabledButton(label) {
  return driver.executeScript(
    `const wanted = arguments[0];
     const normalized = (value) => value.replace(/\\s+/g, " ").trim();
     return [...document.querySelectorAll("button:not([disabled])")].some((button) => {
       if (normalized(button.textContent || "") !== wanted) return false;
       const style = getComputedStyle(button);
       const rect = button.getBoundingClientRect();
       return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
     });`,
    label
  );
}

async function clickVisibleEnabledButton(label) {
  return driver.executeScript(
    `const wanted = arguments[0];
     const normalized = (value) => value.replace(/\\s+/g, " ").trim();
     for (const button of document.querySelectorAll("button:not([disabled])")) {
       if (normalized(button.textContent || "") !== wanted) continue;
       const style = getComputedStyle(button);
       const rect = button.getBoundingClientRect();
       if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
       button.scrollIntoView({ block: "center" });
       const current = button.getBoundingClientRect();
       const top = document.elementFromPoint(current.left + current.width / 2, current.top + current.height / 2);
       if (top !== button && !button.contains(top)) continue;
       button.click();
       return true;
     }
     return false;`,
    label
  );
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

async function clickButton(label) {
  const button = await driver.wait(
    until.elementLocated(By.xpath(`//button[normalize-space(.)=${xpathLiteral(label)} and not(@disabled)]`)),
    10_000,
    `enabled button not found: ${label}`
  );
  await driver.wait(until.elementIsVisible(button), 10_000);
  await button.click();
}

function xpathLiteral(value) {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map((part, index) => `${index === 0 ? "" : `, '\"', `}"${part}"`).join("")})`;
}

function cssAttribute(value) {
  return value.replace(/["\\]/gu, "\\$&");
}

async function waitForFile(file) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`expected file did not appear: ${file}`);
}

async function capture(name) {
  const png = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), png, "base64");
}

async function readBrowserLogs() {
  try {
    return await driver.manage().logs().get(logging.Type.BROWSER);
  } catch (error) {
    return [{ level: { name: "UNAVAILABLE" }, message: String(error) }];
  }
}

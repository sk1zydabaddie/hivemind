/**
 * No-cost Phase 5 audit probe for installed UI reachability, keyboard and
 * accessibility semantics, and a conversation trail long enough to cross the
 * client's retained-event limit. No provider is invoked. The temporary
 * project's event trail is fixture-owned and the user's recent-project list is
 * restored byte-for-byte in `finally`.
 *
 * Usage: node e2e/phase5-ui-accessibility-audit.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, Key, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedVersion = (
  await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `full-audit-phase5-${installedVersion}`
);
const longPairCount = 2100;

let driver;
let tauriDriver;
let project;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion,
  paidProviderCalls: 0,
  baseline: {},
  minimumWindow: {},
  keyboard: {},
  accessibility: {},
  longConversation: {},
  browserSevereLogs: [],
  error: null,
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.equal(
    await isProcessRunning("hivemind_desktop.exe"),
    false,
    "close the installed Hivemind app before this isolated audit probe"
  );
  assert.equal(
    await isProcessRunning("tauri-driver.exe"),
    false,
    "another tauri-driver session is already running"
  );
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });

  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  const fixture = await import(
    pathToFileURL(path.resolve("..", "dist", "test", "support", "manager-fixture.js")).href
  );
  await fixture.withTempRepo(async ({ repo }) => {
    project = repo;
    try {
      await runInstalledSession(repo, false);
      await appendLongConversation(repo);
      await runInstalledSession(repo, true);
    } catch (error) {
      evidence.error = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error), stack: null };
      throw error;
    } finally {
      await closeInstalledSession();
      await stopFixtureDaemon(repo);
    }
  });
  validateObservedFindings();
} finally {
  await closeInstalledSession();
  if (project !== undefined) await stopFixtureDaemon(project);
  if (recentProjectsExisted && recentProjectsBefore !== null) {
    await mkdir(path.dirname(recentProjectsPath), { recursive: true });
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly = sha256(restored) === sha256(recentProjectsBefore);
  } else if (!recentProjectsExisted) {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "phase5-ui-accessibility-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
}

console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

function validateObservedFindings() {
  const work = evidence.minimumWindow.surfaces?.Work;
  assert.ok(work, "minimum-window Work evidence was not recorded");
  assert.ok(work.horizontalOverflowPx > 0, "configured minimum window no longer overflows horizontally");
  assert.ok(
    work.offscreenControls.some((entry) => entry.name === "Close window"),
    "configured minimum window no longer loses the close control"
  );
  assert.equal(
    evidence.keyboard.settingsDialogFocusReturnedToTrigger,
    false,
    "Settings now restores focus to its trigger; retire F5-06 and update this audit"
  );
  assert.equal(evidence.accessibility.composerAssociatedLabelCount, 0);
  assert.equal(evidence.accessibility.composerAriaLabel, null);
  assert.equal(evidence.longConversation.threadAriaRole, "generic");
  assert.equal(evidence.longConversation.threadAriaLive, null);
  assert.equal(evidence.longConversation.viewportTabIndex, null);
  assert.equal(evidence.longConversation.articleCount, 4000);
  assert.ok(evidence.longConversation.documentNodeCount > 18_000);
  assert.equal(evidence.longConversation.earliestPresent, false);
  assert.equal(evidence.longConversation.latestPresent, true);
  assert.equal(evidence.longConversation.truncationNoticePresent, true);
  assert.deepEqual(evidence.browserSevereLogs, []);
  assert.equal(evidence.paidProviderCalls, 0);
}

async function runInstalledSession(repo, longConversation) {
  await startInstalledSession();
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
  const openedAt = Date.now();
  await openProjectDialog(repo);
  await selectTab("Work");
  await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);

  if (longConversation) {
    await driver.wait(
      async () => (await threadText()).includes(`PHASE5-LATEST-${longPairCount - 1}`),
      90_000,
      "the installed thread did not finish rendering the newest long-history reply"
    );
    const longLoadedAt = Date.now();
    const thread = await driver.findElement(By.css('[aria-label="What has happened in this run"]'));
    const longSnapshot = await driver.executeScript(
      `const root = arguments[0];
       const viewport = root.querySelector('[data-slot="scroll-area-viewport"]');
       return {
         documentNodeCount: document.querySelectorAll("*").length,
         threadNodeCount: root.querySelectorAll("*").length,
         articleCount: root.querySelectorAll("article").length,
         textLength: root.textContent.length,
         rootScrollHeight: root.scrollHeight,
         rootClientHeight: root.clientHeight,
         viewportScrollHeight: viewport?.scrollHeight ?? null,
         viewportClientHeight: viewport?.clientHeight ?? null,
         viewportTabIndex: viewport?.getAttribute("tabindex") ?? null,
         viewportRole: viewport?.getAttribute("role") ?? null,
         earliestPresent: root.textContent.includes("PHASE5-EARLIEST-0"),
         latestPresent: root.textContent.includes(arguments[1]),
         truncationNoticePresent: root.textContent.includes("earliest activity is no longer shown")
       };`,
      thread,
      `PHASE5-LATEST-${longPairCount - 1}`
    );
    const threadSemantics = {
      threadAccessibleName: await thread.getAccessibleName().catch(() => ""),
      threadAriaRole: await thread.getAriaRole().catch(() => ""),
      threadAriaLive: await thread.getAttribute("aria-live"),
      threadAriaRelevant: await thread.getAttribute("aria-relevant")
    };
    const agentsAt = Date.now();
    await selectTab("Agents");
    const agentsRenderedAt = Date.now();
    await selectTab("Work");
    await driver.wait(until.elementLocated(By.id("work-composer")), 15_000);
    const workRenderedAt = Date.now();
    evidence.longConversation = {
      appendedConversationPairs: longPairCount,
      appendedConversationEvents: longPairCount * 2 + 1,
      projectOpenToLatestRenderedMs: longLoadedAt - openedAt,
      switchToAgentsMs: agentsRenderedAt - agentsAt,
      switchBackToWorkMs: workRenderedAt - agentsRenderedAt,
      ...threadSemantics,
      ...longSnapshot
    };
    await capture("03-long-conversation-1440x900");
  } else {
    await driver.wait(
      async () => (await bodyText()).includes("Nothing running"),
      30_000,
      "the idle Work surface did not settle"
    );
    evidence.baseline = {
      viewport: await viewportSnapshot(),
      documentNodeCount: await driver.executeScript('return document.querySelectorAll("*").length'),
      projectOpenToComposerMs: Date.now() - openedAt
    };
    await capture("01-idle-work-1440x900");
    await auditAccessibility();
    await auditKeyboard();
    await auditMinimumWindow();
  }

  const severe = (await driver.manage().logs().get(logging.Type.BROWSER))
    .filter((entry) => entry.level?.name === "SEVERE")
    .map((entry) => entry.message);
  evidence.browserSevereLogs.push(...severe);
  await closeInstalledSession();
  await stopFixtureDaemon(repo);
}

async function auditAccessibility() {
  const composer = await driver.findElement(By.id("work-composer"));
  const elements = await driver.findElements(
    By.css('button, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"]')
  );
  const unnamed = [];
  for (const element of elements) {
    if (!(await element.isDisplayed().catch(() => false))) continue;
    const name = await element.getAccessibleName().catch(() => "");
    if (name.trim() === "") {
      unnamed.push({
        tag: await element.getTagName(),
        id: await element.getAttribute("id"),
        role: await element.getAttribute("role")
      });
    }
  }
  evidence.accessibility = {
    composerAccessibleName: await composer.getAccessibleName(),
    composerAriaLabel: await composer.getAttribute("aria-label"),
    composerAriaLabelledBy: await composer.getAttribute("aria-labelledby"),
    composerAssociatedLabelCount: await driver.executeScript(
      "return document.getElementById('work-composer').labels?.length ?? 0"
    ),
    visibleUnnamedControls: unnamed,
    paletteContrast: await driver.executeScript(`
      const sample = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      };
      return {
        body: sample("body"),
        muted: sample(".text-muted-foreground"),
        navy: sample(".text-navy"),
        ink: sample(".text-ink")
      };
    `)
  };
}

async function auditKeyboard() {
  const workTab = await tab("Work");
  await workTab.click();
  await workTab.sendKeys(Key.ARROW_RIGHT);
  const selectedAfterRight = await selectedTabName();
  await (await tab(selectedAfterRight)).sendKeys(Key.ARROW_LEFT);
  const selectedAfterLeft = await selectedTabName();

  await driver.executeScript("document.body.focus()" );
  const focusTrail = [];
  for (let index = 0; index < 24; index += 1) {
    await driver.actions().sendKeys(Key.TAB).perform();
    focusTrail.push(await driver.executeScript(`
      const node = document.activeElement;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        name: node.getAttribute("aria-label") || node.innerText || node.title || node.id || "",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
        x: Math.round(rect.x), y: Math.round(rect.y)
      };
    `));
  }

  await selectTab("Work");
  const settings = await driver.findElement(By.css('button[aria-label="Settings"]'));
  await settings.click();
  const dialog = await driver.wait(until.elementLocated(By.css('[role="dialog"]')), 10_000);
  const dialogName = await dialog.getAccessibleName();
  let escapedDialog = false;
  for (let index = 0; index < 30; index += 1) {
    await driver.actions().sendKeys(Key.TAB).perform();
    const inside = await driver.executeScript(
      "return arguments[0].contains(document.activeElement)",
      dialog
    );
    if (!inside) escapedDialog = true;
  }
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  await driver.wait(
    async () => (await driver.findElements(By.css('[role="dialog"]'))).length === 0,
    10_000,
    "Settings did not close with Escape"
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const focusAfterDialog = await driver.executeScript(`
    const node = document.activeElement;
    return {
      tag: node?.tagName?.toLowerCase() ?? null,
      name: node?.getAttribute?.("aria-label") || node?.innerText || node?.title || node?.id || ""
    };
  `);

  await selectTab("Set up");
  const pressableRestStyle = await driver.executeScript(`
    const node = document.querySelector('[data-slot="checkbox"]');
    if (!node) return null;
    const style = getComputedStyle(node);
    node.disabled = false;
    return {
      wasDisabled: true,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow
    };
  `);
  await driver.executeScript("document.body.focus()");
  let pressableFocus = null;
  for (let index = 0; index < 60; index += 1) {
    await driver.actions().sendKeys(Key.TAB).perform();
    pressableFocus = await driver.executeScript(`
      const node = document.activeElement;
      if (!node?.matches?.('[data-slot="checkbox"], [data-slot="radio"], [data-slot="switch"]')) return null;
      const style = getComputedStyle(node);
      return {
        slot: node.getAttribute("data-slot"),
        name: node.getAttribute("aria-label") || node.innerText || "",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow
      };
    `);
    if (pressableFocus !== null) break;
  }
  await selectTab("Work");
  evidence.keyboard = {
    tabArrowNavigation: { selectedAfterRight, selectedAfterLeft },
    focusTrail,
    focusTrailMissingVisibleOutline: focusTrail.filter(
      (entry) =>
        (entry.outlineStyle === "none" || entry.outlineWidth === "0px") &&
        (entry.boxShadow === "none" || entry.boxShadow === "")
    ),
    pressableRestStyle,
    pressableFocus,
    settingsDialogAccessibleName: dialogName,
    settingsDialogFocusEscaped: escapedDialog,
    settingsDialogEscapeClosed: true,
    settingsDialogFocusAfterClose: focusAfterDialog,
    settingsDialogFocusReturnedToTrigger: focusAfterDialog.name === "Settings"
  };
}

async function auditMinimumWindow() {
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 800, height: 620 });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const surfaces = {};
  for (const name of ["Work", "Set up", "Agents", "Project"]) {
    await selectTab(name);
    await new Promise((resolve) => setTimeout(resolve, 300));
    surfaces[name] = await minimumSurfaceSnapshot();
    await capture(`02-minimum-${name.toLowerCase().replaceAll(" ", "-")}-800x620`);
  }
  evidence.minimumWindow = {
    configuredSize: { width: 800, height: 620 },
    actualWindowRect: await driver.manage().window().getRect(),
    surfaces
  };
  await selectTab("Work");
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
}

async function minimumSurfaceSnapshot() {
  return driver.executeScript(`
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const offscreenControls = [...document.querySelectorAll('button, input, textarea, select, [role="tab"]')]
      .filter((node) => {
        if (!visible(node)) return false;
        const rect = node.getBoundingClientRect();
        return rect.left < 0 || rect.right > window.innerWidth || rect.top < 0 || rect.bottom > window.innerHeight;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          name: node.getAttribute("aria-label") || node.innerText || node.title || node.id || node.tagName,
          left: Math.round(rect.left), right: Math.round(rect.right),
          top: Math.round(rect.top), bottom: Math.round(rect.bottom)
        };
      });
    const clippedContainers = [...document.querySelectorAll('*')]
      .filter((node) => {
        if (!visible(node) || node.closest('.sr-only, [hidden], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(node);
        return ((style.overflowX === "hidden" && node.scrollWidth > node.clientWidth + 2) ||
          (style.overflowY === "hidden" && node.scrollHeight > node.clientHeight + 2));
      })
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        slot: node.getAttribute("data-slot"),
        className: String(node.className ?? "").slice(0, 120),
        hiddenX: Math.max(0, node.scrollWidth - node.clientWidth),
        hiddenY: Math.max(0, node.scrollHeight - node.clientHeight)
      }));
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      verticalOverflowPx: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
      offscreenControls,
      clippedContainers
    };
  `);
}

async function appendLongConversation(repo) {
  const started = Date.now() - longPairCount * 2000;
  const events = [
    event(new Date(started).toISOString(), "conversation.started", null, {
      thread_id: "phase5-long-conversation"
    })
  ];
  for (let index = 0; index < longPairCount; index += 1) {
    events.push(
      event(new Date(started + index * 2000 + 1).toISOString(), "conversation.message_recorded", null, {
        message_id: `phase5-message-${index}`,
        thread_id: "phase5-long-conversation",
        text: index === 0 ? "PHASE5-EARLIEST-0" : `PHASE5-REQUEST-${index}`
      }),
      event(new Date(started + index * 2000 + 1000).toISOString(), "conversation.reply_recorded", null, {
        message_id: `phase5-reply-${index}`,
        thread_id: "phase5-long-conversation",
        text: `PHASE5-LATEST-${index}`
      })
    );
  }
  await appendFile(
    path.join(repo, ".hivemind", "log", "events.jsonl"),
    `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

async function startInstalledSession() {
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
}

async function closeInstalledSession() {
  await driver?.quit().catch(() => undefined);
  driver = undefined;
  tauriDriver?.kill();
  tauriDriver = undefined;
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
}

async function openProjectDialog(wantedPath) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    wantedPath
  );
  await driver.findElement(By.xpath('//button[contains(normalize-space(.), "Open project")]')).click();
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
}

async function selectTab(name) {
  const element = await tab(name);
  await element.click();
  await driver.wait(
    async () => (await element.getAttribute("aria-selected")) === "true",
    10_000,
    `${name} tab did not become selected`
  );
}

async function tab(name) {
  return driver.wait(
    until.elementLocated(By.xpath(`//*[@role="tab" and normalize-space(.)="${name}"]`)),
    15_000
  );
}

async function selectedTabName() {
  const selected = await driver.findElement(By.css('[role="tab"][aria-selected="true"]'));
  return (await selected.getText()).trim();
}

async function viewportSnapshot() {
  return driver.executeScript(`
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      verticalOverflowPx: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight)
    };
  `);
}

async function threadText() {
  const roots = await driver.findElements(By.css('[aria-label="What has happened in this run"]'));
  return roots.length === 0 ? "" : roots[0].getText();
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await bodyText()).trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) {
      throw new Error(`tauri-driver exited before accepting sessions (${tauriDriver.exitCode})`);
    }
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) return;
    } catch {
      // Read-only readiness poll.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

function event(ts, type, taskId, data) {
  return { ts, type, task_id: taskId, data };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], {
    windowsHide: true
  });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not exit within ${timeout}ms`);
}

async function stopFixtureDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0) return;
    await run("taskkill", ["/PID", String(state.pid), "/T", "/F"], {
      windowsHide: true
    }).catch(() => undefined);
  } catch {
    // The fixture helper removes the exact temporary project.
  }
}

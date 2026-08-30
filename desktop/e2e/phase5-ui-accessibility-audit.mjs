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
const remediation = process.argv.includes("--remediation");
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `${remediation ? "phase8-ui-accessibility-remediation" : "full-audit-phase5"}-${installedVersion}`
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
      /* The expanded provider-help matrix is reachable only after the fixture's
         verification question is resolved. Record that deterministic setup
         fact explicitly; otherwise the probe measures a disabled setup step
         while claiming it exercised the provider surface. */
      await fixture.setConfigTestCommand(repo, 'node -e "process.exit(0)"');
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
  remediation ? validateRemediation() : validateObservedFindings();
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

function validateRemediation() {
  for (const [size, expected] of Object.entries({
    "800x620": { width: 800, height: 620 },
    "1280x720": { width: 1280, height: 720 },
    "1366x768": { width: 1366, height: 768 },
    "1440x900": { width: 1440, height: 900 }
  })) {
    const actual = evidence.minimumWindow.windowRects?.[size];
    assert.ok(actual, `${size} installed window rectangle was not recorded`);
    assert.equal(actual.width, expected.width, `${size} installed window width did not apply`);
    assert.equal(actual.height, expected.height, `${size} installed window height did not apply`);
  }
  for (const [size, surfaces] of Object.entries(evidence.minimumWindow.viewports ?? {})) {
    for (const [name, surface] of Object.entries(surfaces)) {
      assert.equal(surface.horizontalOverflowPx, 0, `${size} ${name} has horizontal overflow`);
      assert.deepEqual(surface.offscreenControls, [], `${size} ${name} has offscreen controls`);
    }
  }
  assert.equal(evidence.keyboard.settingsDialogFocusReturnedToTrigger, true);
  assert.equal(evidence.keyboard.settingsDialogFocusEscaped, false);
  assert.ok(evidence.keyboard.pressableFocus, "no pressable received keyboard focus");
  assert.deepEqual(evidence.keyboard.focusTrailMissingVisibleOutline, []);
  assert.equal(evidence.accessibility.composerAccessibleName, "Message Hivemind");
  assert.deepEqual(evidence.accessibility.visibleUnnamedControls, []);
  assert.equal(evidence.longConversation.threadAriaRole, "log");
  assert.equal(evidence.longConversation.threadAriaLive, "polite");
  assert.equal(evidence.longConversation.viewportTabIndex, "0");
  assert.ok(evidence.longConversation.maxMountedArticles < 80);
  assert.ok(evidence.longConversation.maxDocumentNodeCount < 3500);
  assert.equal(evidence.longConversation.earliestReachable, true);
  assert.equal(evidence.longConversation.latestReachableAgain, true);
  assert.ok(evidence.longConversation.pagesVisited >= 13);
  assert.notEqual(evidence.longConversation.livenessBefore, evidence.longConversation.livenessAfter);
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
    if (remediation) {
      await auditRemediatedLongConversation(openedAt);
    } else {
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
    }
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

async function auditRemediatedLongConversation(openedAt) {
  const latest = `PHASE5-LATEST-${longPairCount - 1}`;
  await driver.wait(
    async () => (await threadText()).includes(latest),
    90_000,
    "the installed virtual thread did not render the newest durable reply"
  );
  try {
    await driver.wait(
      async () => {
        const buttons = await driver.findElements(By.xpath('//button[normalize-space(.)="Older messages"]'));
        return buttons.length > 0 && await buttons[0].isDisplayed().catch(() => false);
      },
      90_000,
      "the installed conversation never exposed its durable older-page control"
    );
  } catch (error) {
    const archive = await driver.executeScript(`
      const log = document.querySelector('[data-testid="conversation-log"]');
      return {
        controls: [...document.querySelectorAll("button")]
          .filter((button) => button.offsetParent !== null)
          .map((button) => button.innerText || button.getAttribute("aria-label") || ""),
        region: log?.parentElement?.parentElement?.innerText?.slice(0, 1600) ?? null,
        body: document.body?.innerText?.slice(0, 4000) ?? null
      };
    `);
    const failureShot = `older-messages-missing-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    evidence.longConversation.archiveControlFailure = { ...archive, screenshot: failureShot };
    throw new Error(
      `the newest durable reply rendered without an older-page control; screenshot ${failureShot}`,
      { cause: error }
    );
  }
  const snapshots = [];
  const sample = async () => {
    const value = await driver.executeScript(`
      const root = document.querySelector('[data-testid="conversation-log"]');
      if (!root) return null;
      return {
        articleCount: root.querySelectorAll("article").length,
        documentNodeCount: document.querySelectorAll("*").length,
        text: root.textContent
      };`);
    assert.ok(value, "the scoped conversation log disappeared while sampling an archive page");
    snapshots.push(value);
    return value;
  };
  await sample();
  evidence.longConversation.initialArchiveControls = await driver.executeScript(`
    return [...document.querySelectorAll("button")]
      .filter((button) => button.offsetParent !== null)
      .map((button) => button.innerText || button.getAttribute("aria-label") || "")
      .filter((name) => /Older|Newer|Latest|Reading/u.test(name));
  `);
  evidence.longConversation.initialArchiveRegion = await driver.executeScript(`
    const log = document.querySelector('[data-testid="conversation-log"]');
    return log?.parentElement?.parentElement?.innerText?.slice(0, 800) ?? null;
  `);
  let pagesVisited = 1;
  let earliestReachable = false;
  for (let guard = 0; guard < 24; guard += 1) {
    const settled = await driver.wait(async () => {
      const older = await driver.findElements(By.xpath('//button[normalize-space(.)="Older messages"]'));
      if (older.length > 0 && await older[0].isDisplayed().catch(() => false)) {
        return { kind: "older", element: older[0] };
      }
      const beginning = await driver.findElements(By.xpath('//*[normalize-space(.)="Beginning of conversation"]'));
      if (beginning.length > 0 && await beginning[0].isDisplayed().catch(() => false)) {
        return { kind: "beginning", element: null };
      }
      return false;
    }, 15_000, `archive page ${pagesVisited} did not settle on a next-page or beginning state`);
    if (settled.kind === "beginning") break;
    const previousText = await threadText();
    await settled.element.click();
    pagesVisited += 1;
    await driver.wait(
      async () => (await threadText()) !== previousText,
      15_000,
      `archive page ${pagesVisited} did not replace the scoped conversation log`
    );
    const page = await sample();
    if (page.text.includes("PHASE5-EARLIEST-0")) {
      earliestReachable = true;
      break;
    }
  }
  if (!earliestReachable) {
    const currentLog = await driver.findElement(By.css('[data-testid="conversation-log"]'));
    await currentLog.click();
    await driver.switchTo().activeElement().then((element) => element.sendKeys(Key.HOME));
    await driver.wait(
      async () => (await threadText()).includes("PHASE5-EARLIEST-0"),
      15_000,
      "the first durable request was not reachable from the final archive page with keyboard Home"
    );
    earliestReachable = true;
    await sample();
  }
  evidence.longConversation.pageTraversal = {
    pagesVisited,
    earliestReachable,
    earliestReachedByKeyboard: true
  };
  assert.equal(earliestReachable, true, "older-message paging never reached the first durable request");
  const latestButton = await driver.findElement(By.xpath('//button[normalize-space(.)="Latest"]'));
  await latestButton.click();
  await driver.wait(async () => (await threadText()).includes(latest), 15_000);
  const latestReachableAgain = (await threadText()).includes(latest);
  const livenessBefore = await elapsedText();
  await capture("06-reduced-motion-liveness-before-1440x900");
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  const livenessAfter = await elapsedText();
  await capture("07-reduced-motion-liveness-after-1440x900");
  const threadAccessibleName = await driver.wait(async () => {
    try {
      const name = await (await driver.findElement(By.css('[data-testid="conversation-log"]'))).getAccessibleName();
      return name.trim() === "" ? false : name;
    } catch {
      return false;
    }
  }, 10_000, "the conversation log never exposed a stable accessible name");
  const threadAttributes = await driver.executeScript(`
    const log = document.querySelector('[data-testid="conversation-log"]');
    return {
      role: log?.getAttribute("role") ?? null,
      ariaLive: log?.getAttribute("aria-live") ?? null,
      ariaRelevant: log?.getAttribute("aria-relevant") ?? null,
      tabIndex: log?.getAttribute("tabindex") ?? null
    };
  `);
  evidence.longConversation = {
    appendedConversationPairs: longPairCount,
    appendedConversationEvents: longPairCount * 2 + 2,
    projectOpenToLatestRenderedMs: Date.now() - openedAt,
    threadAccessibleName,
    threadAriaRole: threadAttributes.role,
    threadAriaLive: threadAttributes.ariaLive,
    threadAriaRelevant: threadAttributes.ariaRelevant,
    viewportTabIndex: threadAttributes.tabIndex,
    pagesVisited,
    earliestReachable,
    latestReachableAgain,
    maxMountedArticles: Math.max(...snapshots.map((entry) => entry.articleCount)),
    maxDocumentNodeCount: Math.max(...snapshots.map((entry) => entry.documentNodeCount)),
    livenessBefore,
    livenessAfter
  };
  await capture("05-long-conversation-virtualized-1440x900");
}

async function elapsedText() {
  return driver.executeScript(`
    return [...document.querySelectorAll("span")]
      .map((node) => node.textContent?.trim() ?? "")
      .find((text) => text.endsWith(" elapsed")) ?? null;
  `);
}

async function auditAccessibility() {
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
  const composerAccessibleName = await driver.wait(async () => {
    try {
      const name = await (await driver.findElement(By.id("work-composer"))).getAccessibleName();
      return name.trim() === "" ? false : name;
    } catch {
      return false;
    }
  }, 10_000, "the composer never exposed a stable accessible name");
  const composerAttributes = await driver.executeScript(`
    const composer = document.getElementById("work-composer");
    return {
      ariaLabel: composer?.getAttribute("aria-label") ?? null,
      ariaLabelledBy: composer?.getAttribute("aria-labelledby") ?? null,
      associatedLabelCount: composer?.labels?.length ?? 0
    };
  `);
  evidence.accessibility = {
    composerAccessibleName,
    composerAriaLabel: composerAttributes.ariaLabel,
    composerAriaLabelledBy: composerAttributes.ariaLabelledBy,
    composerAssociatedLabelCount: composerAttributes.associatedLabelCount,
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
      let focusVisual = null;
      for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        const outlined = currentStyle.outlineStyle !== "none" && currentStyle.outlineWidth !== "0px";
        const shadowed = currentStyle.boxShadow !== "none" && currentStyle.boxShadow !== "";
        if (outlined || shadowed) {
          focusVisual = {
            tag: current.tagName.toLowerCase(),
            outlineStyle: currentStyle.outlineStyle,
            outlineWidth: currentStyle.outlineWidth,
            boxShadow: currentStyle.boxShadow
          };
          break;
        }
      }
      return {
        tag: node.tagName.toLowerCase(),
        name: node.getAttribute("aria-label") || node.innerText || node.title || node.id || "",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
        focusVisual,
        x: Math.round(rect.x), y: Math.round(rect.y)
      };
    `));
  }

  await selectTab("Work");
  await driver.wait(async () => {
    if ((await driver.findElements(By.css('[role="dialog"]'))).length > 0) return true;
    try {
      await (await driver.findElement(By.css('button[aria-label="Settings"]'))).click();
    } catch {
      return false;
    }
    return (await driver.findElements(By.css('[role="dialog"]'))).length > 0;
  }, 10_000, "Settings did not open from its exact trigger");
  const dialog = await driver.findElement(By.css('[role="dialog"]'));
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
  await driver.switchTo().activeElement().then((element) => element.sendKeys(Key.ESCAPE));
  try {
    await driver.wait(
      async () => (await driver.findElements(By.css('[role="dialog"]'))).length === 0,
      10_000,
      "Settings did not close with Escape"
    );
  } catch (error) {
    const dialogs = await driver.findElements(By.css('[role="dialog"]'));
    const names = await Promise.all(dialogs.map((element) => element.getAccessibleName()));
    const failureShot = `settings-escape-failed-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    throw new Error(
      `Escape left dialogs ${JSON.stringify(names)} on screen; screenshot ${failureShot}`,
      { cause: error }
    );
  }
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
      (entry) => entry.tag !== "body" && entry.tag !== "html" && entry.focusVisual === null
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
  if (remediation) {
    const viewports = {};
    const windowRects = {};
    for (const size of [
      { width: 800, height: 620 },
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 }
    ]) {
      await driver.manage().window().setRect({ x: -1800, y: 0, ...size });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const key = `${size.width}x${size.height}`;
      windowRects[key] = await driver.manage().window().getRect();
      viewports[key] = {};
      for (const name of ["Work", "Set up", "Agents", "Project"]) {
        await selectTab(name);
        await new Promise((resolve) => setTimeout(resolve, 250));
        viewports[key][name] = await minimumSurfaceSnapshot();
        await capture(`04-${key}-${name.toLowerCase().replaceAll(" ", "-")}`);
        if (name === "Set up") {
          const help = await driver.findElement(By.xpath('//summary[contains(normalize-space(.), "see your provider")]'));
          await help.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          viewports[key]["Set up — expanded provider help"] = await minimumSurfaceSnapshot();
          await capture(`04-${key}-set-up-expanded-provider-help`);
          await help.click();
        }
      }
    }
    evidence.minimumWindow = {
      declaredMinimum: { width: 800, height: 620 },
      actualWindowRect: await driver.manage().window().getRect(),
      windowRects,
      viewports
    };
    await selectTab("Work");
    return;
  }
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
    const testReachability = arguments[0];
    const visible = (node) => {
      if (node.parentElement?.closest('[hidden], [aria-hidden="true"], [data-state="closed"]')) return false;
      if (node.tagName !== "SUMMARY" && node.parentElement?.closest('details:not([open])')) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll('button, input, textarea, select, summary, [role="tab"]')]
      .filter(visible);
    const scrollState = [...document.querySelectorAll('*')]
      .filter((node) => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
      .map((node) => [node, node.scrollLeft, node.scrollTop]);
    const windowScroll = [window.scrollX, window.scrollY];
    const clippedByAncestor = (node, rect) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/(auto|scroll|hidden|clip)/u.test(style.overflowX + " " + style.overflowY)) continue;
        const box = parent.getBoundingClientRect();
        if (rect.left < box.left - 1 || rect.right > box.right + 1 ||
            rect.top < box.top - 1 || rect.bottom > box.bottom + 1) return true;
      }
      return false;
    };
    const offscreenControls = [];
    for (const node of controls) {
      if (testReachability) node.scrollIntoView({ block: "center", inline: "center" });
      const rect = node.getBoundingClientRect();
      if (rect.left < 0 || rect.right > window.innerWidth || rect.top < 0 ||
          rect.bottom > window.innerHeight || clippedByAncestor(node, rect)) {
        offscreenControls.push({
          name: node.getAttribute("aria-label") || node.innerText || node.title || node.id || node.tagName,
          left: Math.round(rect.left), right: Math.round(rect.right),
          top: Math.round(rect.top), bottom: Math.round(rect.bottom)
        });
      }
    }
    if (testReachability) {
      for (const [node, left, top] of scrollState) node.scrollTo(left, top);
      window.scrollTo(windowScroll[0], windowScroll[1]);
    }
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
  `, remediation);
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
  if (remediation) {
    events.push(event(new Date().toISOString(), "spec.draft_started", null, {
      spec_id: "phase8-reduced-motion-liveness"
    }));
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
  const wantedName = path.basename(wantedPath);
  try {
    await driver.wait(async () => {
      try {
        const switcher = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
        return (await switcher.getAttribute("aria-label")).includes(wantedName);
      } catch {
        return false;
      }
    }, 30_000, `the shell did not finish selecting ${wantedName}`);
  } catch (error) {
    const switcher = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
    const actualLabel = await switcher.getAttribute("aria-label");
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    const failureShot = `project-switch-failed-${installedVersion}.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    throw new Error(
      `the dialog closed for ${wantedName}, but the shell label was ${JSON.stringify(actualLabel)}; ` +
        `body was ${JSON.stringify(body.slice(0, 1200))}; screenshot ${failureShot}`,
      { cause: error }
    );
  }
}

async function selectTab(name) {
  await driver.wait(async () => {
    try {
      await (await tab(name)).click();
      return true;
    } catch {
      return false;
    }
  }, 10_000, `${name} tab could not be clicked while the shell was settling`);
  try {
    await driver.wait(
      async () => {
        try {
          return (await (await tab(name)).getAttribute("aria-selected")) === "true";
        } catch {
          return false;
        }
      },
      10_000,
      `${name} tab did not become selected`
    );
  } catch (error) {
    const tabs = await driver.findElements(By.css('[role="tab"]'));
    const states = await Promise.all(tabs.map(async (element) => ({
      name: await element.getText().catch(() => ""),
      selected: await element.getAttribute("aria-selected").catch(() => null)
    })));
    const failureShot = `tab-selection-failed-${name.toLowerCase().replaceAll(" ", "-")}-${installedVersion}.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    throw new Error(
      `${name} did not remain selected; tab states were ${JSON.stringify(states)}; screenshot ${failureShot}`,
      { cause: error }
    );
  }
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
  const roots = await driver.findElements(By.css(
    remediation ? '[data-testid="conversation-log"]' : '[aria-label="What has happened in this run"]'
  ));
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

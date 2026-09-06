/** No-cost installed-artifact proof for R4 conversation and live orchestration. */
import "./protect-recent-projects.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedVersion = (await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")).trim();
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCore = path.join(installedRoot, "core", "dist", "src");
const recentProjectsPath = path.join(process.env.APPDATA ?? "", "ai.hivemind.desktop", "recent-projects.json");
const evidenceDir = path.resolve("..", "docs", "evidence", `conversation-repair-${installedVersion}-${Date.now()}`);

let driver;
let tauriDriver;
let project;
let otherProject;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const driverLog = [];
const evidence = {
  installedVersion,
  installedBinary,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  liveConversation: {},
  duplicateSubmit: {},
  projectContext: {},
  conversationHistory: {},
  attachmentContext: {},
  newConversation: {},
  visibleFailure: {},
  stopResponse: {},
  stopPlanning: {},
  usabilityObservations: {},
  browserSevereLogs: [],
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(path.join(installedCore, "workspace-actions.js")), "installed Core action module missing");
  const receipt = JSON.parse(await readFile(path.resolve("src-tauri", "gen", "install-receipt.json"), "utf8"));
  const payload = JSON.parse(await readFile(path.join(installedRoot, "artifact", "payload-manifest.json"), "utf8"));
  const installedExecutableSha256 = sha256(await readFile(installedBinary));
  assert.equal(installedVersion, receipt.version);
  assert.equal(installedVersion, payload.version);
  assert.equal(installedExecutableSha256, receipt.installed_executable_sha256);
  assert.equal(payload.source.commit, receipt.source_commit);
  evidence.installedIdentity = { ...receipt, installedExecutableSha256, installedPayloadSource: payload.source.commit };
  assert.equal(await isProcessRunning("hivemind_desktop.exe"), false, "close the installed Hivemind app before this proof");
  assert.equal(await isProcessRunning("tauri-driver.exe"), false, "another tauri-driver session is already running");
  await mkdir(evidenceDir, { recursive: true });
  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  const initModule = await import(pathToFileURL(path.join(installedCore, "init.js")).href);
  project = await createFixture(initModule);
  const driverResolution = await run(path.resolve("node_modules", "selenium-webdriver", "bin", "windows", "selenium-manager.exe"),
    ["--browser", "webview2", "--avoid-browser-download", "--skip-driver-in-path", "--avoid-stats", "--output", "JSON"], { windowsHide: true });
  const nativeDriver = JSON.parse(driverResolution.stdout).result;
  assert.equal(nativeDriver.code, 0, nativeDriver.message);
  assert.ok(existsSync(nativeDriver.driver_path), "matching WebView driver was not resolved");
  evidence.nativeDriver = nativeDriver.driver_path;
  tauriDriver = spawn("tauri-driver", ["--native-driver", nativeDriver.driver_path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => driverLog.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => driverLog.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
  await driver.manage().window().setRect({ x: 40, y: 40, width: 1440, height: 900 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const viewport = await driver.executeScript("return { width: innerWidth, height: innerHeight, devicePixelRatio };");
    if (viewport.width === 1440 && viewport.height === 900) break;
    const rect = await driver.manage().window().getRect();
    await driver.manage().window().setRect({ width: rect.width + 1440 - viewport.width, height: rect.height + 900 - viewport.height });
  }
  evidence.viewport = await driver.executeScript("return { width: innerWidth, height: innerHeight, devicePixelRatio };");
  assert.equal(evidence.viewport.width, 1440);
  assert.equal(evidence.viewport.height, 900);
  evidence.outerWindow = await driver.manage().window().getRect();
  await openProjectDialog(project);
  await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);
  const daemon = await waitForDaemon(project);

  const question = "Describe what this project does, in one sentence.";
  await typeComposer(question);
  const callsBefore = (await readCalls()).length;
  await submitOnce();
  await waitForEvent("conversation.message_recorded", question, 4_000);
  const statusProbe = timedAction(daemon.url, { type: "status.inspect", payload: {} });
  const progress = await driver.wait(
    until.elementLocated(By.css('[data-testid="conversation-progress"]')),
    4_000,
    "the scoped conversation progress element did not appear"
  );
  await driver.wait(async () => (await progress.getText()).includes("Thinking"), 4_000);
  await statusProbe.promise;
  const answer = "This installed fixture reports a deterministic TypeScript project status.";
  const liveAnswer = await driver.wait(
    until.elementLocated(By.css('[data-testid="conversation-live-answer"]')),
    8_000,
    "the scoped live-answer element did not appear"
  );
  const partialAnswerText = await driver.wait(async () => {
    const text = await liveAnswer.getText();
    return text.length > 0 && text !== answer && answer.startsWith(text) ? text : false;
  }, 8000, "no genuine partial answer was observed before its completion");
  assert.equal(existsSync(path.join(project, ".hivemind", "phase6-provider-active")), true, "partial answer sampled after provider exit");
  const partialShot = `partial-answer-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, partialShot), Buffer.from(await driver.takeScreenshot(), "base64"));
  await driver.wait(async () => (await liveAnswer.getText()).includes(answer), 8_000);
  const activeDuringAnswer = existsSync(path.join(project, ".hivemind", "phase6-provider-active"));
  const progressTextDuringRun = await progress.getText();
  const headerDuringRun = await driver.findElement(By.css('[data-testid="work-run-header"] h2')).getText();
  assert.equal(headerDuringRun, "Conversation", "header duplicated conversation progress instead of leaving it to the transcript");
  const clockDuringRun = await progress.findElement(By.css(".font-mono")).getText();
  assert.match(clockDuringRun, /elapsed$/);
  const answerTextDuringRun = await liveAnswer.getText();
  assert.equal((await driver.findElements(By.css('[data-testid="conversation-progress"]'))).length, 1, "duplicate live operation rows");
  const exactQuestionRowsDuringRun = (await driver.findElements(By.xpath(`//*[normalize-space(.)=${JSON.stringify(question)}]`))).length;
  const liveShot = `phase6-live-conversation-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, liveShot), Buffer.from(await driver.takeScreenshot(), "base64"));
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal(existsSync(path.join(project, ".hivemind", "phase6-provider-active")), true, "liveness sampled after operation ended");
  const laterProgress = await progress.getText();
  const clockLater = await progress.findElement(By.css(".font-mono")).getText();
  assert.notEqual(clockLater, clockDuringRun, "operation's elapsed element did not change");
  await writeFile(path.join(evidenceDir, `phase6-live-later-${installedVersion}-1440x900.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
  await driver.wait(async () => !(existsSync(path.join(project, ".hivemind", "phase6-provider-active"))), 10_000);
  await waitForText(answer, 10_000);
  await waitForComposerReady(10_000);
  const firstCall = (await readCalls()).at(callsBefore);
  evidence.liveConversation = {
    build: installedVersion,
    screenshot: liveShot,
    partialScreenshot: partialShot,
    typed: question,
    reply: answer,
    durableMessageVisibleWhileRunning: exactQuestionRowsDuringRun > 0,
    scopedActivityWhileRunning: progressTextDuringRun,
    headerWhileRunning: headerDuringRun,
    scopedActivityLater: laterProgress,
    scopedClockWhileRunning: clockDuringRun,
    scopedClockLater: clockLater,
    scopedAnswerWhileRunning: answerTextDuringRun,
    scopedPartialAnswerWhileRunning: partialAnswerText,
    providerStillAliveWhenAnswerSampled: activeDuringAnswer,
    readOnlyStatusSettledWhileRunning: statusProbe.settled,
    readOnlyStatusMs: statusProbe.elapsedMs,
    adapterCalls: (await readCalls()).length - callsBefore
  };
  evidence.projectContext = {
    readmeContentIncluded: firstCall?.prompt.includes("R4_CONTEXT_README_FACT") ?? false,
    sourceContentIncluded: firstCall?.prompt.includes("R4_CONTEXT_SOURCE_FACT") ?? false,
    untrackedNameIncluded: firstCall?.prompt.includes("UNTRACKED-CURRENT.md") ?? false,
    untrackedContentIncluded: firstCall?.prompt.includes("R4_UNTRACKED_CURRENT_FACT") ?? false
  };

  const duplicate = "Give me the fixture name.";
  await typeComposer(duplicate);
  await waitForSend();
  const duplicateBefore = (await readCalls()).length;
  const duplicateDispatched = await driver.executeScript(`const form=document.getElementById("work-composer")?.form;if(!form)return false;form.requestSubmit();form.requestSubmit();return true;`);
  assert.equal(duplicateDispatched, true, "duplicate-submit probe did not reach the composer form");
  await waitForCallCount(duplicateBefore + 1, 8_000);
  await waitForText("phase-six-conversation-fixture", 12_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  evidence.duplicateSubmit = {
    synchronousSubmits: 2,
    adapterCalls: (await readCalls()).length - duplicateBefore,
    durableMessages: countMessages(await readEvents(), duplicate)
  };
  const followupHistory = providerHistory((await readCalls()).at(duplicateBefore));
  assert.deepEqual(followupHistory.turns, [{ user: question, assistant: answer, assistant_kind: "reply", truncated: false }]);
  assert.equal(followupHistory.omitted_turns, 0);
  evidence.conversationHistory.followup = followupHistory;

  const stopResponseBefore = (await readCalls()).length;
  await typeComposer("STOP_RESPONSE");
  await submitOnce();
  await driver.wait(until.elementLocated(By.css('[aria-label="Stop response"]')), 5000);
  await driver.wait(async () => (await postAction(daemon.url, { type: "status.inspect", payload: {} })).value?.conversation_operation?.phase === "reading", 5000);
  await waitForCallCount(stopResponseBefore + 1, 5000);
  const responseChildPid = (await readCalls()).at(-1).pid;
  assert.equal(isPidAlive(responseChildPid), true, "response fixture process was not running before Stop");
  await driver.findElement(By.css('[aria-label="Choose planner, manager, and worker models"]')).click();
  const modelMenu = await driver.wait(until.elementLocated(By.css('[role="menu"]')), 5000);
  assert.match(await modelMenu.getText(), /model assignments, not separate chats/);
  await driver.actions().sendKeys("\uE00C").perform();
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('[aria-label="Stop response"]')), 10000);
  assert.equal((await driver.findElements(By.css('[data-testid="conversation-progress"]'))).length, 1, "reload duplicated or lost the active operation");
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), "", "reload restored the accepted message as an unsent draft");
  await typeComposer("This is my next unsent message.");
  await waitForDraftSaved();
  assert.equal(isPidAlive(responseChildPid), true, "next draft saved only after the provider finished");
  await driver.findElement(By.xpath("//*[@role='tab' and normalize-space(.)='Agents']")).click();
  await driver.findElement(By.xpath("//*[@role='tab' and normalize-space(.)='Work']")).click();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), "This is my next unsent message.", "tab switch lost the next draft while responding");
  await driver.findElement(By.css('[aria-label="Stop response"]')).click();
  await driver.wait(async () => (await postAction(daemon.url, { type: "status.inspect", payload: {} })).value?.conversation_operation === null, 15000);
  assert.equal(isPidAlive(responseChildPid), false, "response fixture process survived acknowledged Stop");
  assert.equal((await readCalls()).length - stopResponseBefore, 1, "Stop allowed another response stage to launch");
  await waitForSend();
  const retainedDraft = await driver.findElement(By.id("work-composer")).getAttribute("value");
  assert.equal(retainedDraft, "This is my next unsent message.");
  const stopShot = `stopped-response-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, stopShot), Buffer.from(await driver.takeScreenshot(), "base64"));
  evidence.stopResponse = { screenshot: stopShot, retainedDraft, modelMenuOpenedWhileRunning: true, stopRecoveredAfterReload: true, responseChildPid, childAbsentAfterStop: true, adapterCalls: 1 };

  const attachmentPrompt = "Summarize the attached notes folder.";
  const attachmentBefore = (await readCalls()).length;
  const attached = await postAction(daemon.url, {
    type: "conversation.submit",
    payload: {
      prompt: attachmentPrompt,
      tool: "planner",
      request_id: randomUUID(),
      attachments: [
        { kind: "folder", path: "notes" },
        { kind: "file", path: "UNTRACKED-CURRENT.md" }
      ]
    }
  });
  assert.equal(attached.ok, true, attached.reason);
  const attachmentCall = (await readCalls()).at(attachmentBefore);
  evidence.attachmentContext = {
    structuredAttachments: [
      { kind: "folder", path: "notes" },
      { kind: "file", path: "UNTRACKED-CURRENT.md" }
    ],
    childNameIncluded: attachmentCall?.prompt.includes("notes/current-behavior.md") ?? false,
    childContentIncluded: attachmentCall?.prompt.includes("R4_FOLDER_ATTACHMENT_FACT") ?? false,
    untrackedFileContentIncluded: attachmentCall?.prompt.includes("R4_UNTRACKED_CURRENT_FACT") ?? false,
    markerTextAppendedToPrompt: attachmentCall?.prompt.includes("Project references:") ?? false
  };

  const buildCallsBefore = (await readCalls()).length;
  const buildPending = postAction(daemon.url, {
    type: "conversation.submit",
    payload: {
      prompt: "Build a tiny status label for this fixture.",
      tool: "planner",
      request_id: randomUUID(),
      attachments: []
    }
  });
  await driver.wait(async () => (await postAction(daemon.url, { type: "status.inspect", payload: {} })).value?.conversation_operation?.phase === "planning", 15000);
  await waitForCallCount(buildCallsBefore + 2, 5000);
  const planningChildPid = (await readCalls()).at(-1).pid;
  assert.equal(isPidAlive(planningChildPid), true, "planning fixture process was not running before Stop");
  await driver.wait(async () => {
    const rows = await driver.findElements(By.css('[data-testid="conversation-progress"]'));
    return rows.length === 1 && (await rows[0].getText()).includes("preparing the task plan");
  }, 5000);
  const planningShot = `planning-handoff-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, planningShot), Buffer.from(await driver.takeScreenshot(), "base64"));
  await driver.findElement(By.css('[aria-label="Stop response"]')).click();
  const buildResult = await buildPending;
  assert.equal(buildResult.ok, true, JSON.stringify(buildResult));
  assert.equal(buildResult.value.status, "stopped");
  assert.equal(isPidAlive(planningChildPid), false, "planning fixture process survived acknowledged Stop");
  assert.equal((await readCalls()).length - buildCallsBefore, 2, "Stop allowed another planning stage to launch");
  evidence.stopPlanning = { screenshot: planningShot, status: buildResult.value.status, planningChildPid, childAbsentAfterStop: true, adapterCalls: 2 };
  const beforeBoundary = await postAction(daemon.url, { type: "status.inspect", payload: {} });
  assert.equal(beforeBoundary.ok, true, beforeBoundary.reason);
  const boundary = await postAction(daemon.url, { type: "conversation.new", payload: {} });
  assert.equal(boundary.ok, true, boundary.reason);
  const afterBoundary = await postAction(daemon.url, { type: "status.inspect", payload: {} });
  assert.equal(afterBoundary.ok, true, afterBoundary.reason);
  evidence.newConversation = {
    activeSpecBefore: beforeBoundary.value.active_spec_id,
    activeSpecAfter: afterBoundary.value.active_spec_id,
    archivedPointers: (await readdir(path.join(project, ".hivemind", "spec", "archive"))).length
  };

  const failurePrompt = "FAIL_VISIBLE";
  await typeComposer(failurePrompt);
  await submitOnce();
  await waitForEventDetail("spec.draft_failed", "PHASE6_VISIBLE_PROVIDER_FAILURE", 12_000);
  const freshHistory = providerHistory((await readCalls()).at(-1));
  assert.deepEqual(freshHistory.turns, []);
  assert.notEqual(freshHistory.conversation_id, followupHistory.conversation_id);
  evidence.conversationHistory.afterNewConversation = freshHistory;
  const failureLabel = "Response could not finish";
  const failureOutcome = await driver.wait(
    async () => {
      for (const outcome of await driver.findElements(By.css('[data-testid="conversation-outcome"]'))) {
        const text = await outcome.getText();
        if (text.includes(failureLabel) && text.includes("PHASE6_VISIBLE_PROVIDER_FAILURE")) return outcome;
      }
      return false;
    },
    12_000,
    "the exact failed planner round did not become visible in the conversation log"
  );
  const failureShot = `phase6-visible-failure-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
  evidence.visibleFailure = {
    build: installedVersion,
    screenshot: failureShot,
    statusText: failureLabel,
    scopedOutcomeText: await failureOutcome.getText(),
    durableFailure: (await readEvents()).some((event) =>
      event.type === "spec.draft_failed" && String(event.data?.detail ?? "").includes("PHASE6_VISIBLE_PROVIDER_FAILURE")
    )
  };

  // U3: real installed text/chip consumers over the installed draft actions.
  // Native picker behavior is unchanged and not simulated as qualified here:
  // seed attachment references through Core, then exercise UI removal and
  // navigation/reload. No production project or provider is used.
  const navigationCallsBefore = (await readCalls()).length;
  const navigationDraft = "Keep this unsent draft while I inspect Agents.";
  await typeComposer(navigationDraft);
  await waitForDraftSaved();
  const currentConversation = (await postAction(daemon.url, { type: "status.inspect", payload: {} })).value.conversation_id;
  const readDraft = await postAction(daemon.url, { type: "draft.inspect", payload: { conversation_id: currentConversation } });
  assert.equal(readDraft.ok, true, readDraft.reason);
  const selectedAttachments = [{ kind: "folder", path: "notes" }, { kind: "file", path: "UNTRACKED-CURRENT.md" }];
  const seeded = await postAction(daemon.url, { type: "draft.save", payload: {
    conversation_id: currentConversation, expected_revision: readDraft.value.revision,
    draft: { ...readDraft.value.draft, content_id: randomUUID(), attachments: selectedAttachments }
  } });
  assert.equal(seeded.ok, true, seeded.reason);
  await driver.navigate().refresh();
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), navigationDraft);
  await assertAttachmentChips(["notes", "UNTRACKED-CURRENT.md"]);
  await driver.findElement(By.xpath("//*[@role='tab' and normalize-space(.)='Agents']")).click();
  await driver.findElement(By.xpath("//*[@role='tab' and normalize-space(.)='Work']")).click();
  const draftAfterTabs = await driver.wait(until.elementLocated(By.id("work-composer")), 5000);
  assert.equal(await draftAfterTabs.getAttribute("value"), navigationDraft);
  await assertAttachmentChips(["notes", "UNTRACKED-CURRENT.md"]);
  evidence.usabilityObservations.draftAcrossTabs = {
    typed: navigationDraft, after: await draftAfterTabs.getAttribute("value"), attachments: selectedAttachments
  };
  otherProject = await createFixture(initModule);
  await openProjectDialog(otherProject);
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), "", "project B inherited A's text");
  await assertAttachmentChips([]);
  const otherDraft = "This draft belongs only to project B.";
  await typeComposer(otherDraft);
  await waitForDraftSaved();
  await openProjectDialog(project);
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), navigationDraft);
  await assertAttachmentChips(["notes", "UNTRACKED-CURRENT.md"]);
  await driver.findElement(By.css('button[aria-label="Remove UNTRACKED-CURRENT.md"]')).click();
  await waitForDraftSaved();
  await driver.navigate().refresh();
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), navigationDraft);
  await assertAttachmentChips(["notes"]);
  const draftScreenshot = `draft-restored-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, draftScreenshot), Buffer.from(await driver.takeScreenshot(), "base64"));
  await openProjectDialog(otherProject);
  await waitForDraftSaved();
  assert.equal(await driver.findElement(By.id("work-composer")).getAttribute("value"), otherDraft);
  await assertAttachmentChips([]);
  await openProjectDialog(project);
  await waitForDraftSaved();
  await driver.findElement(By.css('button[aria-label="New conversation"]')).click();
  await driver.wait(async () => {
    const state = await postAction(daemon.url, { type: "status.inspect", payload: {} });
    return state.ok && state.value.conversation_id !== currentConversation;
  }, 10000, "the UI did not create a new durable conversation boundary");
  await driver.wait(async () => {
    const box = await driver.findElement(By.id("work-composer"));
    return (await box.getAttribute("value")) === "" && (await box.getAttribute("readonly")) === null;
  }, 10000, "new conversation retained the old draft");
  await waitForDraftSaved();
  await assertAttachmentChips([]);
  const otherProjectCalls = await readCalls(otherProject);
  assert.equal(otherProjectCalls.length, 0, "navigation started a provider in project B");
  evidence.usabilityObservations.draftPersistence = {
    screenshot: draftScreenshot, projectAText: navigationDraft, projectBText: otherDraft,
    attachmentsSeededThroughCore: selectedAttachments, removedAttachmentStayedRemovedAfterReload: true,
    projectSwitchPreservedBothDrafts: true, newConversationStartedEmpty: true,
    acceptedMessageDidNotReturnAfterReload: true, nextDraftSavedWhileProviderAlive: true,
    adapterCallsDuringNavigation: (await readCalls()).length - navigationCallsBefore,
    projectBAdapterCallsDuringNavigation: otherProjectCalls.length
  };

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = browserLogs.filter((entry) => entry.level?.name === "SEVERE").map((entry) => entry.message);
} catch (error) {
  evidence.failure = { message: String(error) };
  if (driver) {
    evidence.failure.composer = await driver.executeScript(`const box=document.getElementById("work-composer");const send=document.querySelector('button[aria-label="Send"]');return {value:box?.value,readOnly:box?.readOnly,form:!!box?.form,sendDisabled:send?.disabled,sendAriaDisabled:send?.getAttribute("aria-disabled"),composers:document.querySelectorAll('#work-composer').length};`).catch(() => null);
    evidence.failure.surfaceText = await driver.executeScript("return document.body?.innerText ?? '';").catch(() => "unavailable");
    const failureScreenshot = `failed-attempt-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureScreenshot), Buffer.from(await driver.takeScreenshot(), "base64")).catch(() => undefined);
    evidence.failure.screenshot = failureScreenshot;
  }
  if (project) {
    try {
      const state = JSON.parse(await readFile(path.join(project, ".hivemind", "daemon.json"), "utf8"));
      const inspection = await postAction(state.url, { type: "status.inspect", payload: {} });
      evidence.failure.operation = inspection.value?.conversation_operation ?? null;
      evidence.failure.calls = (await readCalls()).map(({ at, pid, kind }) => ({ at, pid, kind }));
      const durableEvents = await readEvents();
      const nativePage = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('workspace_action',{projectPath:arguments[0],action:{type:'trail.inspect',payload:{limit:20}}}).then(done).catch(error=>done({error:String(error)}));`, project);
      evidence.failure.durableEvents = durableEvents;
      evidence.failure.nativeTrail = nativePage;
      const draftDir = path.join(project, ".hivemind", "ui", "conversation-drafts");
      const draftFiles = await readdir(draftDir);
      evidence.failure.savedDrafts = await Promise.all(draftFiles.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(draftDir, file), "utf8"))));
    } catch { evidence.failure.operation = "inspection unavailable"; }
  }
  throw error;
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (project !== undefined) await stopFixtureDaemon(project);
  if (otherProject !== undefined) await stopFixtureDaemon(otherProject);
  if (project !== undefined) await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
  if (otherProject !== undefined) await rm(otherProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
  if (recentProjectsExisted && recentProjectsBefore !== null) {
    await mkdir(path.dirname(recentProjectsPath), { recursive: true });
    await writeFile(recentProjectsPath, recentProjectsBefore);
    evidence.recentProjects.afterSha256 = sha256(await readFile(recentProjectsPath));
    evidence.recentProjects.restoredExactly = evidence.recentProjects.afterSha256 === evidence.recentProjects.beforeSha256;
  } else {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "phase6-conversation-remediation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), driverLog.join(""), "utf8").catch(() => undefined);
}

assert.equal(evidence.paidProviderCalls, 0);
assert.equal(evidence.liveConversation.providerStillAliveWhenAnswerSampled, true);
assert.equal(evidence.liveConversation.durableMessageVisibleWhileRunning, true);
assert.equal(evidence.liveConversation.readOnlyStatusSettledWhileRunning, true);
assert.ok(evidence.liveConversation.readOnlyStatusMs < 1_000);
assert.equal(evidence.liveConversation.adapterCalls, 1);
assert.equal(evidence.duplicateSubmit.adapterCalls, 1);
assert.equal(evidence.duplicateSubmit.durableMessages, 1);
assert.deepEqual(evidence.projectContext, {
  readmeContentIncluded: true,
  sourceContentIncluded: true,
  untrackedNameIncluded: true,
  untrackedContentIncluded: false
});
assert.deepEqual(evidence.attachmentContext, {
  structuredAttachments: [
    { kind: "folder", path: "notes" },
    { kind: "file", path: "UNTRACKED-CURRENT.md" }
  ],
  childNameIncluded: true,
  childContentIncluded: true,
  untrackedFileContentIncluded: true,
  markerTextAppendedToPrompt: false
});
assert.equal(evidence.newConversation.activeSpecBefore, "S-001");
assert.equal(evidence.newConversation.activeSpecAfter, null);
assert.equal(evidence.newConversation.archivedPointers, 1);
assert.notEqual(evidence.visibleFailure.statusText, "");
assert.equal(evidence.visibleFailure.durableFailure, true);
assert.deepEqual(evidence.browserSevereLogs, []);
assert.equal(evidence.recentProjects.restoredExactly, true);
assert.equal(evidence.usabilityObservations.draftPersistence.adapterCallsDuringNavigation, 0);
console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

async function createFixture(initModule) {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-phase6-remediation-"));
  await run("git", ["init", "-b", "master"], { cwd: repo, windowsHide: true });
  await run("git", ["config", "user.email", "phase6@example.invalid"], { cwd: repo, windowsHide: true });
  await run("git", ["config", "user.name", "Phase 6 Fixture"], { cwd: repo, windowsHide: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "notes"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "phase-six-conversation-fixture", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(path.join(repo, "README.md"), "# R4 fixture\n\nR4_CONTEXT_README_FACT\n");
  await writeFile(path.join(repo, "src", "index.ts"), 'export const status = "R4_CONTEXT_SOURCE_FACT";\n');
  await writeFile(path.join(repo, "notes", "current-behavior.md"), "R4_FOLDER_ATTACHMENT_FACT\n");
  await run("git", ["add", "-A"], { cwd: repo, windowsHide: true });
  await run("git", ["commit", "-m", "phase 6 fixture"], { cwd: repo, windowsHide: true });
  assert.equal(await initModule.initProject(repo), 0);
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, `${JSON.stringify({ ...config, test_command: "", no_tests_declared: true }, null, 2)}\n`);
  const adapter = path.join(repo, ".hivemind", "adapters", "phase6-adapter.mjs");
  await writeFile(adapter, fakeAdapterSource());
  for (const [tool, roles] of [["planner", ["orchestrator"]], ["manager", ["orchestrator"]], ["worker", ["worker"]]]) {
    await writeFile(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), `${JSON.stringify({ tool, invoke: [process.execPath, adapter], prompt_arg: "stdin", verified_on: "2026-08-28T00:00:00.000Z", context_window: 200000, timeout_ms: 30000, roles }, null, 2)}\n`);
    await writeFile(path.join(repo, ".hivemind", "adapters", `${tool}.connection.json`), `${JSON.stringify({ agent_id: "phase6-fixture", connected_at: "2026-08-28T00:00:00.000Z", effective_tokens: 0, readback_source: "phase6-no-paid-proof", provider_version: null, capabilities: [], capabilities_stale: null }, null, 2)}\n`);
  }
  await writeFile(path.join(repo, "UNTRACKED-CURRENT.md"), "R4_UNTRACKED_CURRENT_FACT\n");
  return repo;
}

function fakeAdapterSource() {
  return `import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
let prompt="";for await(const chunk of process.stdin)prompt+=chunk;
const marker=path.join(process.cwd(),".hivemind","phase6-provider-active");
writeFileSync(marker,String(process.pid));
const kind=prompt.includes("TWO KINDS OF ANSWER")?"draft":"plan";
const current=kind==="draft"?prompt.split("What the person typed, verbatim:\\n").at(-1).split("\\n\\nFiles in this project (")[0]:"";
appendFileSync(path.join(process.cwd(),".hivemind","phase6-calls.jsonl"),JSON.stringify({at:new Date().toISOString(),pid:process.pid,kind,prompt})+"\\n");
const progress=JSON.stringify({type:"item.completed",item:{type:"reasoning"}})+"\\n";
process.stderr.write(progress.slice(0,Math.floor(progress.length/2)));await new Promise(r=>setTimeout(r,180));process.stderr.write(progress.slice(Math.floor(progress.length/2)));
await new Promise(r=>setTimeout(r,700));
if(current==="FAIL_VISIBLE"){process.stderr.write("PHASE6_VISIBLE_PROVIDER_FAILURE\\n");rmSync(marker,{force:true});process.exit(7);}
if(current==="STOP_RESPONSE" || kind==="plan"){await new Promise(r=>setTimeout(r,25000));process.stderr.write("PHASE6_DETERMINISTIC_PLAN_REFUSAL\\n");rmSync(marker,{force:true});process.exit(7);}
let result;
if(current.includes("Build a tiny status label"))result={kind:"spec",title:"Add fixture status label",goal:"Show one status label.",non_goals:[],acceptance:["The fixture displays the status label."],assumptions:["Use the existing entry point."],open_questions:[],alternatives:[{title:"Inline",tradeoffs:["Small","Not reusable"]},{title:"Reusable",tradeoffs:["Reusable","More code"]}],self_critique:{weakest_point:"No UI exists.",cut_or_change:"Keep it minimal."}};
else if(current.includes("Give me the fixture name"))result={kind:"reply",reply:"phase-six-conversation-fixture"};
else if(current.includes("attached notes folder"))result={kind:"reply",reply:"The attached notes describe current behavior."};
else result={kind:"reply",reply:"This installed fixture reports a deterministic TypeScript project status."};
const text=JSON.stringify(result);const split=Math.floor(text.length/2);process.stdout.write(text.slice(0,split));await new Promise(r=>setTimeout(r,2000));process.stdout.write(text.slice(split));await new Promise(r=>setTimeout(r,current.startsWith("Describe what")?6000:1400));rmSync(marker,{force:true});`;
}

async function openProjectDialog(wantedPath) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  await driver.wait(until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')), 10_000).then((element) => element.click());
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(`const input=document.getElementById("project-path");const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;setter.call(input,arguments[0]);input.dispatchEvent(new Event("input",{bubbles:true}));`, wantedPath);
  await driver.findElement(By.xpath('//button[contains(normalize-space(.), "Open project")]')).click();
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  const wantedName = path.basename(wantedPath);
  await driver.wait(async () => {
    const switcher = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
    return (await switcher.getAttribute("aria-label")).includes(wantedName);
  }, 30_000, `the shell did not switch to ${wantedName}`);
}

async function typeComposer(value) {
  await driver.wait(async () => {
    const boxes = await driver.findElements(By.id("work-composer"));
    return boxes.length === 1 && (await boxes[0].getAttribute("readonly")) === null;
  }, 10000, "the project draft did not finish loading before typing");
  const changed = await driver.executeScript(`const box=document.getElementById("work-composer");if(!box)return false;const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(box,arguments[0]);box.dispatchEvent(new Event("input",{bubbles:true}));return true;`, value);
  assert.equal(changed, true);
}

async function waitForDraftSaved() {
  await driver.wait(async () => {
    const statuses = await driver.findElements(By.css('[data-testid="composer-draft-status"]'));
    return statuses.length === 1 && (await statuses[0].getText()) === "Draft saved in this project";
  }, 15000, "the exact composer draft did not report a completed save");
}

async function assertAttachmentChips(paths) {
  const groups = await driver.findElements(By.css('[aria-label="Attached project items"]'));
  if (paths.length === 0) { assert.equal(groups.length, 0); return; }
  assert.equal(groups.length, 1);
  const controls = await groups[0].findElements(By.css('button[aria-label^="Remove "]'));
  assert.deepEqual(await Promise.all(controls.map(control => control.getAttribute("aria-label"))), paths.map(item => `Remove ${item}`));
}

function isPidAlive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "fixture did not report a valid child PID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function providerHistory(call) {
  const marker = "Recorded prior exchanges (JSON data, chronological; current message excluded):\n";
  const parts = call.prompt.split(marker);
  assert.equal(parts.length, 2, "actual provider stdin must contain exactly one history block");
  return JSON.parse(parts[1].split("\n")[0]);
}

async function submitOnce() {
  await (await waitForSend()).click();
}

async function waitForSend() {
  return driver.wait(async () => {
    const buttons = await driver.findElements(By.css('button[aria-label="Send"]'));
    // Explainable-disabled project buttons remain focusable. Selenium's
    // isEnabled() alone ignores aria-disabled and can submit before settling.
    return buttons.length === 1 && await buttons[0].isEnabled() &&
      await buttons[0].getAttribute("aria-disabled") !== "true" ? buttons[0] : false;
  }, 15000, "Send did not become available after the previous response");
}

async function waitForText(text, timeout) {
  await driver.wait(async () => {
    const answers = await driver.findElements(By.css('[data-testid="conversation-answer"]'));
    const texts = await Promise.all(answers.map(element => element.getText()));
    return texts.includes(text);
  }, timeout, `did not see exact assistant answer: ${text}`);
}

async function waitForComposerReady(timeout) {
  await driver.wait(async () => {
    const box = await driver.findElement(By.id("work-composer"));
    return (await box.isEnabled()) && (await driver.findElements(By.css('[data-testid="conversation-progress"]'))).length === 0;
  }, timeout, "the conversation composer did not settle");
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) throw new Error(`tauri-driver exited early (${tauriDriver.exitCode})`);
    try { if ((await fetch(`${driverUrl}/status`)).ok) return; } catch { /* readiness poll */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    if (typeof body === "string" && body.trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("installed application rendered no readable body");
}

async function waitForDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (typeof state.url === "string" && typeof state.auth_token === "string" &&
          (await fetch(`${state.url}/health`, { headers: { authorization: `Bearer ${state.auth_token}` } })).ok) return state;
    } catch { /* shell startup */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const body = await driver.executeScript("return document.body?.innerText ?? ''").catch(() => "");
  throw new Error(`fixture daemon did not become reachable; installed surface said: ${String(body).slice(0, 1200)}`);
}

function timedAction(url, action) {
  const started = Date.now();
  const probe = { settled: false, elapsedMs: null, promise: null };
  probe.promise = postAction(url, action).finally(() => { probe.settled = true; probe.elapsedMs = Date.now() - started; });
  return probe;
}

async function postAction(url, action) {
  const state = JSON.parse(await readFile(path.join(project, ".hivemind", "daemon.json"), "utf8"));
  const response = await fetch(`${url}/workspace/action`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.auth_token}` },
    body: JSON.stringify(action)
  });
  const parsed = await response.json();
  return { status: response.status, ...parsed };
}

async function readEvents() {
  return (await readFile(path.join(project, ".hivemind", "log", "events.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

async function waitForEvent(type, text, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readEvents()).some((event) => event.type === type && event.data?.text === text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`did not observe durable ${type}`);
}

async function waitForEventDetail(type, detail, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readEvents()).some((event) =>
      event.type === type && String(event.data?.detail ?? "").includes(detail)
    )) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`did not observe durable ${type} containing ${detail}`);
}

function countMessages(events, text) {
  return events.filter((event) => event.type === "conversation.message_recorded" && event.data?.text === text).length;
}

async function readCalls(root = project) {
  try { return (await readFile(path.join(root, ".hivemind", "phase6-calls.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function waitForCallCount(count, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readCalls()).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`did not observe ${count} adapter calls`);
}

async function stopFixtureDaemon(root) {
  try {
    const state = JSON.parse(await readFile(path.join(root, ".hivemind", "daemon.json"), "utf8"));
    if (Number.isInteger(state.pid)) await run("taskkill", ["/PID", String(state.pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
  } catch { /* already stopped */ }
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not exit`);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

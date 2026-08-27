/**
 * No-cost Phase 3 audit probe for conversation and orchestration in the
 * INSTALLED application.
 *
 * It uses a deterministic local adapter, never a provider. The adapter pauses
 * long enough to sample the installed surface while an action is in flight and
 * records the exact prompts Core supplied. The temporary project and the
 * user's recent-project registry are restored in `finally`.
 *
 * Usage: node e2e/phase3-conversation-audit.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedInit = path.join(installedRoot, "core", "dist", "src", "init.js");
const installedActivity = path.join(installedRoot, "core", "dist", "src", "agent-activity.js");
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  "full-audit-phase3-26.826.1622"
);

let tauriDriver;
let driver;
let fixtureRoot;
let project;
let recentProjectsBefore = null;
let eventStream;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion: "26.826.1622",
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  firstQuestion: {},
  doubleSubmit: {},
  folderAttachmentContext: {},
  activeSpecRouting: {},
  newConversation: {},
  contextAssembly: {},
  activityDecoder: {},
  browserSevereLogs: [],
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(installedInit), `installed init module missing: ${installedInit}`);
  assert.ok(existsSync(installedActivity), `installed activity decoder missing: ${installedActivity}`);
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
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "hivemind-phase3-audit-"));
  assert.equal(
    path.dirname(fixtureRoot),
    path.resolve(os.tmpdir()),
    "the audit fixture must stay inside the system temporary directory"
  );
  project = path.join(fixtureRoot, "conversation-project");
  await createFixture(project);

  if (existsSync(recentProjectsPath)) {
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  const activityModule = await import(pathToFileURL(installedActivity).href);
  const wholeCodexLine = JSON.stringify({
    type: "item.completed",
    item: { type: "reasoning", text: "Inspecting project files" }
  });
  const splitAt = Math.floor(wholeCodexLine.length / 2);
  evidence.activityDecoder = {
    wholeCodexRecord: activityModule.activityLines([`${wholeCodexLine}\n`]),
    sameRecordSplitAcrossChunks: activityModule.activityLines([
      wholeCodexLine.slice(0, splitAt),
      `${wholeCodexLine.slice(splitAt)}\n`
    ]),
    plainProgress: activityModule.activityLines(["Inspecting project files\n"]),
    claudeStreamJson: activityModule.activityLines([
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Inspecting project files" }] } })}\n`
    ])
  };

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
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 }).catch(
    () => undefined
  );
  await openProjectDialog(project);
  await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);
  await waitForText("Nothing running", 30_000);

  const daemon = await waitForDaemon(project);
  eventStream = collectEventStream(`${daemon.url}/events/stream`);
  await eventStream.ready;

  /* The event is durable almost immediately, but the live event stream and a
     second read-only action are both held behind the full provider call. */
  const firstQuestion = "Describe what this project does, in one sentence.";
  await typeComposer(firstQuestion);
  const firstSentAt = Date.now();
  await submitOnce();
  await waitForEvent(project, "conversation.message_recorded", firstQuestion, 4_000);
  const statusProbe = timedWorkspaceAction(daemon.url, { type: "status.inspect", payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const duringFirst = await bodyText();
  const diskDuringFirst = await readEvents(project);
  evidence.firstQuestion = {
    typed: firstQuestion,
    diskRecordedWhileCallRunning: hasConversationMessage(diskDuringFirst, firstQuestion),
    visibleInThreadWhileCallRunning: duringFirst.includes(firstQuestion),
    workingIndicatorVisible: duringFirst.includes("Planner is reading your request"),
    activityVisible: duringFirst.includes("Thinking"),
    liveEventDeliveredWhileCallRunning: eventStream.messages.some(
      (entry) => entry.receivedAt < Date.now() && entry.message?.event?.type === "conversation.message_recorded" && entry.message.event.data?.text === firstQuestion
    ),
    readOnlyStatusSettledWhileCallRunning: statusProbe.settled
  };
  await capture("01-first-question-in-flight");

  const firstReply = "This fixture is a small status-reporting TypeScript project.";
  await driver.wait(
    async () => (await bodyText()).includes(firstReply),
    30_000,
    "the deterministic first reply never appeared"
  );
  await statusProbe.promise;
  const firstFinishedAt = Date.now();
  const firstCalls = await readCalls(project);
  const firstDraftCall = firstCalls.find((call) => call.kind === "draft");
  evidence.firstQuestion = {
    ...evidence.firstQuestion,
    replied: firstReply,
    providerDurationMs: firstFinishedAt - firstSentAt,
    readOnlyStatusBlockedMs: statusProbe.elapsedMs,
    liveMessageDeliveryDelayMs: eventStream.messages.find(
      (entry) => entry.message?.event?.type === "conversation.message_recorded" && entry.message.event.data?.text === firstQuestion
    )?.receivedAt - firstSentAt,
    visibleAfterCall: (await bodyText()).includes(firstQuestion),
    capturedPromptKind: firstDraftCall?.kind ?? null
  };
  await capture("02-first-question-answered");

  const capturedPrompt = firstDraftCall?.prompt ?? "";
  evidence.contextAssembly = {
    trackedReadmeContentIncluded: capturedPrompt.includes("A deterministic fixture used to audit conversation behavior."),
    trackedSourceContentIncluded: capturedPrompt.includes("phaseThreeStatus"),
    untrackedFileNameIncluded: capturedPrompt.includes("UNTRACKED-CURRENT.md"),
    untrackedFileContentIncluded: capturedPrompt.includes("LATEST_UNCOMMITTED_BEHAVIOR")
  };

  /* Two submits in one browser turn reach React before its asynchronous busy
     render can disable the control. This mirrors a fast Enter/click pair. */
  const duplicateQuestion = "Give me the fixture name.";
  const beforeDuplicateCalls = (await readCalls(project)).length;
  await typeComposer(duplicateQuestion);
  await driver.executeScript(
    `const form = document.getElementById("work-composer")?.form;
     if (!form) return false;
     form.requestSubmit();
     form.requestSubmit();
     return true;`
  );
  await waitForCallCount(project, beforeDuplicateCalls + 2, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const duplicateCalls = (await readCalls(project)).slice(beforeDuplicateCalls);
  evidence.doubleSubmit = {
    typed: duplicateQuestion,
    synchronousSubmitCount: 2,
    adapterCallsObserved: duplicateCalls.length,
    identicalDraftPrompts: duplicateCalls.filter((call) => call.kind === "draft" && call.prompt.includes(duplicateQuestion)).length,
    durableMessageCountAtSecondCallStart: countConversationMessages(await readEvents(project), duplicateQuestion),
    workingIndicatorVisibleWhileSecondCallRuns: (await bodyText()).includes("Planner is reading your request")
  };
  await capture("03-double-submit-second-call-running");
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  evidence.doubleSubmit.durableMessageCountAfterSettle = countConversationMessages(
    await readEvents(project),
    duplicateQuestion
  );

  /* This is the exact text shape the attachment control appends for a folder.
     The folder's tracked child is named in the global file list, but the folder
     reference does not promote that child's contents into the bounded pack. */
  const folderReferenceQuestion =
    "Summarize the attached project folder.\n\nProject references:\n- @notes";
  const beforeFolderCalls = (await readCalls(project)).length;
  await typeComposer(folderReferenceQuestion);
  await submitOnce();
  await waitForCallCount(project, beforeFolderCalls + 1, 20_000);
  await waitForComposerReady(10_000);
  const folderCall = (await readCalls(project)).at(beforeFolderCalls);
  evidence.folderAttachmentContext = {
    submittedTextShape: folderReferenceQuestion,
    childFileNameListed: folderCall?.prompt.includes("notes/current-behavior.yaml") ?? false,
    childFileContentIncluded: folderCall?.prompt.includes("FOLDER_ATTACHMENT_ONLY_FACT") ?? false
  };

  /* Create a valid active spec. The deterministic planner then refuses the
     separate plan.prepare call, leaving the spec active and no plan waiting. */
  const buildRequest = "Build a tiny status label for this fixture.";
  const beforeBuildCalls = (await readCalls(project)).length;
  await typeComposer(buildRequest);
  await submitOnce();
  await waitForCallCount(project, beforeBuildCalls + 2, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const duringPlanPrepare = await bodyText();
  evidence.activeSpecRouting.planPrepareProgress = {
    genericWaitVisible: duringPlanPrepare.includes("Planner is reading your request"),
    adapterActivityVisible: duringPlanPrepare.includes("Thinking")
  };
  await capture("04-plan-prepare-in-flight");
  await waitForComposerReady(10_000);
  const afterBuildInspection = await postWorkspaceAction(daemon.url, {
    type: "status.inspect",
    payload: {}
  });
  evidence.activeSpecRouting = {
    ...evidence.activeSpecRouting,
    buildRequest,
    activeSpecAfterPlanFailure: afterBuildInspection.value?.active_spec_id ?? null,
    planAfterFailure: afterBuildInspection.value?.plan ?? null
  };
  await capture("05-active-spec-plan-failure");

  /* This is still a question, but the client skips spec.draft once an active
     spec exists and sends it straight to plan.prepare. */
  const bypassedQuestion = "What does this project do now?";
  const beforeBypassCalls = (await readCalls(project)).length;
  const bypassEventsBefore = await readEvents(project);
  await typeComposer(bypassedQuestion);
  await submitOnce();
  await waitForCallCount(project, beforeBypassCalls + 1, 20_000);
  await waitForComposerReady(10_000);
  const bypassCalls = (await readCalls(project)).slice(beforeBypassCalls);
  const bypassEventsAfter = await readEvents(project);
  evidence.activeSpecRouting = {
    ...evidence.activeSpecRouting,
    typedQuestion: bypassedQuestion,
    adapterCallKinds: bypassCalls.map((call) => call.kind),
    reachedConversationClassifier: bypassCalls.some((call) => call.kind === "draft"),
    durableMessageAdded: countConversationMessages(bypassEventsAfter, bypassedQuestion) > countConversationMessages(bypassEventsBefore, bypassedQuestion),
    composerClearedAfterFailure: await composerValue() === "",
    visibleInThreadAfterFailure: (await bodyText()).includes(bypassedQuestion)
  };
  await capture("06-question-bypassed-conversation");

  /* A new-conversation boundary changes presentation history only. The active
     spec remains, so the first question in the supposedly fresh conversation
     takes the same planning path. */
  const newConversationButton = await driver.wait(
    until.elementLocated(By.xpath('//button[contains(normalize-space(.), "New conversation")]')),
    15_000
  );
  await newConversationButton.click();
  await waitForText("New conversation. The run has ended", 15_000);
  const afterNewConversation = await postWorkspaceAction(daemon.url, {
    type: "status.inspect",
    payload: {}
  });
  const freshQuestion = "Can you summarize this supposedly fresh conversation?";
  const beforeFreshCalls = (await readCalls(project)).length;
  await typeComposer(freshQuestion);
  await submitOnce();
  await waitForCallCount(project, beforeFreshCalls + 1, 20_000);
  await waitForComposerReady(10_000);
  const freshCalls = (await readCalls(project)).slice(beforeFreshCalls);
  evidence.newConversation = {
    feedbackClaimedClearSlate: true,
    activeSpecStillPresent: afterNewConversation.value?.active_spec_id ?? null,
    planStillPresent: afterNewConversation.value?.plan ?? null,
    firstAdapterCallKinds: freshCalls.map((call) => call.kind),
    firstQuestionReachedConversationClassifier: freshCalls.some((call) => call.kind === "draft"),
    firstQuestionRecorded: hasConversationMessage(await readEvents(project), freshQuestion)
  };
  await capture("07-new-conversation-still-bound-to-spec");

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = browserLogs
    .filter((entry) => entry.level?.name === "SEVERE")
    .map((entry) => entry.message);
  validateObservedFindings();
} finally {
  eventStream?.stop();
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (recentProjectsBefore !== null) {
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly = sha256(restored) === sha256(recentProjectsBefore);
  }
  if (project !== undefined) {
    await stopFixtureDaemon(project);
  }
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "phase3-conversation-audit.json"),
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
  assert.equal(evidence.paidProviderCalls, 0);
  assert.equal(evidence.firstQuestion.diskRecordedWhileCallRunning, true);
  assert.equal(evidence.firstQuestion.visibleInThreadWhileCallRunning, false);
  assert.equal(evidence.firstQuestion.liveEventDeliveredWhileCallRunning, false);
  assert.equal(evidence.firstQuestion.readOnlyStatusSettledWhileCallRunning, false);
  assert.ok(evidence.firstQuestion.readOnlyStatusBlockedMs >= 2_000);
  assert.equal(evidence.doubleSubmit.identicalDraftPrompts, 2);
  assert.equal(evidence.doubleSubmit.durableMessageCountAfterSettle, 2);
  assert.equal(evidence.folderAttachmentContext.childFileNameListed, true);
  assert.equal(evidence.folderAttachmentContext.childFileContentIncluded, false);
  assert.equal(evidence.activeSpecRouting.activeSpecAfterPlanFailure, "S-001");
  assert.deepEqual(evidence.activeSpecRouting.adapterCallKinds, ["plan"]);
  assert.equal(evidence.activeSpecRouting.reachedConversationClassifier, false);
  assert.equal(evidence.activeSpecRouting.durableMessageAdded, false);
  assert.equal(evidence.activeSpecRouting.composerClearedAfterFailure, true);
  assert.equal(evidence.activeSpecRouting.visibleInThreadAfterFailure, false);
  assert.equal(evidence.activeSpecRouting.planPrepareProgress?.genericWaitVisible, true);
  assert.equal(evidence.activeSpecRouting.planPrepareProgress?.adapterActivityVisible, false);
  assert.equal(evidence.newConversation.activeSpecStillPresent, "S-001");
  assert.deepEqual(evidence.newConversation.firstAdapterCallKinds, ["plan"]);
  assert.equal(evidence.newConversation.firstQuestionRecorded, false);
  assert.equal(evidence.contextAssembly.trackedReadmeContentIncluded, true);
  assert.equal(evidence.contextAssembly.trackedSourceContentIncluded, true);
  assert.equal(evidence.contextAssembly.untrackedFileNameIncluded, false);
  assert.equal(evidence.contextAssembly.untrackedFileContentIncluded, false);
  assert.deepEqual(evidence.activityDecoder.wholeCodexRecord, ["Thinking"]);
  assert.deepEqual(evidence.activityDecoder.sameRecordSplitAcrossChunks, []);
  assert.deepEqual(evidence.activityDecoder.plainProgress, []);
  assert.deepEqual(evidence.activityDecoder.claudeStreamJson, []);
  assert.deepEqual(evidence.browserSevereLogs, []);
}

async function createFixture(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "phase-three-conversation-fixture", private: true, type: "module" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "README.md"),
    "# Conversation fixture\n\nA deterministic fixture used to audit conversation behavior.\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "src", "index.ts"),
    'export function phaseThreeStatus(): string { return "ready"; }\n',
    "utf8"
  );
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(
    path.join(root, "notes", "current-behavior.yaml"),
    "audit_fact: FOLDER_ATTACHMENT_ONLY_FACT\n",
    "utf8"
  );
  await gitInitAndCommit(root);

  const initModule = await import(pathToFileURL(installedInit).href);
  assert.equal(await initModule.initProject(root), 0, "installed Core could not initialize the fixture");
  const configPath = path.join(root, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, test_command: "", no_tests_declared: true }, null, 2)}\n`,
    "utf8"
  );

  const fakeAdapter = path.join(root, ".hivemind", "adapters", "phase3-fake-adapter.mjs");
  await writeFile(fakeAdapter, fakeAdapterSource(), "utf8");
  for (const [tool, roles] of [
    ["planner", ["orchestrator"]],
    ["manager", ["orchestrator"]],
    ["worker", ["worker"]]
  ]) {
    const profile = {
      tool,
      invoke: [process.execPath, fakeAdapter],
      prompt_arg: "stdin",
      verified_on: "2026-08-26T00:00:00.000Z",
      context_window: 200000,
      timeout_ms: 30000,
      roles
    };
    const connection = {
      agent_id: "codex-sol",
      connected_at: "2026-08-26T00:00:00.000Z",
      effective_tokens: 0,
      readback_source: "phase3-no-paid-audit",
      provider_version: null,
      capabilities: [],
      capabilities_stale: null
    };
    await writeFile(
      path.join(root, ".hivemind", "adapters", `${tool}.profile.json`),
      `${JSON.stringify(profile, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(root, ".hivemind", "adapters", `${tool}.connection.json`),
      `${JSON.stringify(connection, null, 2)}\n`,
      "utf8"
    );
  }

  await writeFile(
    path.join(root, "UNTRACKED-CURRENT.md"),
    "LATEST_UNCOMMITTED_BEHAVIOR is the behavior a current-project answer must see.\n",
    "utf8"
  );
}

function fakeAdapterSource() {
  return `import { appendFileSync } from "node:fs";
import path from "node:path";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const kind = prompt.includes("TWO KINDS OF ANSWER") ? "draft" : "plan";
appendFileSync(
  path.join(process.cwd(), ".hivemind", "phase3-calls.jsonl"),
  JSON.stringify({ at: new Date().toISOString(), kind, prompt }) + "\\n",
  "utf8"
);
process.stderr.write(JSON.stringify({
  type: "item.completed",
  item: { type: "reasoning", text: "Inspecting project files" }
}) + "\\n");
await new Promise((resolve) => setTimeout(resolve, kind === "draft" ? 3000 : 900));
if (kind === "plan") {
  process.stderr.write("PHASE3_DETERMINISTIC_PLAN_REFUSAL\\n");
  process.exitCode = 7;
} else if (prompt.includes("Build a tiny status label")) {
  process.stdout.write(JSON.stringify({
    kind: "spec",
    title: "Add fixture status label",
    goal: "Show one small status label for the audit fixture.",
    non_goals: [],
    acceptance: ["The fixture displays the status label."],
    assumptions: ["Use the existing fixture entry point."],
    open_questions: [],
    alternatives: [
      { title: "Inline label", tradeoffs: ["Smallest change", "Limited reuse"] },
      { title: "Reusable component", tradeoffs: ["Reusable", "More structure"] }
    ],
    self_critique: { weakest_point: "The fixture has no UI.", cut_or_change: "Keep the label minimal." }
  }));
} else if (prompt.includes("Give me the fixture name")) {
  process.stdout.write(JSON.stringify({ kind: "reply", reply: "The fixture is phase-three-conversation-fixture." }));
} else {
  process.stdout.write(JSON.stringify({ kind: "reply", reply: "This fixture is a small status-reporting TypeScript project." }));
}
`;
}

async function gitInitAndCommit(root) {
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Audit"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "audit@invalid.local"], { cwd: root, windowsHide: true });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "phase 3 audit fixture"], { cwd: root, windowsHide: true });
}

async function openProjectDialog(wantedPath) {
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
    wantedPath
  );
  const openButton = await driver.wait(
    until.elementLocated(By.xpath('//button[contains(normalize-space(.), "Open project")]')),
    10_000
  );
  await openButton.click();
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
}

async function typeComposer(value) {
  const changed = await driver.executeScript(
    `const box = document.getElementById("work-composer");
     if (!box) return false;
     const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
     setter.call(box, arguments[0]);
     box.dispatchEvent(new Event("input", { bubbles: true }));
     return true;`,
    value
  );
  assert.equal(changed, true, "the installed composer was not reachable");
}

async function composerValue() {
  return driver.executeScript('return document.getElementById("work-composer")?.value ?? null;');
}

async function submitOnce() {
  const submitted = await driver.executeScript(
    `const form = document.getElementById("work-composer")?.form;
     if (!form) return false;
     form.requestSubmit();
     return true;`
  );
  assert.equal(submitted, true, "the installed composer form was not reachable");
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

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    if (typeof body === "string" && body.trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function waitForText(text, timeout) {
  await driver.wait(async () => (await bodyText()).includes(text), timeout, `did not see ${text}`);
}

async function waitForComposerReady(timeout) {
  await driver.wait(
    async () =>
      driver.executeScript(
        'return Boolean(document.querySelector("button[aria-label=\\"Send\\"][title=\\"Type something first\\"]"));'
      ),
    timeout,
    "the composer did not become ready"
  );
}

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

async function waitForDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (typeof state.url === "string" && state.url !== "") {
        const health = await fetch(`${state.url}/health`);
        if (health.ok) return state;
      }
    } catch {
      // The shell may still be starting the project daemon.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("the fixture daemon did not become reachable within 30 seconds");
}

function collectEventStream(url) {
  const controller = new AbortController();
  const messages = [];
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  void (async () => {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.ok, true, "event stream did not open");
    markReady();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffered += decoder.decode(part.value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/u);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/u).find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        try {
          messages.push({ receivedAt: Date.now(), message: JSON.parse(data.slice(6)) });
        } catch {
          // The malformed frame is evidence only if the app emits one; ignore comments.
        }
      }
    }
  })().catch((error) => {
    if (error?.name !== "AbortError") transport.push(`event stream ${String(error)}\n`);
    markReady();
  });
  return { messages, ready, stop: () => controller.abort() };
}

function timedWorkspaceAction(url, action) {
  const startedAt = Date.now();
  const probe = {
    settled: false,
    elapsedMs: null,
    promise: null
  };
  probe.promise = postWorkspaceAction(url, action).finally(() => {
    probe.settled = true;
    probe.elapsedMs = Date.now() - startedAt;
  });
  return probe;
}

async function postWorkspaceAction(url, action) {
  const response = await fetch(`${url}/workspace/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action)
  });
  const parsed = await response.json();
  if (!response.ok || parsed.ok !== true) {
    throw new Error(parsed.reason ?? `workspace action failed with ${response.status}`);
  }
  return parsed;
}

async function readEvents(root) {
  const text = await readFile(path.join(root, ".hivemind", "log", "events.jsonl"), "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function hasConversationMessage(events, text) {
  return countConversationMessages(events, text) > 0;
}

function countConversationMessages(events, text) {
  return events.filter(
    (event) => event.type === "conversation.message_recorded" && event.data?.text === text
  ).length;
}

async function waitForEvent(root, type, text, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readEvents(root)).some((event) => event.type === type && event.data?.text === text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`did not observe durable ${type} within ${timeout}ms`);
}

async function readCalls(root) {
  try {
    const text = await readFile(path.join(root, ".hivemind", "phase3-calls.jsonl"), "utf8");
    return text
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForCallCount(root, count, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await readCalls(root)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`did not observe ${count} deterministic adapter calls within ${timeout}ms`);
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
    // The exact fixture directory is removed below; stale state needs no action.
  }
}

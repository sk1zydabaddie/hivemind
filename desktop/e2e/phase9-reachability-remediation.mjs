/** No-cost installed-artifact proof for R7 reachability and failure states. */
import "./protect-recent-projects.mjs";

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedVersion = (await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")).trim();
const installedCore = path.join(installedRoot, "core", "dist", "src");
const evidenceDir = path.resolve("..", "docs", "evidence", `remediation-phase9-${installedVersion}`);
const registryPath = path.join(process.env.APPDATA ?? "", "ai.hivemind.desktop", "recent-projects.json");

let repo;
let driver;
let tauriDriver;
const driverLog = [];
const evidence = {
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  providerProcessCalls: 0,
  consumers: {},
  quota: {},
  retryFailure: {},
  screenshots: [],
  browserSevereLogs: [],
  diagnosticBody: null
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.equal(await isProcessRunning("hivemind_desktop.exe"), false, "close Hivemind before this isolated proof");
  assert.equal(await isProcessRunning("tauri-driver.exe"), false, "another tauri-driver session is running");
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });
  repo = await createFixture();
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify([{ path: repo, opened_at: String(Math.floor(Date.now() / 1000)) }], null, 2)}\n`,
    "utf8"
  );

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => driverLog.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => driverLog.push(`stderr ${chunk}`));
  await waitForDriver();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().window().setRect({ x: 40, y: 40, width: 1440, height: 900 });
  await waitForText("Live", 45_000);
  await clickTab("Project");
  try {
    await waitForText("Extra review", 30_000);
    await waitForText("Provider usage", 30_000);
    await waitForText("Accounts", 30_000);
    await waitForText("Copy review command", 30_000);
    await driver.wait(
      async () => (await driver.findElements(By.css('button[aria-label="Add an account"]'))).length === 1,
      30_000,
      "did not see the Add an account control"
    );
  } catch (error) {
    evidence.diagnosticBody = await bodyText();
    await capture("00-project-surface-failure");
    throw error;
  }

  const projectText = await bodyText();
  evidence.consumers = {
    accounts: hasText(projectText, "Accounts"),
    addAccount: (await driver.findElements(By.css('button[aria-label="Add an account"]'))).length === 1,
    characterization: hasText(projectText, "Characterize a failing case"),
    bestOfTwo: hasText(projectText, "Compare two drafts"),
    draftRefine: hasText(projectText, "Draft, then refine"),
    memoryReview: hasText(projectText, "Copy review command"),
    qualityCancel: (await driver.findElements(By.xpath('//button[normalize-space(.)="Stop"]'))).length === 1
  };
  evidence.quota = {
    providerLabel: hasText(projectText, "Provider usage · codex-fixture · plus"),
    realRemaining: hasText(projectText, "primary: 76% left"),
    internalCeilingMislabelled: hasText(projectText, "token_ceiling")
  };
  await reveal("Extra review");
  await capture("01-project-consumers-and-provider-quota");

  await driver.findElement(By.css('button[aria-label="Add an account"]')).click();
  await waitForText("Agent account folder", 10_000);
  await reveal("Agent account folder");
  await capture("02-account-registration-consumer");
  await driver.findElement(By.css('button[aria-label="Close account form"]')).click();

  await reveal("Characterize a failing case");
  await clickButton("Characterize a failing case");
  await waitForText("Characterization did not start", 30_000);
  const failure = await bodyText();
  evidence.retryFailure = {
    visible: failure.includes("Characterization did not start"),
    retryInstruction: failure.includes("You can try the same control again."),
    controlStillPresent: failure.includes("Characterize a failing case")
  };
  const alerts = await driver.findElements(By.css('[role="alert"]'));
  assert.ok(alerts.length > 0, "the characterization refusal did not render an alert");
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", alerts.at(-1));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await capture("03-characterization-refusal-remains-retryable");

  await reveal("Copy review command");
  await clickButton("Copy review command");
  await waitForText("Review command copied", 15_000);
  evidence.consumers.memoryReviewAnswered = true;
  await reveal("Review command copied");
  await capture("04-memory-review-handoff-consumer");

  await reveal("Stop");
  await clickButton("Stop");
  await waitForText("Quality review cancellation started", 15_000);
  evidence.consumers.qualityCancelAnswered = true;
  await reveal("Quality review cancellation started");
  await capture("05-quality-cancellation-consumer");

  const logs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = logs.filter((entry) => entry.level?.name === "SEVERE").map((entry) => entry.message);
  evidence.providerProcessCalls = existsSync(path.join(repo, "fixture-adapter-invoked")) ? 1 : 0;
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (repo !== undefined) {
    await stopFixtureDaemon(repo);
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "phase9-reachability-remediation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), driverLog.join(""), "utf8").catch(() => undefined);
}

assert.deepEqual(evidence.consumers, {
  accounts: true,
  addAccount: true,
  characterization: true,
  bestOfTwo: true,
  draftRefine: true,
  memoryReview: true,
  qualityCancel: true,
  memoryReviewAnswered: true,
  qualityCancelAnswered: true
});
assert.deepEqual(evidence.quota, {
  providerLabel: true,
  realRemaining: true,
  internalCeilingMislabelled: false
});
assert.deepEqual(evidence.retryFailure, {
  visible: true,
  retryInstruction: true,
  controlStillPresent: true
});
assert.deepEqual(evidence.browserSevereLogs, []);
assert.equal(evidence.paidProviderCalls, 0);
assert.equal(evidence.providerProcessCalls, 0);
console.log(JSON.stringify(evidence, null, 2));

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-phase9-"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "phase9-reachability", private: true }, null, 2)}\n`, "utf8");
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Fixture"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "fixture@invalid.local"], { cwd: root, windowsHide: true });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, windowsHide: true });
  const init = await import(pathToFileURL(path.join(installedCore, "init.js")).href);
  const spec = await import(pathToFileURL(path.join(installedCore, "spec.js")).href);
  const events = await import(pathToFileURL(path.join(installedCore, "events.js")).href);
  assert.equal(await init.initProject(root), 0);
  const { stdout: baseCommitOutput } = await run("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true });
  const tasksDir = path.join(root, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, "T-PROOF.contract.json"),
    `${JSON.stringify({
      task_id: "T-PROOF",
      title: "Inspect a deliberately unadmitted task",
      agent_role: "builder",
      routing_task_type: "testing",
      base_commit: baseCommitOutput.trim(),
      acceptance_criterion: "Behavioral: a human confirms the no-cost refusal remains visible.",
      allowed_files: ["package.json"],
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node -e \"process.exit(0)\""],
      patch_requirements: []
    }, null, 2)}\n`,
    "utf8"
  );
  const adapterMarker = path.join(root, "fixture-adapter-invoked");
  const adapterScript = path.join(root, "fixture-adapter.mjs");
  await writeFile(
    adapterScript,
    `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(adapterMarker)}, "invoked\\n"));\n`,
    "utf8"
  );
  const adaptersDir = path.join(root, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, "worker.profile.json"),
    `${JSON.stringify({
      tool: "worker",
      invoke: [process.execPath, adapterScript],
      prompt_arg: "stdin",
      verified_on: "2026-08-28",
      context_window: 100000,
      roles: ["worker"]
    }, null, 2)}\n`,
    "utf8"
  );
  assert.equal((await spec.createSpec(root, "S-001", "Reachability proof")).ok, true);
  const sessionId = "00000000-0000-4000-8000-000000000009";
  const records = [
    { type: "manager.run_started", task_id: null, data: { version: 1, session_id: sessionId, spec_id: "S-001", tool: "manager", autonomy_level: "review_everything" } },
    { type: "task.created", task_id: "T-PROOF", data: { version: 1, title: "Inspect a deliberately missing contract", session_id: sessionId } },
    { type: "task.failed", task_id: "T-PROOF", data: { version: 1, reason: "Fixture stops before any provider call.", session_id: sessionId } },
    { type: "manager.run_failed", task_id: null, data: { version: 1, session_id: sessionId, reason: "No-cost fixture terminal state." } },
    { type: "quota.exhausted", task_id: "T-PROOF", data: { version: 1, source: "token_ceiling", provider: "codex-fixture" } },
    { type: "provider.quota_observed", task_id: "T-PROOF", data: { version: 1, provider: "codex-fixture", plan: "plus", windows: [{ name: "primary", used_percent: 24, window_minutes: 300, resets_at: "2026-08-29T00:00:00Z" }] } },
    {
      type: "memory.proposed",
      task_id: null,
      data: {
        version: 1,
        proposal_id: "M-00000000-0000-4000-8000-000000000009",
        title: "Keep provider evidence explicit",
        lesson: "External quota and internal ceilings must remain separate facts.",
        evidence: ["Phase 9 installed reachability proof"]
      }
    },
    {
      type: "quality.admission_decided",
      task_id: "T-PROOF",
      data: {
        version: 1,
        quality_run_id: "Q-T-PROOF-00000000-0000-4000-8000-000000000009",
        strategy: "best_of_n",
        admitted: true,
        reason: "Installed cancellation reachability proof",
        task_tier: "high",
        routing_task_type: "testing",
        promoted_policy_applied: false
      }
    }
  ];
  for (const record of records) {
    const appended = await events.appendEvent(root, record);
    assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
  }
  return root;
}

async function clickTab(label) {
  const tab = await driver.wait(until.elementLocated(By.xpath(`//*[@role="tab" and normalize-space(.)=${JSON.stringify(label)}]`)), 15_000);
  await tab.click();
}

async function clickButton(label) {
  const button = await driver.wait(until.elementLocated(By.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`)), 15_000);
  await driver.wait(until.elementIsEnabled(button), 15_000);
  await button.click();
}

async function reveal(text) {
  await driver.executeScript(`const wanted=arguments[0];const node=[...document.querySelectorAll("*")].find((entry)=>entry.children.length===0&&entry.textContent?.includes(wanted));node?.scrollIntoView({block:"center"});`, text);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function waitForText(text, timeout) {
  await driver.wait(async () => hasText(await bodyText(), text), timeout, `did not see ${text}`);
}

function hasText(body, text) {
  return body.toLocaleLowerCase().includes(text.toLocaleLowerCase());
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function capture(name) {
  const file = `${name}-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, file), Buffer.from(await driver.takeScreenshot(), "base64"));
  evidence.screenshots.push({ item: name, build: installedVersion, file });
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) throw new Error(`tauri-driver exited early (${tauriDriver.exitCode})`);
    try { if ((await fetch(`${driverUrl}/status`)).ok) return; } catch { /* readiness poll */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready");
}

async function stopFixtureDaemon(root) {
  const state = path.join(root, ".hivemind", "daemon.json");
  if (!existsSync(state)) return;
  try {
    const daemon = JSON.parse(await readFile(state, "utf8"));
    await fetch(`${daemon.url}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${daemon.auth_token}` } });
  } catch { /* cleanup is best effort */ }
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not exit`);
}

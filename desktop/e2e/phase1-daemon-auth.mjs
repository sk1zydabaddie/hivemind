/**
 * Installed Phase 1 proof. It opens a disposable project through the installed
 * shell, requires the browser SSE client and Rust action transport to work,
 * then attacks the same daemon from an ordinary credential-free process.
 * The per-session credential is validated in memory and never written to
 * evidence, logs, filenames, or console output.
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedVersion = (
  await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `remediation-phase1-${installedVersion}`
);
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const coreCli = path.resolve("..", "dist", "src", "cli.js");

let driver;
let tauriDriver;
let repo;
let daemonPid;
let authToken;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  projectConnection: {},
  daemonState: {},
  routeBoundary: {},
  browserSevereLogs: [],
  recentProjects: {},
  screenshot: null,
  error: null
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });

  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  repo = await createFixtureProject();
  await mkdir(path.dirname(recentProjectsPath), { recursive: true });
  await writeFile(
    recentProjectsPath,
    `${JSON.stringify([{ path: repo, opened_at: String(Math.floor(Date.now() / 1000)) }], null, 2)}\n`,
    "utf8"
  );

  tauriDriver = spawn("tauri-driver", [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${String(chunk)}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${String(chunk)}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
  await waitForBody();
  await waitForLiveConnection();

  const rustAction = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke("workspace_action", {
       projectPath: arguments[0],
       action: { type: "status.inspect", payload: {} }
     }).then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error) }));`,
    repo
  );
  assert.equal(rustAction.ok, true, `installed Rust action transport failed: ${JSON.stringify(rustAction)}`);
  evidence.projectConnection = {
    eventStreamOpened: true,
    rustWorkspaceActionSucceeded: true,
    selectedProjectNameVisible: (await bodyText()).includes(path.basename(repo))
  };

  const state = JSON.parse(
    await readFile(path.join(repo, ".hivemind", "daemon.json"), "utf8")
  );
  authToken = String(state.auth_token ?? "");
  daemonPid = Number(state.pid);
  assert.equal(state.version, 2);
  assert.match(authToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(String(state.url ?? ""), /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u);
  assert.equal(Number.isSafeInteger(daemonPid) && daemonPid > 0, true);
  evidence.daemonState = {
    version: state.version,
    credentialPresent: true,
    credentialShapeValid: true,
    credentialBytes: 32,
    loopbackUrl: true,
    pidPresent: true
  };

  const marker = path.join(repo, "credential-free-action-ran.txt");
  const unauthenticated = await fetch(`${state.url}/workspace/action`, {
    method: "POST",
    headers: {
      origin: "https://untrusted.example",
      "content-type": "text/plain"
    },
    body: JSON.stringify({
      type: "checks.try",
      payload: {
        command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`
      }
    })
  });
  const unauthenticatedBody = await unauthenticated.json();
  const wrongCredential = await fetch(`${state.url}/health`, {
    headers: { authorization: `Bearer ${"W".repeat(43)}` }
  });
  const hostileOrigin = await fetch(`${state.url}/health`, {
    headers: {
      authorization: `Bearer ${authToken}`,
      origin: "https://untrusted.example"
    }
  });
  const badContentType = await fetch(`${state.url}/workspace/action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "text/plain"
    },
    body: JSON.stringify({ type: "status.inspect", payload: {} })
  });
  const validAction = await fetch(`${state.url}/workspace/action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ type: "status.inspect", payload: {} })
  });
  const streamAbort = new AbortController();
  const validStream = await fetch(
    `${state.url}/events/stream?access_token=${encodeURIComponent(authToken)}`,
    {
      headers: { origin: "http://tauri.localhost" },
      signal: streamAbort.signal
    }
  );
  streamAbort.abort();

  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(unauthenticatedBody, {
    ok: false,
    reason: "daemon authentication required"
  });
  assert.equal(existsSync(marker), false, "credential-free request reached dispatcher execution");
  assert.equal(wrongCredential.status, 401);
  assert.equal(hostileOrigin.status, 403);
  assert.equal(badContentType.status, 415);
  assert.equal(validAction.status, 200);
  assert.equal(validStream.status, 200);
  assert.match(validStream.headers.get("content-type") ?? "", /^text\/event-stream/u);
  evidence.routeBoundary = {
    credentialFreeMutationStatus: unauthenticated.status,
    credentialFreeMutationExecuted: false,
    wrongCredentialStatus: wrongCredential.status,
    authenticatedHostileOriginStatus: hostileOrigin.status,
    authenticatedUnsupportedContentTypeStatus: badContentType.status,
    authenticatedActionStatus: validAction.status,
    authenticatedEventStreamStatus: validStream.status
  };

  await driver.findElement(By.css('button[aria-label="Settings"]')).click();
  await driver.wait(
    async () => (await bodyText()).includes(`This build is ${installedVersion}`),
    15_000,
    "Settings did not show the installed build number"
  );
  await driver.wait(
    async () => driver.executeScript(
      `const dialog = document.querySelector('[role="dialog"]');
       const line = [...(dialog?.querySelectorAll('p') ?? [])]
         .find((element) => (element.textContent ?? '').includes(arguments[0]));
       if (!line) return false;
       line.scrollIntoView({ block: 'center' });
       const rect = line.getBoundingClientRect();
       return rect.top >= 0 && rect.bottom <= window.innerHeight;`,
      `This build is ${installedVersion}`
    ),
    10_000,
    "Settings build label did not become visible for the installed screenshot"
  );
  const screenshot = path.join(
    evidenceDir,
    `installed-authenticated-${installedVersion}-1440x900.png`
  );
  await writeFile(screenshot, await driver.takeScreenshot(), "base64");
  evidence.screenshot = screenshot;

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = browserLogs.filter((entry) => entry.level?.name === "SEVERE");
  assert.deepEqual(severe, [], `installed WebView logged errors: ${JSON.stringify(severe)}`);
  evidence.browserSevereLogs = severe;
} catch (error) {
  evidence.error = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error), stack: null };
  throw error;
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  if (Number.isSafeInteger(daemonPid) && daemonPid > 0) {
    spawnSync("taskkill", ["/PID", String(daemonPid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
  }
  if (recentProjectsExisted && recentProjectsBefore !== null) {
    await mkdir(path.dirname(recentProjectsPath), { recursive: true });
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly =
      sha256(restored) === sha256(recentProjectsBefore);
  } else {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  if (authToken !== undefined) {
    assert.equal(transport.join("").includes(authToken), false, "driver output exposed the daemon credential");
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
  if (repo !== undefined) {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

assert.equal(evidence.recentProjects.restoredExactly, true);
assert.equal(evidence.error, null);
console.log(`installed daemon authentication passed for ${installedVersion}`);
console.log(`evidence: ${evidenceDir}`);

async function createFixtureProject() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hivemind-phase1-auth-"));
  await run("git", ["init", "-q"], { cwd: fixture, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Phase 1"], {
    cwd: fixture,
    windowsHide: true
  });
  await run("git", ["config", "user.email", "phase1@example.test"], {
    cwd: fixture,
    windowsHide: true
  });
  await writeFile(path.join(fixture, "README.md"), "# Phase 1 daemon authentication fixture\n");
  await run("git", ["add", "README.md"], { cwd: fixture, windowsHide: true });
  await run("git", ["commit", "-q", "-m", "fixture"], { cwd: fixture, windowsHide: true });
  await run(process.execPath, [coreCli, "init"], { cwd: fixture, windowsHide: true });
  return fixture;
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
      // Read-only readiness retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await bodyText()).trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function waitForLiveConnection() {
  await driver.wait(
    async () => driver.executeScript(
      `return [...document.querySelectorAll('[aria-live="polite"]')]
        .some((element) => (element.textContent ?? "").trim().toLowerCase() === "live");`
    ),
    30_000,
    "the installed browser client did not authenticate and open its event stream"
  );
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

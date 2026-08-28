import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Builder, Capabilities, logging } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const installedBinary = process.env.HIVEMIND_E2E_BINARY
  ? path.resolve(process.env.HIVEMIND_E2E_BINARY)
  : path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI", "hivemind_desktop.exe");
const evidenceDir = process.env.HIVEMIND_E2E_EVIDENCE
  ? path.resolve(process.env.HIVEMIND_E2E_EVIDENCE)
  : path.join(os.tmpdir(), "hivemind-phase0-update-containment");

let tauriDriver;
let driver;
const transport = [];

try {
  await mkdir(evidenceDir, { recursive: true });
  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().window().setRect({ width: 1440, height: 900 });
  await waitForBody();

  const discovery = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("newer_version")
      .then((value) => ({ resolved: true, value }), (error) => ({ resolved: false, error: String(error) }));`
  );
  assert.equal(discovery.resolved, true, `read-only update discovery failed: ${JSON.stringify(discovery)}`);
  assert.match(discovery.value?.source ?? "", /^(none|release|unknown)$/u);

  const installAttempt = await driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("take_newer_version", {})
      .then((value) => ({ resolved: true, value }), (error) => ({ resolved: false, error: String(error) }));`
  );
  assert.equal(
    installAttempt.resolved,
    false,
    `the removed install command unexpectedly resolved: ${JSON.stringify(installAttempt)}`
  );
  assert.match(installAttempt.error ?? "", /take_newer_version/iu);
  assert.match(installAttempt.error ?? "", /not found|unknown/iu);

  const updateButtons = await driver.executeScript(
    `return [...document.querySelectorAll("button")]
      .map((button) => (button.textContent ?? "").trim())
      .filter((text) => /build and restart|update and restart|install it again/i.test(text));`
  );
  assert.deepEqual(updateButtons, [], "the installed UI still exposes an update execution control");

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = browserLogs.filter((entry) => entry.level?.name === "SEVERE");
  assert.deepEqual(severe, [], `the installed WebView logged errors: ${JSON.stringify(severe)}`);

  const screenshotPath = path.join(evidenceDir, "installed-1440x900.png");
  await writeFile(screenshotPath, await driver.takeScreenshot(), "base64");
  const result = {
    installedBinary,
    discovery,
    installAttempt,
    updateButtons,
    buildNumber: discovery.value.running,
    severe,
    screenshotPath
  };
  await writeFile(path.join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`installed update containment passed: ${installedBinary}`);
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
      // Read-only readiness retry.
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

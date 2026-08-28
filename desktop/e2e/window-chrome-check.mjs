/**
 * Look at the window, at 1440x900, and prove the chrome behaves.
 *
 * Screenshots the merged bar, a drag in progress, and a maximised window, and
 * checks the behaviours that a custom title bar usually breaks:
 *   - clicking a tab must not move the window
 *   - dragging the header must move it
 *   - double-click on the header must maximise, and again must restore
 *   - the controls must be where a Windows user expects them
 */
import assert from "node:assert/strict";
import "./protect-recent-projects.mjs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Builder, Capabilities, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-window-chrome");
let tauriDriver;
let driver;

async function shot(name) {
  const png = await driver.takeScreenshot();
  const file = path.join(evidence, `${name}.png`);
  await writeFile(file, Buffer.from(png, "base64"));
  console.log(`  screenshot: ${file}`);
}

/* The window's rectangle, measured from OUTSIDE the app.
 *
 * Deliberately not asked of the webview: `outer_position` is not in this app's
 * capability list and must not be added for a test's convenience -- the ACL is
 * the product's security surface, not the harness's. user32 answers the same
 * question without granting the webview anything, and it is the more honest
 * instrument anyway: it measures the window a person sees. */
async function rect() {
  const script = `
    Add-Type -Namespace Native -Name Win -MemberDefinition @'
      [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
      public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
    $p = Get-Process hivemind_desktop -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { "none"; exit }
    $r = New-Object Native.Win+RECT
    [void][Native.Win]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
  `;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", script]);
  const raw = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!/^-?\d+,/.test(raw)) return { raw };
  const [left, top, right, bottom] = raw.split(",").map(Number);
  return { left, top, width: right - left, height: bottom - top, raw };
}

/* Only `is_maximized` is asked of the shell, because the app itself needs that
   one for its maximise control and it is therefore already granted. */
async function isMaximized() {
  return driver.executeScript(
    `return window.__TAURI_INTERNALS__.invoke("plugin:window|is_maximized", { label: null })
       .catch((error) => ({ error: String(error) }));`
  );
}

try {
  assert.ok(existsSync(installed), `no installed binary at ${installed}`);
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installed });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(
    async () => (await driver.executeScript("return document.body.innerText;")).trim().length > 40,
    30_000
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  /* 1. The merged bar. */
  console.log("--- the window as it opens ---");
  const header = await driver.executeScript(
    `const element = document.querySelector("header[data-tauri-drag-region]");
     if (!element) return null;
     const box = element.getBoundingClientRect();
     const controls = [...document.querySelectorAll("button")]
       .filter((entry) => /window$/.test(entry.getAttribute("aria-label") || ""))
       .map((entry) => ({ label: entry.getAttribute("aria-label"), x: Math.round(entry.getBoundingClientRect().x) }));
     return {
       headerTop: Math.round(box.top),
       headerHeight: Math.round(box.height),
       viewportWidth: window.innerWidth,
       background: getComputedStyle(element).backgroundColor,
       controls
     };`
  );
  console.log(`  header: ${JSON.stringify(header)}`);
  assert.ok(header, "no drag-region header found");
  /* The header starts at the very top: no system caption above it. */
  assert.equal(header.headerTop, 0, "something sits above the header");
  /* Controls exist and are on the right-hand side. */
  assert.equal(header.controls.length, 3, "expected three window controls");
  for (const control of header.controls) {
    assert.ok(
      control.x > header.viewportWidth * 0.8,
      `${control.label} is not on the right (x=${control.x} of ${header.viewportWidth})`
    );
  }
  await shot("1-merged-bar");

  /* 2. Clicking a tab must NOT move the window. */
  const before = await rect();
  console.log(`  window rect before tab click: ${JSON.stringify(before)}`);
  await driver.executeScript(
    `const tab = [...document.querySelectorAll('[role="tab"]')].find((entry) => entry.offsetParent !== null);
     if (tab) { const box = tab.getBoundingClientRect();
       tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1,
         clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 })); }`
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterTab = await rect();
  console.log(`  window rect after tab mousedown: ${JSON.stringify(afterTab)}`);
  assert.equal(
    `${afterTab.left},${afterTab.top}`,
    `${before.left},${before.top}`,
    "clicking a tab moved the window: the tab row became a drag surface"
  );

  /* 3. Double-click on the header must maximise, and again restore. */
  const dblclick = async () => {
    await driver.executeScript(
      `const header = document.querySelector("header[data-tauri-drag-region]");
       const box = header.getBoundingClientRect();
       /* An empty part of the header, clear of the brand mark and the tabs. */
       const x = box.width * 0.55;
       header.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2, clientX: x, clientY: 8 }));`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  };
  await dblclick();
  const maximised = await isMaximized();
  console.log(`  after double-click: is_maximized=${JSON.stringify(maximised)} rect=${JSON.stringify(await rect())}`);
  assert.equal(maximised, true, "double-click on the header did not maximise");
  await shot("2-maximised");

  await dblclick();
  const restored = await isMaximized();
  console.log(`  after second double-click: is_maximized=${JSON.stringify(restored)}`);
  assert.equal(restored, false, "double-click did not restore");

  /* 4. A drag in progress. `start_dragging` hands the drag to the OS, so the
        screenshot is taken while the window is in the system's drag loop. */
  console.log("--- drag ---");
  await driver.executeScript(
    `const header = document.querySelector("header[data-tauri-drag-region]");
     header.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1,
       clientX: header.getBoundingClientRect().width * 0.55, clientY: 8 }));`
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  await shot("3-drag-started");
  console.log(`  window rect during drag: ${JSON.stringify(await rect())}`);

  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = logs.filter((entry) => entry.level?.name === "SEVERE");
  console.log(`  browser SEVERE: ${JSON.stringify(severe.map((entry) => entry.message.slice(0, 200)))}`);
  assert.deepEqual(severe, [], "the chrome logged errors");

  console.log(`\nWINDOW CHROME VERIFIED. evidence: ${evidence}`);
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

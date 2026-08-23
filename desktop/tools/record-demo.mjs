/**
 * Presentation recorder: the verified replay, captured clean.
 *
 * Same rig as verify:reachable -- the replay built for PRODUCTION, served
 * under the committed Tauri CSP, opened in a managed headless browser (no
 * cursor, by construction). The screencast starts KEEPING frames only when
 * the run header's task counter appears, so the recording opens on the four
 * tasks rather than on empty chrome, and stops two seconds after Shipped.
 *
 * Also captures the presentation stills at 2x device scale in the same
 * session, so every asset comes from the palette that actually ships.
 *
 * Usage: node tools/record-demo.mjs   (needs ffmpeg on PATH)
 * Output: docs/evidence/presentation/
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { ensureHarness } from "./managed-browser.mjs";

const PORT = process.env.CDP_PORT ?? "9444";
const BASE = process.env.REPLAY_BASE ?? "http://127.0.0.1:1430";
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.resolve(DESKTOP_ROOT, "..", "docs", "evidence", "presentation");
const RATES = [4, 6, 8];

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* CDP client, copied from check-reachable.mjs (same target discovery). */
async function open() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const usable = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const expectedOrigin = new URL(BASE).origin;
  const target =
    usable.find((t) => (t.url ?? "").startsWith(expectedOrigin)) ??
    usable.find((t) => (t.url ?? "") === "about:blank") ??
    usable[0];
  if (!target) throw new Error("no debuggable page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const frameHandlers = new Set();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method === "Page.screencastFrame") {
        for (const handler of frameHandlers) handler(message.params);
      }
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    }
    return result.result.value;
  };
  return { send, evaluate, onFrame: (h) => frameHandlers.add(h), offFrame: (h) => frameHandlers.delete(h) };
}

async function waitReady(page) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await page.evaluate(
      "return document.body !== null && (document.body.innerText || '').trim().length > 200;"
    );
    if (ready) return;
    await settle(300);
  }
  throw new Error("page never rendered");
}

async function clickNamed(page, wanted) {
  const opened = await page.evaluate(`
    const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
    const wanted = ${JSON.stringify(wanted)};
    const target = [...document.querySelectorAll("button")].find(
      (el) =>
        el.offsetParent !== null &&
        (norm(el.innerText) === wanted ||
          norm(el.getAttribute("aria-label")) === wanted ||
          norm(el.innerText).startsWith(wanted))
    );
    if (!target) return false;
    target.click();
    return true;
  `);
  if (!opened) throw new Error(`no control named "${wanted}"`);
}

async function still(page, { url, out, open: opener, scale = 2, settleMs = 1800 }) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: scale,
    mobile: false
  });
  await page.send("Page.navigate", { url });
  await waitReady(page);
  await settle(settleMs);
  if (opener) {
    await clickNamed(page, opener);
    await settle(1600);
  }
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT_DIR, out), Buffer.from(shot.data, "base64"));
  console.log(`still: ${out}`);
}

async function record(page, rate) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const framesDir = mkdtempSync(path.join(tmpdir(), `hivemind-demo-${rate}x-`));
  const frames = [];
  let keeping = false;
  const handler = (params) => {
    void page.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    if (!keeping) return;
    frames.push({ data: params.data, ts: params.metadata.timestamp });
  };
  page.onFrame(handler);

  await page.send("Page.navigate", {
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run&play=${rate}`
  });
  await waitReady(page);
  await page.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth: 1440,
    maxHeight: 900
  });

  /* Keep nothing until the run header's task counter exists -- the recording
     opens on the four tasks, not on boot chrome. */
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = await page.evaluate(
      "return /\\b\\d+\\s*\\/\\s*4\\b/.test(document.body.innerText) || /of 4/.test(document.body.innerText);"
    );
    if (started) break;
    await settle(150);
  }
  keeping = true;
  console.log(`${rate}x: recording (tasks visible)`);

  for (let attempt = 0; attempt < 900; attempt += 1) {
    const shipped = await page.evaluate("return document.body.innerText.includes('Shipped');");
    if (shipped) break;
    await settle(200);
  }
  await settle(2000);
  await page.send("Page.stopScreencast");
  page.offFrame(handler);
  if (frames.length < 10) throw new Error(`${rate}x: only ${frames.length} frames captured`);

  /* Frames arrive on compositor updates, not a fixed clock; the concat
     demuxer carries each frame's real duration. */
  const lines = [];
  for (let index = 0; index < frames.length; index += 1) {
    const name = `frame-${String(index).padStart(5, "0")}.png`;
    writeFileSync(path.join(framesDir, name), Buffer.from(frames[index].data, "base64"));
    const duration =
      index + 1 < frames.length
        ? Math.max(0.02, frames[index + 1].ts - frames[index].ts)
        : 2.0;
    lines.push(`file '${name}'`);
    lines.push(`duration ${duration.toFixed(4)}`);
  }
  lines.push(`file 'frame-${String(frames.length - 1).padStart(5, "0")}.png'`);
  writeFileSync(path.join(framesDir, "list.txt"), lines.join("\n"));

  const outFile = path.join(OUT_DIR, `demo-replay-${rate}x.mp4`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", path.join(framesDir, "list.txt"),
      "-vf", "format=yuv420p,scale=1440:-2",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "18",
      "-movflags", "+faststart",
      outFile
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const seconds = frames[frames.length - 1].ts - frames[0].ts + 2;
  console.log(`${rate}x: ${frames.length} frames, ${seconds.toFixed(1)}s -> ${outFile}`);
  rmSync(framesDir, { recursive: true, force: true });
}

/* ── main ─────────────────────────────────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });
const productionRoot = mkdtempSync(path.join(tmpdir(), "hivemind-demo-prod-"));
let harness;
const cleanup = () => {
  harness?.stop();
  rmSync(productionRoot, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

await build({
  root: DESKTOP_ROOT,
  logLevel: "error",
  build: {
    outDir: productionRoot,
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: { input: { replay: path.join(DESKTOP_ROOT, "replay.html") } }
  }
});
const tauriConfig = JSON.parse(
  readFileSync(path.join(DESKTOP_ROOT, "src-tauri", "tauri.conf.json"), "utf8")
);
const csp = tauriConfig.app?.security?.csp;
if (typeof csp !== "string" || csp.trim() === "") throw new Error("no committed CSP");

harness = await ensureHarness({ base: BASE, port: PORT, root: DESKTOP_ROOT, staticRoot: productionRoot, csp });
const page = await open();
await page.send("Page.enable");
await page.send("Runtime.enable");

for (const rate of RATES) {
  await record(page, rate);
}

await still(page, {
  url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
  out: "beat2-mechanism-plan-review.png",
  open: "View plan"
});
await still(page, {
  url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
  out: "beat1-support-checks-output.png",
  open: "Checks"
});
await still(page, {
  url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
  out: "beat3-three-agents-parallel.png"
});
await still(page, {
  url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40ship-review`,
  out: "ship-review-diff.png",
  open: "Show me the changes"
});
await still(page, {
  url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40ship`,
  out: "shipped-card.png"
});

console.log("done");
process.exit(0);

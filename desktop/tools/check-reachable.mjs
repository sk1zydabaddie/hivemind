/**
 * Can a person actually REACH every control on these surfaces?
 *
 * The desktop suite has 211 tests and none of them could answer that, because
 * none of them has a viewport. A component test renders into an unbounded
 * container, so overflow simply does not exist there: the markup is present,
 * every assertion about it passes, and a control clipped below the fold looks
 * identical to one you can press. That is the instrument failure this project
 * keeps rediscovering — **a test that cannot see the constraint cannot fail on
 * it** — and it let the entire first-run path ship unfinishable.
 *
 * So this is a different instrument, not more of the same one. It loads real
 * surfaces at real viewport sizes and asks one question per control:
 *
 *     scroll it into view, then is it inside the viewport?
 *
 * If a control cannot be scrolled to, it cannot be pressed, and a surface with
 * an unpressable control cannot be completed. Nothing here inspects markup.
 *
 * Sizes are the ones people actually have, smallest first: a 1366x768 laptop is
 * the common floor and is where a tall setup screen fails first.
 *
 * It starts what it needs. The dev server and the browser used to be
 * preconditions a person had to satisfy, which is why this ran only when
 * somebody remembered -- and it then caught a crash three commits after the
 * code that caused it landed. Anything already running is used and left alone;
 * anything missing is started and stopped again. See tools/managed-browser.mjs.
 *
 * Usage: npm run verify:reachable   (part of `npm run ship`)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureHarness } from "./managed-browser.mjs";
const PORT = process.env.CDP_PORT ?? "9444";
const BASE = process.env.REPLAY_BASE ?? "http://localhost:1420";

/** The surfaces a person MUST be able to finish. */
const SURFACES = [
  {
    name: "setup — connect a provider",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run&section=setup`
  },
  {
    name: "work — mid-run",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`
  },
  {
    name: "work — ready to ship",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40ship`
  },
  {
    name: "project — history",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run&section=project`
  },
  /* Dialogs do not exist until they are opened, so a surface list that only
     navigates can never see them -- and a dialog whose Approve button is below
     the fold is this same bug with worse consequences, because the surface it
     blocks is the one that authorises a change. */
  {
    name: "settings dialog",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
    open: "Settings"
  },
  {
    name: "plan review dialog",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
    open: "View plan"
  },
  {
    name: "checks dialog",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40midrun`,
    open: "Checks"
  },
  {
    /* Not a dialog: the ship review opens the diff INLINE in the inspector, so
       requiring a modal here would fail on the app being right. */
    name: "ship review — the diff",
    url: `${BASE}/replay.html?scenario=e2e-textkit-parallel-run%40ship-review`,
    open: "Show me the changes",
    dialog: false
  }
];

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 }
];

async function open() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const usable = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const target =
    usable.find((t) => (t.url ?? "").includes("localhost:1420")) ??
    usable.find((t) => (t.url ?? "") === "about:blank") ??
    usable[0];
  if (!target) throw new Error("no debuggable page; start a browser with --remote-debugging-port");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
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
  return { send, evaluate, close: () => ws.close() };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Every visible control, scrolled to and then measured. `scrollIntoView` is the
   same thing a keyboard user's focus does, so a control it cannot bring into
   the viewport is one nobody can reach by any means. */
const PROBE = `
  const controls = [...document.querySelectorAll('button, [role="tab"], a[href], input, textarea, select')]
    .filter((el) => {
      if (el.disabled) return false;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return false;
      return el.offsetParent !== null || getComputedStyle(el).position === "fixed";
    });
  const unreachable = [];
  for (const el of controls) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const box = el.getBoundingClientRect();
    const label = (el.innerText || el.getAttribute("aria-label") || el.placeholder || el.tagName)
      .replace(/\\s+/g, " ").trim().slice(0, 48);
    /* A 2px tolerance for sub-pixel layout; anything more is genuinely off. */
    const belowFold = box.top > window.innerHeight - 2 || box.bottom < 2;
    const offSide = box.left > window.innerWidth - 2 || box.right < 2;
    if (belowFold || offSide) {
      unreachable.push({
        label,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        viewport: window.innerHeight
      });
    }
  }
  /* And the other half of the same failure: a container that has more content
     than it shows and cannot scroll. That is content nobody can reach even if
     no control happens to sit in it. */
  const clipped = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.overflowY !== "hidden") continue;
    if (el.scrollHeight <= el.clientHeight + 2) continue;
    if (el.clientHeight === 0) continue;
    /* Screen-reader-only content is clipped ON PURPOSE -- a 1px box with
       overflow hidden is how the pattern works, and every dialog title uses it.
       Flagging those buries the real finding under a dozen of them. */
    if (el.closest(".sr-only") !== null || el.classList.contains("sr-only")) continue;
    /* Same for anything deliberately collapsed: a closed disclosure is not
       unreachable content, it is content with a control that opens it. */
    if (el.closest("[hidden], [aria-hidden='true'], details:not([open])") !== null) continue;
    clipped.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 70),
      hidden: el.scrollHeight - el.clientHeight
    });
  }
  return { controls: controls.length, unreachable, clipped };
`;

const harness = await ensureHarness({
  base: BASE,
  port: PORT,
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
});

/* The interesting exit from this script is the failing one -- a surface that
   never rendered throws before the tidy path at the bottom is reached. Without
   this, every failed run leaks a dev server and a headless browser, and the
   NEXT run finds them already listening and reports on stale code. */
process.on("exit", () => harness.stop());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    harness.stop();
    process.exit(130);
  });
}

const page = await open();
await page.send("Page.enable");

let failures = 0;
for (const viewport of VIEWPORTS) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false
  });
  for (const surface of SURFACES) {
    await page.send("Page.navigate", { url: surface.url });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = await page.evaluate(
        "return (document.body.innerText || '').trim().length > 200;"
      );
      if (!ready) await settle(300);
    }
    if (!ready) {
      await page.send("Page.reload", { ignoreCache: true });
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        ready = await page.evaluate(
          "return (document.body.innerText || '').trim().length > 200;"
        );
        if (!ready) await settle(300);
      }
    }
    if (!ready) throw new Error(`${surface.name} never rendered`);
    await settle(1200);

    if (surface.open !== undefined) {
      const opened = await page.evaluate(`
        const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
        const wanted = ${JSON.stringify(surface.open)};
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
      if (!opened) throw new Error(`${surface.name}: no control named "${surface.open}"`);
      await settle(1400);
      /* And it really opened. A dialog that failed to appear would otherwise be
         reported as a clean pass on whatever was behind it. */
      if (surface.dialog === false) { /* inline surface; nothing to assert */ }
      const isOpen = surface.dialog === false ? true : await page.evaluate(
        'return document.querySelector(\'[role="dialog"]\') !== null;'
      );
      if (!isOpen) throw new Error(`${surface.name}: "${surface.open}" opened no dialog`);
    }

    const found = await page.evaluate(PROBE);
    const label = `${viewport.width}x${viewport.height}  ${surface.name}`;
    if (found.unreachable.length === 0 && found.clipped.length === 0) {
      console.log(`  ok   ${label}  (${found.controls} controls)`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL ${label}  (${found.controls} controls)`);
    for (const entry of found.unreachable) {
      console.log(
        `         unreachable: "${entry.label}" at y=${entry.top}..${entry.bottom} of ${entry.viewport}`
      );
    }
    for (const entry of found.clipped) {
      console.log(`         clipped: <${entry.tag} class="${entry.cls}"> hides ${entry.hidden}px`);
    }
  }
}

await page.close();
harness.stop();
if (failures > 0) {
  console.error(`\n${failures} surface/viewport combination(s) cannot be completed.`);
  process.exit(1);
}
console.log("\nevery control on every surface is reachable at every size checked");

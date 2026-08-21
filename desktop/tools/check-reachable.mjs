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
 * It starts what it needs. The app is built for production, served under the
 * committed Tauri CSP, and opened in a managed browser. This matters because a
 * dev server can load an asset that the installed bundle later inlines and the
 * WebView blocks. See tools/managed-browser.mjs.
 *
 * Usage: npm run verify:reachable   (part of `npm run ship`)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { ensureHarness } from "./managed-browser.mjs";
const PORT = process.env.CDP_PORT ?? "9444";
const BASE = process.env.REPLAY_BASE ?? "http://127.0.0.1:1430";
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    name: "work — first-message liveness",
    url: `${BASE}/replay.html?scenario=first-message-live&section=work`,
    liveness: true
  },
  {
    name: "work — choose project agents",
    url: `${BASE}/replay.html?scenario=empty-project&section=work`,
    open: "Choose planner, manager, and worker models",
    dialog: false
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
  const expectedOrigin = new URL(BASE).origin;
  const target =
    usable.find((t) => (t.url ?? "").startsWith(expectedOrigin)) ??
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
  const events = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      events.push(message);
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
  return {
    send,
    evaluate,
    drainEvents: () => events.splice(0, events.length),
    close: () => ws.close()
  };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Every visible control, scrolled to and then measured. `scrollIntoView` is the
   same thing a keyboard user's focus does, so a control it cannot bring into
   the viewport is one nobody can reach by any means. */
const PROBE = `
  const controls = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], a[href], input, textarea, select')]
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
  /* A present <img> is not a loaded image. The production CSP bug left every
     provider mark in the DOM with a real box and zero natural size, so neither
     a markup assertion nor the reachability geometry could see it. */
  const brokenImages = [...document.images]
    .filter((image) => image.offsetParent !== null)
    .filter((image) => !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0)
    .map((image) => image.currentSrc || image.src || "(empty source)");

  /* Shared primitives are a contract only when identical variants actually
     render identically. Source scans cannot see a local class overriding a
     component's padding, fill, radius, or shadow, so compare the computed
     result in the production bundle. Disabled and selected states are separate
     groups because they are deliberately different states. */
  const visualSignature = (el) => {
    const style = getComputedStyle(el);
    const contentSized = ["card", "graph", "lane", "task"].includes(
      el.getAttribute("data-shape")
    ) || ["row", "file"].includes(el.getAttribute("data-size"));
    return [
      contentSized ? "content-sized" : Math.round(el.getBoundingClientRect().height * 10) / 10,
      style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
      style.gap, style.fontSize, style.fontWeight, style.borderRadius,
      style.borderTopWidth, style.borderTopColor, style.backgroundColor,
      style.backgroundImage, style.color, style.boxShadow
    ].join("|");
  };
  const primitiveGroups = new Map();
  for (const el of document.querySelectorAll('[data-slot="button"], [data-slot="selection-control"], [data-slot="tabs-trigger"], [data-slot="checkbox"], [data-slot="radio"], [data-slot="switch-thumb"], [data-slot="panel-header"], [data-slot="dialog-header"][class*="border-b"], [data-slot="dialog-footer"][class*="border-t"]')) {
    if (el.offsetParent === null) continue;
    const slot = el.getAttribute("data-slot");
    const key = [
      slot,
      el.getAttribute("data-variant") || "",
      el.getAttribute("data-size") || "",
      el.getAttribute("data-shape") || "",
      el.getAttribute("aria-pressed") || "",
      el.getAttribute("data-state") || "",
      el.querySelector(":scope > svg") === null ? "text-only" : "with-icon",
      el.disabled ? "disabled" : "enabled"
    ].join(":");
    const signature = visualSignature(el);
    if (!primitiveGroups.has(key)) primitiveGroups.set(key, new Map());
    const signatures = primitiveGroups.get(key);
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature).push(
      (el.innerText || el.getAttribute("aria-label") || slot).replace(/\s+/g, " ").trim().slice(0, 36)
    );
  }
  const inconsistentControls = [...primitiveGroups.entries()]
    .filter(([, signatures]) => signatures.size > 1)
    .map(([group, signatures]) => ({
      group,
      variants: [...signatures.entries()].map(([signature, labels]) => ({ signature, labels }))
    }));
  /* A dark shared face needs a light foreground all the way through its
     descendants. The installed audit found black caller spans on navy row
     buttons even though the Button root itself correctly computed to white. */
  const lowContrastControls = [];
  const channelsOf = (value) => {
    const match = /rgba?\\(\\s*(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)(?:\\D+(0(?:\\.\\d+)?|1(?:\\.0+)?))?/u.exec(value);
    return match === null
      ? null
      : { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) };
  };
  const relativeLuminance = (rgb) => {
    const linear = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const contrastRatio = (a, b) => {
    const first = relativeLuminance(a);
    const second = relativeLuminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  for (const control of document.querySelectorAll('[data-slot="button"], [data-slot="selection-control"], [data-slot="tabs-trigger"]')) {
    if (control.offsetParent === null || control.disabled) continue;
    /* Contrast ownership applies only when the primitive paints an opaque dark
       face. Flat navigation and utility actions intentionally inherit the
       panel below them; treating transparent black as a dark fill would turn
       their correct navy text into a false failure. */
    const face = channelsOf(getComputedStyle(control).backgroundColor);
    if (face === null || face.alpha < 0.8 || face.rgb.reduce((sum, channel) => sum + channel, 0) / 3 >= 140) {
      continue;
    }
    const candidates = [control, ...control.querySelectorAll("*")];
    for (const candidate of candidates) {
      const ownsText = candidate === control || [...candidate.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ""
      );
      if (!ownsText || candidate.getBoundingClientRect().width === 0) continue;
      const color = getComputedStyle(candidate).color;
      const channels = channelsOf(color);
      if (channels !== null && contrastRatio(face.rgb, channels.rgb) < 4.5) {
        lowContrastControls.push({
          label: (candidate.textContent || control.getAttribute("aria-label") || "control").trim().slice(0, 48),
          control: (control.innerText || control.getAttribute("aria-label") || control.getAttribute("data-slot") || "control").replace(/\\s+/g, " ").trim().slice(0, 72),
          element: candidate.tagName.toLowerCase() + "." + candidate.className.toString().replace(/\\s+/g, ".").slice(0, 80),
          color
        });
      }
    }
  }
  return { controls: controls.length, unreachable, clipped, brokenImages, inconsistentControls, lowContrastControls };
`;

/* Build the replay through the SAME production transform that Tauri bundles.
   The dev server serves imported SVGs as same-origin source files, so it could
   never reproduce Vite inlining them as data URLs. A temporary production
   entry gives the real assets and chunks without shipping replay.html. */
const productionRoot = mkdtempSync(path.join(tmpdir(), "hivemind-reachable-dist-"));
let harness = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  harness?.stop();
  rmSync(productionRoot, { recursive: true, force: true });
};
/* Register before the build: a transform error is still a failing exit, and a
   guard must not leak its temporary production tree while reporting one. */
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
    /* replay.tsx uses top-level await. The application modules and asset
       handling still take the production path; only this harness entry keeps
       its existing modern-browser syntax. */
    target: "esnext",
    rollupOptions: {
      input: { replay: path.join(DESKTOP_ROOT, "replay.html") }
    }
  }
});
const tauriConfig = JSON.parse(
  readFileSync(path.join(DESKTOP_ROOT, "src-tauri", "tauri.conf.json"), "utf8")
);
const csp = tauriConfig.app?.security?.csp;
if (typeof csp !== "string" || csp.trim() === "") {
  throw new Error("the committed Tauri CSP is missing, so production resources cannot be checked");
}

harness = await ensureHarness({
  base: BASE,
  port: PORT,
  root: DESKTOP_ROOT,
  staticRoot: productionRoot,
  csp
});

/* The interesting exit from this script is the failing one -- a surface that
   never rendered throws before the tidy path at the bottom is reached. Without
   this, every failed run leaks a server and a headless browser, and the next
   run can report against stale state. Cleanup is registered above before the
   production build, because that build can fail too. */

const page = await open();
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Log.enable");
await page.send("Network.enable");

let failures = 0;
for (const viewport of VIEWPORTS) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false
  });
  for (const surface of SURFACES) {
    page.drainEvents();
    await page.send("Page.navigate", { url: surface.url });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = await page.evaluate(
        "return document.body !== null && (document.body.innerText || '').trim().length > 200;"
      );
      if (!ready) await settle(300);
    }
    if (!ready) {
      await page.send("Page.reload", { ignoreCache: true });
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        ready = await page.evaluate(
          "return document.body !== null && (document.body.innerText || '').trim().length > 200;"
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
    const browserIssues = page.drainEvents().flatMap((event) => {
      if (event.method === "Runtime.exceptionThrown") {
        return [event.params?.exceptionDetails?.exception?.description ?? "uncaught browser exception"];
      }
      if (event.method === "Runtime.consoleAPICalled" && event.params?.type === "error") {
        return [(event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ")];
      }
      if (event.method === "Log.entryAdded" && event.params?.entry?.level === "error") {
        return [event.params.entry.text ?? "browser log error"];
      }
      if (
        event.method === "Network.loadingFailed" &&
        event.params?.canceled !== true &&
        event.params?.errorText !== "net::ERR_ABORTED"
      ) {
        return [`resource failed: ${event.params?.errorText ?? "unknown network error"}`];
      }
      return [];
    });
    const label = `${viewport.width}x${viewport.height}  ${surface.name}`;
    if (surface.liveness === true) {
      const before = await page.evaluate(`
        return [...document.querySelectorAll("span")]
          .map((element) => element.textContent?.trim() ?? "")
          .find((text) => text.endsWith(" elapsed")) ?? null;
      `);
      await settle(3_100);
      const after = await page.evaluate(`
        return [...document.querySelectorAll("span")]
          .map((element) => element.textContent?.trim() ?? "")
          .find((text) => text.endsWith(" elapsed")) ?? null;
      `);
      if (before === null || after === null || before === after) {
        const visibleText = await page.evaluate(
          `return (document.body.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 500);`
        );
        failures += 1;
        console.error(`  FAIL ${label}: functional liveness did not change (${before} -> ${after}); visible: ${visibleText}`);
        continue;
      }
    }
    if (
      found.unreachable.length === 0 &&
      found.clipped.length === 0 &&
      found.brokenImages.length === 0 &&
      found.inconsistentControls.length === 0 &&
      found.lowContrastControls.length === 0 &&
      browserIssues.length === 0
    ) {
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
    for (const source of found.brokenImages) {
      console.log(`         image did not load: ${source}`);
    }
    for (const issue of found.inconsistentControls) {
      console.log(`         inconsistent ${issue.group}: ${JSON.stringify(issue.variants)}`);
    }
    for (const issue of found.lowContrastControls) {
      console.log(`         low-contrast text on control "${issue.control}": ${issue.element} "${issue.label}" rendered ${issue.color}`);
    }
    for (const issue of browserIssues) {
      console.log(`         browser error: ${issue}`);
    }
  }
}

await page.close();
cleanup();
if (failures > 0) {
  console.error(`\n${failures} surface/viewport combination(s) cannot be completed.`);
  process.exit(1);
}
console.log("\nevery control on every surface is reachable at every size checked");

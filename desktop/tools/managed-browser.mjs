/**
 * The dev server and the browser `verify:reachable` needs, started by the check
 * itself.
 *
 * Why this file exists: the reachability harness caught a crash three commits
 * after the code that caused it landed, because it needed two things running
 * that `npm run ship` does not provide, so it only ran when somebody remembered.
 * A guard that fires when remembered is the same shape as the version check
 * that was written, correct, and never called — built, right, and silent.
 *
 * The browser dependency is not removable and should not be argued away. The
 * whole reason this instrument exists is that no DOM-only assertion can measure
 * overflow: a component test renders into an unbounded container, where a
 * control below the fold is indistinguishable from one you can press. Measuring
 * that needs a real viewport, which needs a real engine.
 *
 * So it is provided rather than assumed. Two rules:
 *
 * - **Nothing already running is touched.** If a dev server or a debuggable
 *   browser is already there, it is used as-is and left alone afterwards. The
 *   common case is a person with `npm run dev` open, and killing their server
 *   at the end of a check would be a worse bug than the one this prevents.
 * - **A browser that cannot be found is a failure, not a skip.** A check that
 *   quietly passes when it could not run is the silent guard again, one level
 *   further down.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop only the process tree this harness started. Edge ignores the ordinary
 * Node child signal on Windows and otherwise survives a green check, keeping
 * both the port and the parent Node process alive. `taskkill` is bound to the
 * exact captured PID; it never enumerates or touches an existing browser. */
function stopStartedProcess(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  child.kill();
}

function listeningPid(port) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return null;
  const suffix = `:${String(port)}`;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || columns[3] !== "LISTENING") continue;
    if (!columns[1].endsWith(suffix)) continue;
    const pid = Number.parseInt(columns[4], 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function stopStartedBrowser(child, port) {
  if (process.platform === "win32") {
    /* Edge may relaunch under a child PID and let the PID returned by spawn
       exit. The port was proven unused immediately before this harness started
       Edge, so its listener is the exact owned browser even after relaunch. */
    const pid = listeningPid(port) ?? child.pid;
    if (pid !== undefined) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
    return;
  }
  stopStartedProcess(child);
}

async function responds(url) {
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return answer.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, seconds, what) {
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
    if (await responds(url)) return;
    await settle(250);
  }
  throw new Error(`${what} did not come up within ${seconds}s`);
}

/** Every place a Chromium lives, per platform. Order is preference. */
function browserCandidates() {
  if (process.platform === "win32") {
    const roots = [
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA
    ].filter(Boolean);
    const suffixes = [
      path.join("Microsoft", "Edge", "Application", "msedge.exe"),
      path.join("Google", "Chrome", "Application", "chrome.exe")
    ];
    return roots.flatMap((root) => suffixes.map((suffix) => path.join(root, suffix)));
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ];
}

/**
 * The first candidate that exists, or a failure that says why it is a failure.
 *
 * Separated out so the empty case is testable. It has to THROW: a reachability
 * check that returns green because it could not find a browser is the silent
 * guard this whole file exists to close, one level further down.
 */
export function findBrowser(candidates, port) {
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (binary === undefined) {
    throw new Error(
      [
        "no Chromium-based browser found, so reachability cannot be measured.",
        "        Install Chrome or Edge, or start one yourself with",
        `        --remote-debugging-port=${String(port)} and re-run.`,
        "        This is a failure rather than a skip on purpose: a check that",
        "        passes when it could not run is worse than no check."
      ].join("\n")
    );
  }
  return binary;
}

/**
 * Start whatever is missing, and return how to put it back.
 *
 * `stop()` only stops what this started. Anything it found already running is
 * left exactly as it was.
 */
export async function ensureHarness({ base, port, root, candidates, staticRoot, csp }) {
  const started = [];
  let profile = null;

  if (staticRoot !== undefined) {
    const baseUrl = new URL(base);
    const mime = new Map([
      [".css", "text/css; charset=utf-8"],
      [".html", "text/html; charset=utf-8"],
      [".js", "text/javascript; charset=utf-8"],
      [".json", "application/json; charset=utf-8"],
      [".png", "image/png"],
      [".svg", "image/svg+xml"],
      [".woff2", "font/woff2"]
    ]);
    const server = createServer((request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url ?? "/", base).pathname);
        if (pathname === "/favicon.ico") {
          response.writeHead(204, { "Content-Security-Policy": csp }).end();
          return;
        }
        const relative = pathname === "/" ? "replay.html" : pathname.slice(1);
        const fixture = relative.startsWith("tools/") && relative.endsWith(".json");
        const target = path.resolve(fixture ? root : staticRoot, relative);
        const rootPrefix = `${path.resolve(fixture ? root : staticRoot)}${path.sep}`;
        if (!target.startsWith(rootPrefix)) {
          response.writeHead(403).end("forbidden");
          return;
        }
        const body = readFileSync(target);
        const type = mime.get(path.extname(target).toLowerCase()) ?? "application/octet-stream";
        response.writeHead(200, {
          "Content-Security-Policy": csp,
          "Content-Type": type,
          "Cache-Control": "no-store"
        });
        response.end(body);
      } catch {
        response.writeHead(404).end("not found");
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(baseUrl.port), baseUrl.hostname, resolve);
    });
    started.push(() => server.close());
    console.log("  started the production replay under the Tauri CSP");
  } else if (!(await responds(base))) {
    const dev = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
      cwd: root,
      stdio: "ignore",
      shell: process.platform === "win32"
    });
    started.push(() => stopStartedProcess(dev));
    await waitFor(base, 40, "the dev server");
    console.log("  started a dev server");
  }

  if (!(await responds(`http://127.0.0.1:${port}/json/list`))) {
    const binary = findBrowser(candidates ?? browserCandidates(), port);
    profile = mkdtempSync(path.join(tmpdir(), "hivemind-reachable-"));
    const browser = spawn(
      binary,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars=false",
        "about:blank"
      ],
      { stdio: "ignore" }
    );
    started.push(() => stopStartedBrowser(browser, port));
    await waitFor(`http://127.0.0.1:${port}/json/list`, 30, "the browser");
    console.log(`  started ${path.basename(binary)} headless`);
  }

  return {
    stop() {
      for (const kill of started.reverse()) {
        try {
          kill();
        } catch {
          /* Already gone. Nothing to do, and nothing worth reporting. */
        }
      }
      if (profile !== null) {
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          /* A locked profile directory on Windows outlives the process by a
             moment. It is in the system temp directory; leaving it is fine. */
        }
      }
    }
  };
}

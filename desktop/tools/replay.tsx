/* Replay harness. Drives the real App against a captured event trail and the
 * projection Core actually produced for it. Not part of the app.
 *
 *   node tools/collect-replay.mjs
 *   npm run dev   ->  /replay.html?scenario=<id>
 *
 * Read-only: the collector never writes to docs/evidence, and this page never
 * writes anywhere.
 */
export {};

interface ReplayEvent {
  ts: string;
  type: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

interface ReplayOutputRecord {
  ts: string;
  task_id: string;
  tool: string;
  stream: string;
  text: string;
}

interface ReplayFrame {
  event_index: number;
  at_ms: number;
  inspection: Record<string, unknown>;
}

interface ReplayScenario {
  id: string;
  source: string;
  events: ReplayEvent[];
  span_ms: number;
  inspection: Record<string, unknown> | null;
  inspection_error: string | null;
  /** Projections at each point the run visibly changed. Playback only. */
  timeline?: ReplayFrame[];
  /** Captured worker output, keyed by task. Playback only. */
  output?: Record<string, ReplayOutputRecord[]>;
  /** Real submitted diffs, keyed by task, where the capture kept them. */
  patches?: Record<string, string>;
  /** A real drafted spec, for replaying the one review. */
  spec_review?: Record<string, unknown>;
}

const HEX = "9f".repeat(32);
const params = new URLSearchParams(window.location.search);

/* Captured settings state. Written by running `project.init` and
   `adapter.connect` against a real repository and a real coding agent, so the
   settings surface is replayed from what Core actually returned rather than
   from a hand-written shape. */
const settings = await fetch("/tools/settings-live.json")
  .then(async (response) => (response.ok ? ((await response.json()) as {
    config: Record<string, unknown>;
    connect: Record<string, unknown>;
    model_discovery: Record<string, unknown>;
  }) : null))
  .catch(() => null);

const response = await fetch("/tools/replay-data.json");
if (!response.ok) {
  document.body.textContent =
    "No replay data. Run: node tools/collect-replay.mjs";
  throw new Error("replay data missing");
}
const data = (await response.json()) as {
  scenarios: ReplayScenario[];
  /* Live captures rather than replayed trails -- see the stubs below. */
  project_files?: {
    listings?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
  check_output?: unknown;
};
const wanted = params.get("scenario");
const scenario =
  data.scenarios.find((entry) => entry.id === wanted) ?? data.scenarios[0];
if (!scenario) throw new Error("no replay scenarios");

/* A visible label, so a screenshot can never be mistaken for a live run. */
const banner = document.createElement("div");
banner.style.cssText =
  "position:fixed;z-index:999;right:8px;bottom:8px;padding:4px 8px;border-radius:6px;background:#1F2328;color:#fff;font:11px ui-monospace,monospace;opacity:.75";
banner.textContent = `replay: ${scenario.id} · ${scenario.events.length} events · ${scenario.source}`;
document.addEventListener("DOMContentLoaded", () => {
  if (!playing) return;
  /* A recording still has to admit what it is, but a paragraph of provenance
     across the corner of a demo is not the way to do it. */
  banner.textContent = `replay · ${playSpeed}×`;
});
document.addEventListener("DOMContentLoaded", () => document.body.append(banner));

/* ── Playback ──────────────────────────────────────────────────────────────
 *
 * `?play=<speed>` replays the run on its own clock instead of dumping every
 * event at once, so the app can be recorded working rather than photographed
 * finished. Everything it plays is captured: the events and their timestamps,
 * the worker output records, and a Core projection at each point the run
 * changed. Nothing is simulated -- if the capture lacks it, playback lacks it.
 *
 * Two liberties, both about time rather than content:
 *   - Dead air is collapsed. The trail opens with 24 minutes between a settings
 *     change and the prompt; a demo of that is a demo of nothing.
 *   - The remaining gaps are divided by the speed factor.
 *
 *   /replay.html?scenario=e2e-textkit-parallel-run&play=6
 */
const playSpeed = Number(params.get("play") ?? "0");
const playing = Number.isFinite(playSpeed) && playSpeed > 0 && scenario.events.length > 0;
/* High enough that a worker thinking for ninety seconds still reads as work,
   low enough that the 24 minutes between a settings change and the prompt, and
   the 94 seconds spent reading the plan, do not. */
const IDLE_CEILING_MS = 20_000;

/* One clock for everything. The events define it -- gaps clamped, then scaled --
 * and worker output is mapped onto the same curve by interpolation, so a line
 * of agent output lands between the two events it really happened between.
 * Giving output its own clock made it drift behind whatever moment the app
 * happened to open the stream. */
function buildClock(events: ReplayEvent[], speed: number): {
  offsets: number[];
  toPlayback: (realMs: number) => number;
} {
  const real: number[] = [];
  const offsets: number[] = [];
  let elapsed = 0;
  let previous: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.ts);
    const usable: number = Number.isFinite(at) ? at : (previous ?? 0);
    if (previous !== null) {
      elapsed += Math.min(Math.max(0, usable - previous), IDLE_CEILING_MS) / speed;
    }
    real.push(usable);
    offsets.push(elapsed);
    previous = usable;
  }
  const toPlayback = (realMs: number): number => {
    if (!Number.isFinite(realMs) || real.length === 0) return 0;
    if (realMs <= real[0]!) return 0;
    if (realMs >= real.at(-1)!) return offsets.at(-1)!;
    let index = 0;
    while (index < real.length - 1 && real[index + 1]! < realMs) index += 1;
    const spanReal = real[index + 1]! - real[index]!;
    const spanPlay = offsets[index + 1]! - offsets[index]!;
    if (spanReal <= 0) return offsets[index]!;
    const fraction = Math.min(1, (realMs - real[index]!) / spanReal);
    return offsets[index]! + spanPlay * fraction;
  };
  return { offsets, toPlayback };
}

const clock = playing
  ? buildClock(scenario.events, playSpeed)
  : { offsets: [], toPlayback: () => 0 };
const schedule = clock.offsets;
/* When playback actually began, so a stream opened late still lands its records
   where they belong rather than restarting the clock. */
let playbackStartedAt: number | null = null;
/* How far the run has got, as an event count. The projection served to
   `status.inspect` is the newest captured frame at or behind this point, so the
   rail can never be ahead of the story. */
let delivered = playing ? 0 : scenario.events.length;

function currentInspection(): Record<string, unknown> | null {
  if (!playing || scenario.timeline === undefined) return scenario.inspection;
  let frame: ReplayFrame | null = null;
  for (const candidate of scenario.timeline) {
    if (candidate.event_index <= delivered - 1) frame = candidate;
  }
  return frame?.inspection ?? emptyInspection();
}

/* Before the first captured frame there is nothing to report yet. This is the
   shape of a project that has done nothing, not an invented one. */
function emptyInspection(): Record<string, unknown> | null {
  const first = scenario.timeline?.[0]?.inspection;
  if (first === undefined) return scenario.inspection;
  return {
    ...first,
    tasks: [],
    execution_groups: [],
    task_titles: {},
    plan_review: null,
    current_plan: null,
    needs_you: [],
    later: []
  };
}

class ReplayEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  #timers: number[] = [];

  constructor(url: string) {
    const outputMatch = /\/tasks\/([^/]+)\/output\/stream/u.exec(url);
    window.setTimeout(() => {
      this.onopen?.();
      if (outputMatch) {
        this.#streamOutput(decodeURIComponent(outputMatch[1]!));
        return;
      }
      this.#streamEvents();
    }, 0);
  }

  #emit(index: number): void {
    delivered = Math.max(delivered, index + 1);
    this.onmessage?.({
      data: JSON.stringify({
        kind: "event",
        source: playing ? "live" : "history",
        seq: index + 1,
        event: scenario.events[index]
      })
    });
  }

  #streamEvents(): void {
    if (!playing) {
      scenario.events.forEach((_, index) => this.#emit(index));
      return;
    }
    playbackStartedAt ??= performance.now();
    scenario.events.forEach((_, index) => {
      this.#timers.push(
        window.setTimeout(() => this.#emit(index), Math.round(schedule[index]!))
      );
    });
  }

  /* Worker output rides the events' clock. A stream the app opens partway
     through gets everything already due at once -- as history, which is what it
     is -- and the rest on schedule. */
  #streamOutput(taskId: string): void {
    const records = scenario.output?.[taskId];
    if (records === undefined) return;
    if (!playing) {
      for (const record of records) this.#send(record, "history");
      return;
    }
    const elapsed = playbackStartedAt === null ? 0 : performance.now() - playbackStartedAt;
    for (const record of records) {
      const due = clock.toPlayback(Date.parse(record.ts)) - elapsed;
      if (due <= 0) this.#send(record, "history");
      else this.#timers.push(window.setTimeout(() => this.#send(record, "live"), Math.round(due)));
    }
  }

  #send(record: ReplayOutputRecord, source: "history" | "live"): void {
    this.onmessage?.({ data: JSON.stringify({ kind: "output", source, record }) });
  }

  close(): void {
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers = [];
  }
}

(window as unknown as { EventSource: unknown }).EventSource = ReplayEventSource;
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  transformCallback: (callback: unknown) => callback,
  invoke: async (command: string, payload: Record<string, unknown>) => {
    /* The shell remembers which projects have been opened, and the app now
       opens the most recent one rather than defaulting to the process working
       directory — which for an installed build was its own install folder.
       The harness models the shell, so it has to model this too: without it
       the replay opens nothing and every scenario renders the setup screen.
       Caught by a screenshot run refusing to photograph a surface that did not
       contain what it came for. */
    if (command === "recent_projects") {
      return [{ path: "D:\\Projects\\trimr-replay", opened_at: "0" }];
    }
    /* The LAUNCH question, which is a different one from "what is in the list".
       The app asks this so a deleted last project can be reported rather than
       silently replaced by an older one; the harness models the shell, so it
       answers it too. Its absence left the replay with no project open and
       every scenario rendering the setup screen -- caught by the reachability
       check, which is the same failure mode the comment above records. */
    if (command === "last_project") {
      return { path: "D:\\Projects\\trimr-replay", opened_at: "0", missing: false };
    }
    if (command === "remember_project") return null;
    /* Removing an entry is shell state the replay has none of, and answering
       is closer to the truth than throwing: there is nothing to forget. */
    if (command === "forget_project") return null;
    /* The replay has no updater endpoint. Return the ordinary quiet answer so
       design captures are not dominated by a harness-only network fault. */
    if (command === "newer_version") {
      return {
        source: "none",
        running: "26.816.1540-replay"
      };
    }
    if (command === "dismissed_hints") return { "setup.what-this-is": true };
    if (command === "select_project") {
      return {
        project_root: "D:\\Projects\\trimr-replay",
        daemon_url: "http://127.0.0.1:7777",
        build_id: HEX,
        shell_build_id: HEX,
        expected_shell_build_id: HEX,
        status: "attached"
      };
    }
    if (command === "workspace_action") {
      const action = payload.action as { type: string };
      if (action.type === "status.inspect") {
        const inspection = currentInspection();
        if (inspection === null) {
          throw new Error(scenario.inspection_error ?? "no projection for this trail");
        }
        return inspection;
      }
      if (action.type === "trail.inspect") return scenario.events.slice(0, delivered);
      /* The settings surface, served from a REAL capture: `config.inspect` and
         `adapter.connect` recorded from a project that was actually
         initialised and actually probed against codex-cli. The probe's
         capabilities are what the provider reported back, not a fixture. */
      if (action.type === "config.inspect" || action.type === "config.set") {
        if (settings === null) throw new Error("no captured settings state");
        return settings.config;
      }
      /* The AGENTS.md proposal, shaped exactly as Core returns one.
         A refusal here would render no card, and the card's controls would then
         be checked by nothing -- the reachability run can only see what the
         replay draws. So it answers with a proposal whose facts match the
         replay project, which is a state a real project genuinely reaches.

         The stub exists at all because without one the throw took the whole
         surface down, which is the same failure the `last_project` comment
         above records. */
      if (action.type === "agents.propose") {
        const body: string[] = [
          "## What this project is",
          "trimr — Node.js — ES modules.",
          "",
          "## Where things are",
          "- Source lives in `src/`.",
          "- Tests live in `test/`.",
          "",
          "## How this project is checked",
          "- `npm test` runs the tests (found in this project)."
        ];
        return {
          summary: "create AGENTS.md with a detected-facts section",
          diff: ["--- a/AGENTS.md", "+++ b/AGENTS.md", "@@ -1,0 +1,11 @@", "+# trimr", "+", ...body.map((line) => `+${line}`)].join(String.fromCharCode(10)),
          bytes: 402,
          over_target: false,
          size_target_bytes: 8192,
          has_existing_file: false,
          existing_sha: null,
          proposed_sha: "replay000000",
          facts: {
            project_name: "trimr",
            stack: "Node.js",
            source_dirs: ["src"],
            test_dirs: ["test"],
            checks: [{ command: "npm test", kind: "tests", source: "found in this project" }]
          }
        };
      }
      if (action.type === "agents.apply") return { bytes: 402, path: "AGENTS.md" };
      if (action.type === "provider.auth.inspect") {
        if (settings === null) throw new Error("no captured settings state");
        const providers = (settings.config as { providers?: Array<{ id?: unknown }> }).providers ?? [];
        return {
          providers: providers.map((provider) => ({
            provider_id: String(provider.id ?? ""),
            status: "unknown",
            detail: "The replay does not contain provider login standing."
          }))
        };
      }
      if (action.type === "models.discover") {
        if (settings === null) throw new Error("no captured model discovery");
        return settings.model_discovery;
      }
      if (action.type === "adapter.connect") {
        if (settings === null) throw new Error("no captured settings state");
        return settings.connect;
      }
      /* A worker's real submitted diff, where the evidence folder kept one.
         A scenario without a captured patch answers with nothing rather than a
         stand-in, so the change viewer shows its "no lines to show" state --
         which is the honest rendering of a run whose diffs were never kept. */
      if (action.type === "change.inspect") {
        const payload = (action as { payload?: { task_id?: unknown } }).payload ?? {};
        const taskId = String(payload.task_id ?? "");
        const patch = scenario.patches?.[taskId];
        if (patch === undefined) {
          throw new Error("this run's record does not include the lines it changed");
        }
        return { task_id: taskId, diff: patch };
      }

      /* The project's own files and what its checks printed.
         Neither is replayed state: no trail in the corpus retained the source
         tree or the checks' output, so these are LIVE captures taken by
         `collect-replay.mjs` running the real Core functions over a real
         directory and a real failing command. Named as such in the evidence
         README rather than passed off as a replayed run. */
      if (action.type === "files.list") {
        const payload = (action as { payload?: { path?: unknown } }).payload ?? {};
        const directory = String(payload.path ?? ".");
        const listing = data.project_files?.listings?.[directory];
        if (listing === undefined) {
          throw new Error("this capture does not include that directory");
        }
        return listing;
      }
      if (action.type === "files.read") {
        const payload = (action as { payload?: { path?: unknown } }).payload ?? {};
        const file = String(payload.path ?? "");
        const content = data.project_files?.files?.[file];
        if (content === undefined) {
          throw new Error("this capture did not keep the text of that file");
        }
        return content;
      }
      if (action.type === "checks.inspect") {
        if (data.check_output == null) {
          throw new Error("no checks have been run and recorded in this project yet");
        }
        return data.check_output;
      }

      /* The spec half of the review, served from a REAL drafted spec captured
         by the drafting experiment rather than a fixture. */
      if (action.type === "spec.review" && scenario.spec_review !== undefined) {
        return scenario.spec_review;
      }
      return {};
    }
    throw new Error(`replay harness has no stub for ${command}`);
  }
};

/* Drive the replayed app to a surface that normally needs a click, so a
 * headless capture can reach the agent graph and the project record. Harness
 * only -- the app has no idea this exists and gets no test hooks of its own.
 *
 *   /replay.html?scenario=<id>&tab=project
 *   /replay.html?scenario=<id>&tab=agents
 *   /replay.html?scenario=<id>&open=changes
 *   /replay.html?scenario=<id>&open=file&file=<path an agent is holding>
 */
const clickByName = (name: string): boolean => {
  /* Scoped to the open dialog when there is one.
     Radix dismisses a modal on an outside pointerdown, so a driver that clicks
     a button BEHIND the overlay closes the very dialog it just opened -- which
     is what a multi-step walk into a file tree did, silently, and looked like
     the tree failing to respond. */
  const scope: ParentNode = document.querySelector("[role=dialog]") ?? document;
  const buttons = [...scope.querySelectorAll("button")];
  /* Exact before prefix: "src" must not match "src/slugify.js" when the tree
     really does have a folder called `src`. A tab may still carry a live count
     after its label ("Agents3"), so prefix stays as the fallback. */
  const match =
    buttons.find(
      (button) =>
        (button.textContent ?? "").trim() === name ||
        button.getAttribute("aria-label") === name
    ) ?? buttons.find((button) => (button.textContent ?? "").trim().startsWith(name));
  if (!match) return false;
  /* Radix's tab trigger activates on mousedown and on focus, not on a bare
     programmatic click -- so drive the whole sequence rather than `.click()`. */
  match.focus();
  for (const type of ["pointerdown", "mousedown", "mouseup"]) {
    match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  match.click();
  return true;
};

const drive = (): void => {
  const steps = [
    params.get("tab") === "project" ? "Project" : null,
    params.get("tab") === "agents" ? "Agents" : null,
    params.get("open") === "plan" ? "View plan" : null,
    params.get("open") === "changes" ? "See every line" : null,
    params.get("open") === "checks" ? "Checks" : null,
    /* A file an agent is holding, opened from the rail. Names the file rather
       than a control, because the file list IS the control. */
    params.get("open") === "file" ? (params.get("file") ?? "") : null,
    /* Open the change dialog from the rail, then walk the tree to a file whose
       text the capture actually kept. */
    ...(params.get("open") === "filetext"
      ? [params.get("file") ?? "", ...(params.get("walk") ?? "").split("/").filter((s) => s !== "")]
      : []),
    params.get("open") === "commands" ? "Commands" : null,
    params.get("open") === "settings" ? "Settings" : null,
    /* The connect flow: open settings, then ask one agent to take one role.
       The probe result it renders is the captured one. */
    ...(params.get("open") === "connect" ? ["Settings", "worker"] : []),
    params.get("open") === "limits" ? "Settings" : null
  ].filter((step): step is string => step !== null);
  if (steps.length === 0) return;
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (steps.length > 0 && clickByName(steps[0]!)) steps.shift();
    if (steps.length === 0 || attempts > 60) {
      window.clearInterval(timer);
      /* The harness focuses what it clicks, and a programmatic focus() counts
         as :focus-visible — so a captured surface wore a focus ring that no
         person would see after clicking the same control with a mouse. Blur it
         once the driving is done, unless the surface legitimately took focus
         itself (a dialog's autofocus, which IS what a person sees). */
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[role=tablist]") !== null) {
          active.blur();
        }
        /* Bring the probe's answer into frame, since it lands below the fold
           of a dialog the capture cannot scroll by hand. */
        const scrollTo = { connect: "compared what it reported", limits: "Spending limits" }[
          params.get("open") ?? ""
        ];
        if (scrollTo !== undefined) {
          const target = [...document.querySelectorAll("section")].find((node) =>
            (node.textContent ?? "").includes(scrollTo)
          );
          target?.scrollIntoView({ block: scrollTo === "Spending limits" ? "start" : "end" });
        }
      }, 400);
    }
  }, 100);
};

void import("../src/main").then(() => window.setTimeout(drive, 300));

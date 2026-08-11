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
}

const HEX = "9f".repeat(32);
const params = new URLSearchParams(window.location.search);

const response = await fetch("/tools/replay-data.json");
if (!response.ok) {
  document.body.textContent =
    "No replay data. Run: node tools/collect-replay.mjs";
  throw new Error("replay data missing");
}
const data = (await response.json()) as { scenarios: ReplayScenario[] };
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
      return {};
    }
    throw new Error(`replay harness has no stub for ${command}`);
  }
};

/* Drive the replayed app to a surface that normally needs a click, so a
 * headless capture can reach the map and the project record. Harness only --
 * the app has no idea this exists and gets no test hooks of its own.
 *
 *   /replay.html?scenario=<id>&tab=project
 *   /replay.html?scenario=<id>&view=map
 */
const clickByName = (name: string): boolean => {
  const match = [...document.querySelectorAll("button")].find(
    (button) =>
      (button.textContent ?? "").trim() === name ||
      button.getAttribute("aria-label") === name
  );
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
    params.get("view") === "map" ? "Map" : null,
    params.get("open") === "plan" ? "View plan" : null
  ].filter((step): step is string => step !== null);
  if (steps.length === 0) return;
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (steps.length > 0 && clickByName(steps[0]!)) steps.shift();
    if (steps.length === 0 || attempts > 60) window.clearInterval(timer);
  }, 100);
};

void import("../src/main").then(() => window.setTimeout(drive, 300));

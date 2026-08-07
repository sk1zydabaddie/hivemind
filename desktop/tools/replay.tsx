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

interface ReplayScenario {
  id: string;
  source: string;
  events: ReplayEvent[];
  span_ms: number;
  inspection: Record<string, unknown> | null;
  inspection_error: string | null;
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
document.addEventListener("DOMContentLoaded", () => document.body.append(banner));

class ReplayEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    const output = url.includes("/output/stream");
    window.setTimeout(() => {
      this.onopen?.();
      if (output) return;
      scenario.events.forEach((event, index) => {
        this.onmessage?.({
          data: JSON.stringify({ kind: "event", source: "history", seq: index + 1, event })
        });
      });
    }, 0);
  }

  close(): void {
    /* no transport to close */
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
        if (scenario.inspection === null) {
          throw new Error(scenario.inspection_error ?? "no projection for this trail");
        }
        return scenario.inspection;
      }
      if (action.type === "trail.inspect") return scenario.events;
      return {};
    }
    throw new Error(`replay harness has no stub for ${command}`);
  }
};

void import("../src/main");

/* Replay collector.
 *
 * Reads captured event trails out of docs/evidence (never writing to them),
 * replays each into a throwaway scratch repository, and runs Core's real
 * `inspectWorkspace` over it. The output is what the daemon would actually have
 * told the desktop for that run — not a hand-written fixture.
 *
 *   node tools/collect-replay.mjs
 *
 * Writes tools/replay-data.json, which replay.html loads. That file is derived
 * data: regenerate it rather than editing it.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const evidenceRoot = path.join(repoRoot, "docs", "evidence");

const EVENT_LINE = /^\{"ts":"20\d\d-/u;

async function collectEvidenceFiles() {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".md")) {
        found.push(full);
      }
    }
  }
  await walk(evidenceRoot);
  return found.sort();
}

/** Every line in the file that parses as a durable Hivemind event. */
function extractEvents(text) {
  const events = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!EVENT_LINE.test(line)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed?.ts === "string" &&
      typeof parsed?.type === "string" &&
      typeof parsed?.data === "object" &&
      parsed.data !== null
    ) {
      events.push({
        ts: parsed.ts,
        type: parsed.type,
        task_id: typeof parsed.task_id === "string" ? parsed.task_id : null,
        data: parsed.data
      });
    }
  }
  return events;
}

/* A trail can hold several separate runs. Split on a long quiet gap so each
   scenario is one run rather than a decade of unrelated history. */
function splitRuns(events, gapMs = 30 * 60 * 1000) {
  const sorted = [...events].sort((left, right) => left.ts.localeCompare(right.ts));
  const runs = [];
  let current = [];
  let previous = null;
  for (const event of sorted) {
    if (previous !== null && Date.parse(event.ts) - Date.parse(previous) > gapMs) {
      runs.push(current);
      current = [];
    }
    current.push(event);
    previous = event.ts;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/* Some state a run depends on is not in the event trail at all: the ratified
 * plan, the spec, the contracts and the spend ledger are files. A trail on its
 * own therefore replays with a null plan and zero spend -- which is exactly why
 * the plan review and the spend meter had never been seen against real data.
 *
 * An evidence folder may carry a `project-state/` directory mirroring the
 * layout of `.hivemind/`. When one sits beside a trail, it is copied in after
 * `initProject`, so the replay gets the real artefacts rather than a
 * reconstruction. Captured, never invented: if the folder is absent the replay
 * behaves exactly as before.
 */
async function restoreProjectState(repo, trailPath) {
  const stateDir = path.join(path.dirname(trailPath), "project-state");
  try {
    await readdir(stateDir);
  } catch {
    return false;
  }
  /* Everything except config.json, which is merged below rather than copied:
     copying it whole would replace the config `initProject` just wrote, losing
     the format version the rest of Core requires. */
  await cp(stateDir, path.join(repo, ".hivemind"), {
    recursive: true,
    force: true,
    filter: (source) => path.basename(source) !== "config.json"
  });

  /* config.json cannot be restored wholesale -- it carries `repo_root` and a
     base branch belonging to the machine that ran it. Only the two settings the
     UI reads back are merged: without them the spend meter compares real usage
     against init's default ceilings and shows a run that was well inside budget
     in amber, which is a wrong signal rather than a missing one. */
  const captured = path.join(stateDir, "config.json");
  try {
    const source = JSON.parse(await readFile(captured, "utf8"));
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const key of ["resource_policy", "execution"]) {
      if (source[key] !== undefined) config[key] = source[key];
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    /* No captured config, or none worth merging. The defaults stand. */
  }
  return true;
}

async function scratchRepo(events, trailPath) {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-replay-"));
  const git = (args) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
  await git(["init"]);
  await git(["config", "user.name", "Hivemind Replay"]);
  await git(["config", "user.email", "replay@example.test"]);
  await writeFile(path.join(repo, "README.md"), "# Replay\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "replay base"]);
  const { initProject } = await import(
    new URL(`file://${path.join(repoRoot, "dist", "src", "init.js").replaceAll("\\", "/")}`)
  );
  await initProject(repo);
  await mkdir(path.join(repo, ".hivemind", "log"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "log", "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
  /* Real captured contracts win over reconstructed ones. Only synthesize the
     contracts the capture did not include. */
  const restored = await restoreProjectState(repo, trailPath);
  await writeContracts(repo, events, restored);
  return repo;
}

/* Core lists tasks from `.hivemind/tasks/*.contract.json`, not from the event
 * log, so a captured trail on its own projects zero tasks. The trail does carry
 * what each contract said in `task.created`, so the collector writes those back
 * out. Anything not recorded there is left empty rather than invented — see the
 * replay findings in DESIGN-NOTES.md. */
async function writeContracts(repo, events, restored = false) {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  const already = restored
    ? new Set((await readdir(tasksDir)).map((name) => name.replace(/\.contract\.json$/u, "")))
    : new Set();
  const seen = new Set();
  for (const event of events) {
    if (event.type !== "task.created" || event.task_id === null) continue;
    if (seen.has(event.task_id) || already.has(event.task_id)) continue;
    seen.add(event.task_id);
    const data = event.data;
    const allowed = Array.isArray(data.allowed_files) ? data.allowed_files : [];
    await writeFile(
      path.join(tasksDir, `${event.task_id}.contract.json`),
      `${JSON.stringify(
        {
          task_id: event.task_id,
          title: typeof data.title === "string" ? data.title : event.task_id,
          agent_role: typeof data.agent_role === "string" ? data.agent_role : "builder",
          routing_task_type:
            typeof data.routing_task_type === "string" ? data.routing_task_type : "other",
          base_commit: typeof data.base_commit === "string" ? data.base_commit : "0".repeat(40),
          acceptance_criterion:
            typeof data.acceptance_criterion === "string" ? data.acceptance_criterion : "",
          allowed_files: allowed,
          allowed_file_intents: Object.fromEntries(allowed.map((file) => [file, "modify"])),
          read_only_files: Array.isArray(data.read_only_files) ? data.read_only_files : [],
          forbidden_files: Array.isArray(data.forbidden_files) ? data.forbidden_files : [],
          allowed_symbols: [],
          forbidden_symbols: [],
          must_not_change: [],
          /* Not recorded in `task.created`. Core refuses a contract without it,
             so the replay supplies the command named by the acceptance criterion
             when there is one. This is the only synthesized field. */
          required_tests: Array.isArray(data.required_tests) && data.required_tests.length > 0
            ? data.required_tests
            : [commandFromAcceptance(data.acceptance_criterion)],
          deterministic_validity_check: "node -e \"process.exit(0)\" # replay: not recorded in the trail",
          patch_requirements: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

/* The trail keeps the acceptance criterion verbatim; when it names a command,
   that command is the honest stand-in for the checks Core did not record. */
function commandFromAcceptance(criterion) {
  if (typeof criterion !== "string") return "npm test";
  const match = /((?:node|npm|npx|pnpm|yarn)\s+[^.;]+)/u.exec(criterion);
  return match === null ? "npm test" : match[1].trim();
}

async function inspect(events, trailPath) {
  const repo = await scratchRepo(events, trailPath);
  try {
    const { inspectWorkspace } = await import(
      new URL(
        `file://${path.join(repoRoot, "dist", "src", "workspace-inspection.js").replaceAll("\\", "/")}`
      )
    );
    const result = await inspectWorkspace(repo);
    return result.ok
      ? { ok: true, inspection: result.value }
      : { ok: false, reason: result.reason };
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

/* Where the run was busiest: the point at which the most tasks were started and
 * none of them had finished yet. Cutting the trail there and projecting the
 * truncated events through Core gives a genuine mid-run state -- something the
 * corpus has never held, because every captured trail projects only to its end.
 *
 * A finished run is the easy state to draw. Work in flight is the one the
 * product is actually about, and it had only ever been seen in fixtures or in a
 * screenshot caught at whatever moment a human happened to press the button.
 */
function busiestPrefix(run) {
  const running = new Set();
  let best = { count: 0, index: -1 };
  run.forEach((event, index) => {
    if (event.task_id === null) return;
    if (event.type === "task.started" || event.type === "task.resumed") running.add(event.task_id);
    if (["task.completed", "task.failed", "task.blocked", "task.cancelled"].includes(event.type)) {
      running.delete(event.task_id);
    }
    if (running.size > best.count) best = { count: running.size, index };
  });
  return best.count >= 2 ? run.slice(0, best.index + 1) : null;
}

const files = await collectEvidenceFiles();
const scenarios = [];
for (const file of files) {
  const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
  const events = extractEvents(await readFile(file, "utf8"));
  if (events.length === 0) continue;
  for (const [index, run] of splitRuns(events).entries()) {
    if (run.length < 3) continue;
    const id = `${path.basename(file).replace(/\.(jsonl|md)$/u, "")}${index === 0 ? "" : `-${index + 1}`}`;
    const projected = await inspect(run, file);
    scenarios.push({
      id,
      source: relative,
      events: run,
      span_ms: Date.parse(run.at(-1).ts) - Date.parse(run[0].ts),
      inspection: projected.ok ? projected.inspection : null,
      inspection_error: projected.ok ? null : projected.reason
    });
    console.log(
      `${id.padEnd(34)} ${String(run.length).padStart(3)} events  ${
        projected.ok ? "projected" : `NO PROJECTION: ${projected.reason}`
      }`
    );

    const midrun = busiestPrefix(run);
    if (midrun !== null && midrun.length < run.length) {
      const midProjected = await inspect(midrun, file);
      scenarios.push({
        id: `${id}@midrun`,
        source: `${relative} (cut at peak concurrency)`,
        events: midrun,
        span_ms: Date.parse(midrun.at(-1).ts) - Date.parse(midrun[0].ts),
        inspection: midProjected.ok ? midProjected.inspection : null,
        inspection_error: midProjected.ok ? null : midProjected.reason
      });
      console.log(
        `${`${id}@midrun`.padEnd(34)} ${String(midrun.length).padStart(3)} events  ${
          midProjected.ok ? "projected" : `NO PROJECTION: ${midProjected.reason}`
        }`
      );
    }
  }
}

scenarios.sort((left, right) => right.events.length - left.events.length);
await writeFile(
  path.join(desktopRoot, "tools", "replay-data.json"),
  `${JSON.stringify({ generated_from: "docs/evidence", scenarios }, null, 2)}\n`,
  "utf8"
);
console.log(`\n${scenarios.length} scenarios -> tools/replay-data.json`);

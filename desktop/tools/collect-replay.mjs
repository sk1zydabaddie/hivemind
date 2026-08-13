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
/**
 * The diffs a run's workers actually produced, if the capture kept them.
 *
 * `.hivemind/patches/<task>/diff.patch` is where Core writes a submitted
 * change, so an evidence folder that mirrored `.hivemind` has the real thing.
 * This is what lets the change viewer be verified against a real patch rather
 * than a hand-written one -- and a run whose capture predates the practice
 * simply has none, which the viewer states plainly.
 */
async function readCapturedPatches(trailPath) {
  const patches = {};
  for (const stateDir of ["project-state", "project-state-after"]) {
    const root = path.join(path.dirname(trailPath), stateDir, "patches");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        patches[entry.name] = await readFile(path.join(root, entry.name, "diff.patch"), "utf8");
      } catch {
        /* A task directory with no diff is a task that submitted nothing. */
      }
    }
  }
  return patches;
}

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
  await rewindLeaseStore(repo, events);
  return repo;
}

/* A cut trail must not be handed the run's FINAL file state.
 *
 * `project-state/` is captured after the run finished, so replaying a trail cut
 * mid-run served a lease store that had already been emptied at adoption — and
 * the rail rendered it as fact: "Files being edited — 0" beside three agents
 * that were each holding two files. Leases are a file rather than events, so
 * nothing cut them with the trail.
 *
 * This is the silently-wrong-UI shape from the one direction the "capture the
 * trail AND the project state" rule did not cover: captured state is not wrong,
 * it is just LATER than the cut.
 *
 * Nothing is invented. The store is `{ path: taskId }`; `lease.approved`
 * records what was granted and `lease.released` gives it back, so replaying the
 * pair to the cut point reconstructs exactly who held what at that moment. It
 * is then read back through Core's own `readActiveLeases`, so the reconstruction
 * has to satisfy Core's validation to appear at all.
 */
async function rewindLeaseStore(repo, events) {
  const held = {};
  for (const event of events) {
    if (event.task_id === null) continue;
    if (event.type === "lease.approved") {
      for (const file of event.data.granted ?? []) held[file] = event.task_id;
    }
    if (event.type === "lease.released") {
      for (const [file, holder] of Object.entries(held)) {
        if (holder === event.task_id) delete held[file];
      }
    }
  }
  await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "leases", "active.json"),
    `${JSON.stringify(Object.fromEntries(Object.entries(held).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
    "utf8"
  );
}

/* The other half of the same problem, and the half that cannot be reconstructed.
 *
 * The manager session's `status` is what the client reads to decide whether a
 * run is live — which is what chooses "running 1m 39s" over "took 1m 39s". Core
 * derives it from the session's own pending actions
 * (`proposed_action.actions.length === 0 ? "complete" : "active"`), so rewinding
 * the FILE would mean inventing a scheduled action, and an invented action can
 * surface an approval control. That is far past what a capture may do.
 *
 * So the enum is corrected on the projection instead, for a cut that reaches no
 * terminal event — the trail itself is the evidence the run had not finished.
 * `pending_action` and `continuation_available` are left exactly as captured, so
 * this cannot conjure an affordance; it only stops a live run being described in
 * the past tense. Marked in the scenario's `source`, like every other
 * synthesized state in this file.
 */
function liveSession(inspection, events) {
  const finished = events.some((event) =>
    ["adoption.completed", "scheduler.run_completed", "scheduler.run_cancelled"].includes(event.type)
  );
  const session = inspection?.manager_session;
  if (finished || !session || (session.status !== "complete" && session.status !== "stopped")) {
    return inspection;
  }
  return {
    ...inspection,
    manager_session: {
      ...session,
      status: "active",
      last_activity_at: events.at(-1)?.ts ?? session.last_activity_at
    }
  };
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

/* A projection at every point the run visibly changed.
 *
 * Playing a trail back in time is only honest if the projection moves with it.
 * Serving the final projection while events trickle in would draw a rail
 * reading "4/4 shipped" over a thread that has not finished planning -- the
 * exact class of wrong this corpus keeps producing.
 *
 * One scratch repository is built and re-inspected at each cut, because
 * `initProject` and `git init` dominate the cost and neither changes.
 */
const MILESTONE_TYPES = new Set([
  "plan.prepared",
  "plan.ratified",
  "task.started",
  "task.completed",
  "task.failed",
  "task.blocked",
  "patch.rejected",
  "integration.passed",
  "integration.failed",
  "adoption.reviewed",
  "adoption.completed"
]);

async function inspectTimeline(run, trailPath) {
  const cuts = [];
  run.forEach((event, index) => {
    if (MILESTONE_TYPES.has(event.type)) cuts.push(index);
  });
  if (cuts.length === 0) return null;
  if (cuts.at(-1) !== run.length - 1) cuts.push(run.length - 1);

  const repo = await scratchRepo(run, trailPath);
  const eventsPath = path.join(repo, ".hivemind", "log", "events.jsonl");
  try {
    const { inspectWorkspace } = await import(
      new URL(
        `file://${path.join(repoRoot, "dist", "src", "workspace-inspection.js").replaceAll("\\", "/")}`
      )
    );
    const start = Date.parse(run[0].ts);
    const frames = [];
    for (const cut of cuts) {
      const prefix = run.slice(0, cut + 1);
      await writeFile(
        eventsPath,
        `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8"
      );
      const result = await inspectWorkspace(repo);
      if (!result.ok) continue;
      frames.push({
        event_index: cut,
        at_ms: Date.parse(run[cut].ts) - start,
        inspection: result.value
      });
    }
    return frames.length > 0 ? frames : null;
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

/* Worker output is not in the trail: it is written to
 * `.hivemind/log/tasks/<id>.output.jsonl`, which a capture only holds if the
 * evidence folder took it. Where it exists, playback can stream it back on the
 * same clock as the events, which is the difference between a demo of state
 * changing and a demo of agents working. */
async function collectOutput(trailPath) {
  const dir = path.join(path.dirname(trailPath), "project-state", "log", "tasks");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const output = {};
  for (const name of names) {
    if (!name.endsWith(".output.jsonl")) continue;
    const records = [];
    for (const line of (await readFile(path.join(dir, name), "utf8")).split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.task_id === "string" && typeof record?.text === "string") {
          records.push(record);
        }
      } catch {
        /* a truncated final line is not worth failing a capture over */
      }
    }
    if (records.length > 0) output[records[0].task_id] = records;
  }
  return Object.keys(output).length > 0 ? output : null;
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

/* The one state a captured trail cannot project: ready to ship.
 *
 * `inspectLatestAdoptionReadiness` compares the verified set against the live
 * repository, and a scratch repository is not the repository the run happened
 * in -- so a trail cut just before `adoption.completed` projects as "the checks
 * are stale" rather than "ready". The live run showed the ship bar; the replay
 * of the same trail cannot.
 *
 * So the queue item is rebuilt from the run's own `adoption.reviewed` event,
 * field for field as `buildQueues` builds it. Everything shown -- the tasks,
 * the files, the branch, the base commit, the identifiers -- is read out of a
 * durable event this run really appended. What is synthesized is the *state*:
 * that the readiness check would say "ready". Per the standing rule, that is
 * marked here, in the scenario's `source`, and in the DESIGN-NOTES.
 */
function shipReadyCut(run, { bound = true } = {}) {
  const completedAt = run.findIndex((event) => event.type === "adoption.completed");
  if (completedAt < 1) return null;
  const reviewed = [...run.slice(0, completedAt)]
    .reverse()
    .find((event) => event.type === "adoption.reviewed");
  if (reviewed === undefined) return null;
  const data = reviewed.data;
  if (
    typeof data.pending_adoption_id !== "string" ||
    typeof data.verification_id !== "string" ||
    typeof data.expected_base_head !== "string" ||
    typeof data.expected_state_hash !== "string" ||
    !Array.isArray(data.task_ids) ||
    !Array.isArray(data.changed_files)
  ) {
    return null;
  }
  const baseBranch = typeof data.base_branch === "string" ? data.base_branch : "the project branch";
  /* Shipping is TWO steps, and the first one had never been captured.
     `exactReview` is false until an `adoption.reviewed` event exists, so the
     bar a person actually meets first says "Fresh checks passed; review the
     change set" and offers `adoption.review`. Only after that does it become
     "Confirm this exact change set" with `adoption.execute`. Both are Core's
     own wording from `buildQueues`; `bound` chooses which step to draw. */
  const item = {
    id: `adoption:${data.verification_id}:${bound ? data.pending_adoption_id : "review"}`,
    kind: "adoption_ready",
    title: bound ? "Confirm this exact change set" : "Fresh checks passed; review the change set",
    detail: `${data.task_ids.join(" + ")} / ${data.changed_files.length} files / base ${data.expected_base_head.slice(0, 8)}. ${
      bound
        ? `This one action moves the verified set onto ${baseBranch}.`
        : "Review binds this exact set before merge authorization appears."
    }`,
    created_at: reviewed.ts,
    task_id: null,
    action: bound
      ? {
          type: "adoption.execute",
          payload: {
            pending_adoption_id: data.pending_adoption_id,
            verification_id: data.verification_id,
            expected_base_head: data.expected_base_head,
            expected_state_hash: data.expected_state_hash
          }
        }
      : { type: "adoption.review", payload: { verification_id: data.verification_id } },
    change_set: {
      verification_id: data.verification_id,
      base_branch: baseBranch,
      task_ids: [...data.task_ids],
      changed_files: [...data.changed_files]
    }
  };
  return { events: run.slice(0, completedAt), item };
}

/* The one review: a plan awaiting ratification, with the spec half beside it.
 *
 * No captured trail holds this state either -- the real run's plan was ratified
 * during it, so every trail projects with `plan_review: null`. What is real
 * here is everything on the screen: the plan is the run's own ratified plan,
 * and the spec is a REAL drafted spec from the drafting experiment
 * (`docs/evidence/spec-drafting-vacuity.json`), with its real open question and
 * its real suggested non-goal. What is synthesized is one boolean -- that the
 * plan is pending rather than approved. Marked here and in the scenario id.
 *
 * `assumptions` is empty because that experiment predates the drafter writing
 * them; an invented assumption would be exactly the theatre the experiment was
 * run to detect.
 */
function specReviewFromDraft(result) {
  const draft = result.draft;
  if (draft === undefined) return null;
  return {
    spec_id: "S-001",
    title: draft.title ?? "",
    authorship: "drafted",
    status: "draft",
    goal: draft.goal ?? "",
    drafted_non_goals: [...(draft.non_goals ?? [])],
    acceptance: [...(draft.acceptance ?? [])],
    open_questions: [...(draft.open_questions ?? [])],
    assumptions: [],
    asked_for: result.prompt ?? null
  };
}

async function draftedSpecs() {
  const file = path.join(evidenceRoot, "spec-drafting-vacuity.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const wanted = [
    ["blocked", (entry) => (entry.draft?.open_questions ?? []).length > 0],
    ["ready", (entry) => (entry.draft?.open_questions ?? []).length === 0]
  ];
  const found = [];
  for (const [suffix, matches] of wanted) {
    const entry = (parsed.results ?? []).find(matches);
    const review = entry === undefined ? null : specReviewFromDraft(entry);
    if (review !== null) found.push({ suffix, review });
  }
  return found;
}

/* A project that has done nothing: no tasks, no plan, nothing in the queue.
 *
 * Every captured trail starts after somebody typed a prompt, so the first thing
 * a person sees has never had a scenario. This is the same emptying replay.html
 * already does before a playback's first captured frame -- a real projection
 * with its run-shaped fields cleared -- rather than a hand-written inspection,
 * so the settings, the ceilings and the shape of the object stay real.
 */
function emptyProjectScenario(scenario) {
  if (scenario.inspection === null) return null;
  return {
    id: "empty-project",
    source: `${scenario.source} (run-shaped fields cleared: a project that has done nothing)`,
    events: [],
    span_ms: 0,
    inspection: {
      ...scenario.inspection,
      tasks: [],
      execution_groups: [],
      task_titles: {},
      plan_review: null,
      current_plan: null,
      manager_session: null,
      needs_you: [],
      later: [],
      active_spec_id: null,
      active_spec_title: null
    },
    inspection_error: null
  };
}

const files = await collectEvidenceFiles();
const scenarios = [];
for (const file of files) {
  const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
  const events = extractEvents(await readFile(file, "utf8"));
  if (events.length === 0) continue;
  for (const [index, run] of splitRuns(events).entries()) {
    /* Three events is a reasonable floor for noise, but a run stopped at its
       review is genuinely short -- a plan prepared and a decision recorded is
       two -- and it is the state the review screens most needed. Keep anything
       carrying a plan however brief. */
    if (run.length < 3 && !run.some((event) => event.type.startsWith("plan."))) continue;
    const id = `${path.basename(file).replace(/\.(jsonl|md)$/u, "")}${index === 0 ? "" : `-${index + 1}`}`;
    const projected = await inspect(run, file);
    const patches = await readCapturedPatches(file);
    scenarios.push({
      id,
      source: relative,
      events: run,
      /* The real diffs a worker produced, where the evidence folder kept them.
         Captured, never invented: a scenario without them replays exactly as
         before and the change viewer says it has nothing to show. Serving one
         run's patch under another run's scenario would be the same class of
         mistake as serving a finished projection over a mid-run trail. */
      patches,
      span_ms: Date.parse(run.at(-1).ts) - Date.parse(run[0].ts),
      inspection: projected.ok ? projected.inspection : null,
      inspection_error: projected.ok ? null : projected.reason
    });
    console.log(
      `${id.padEnd(34)} ${String(run.length).padStart(3)} events  ${
        projected.ok ? "projected" : `NO PROJECTION: ${projected.reason}`
      }`
    );

    /* Only a run that reaches a ship is worth the cost of a frame-by-frame
       projection, and only that run can be played as a demo of the whole
       thing. Everything else keeps the single end-state projection. */
    const complete =
      run.some((event) => event.type === "plan.ratified") &&
      run.some((event) => event.type === "adoption.completed");
    if (complete && projected.ok) {
      const scenario = scenarios.at(-1);
      const [timeline, output] = await Promise.all([
        inspectTimeline(run, file),
        collectOutput(file)
      ]);
      if (timeline !== null) scenario.timeline = timeline;
      if (output !== null) scenario.output = output;
      console.log(
        `${"".padEnd(34)}     playback: ${timeline?.length ?? 0} projections, ${
          output === null ? 0 : Object.values(output).reduce((n, r) => n + r.length, 0)
        } output records`
      );
    }

    for (const bound of [true, false]) {
    const ship = shipReadyCut(run, { bound });
    if (ship !== null) {
      const shipProjected = await inspect(ship.events, file);
      if (shipProjected.ok) {
        /* The stale-checks item the scratch repository produces is the same
           artefact, from the other side: it is a fact about the replay, not
           about the run, whose trail goes integration.passed -> reviewed ->
           completed with no rerun in between. */
        const rest = (shipProjected.inspection.needs_you ?? []).filter(
          (item) => item.kind !== "reverification_required"
        );
        scenarios.push({
          id: `${id}@ship${bound ? "" : "-review"}`,
          source: `${relative} (cut before adoption; readiness rebuilt from adoption.reviewed, ${bound ? "bound" : "unbound"} step)`,
          patches,
          events: ship.events,
          span_ms: Date.parse(ship.events.at(-1).ts) - Date.parse(ship.events[0].ts),
          inspection: { ...shipProjected.inspection, needs_you: [ship.item, ...rest] },
          inspection_error: null
        });
        console.log(
          `${`${id}@ship${bound ? "" : "-review"}`.padEnd(34)} ${String(ship.events.length).padStart(3)} events  projected + readiness rebuilt`
        );
      }
    }
    }

    const midrun = busiestPrefix(run);
    if (midrun !== null && midrun.length < run.length) {
      const midProjected = await inspect(midrun, file);
      scenarios.push({
        id: `${id}@midrun`,
        source: `${relative} (cut at peak concurrency; leases rebuilt from the trail, session status corrected to live)`,
        events: midrun,
        span_ms: Date.parse(midrun.at(-1).ts) - Date.parse(midrun[0].ts),
        inspection: midProjected.ok ? liveSession(midProjected.inspection, midrun) : null,
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

/* The review pair, hung off the richest run that actually carries a plan. */
const planned = scenarios.find(
  (scenario) => scenario.inspection?.current_plan !== null && scenario.inspection !== null
);
if (planned !== undefined) {
  for (const { suffix, review } of await draftedSpecs()) {
    scenarios.push({
      id: `${planned.id}@review-${suffix}`,
      source: `${planned.source} + docs/evidence/spec-drafting-vacuity.json (real plan, real drafted spec; the pending state is synthesized)`,
      events: planned.events,
      span_ms: planned.span_ms,
      inspection: {
        ...planned.inspection,
        plan_review: planned.inspection.current_plan,
        needs_you: []
      },
      inspection_error: null,
      spec_review: review
    });
    console.log(
      `${`${planned.id}@review-${suffix}`.padEnd(34)}   real plan + real drafted spec, pending synthesized`
    );
  }
}

const richest = scenarios.find((scenario) => scenario.inspection !== null);
const empty = richest === undefined ? null : emptyProjectScenario(richest);
if (empty !== null) {
  scenarios.push(empty);
  console.log(`${empty.id.padEnd(34)}   0 events  cleared from ${richest.id}`);
}

/* The two surfaces the evidence corpus cannot serve, captured for real instead.
 *
 * The `project-state` capture in every trail is the `.hivemind` directory -- Hivemind's
 * own record -- and none of them retained the project's SOURCE tree or what its
 * checks printed. So neither the file tree nor the checks pane has captured
 * state to replay, and inventing some would be a fixture pretending to be a
 * trail.
 *
 * These run the REAL Core functions -- `listProjectFiles`, `readProjectFile`,
 * `runNamedCheck`, `storeCheckOutput`, `readCheckOutput` -- over a real
 * directory and a real command, and keep what comes back. It is genuinely
 * produced rather than authored, and it is named in the README as a live
 * capture rather than a replayed trail, because that is what it is.
 *
 * The capture procedure has been changed so the next run retains both from the
 * trail itself; see desktop/DESIGN-NOTES.md. When it does, this is deleted.
 */
async function captureProjectFiles() {
  const { listProjectFiles, readProjectFile } = await import(
    new URL(`file://${path.join(repoRoot, "dist", "src", "project-files.js").replaceAll("\\", "/")}`)
  );
  /* A real project: this repository's own desktop client. */
  const listings = {};
  const files = {};
  const queue = ["."];
  let budget = 40;
  while (queue.length > 0 && budget > 0) {
    const directory = queue.shift();
    const listed = await listProjectFiles(desktopRoot, directory);
    if (!listed.ok) continue;
    listings[directory] = listed.value;
    budget -= 1;
    for (const entry of listed.value.entries) {
      /* Bounded on purpose: a full walk of node_modules would be most of a
         gigabyte of replay data for a screenshot of a tree. Named here rather
         than silently truncated. */
      if (entry.kind === "directory" && !["node_modules", "dist"].includes(entry.name)) {
        if (directory.split("/").length < 3) queue.push(entry.path);
      }
    }
  }
  for (const wanted of ["src/lib/diff-model.ts", "src/lib/provider-usage.ts", "package.json"]) {
    const read = await readProjectFile(desktopRoot, wanted);
    if (read.ok) files[wanted] = read.value;
  }
  return { listings, files };
}

async function captureCheckOutput() {
  const { runNamedCheck } = await import(
    new URL(`file://${path.join(repoRoot, "dist", "src", "check-runner.js").replaceAll("\\", "/")}`)
  );
  const { newChecksRunId, storeCheckOutput, readCheckOutput } = await import(
    new URL(`file://${path.join(repoRoot, "dist", "src", "check-output.js").replaceAll("\\", "/")}`)
  );
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-replay-checks-"));
  try {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(
      path.join(repo, "test", "slugify.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'const slugify = (value) => value.toLowerCase().replaceAll(" ", "-");',
        'test("lowercases and hyphenates", () => {',
        '  assert.equal(slugify("Hello World"), "hello-world");',
        "});",
        'test("strips punctuation", () => {',
        '  assert.equal(slugify("Hello, World!"), "hello-world");',
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
    /* A real command, really run, really failing -- the second assertion is
       genuinely wrong. Nothing about the output below is authored. */
    const checks = [
      await runNamedCheck(repo, "lint", `${JSON.stringify(process.execPath)} --check test/slugify.test.js`),
      await runNamedCheck(repo, "tests", `${JSON.stringify(process.execPath)} --test test/slugify.test.js`)
    ];
    const runId = newChecksRunId();
    const stored = await storeCheckOutput(repo, runId, checks);
    if (!stored.ok) return null;
    const read = await readCheckOutput(repo, runId);
    if (!read.ok) return null;
    return {
      ...read.value,
      ran_at: new Date().toISOString(),
      task_ids: [],
      tests: checks.every((check) => check.exit_code === 0) ? "pass" : "fail"
    };
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

const projectFiles = await captureProjectFiles();
console.log(
  `${"live: project files".padEnd(34)}   ${String(Object.keys(projectFiles.listings).length)} directories, ${String(Object.keys(projectFiles.files).length)} files`
);
const checkOutput = await captureCheckOutput();
console.log(
  `${"live: check output".padEnd(34)}   ${checkOutput === null ? "unavailable" : `${String(checkOutput.checks.length)} checks, ${checkOutput.tests}`}`
);

scenarios.sort((left, right) => right.events.length - left.events.length);
await writeFile(
  path.join(desktopRoot, "tools", "replay-data.json"),
  `${JSON.stringify(
    { generated_from: "docs/evidence", scenarios, project_files: projectFiles, check_output: checkOutput },
    null,
    2
  )}\n`,
  "utf8"
);
console.log(`\n${scenarios.length} scenarios -> tools/replay-data.json`);

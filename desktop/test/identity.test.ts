import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { holdingGate, passedGates } from "../src/lib/gates";
import { createBoardProjection, type BoardProjection } from "../src/lib/projection";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const withEvents = (types: string[]): BoardProjection => ({
  ...createBoardProjection(),
  recentEvents: types.map((type, index) => ({ seq: index, type }) as never)
});

describe("the gates are drawn from the trail", () => {
  /* The whole claim of this surface: a screenshot where nothing has gone wrong
     still shows that something is being enforced. That is only true if the
     rules come from events that really happened. */
  test("a rule is drawn only for a gate something actually passed through", () => {
    expect(passedGates(createBoardProjection())).toEqual([]);

    const rules = passedGates(withEvents(["lease.approved", "task.started"]));
    expect(rules.map((rule) => rule.id)).toEqual(["scope"]);
    expect(rules[0]!.detail).toBe("1 file claim approved");
    /* No rule for the gates nothing has reached. Drawing those would be
       describing the product rather than reporting the run. */
    expect(rules.map((rule) => rule.id)).not.toContain("write");
  });

  /* The constraint that matters most: the rules must not become chrome. */
  test("one rule per GATE, never per task and never per phase", () => {
    const rules = passedGates(
      withEvents([
        "lease.approved",
        "lease.approved",
        "lease.approved",
        "write_intent.approved",
        "write_intent.approved"
      ])
    );
    expect(rules).toHaveLength(2);
    expect(rules.find((rule) => rule.id === "scope")!.detail).toBe("3 file claims approved");
    expect(rules.find((rule) => rule.id === "write")!.detail).toBe("2 edits approved");
  });

  test("only a held gate is allowed to be loud", () => {
    for (const rule of passedGates(withEvents(["lease.approved"]))) {
      expect(rule.standing).toBe("passed");
    }
    const held = holdingGate({
      task_id: "T-004",
      state: "paused",
      issue: "package.json needs a person"
    } as never);
    expect(held?.standing).toBe("held");
    expect(held?.detail).toBe("package.json needs a person");
  });

  /* Core's reason, verbatim, or no rule. A rule that invented a name for
     something nobody named would be the surface asserting a fact of its own. */
  test("a task with no recorded reason gets no rule", () => {
    expect(holdingGate({ task_id: "T-001", state: "paused", issue: "" } as never)).toBeNull();
    expect(
      holdingGate({ task_id: "T-002", state: "running", issue: "still going" } as never)
    ).toBeNull();
  });

  test("the passed rule is thinner and lighter than any lane", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const gate = styles.slice(styles.indexOf(".gate-rule::before"));
    /* A hairline against the rule colour. The lane is 2px in navy or clay; a
       gate that matched it would be another lane, and every phase boundary
       drawing one would be horizontal noise competing with the attention
       edge for the same glance. */
    expect(gate).toMatch(/height:\s*1px/u);
    expect(gate).toMatch(/background:\s*var\(--rule\)/u);
    expect(styles).toMatch(/\.lane\[data-standing="working"\][\s\S]*?background:\s*var\(--navy\)/u);
  });
});

describe("the motion is bound to real state", () => {
  test("nothing animates on a timer", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    for (const name of ["hex-draw", "hex-advance", "ship-land"]) {
      const rule = new RegExp(`animation:\\s*${name}[^;]*;`, "u").exec(styles);
      expect(rule, `${name} must be declared`).not.toBeNull();
      /* `infinite` is what makes a decoration out of a signal. The one
         exception in this app is the attention edge, which is elsewhere and
         means "this needs you" rather than "something happened". */
      expect(rule![0]).not.toMatch(/infinite/u);
    }
  });

  test("every new animation is switched off for reduced motion", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    /* `\n}` needs the brace escaped under the `u` flag — a lone `}` is a
       "lone quantifier bracket" and the file will not even parse. */
    const reduced = styles.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/gu) ?? [];
    const joined = reduced.join("\n");
    for (const name of ["hex-check", "hex-advance", "ship-mark"]) {
      expect(joined, `${name} must stop under reduced motion`).toMatch(
        new RegExp(`\\.${name}`, "u")
      );
    }
  });

  test("the check draws on completion rather than fading in", async () => {
    const hex = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "hex.tsx"),
      "utf8"
    );
    /* Taken from 21st.dev's AI Task List: a dash-offset keyframe rather than an
       animated motion value, so reduced motion is handled in CSS with no JS
       branch to get out of step. */
    expect(hex).toMatch(/strokeDasharray/u);
    expect(hex).toMatch(/pathLength=\{1\}/u);
    expect(hex).not.toMatch(/framer-motion|useReducedMotion/u);
  });
});

describe("the accumulation is a count, not a metric", () => {
  test("the comb counts shipped tasks and invents nothing", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"),
      "utf8"
    );
    const comb = source.slice(source.indexOf("function Comb("));
    /* Every stat card surveyed for this pass paired a count-up on mount with a
       percentage change against a "previous period". Both are invented. */
    expect(comb).not.toMatch(/streak|average|percent|%|previous|trend|since last/iu);
    expect(comb).not.toMatch(/setInterval|requestAnimationFrame/u);
    /* And a capped comb says it is capped. A count that silently stops is a
       count that lies. */
    expect(comb).toMatch(/more not drawn/u);
  });
});

describe("the mark is the real one", () => {
  test("the brand mark ships as the asset, in both themes", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    expect(app).toMatch(/assets\/mark\.png/u);
    expect(app).toMatch(/assets\/mark-dark\.png/u);
    /* The near-black half of the mark disappears on the dark canvas, so the
       swap is a real requirement rather than a nicety — and it is done in CSS
       so it follows the OS with no JS and no flash of the wrong one. */
    expect(app).toMatch(/prefers-color-scheme: dark/u);
    expect(app).not.toMatch(/const hex = \(cx: number/u);
  });
});

describe("the build mismatch has an exit", () => {
  test("it is recognised by code and offers the action", async () => {
    const { plainConnectionProblem } = await import(
      "../src/components/workspace/setup-screen"
    );
    const { PROJECT_FAULT } = await import("../src/lib/project-session");
    const problem = plainConnectionProblem(
      PROJECT_FAULT.daemonBuildMismatch,
      "daemon build mismatch: state 9f9f…, running 9f9f…, expected a1b2…"
    );
    /* Plain language, and no hashes in the sentence a person reads. */
    expect(problem?.title).toBe("Hivemind was updated");
    expect(problem?.detail).not.toMatch(/daemon|hash|[0-9a-f]{16}/u);
    /* And a control that performs the action the message names — the whole
       defect was an instruction with nothing in the app that did it. */
    expect(problem?.action).toBe("restart_daemon");
  });

  test("the check itself is not weakened", async () => {
    const shell = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );
    /* Two runs against a stale build cost ~38K tokens. The comparison stays
       exact and stays fatal; only the way out is new. */
    expect(shell).toMatch(
      /state_build_id != expected_build_id \|\| health_build_id != expected_build_id/u
    );
  });

  test("a restart is refused unless idleness is PROVED", async () => {
    const shell = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );
    const restart = shell.slice(shell.indexOf("pub async fn restart_daemon"));
    expect(restart).toMatch(/standing\.work != DaemonWork::Idle/u);
    /* Read off disk, not asked of the daemon: the daemon in question is the
       wrong build, so its own account of itself is the thing under suspicion —
       and a field added to /health today is absent from every daemon old
       enough to hit this. */
    const work = shell.slice(shell.indexOf("fn daemon_work"));
    expect(work).toMatch(/active_reservations/u);
    expect(work).toMatch(/task_worktrees/u);
    /* Unknown is never idle. Guessing here abandons somebody's run, which is
       the exact thing the detached daemon exists to prevent. */
    expect(work).toMatch(/DaemonWork::Unknown/u);
  });
});

describe("the lanes carry the canvas", () => {
  test("one rule for the passed gates, however many there are", async () => {
    const canvas = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "lane-canvas.tsx"),
      "utf8"
    );
    /* Three stacked rules across a full-width canvas is the horizontal noise
       this was explicitly not to become. The passed gates share one line; a
       held gate gets its own, because it is the one that stopped something. */
    expect(canvas).toMatch(/passed\.length === 0 \? null : \(/u);
    expect(canvas).not.toMatch(/gates\.map\(/u);
    expect(canvas).toMatch(/held\.map\(/u);
  });

  test("the canvas draws lanes as columns, from Core's own phase", async () => {
    const canvas = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "lane-canvas.tsx"),
      "utf8"
    );
    expect(canvas).toMatch(/taskPhase\(task\)/u);
    expect(canvas).toMatch(/task\.lease_files\.length/u);
    /* Nothing derived, estimated or timed. */
    expect(canvas).not.toMatch(/setInterval|Date\.now|Math\.random/u);
  });

  test("and gives it back when nothing is running", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    /* The map is already a full-size picture of the same fact, so the canvas
       is not drawn over it. */
    expect(work).toMatch(/stage === "graph" \?/u);
    const canvas = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "lane-canvas.tsx"),
      "utf8"
    );
    expect(canvas).toMatch(/if \(tasks\.length === 0\) return null;/u);
  });
});

describe("the dev loop closes itself", () => {
  const SELF = ["src-tauri", "src", "selfbuild.rs"];

  test("staleness is measured from disk, not from a version string", async () => {
    const source = await readFile(path.join(desktopRoot, ...SELF), "utf8");
    /* The failure being closed is a build that never happened. A version string
       only says what the last build CLAIMED, so comparing versions would be
       silent on exactly the case this exists for. */
    expect(source).toMatch(/head_commit_seconds/u);
    expect(source).toMatch(/newest_source/u);
    expect(source).toMatch(/\.modified\(\)/u);
  });

  test("it only ever offers to rebuild its own source", async () => {
    const source = await readFile(path.join(desktopRoot, ...SELF), "utf8");
    /* By identifier out of tauri.conf.json, not by folder name: offering to
       rebuild the app from somebody's unrelated project would be absurd, and
       doing it from a repository that merely looks similar would be worse. */
    expect(source).toMatch(/ai\.hivemind\.desktop/u);
    for (const command of ["rebuild_app", "install_built_and_restart"]) {
      const body = source.slice(source.indexOf(`pub async fn ${command}`));
      expect(body.slice(0, 900), `${command} must refuse a foreign repository`).toMatch(
        /if !is_own_source\(&root\)/u
      );
    }
  });

  test("nothing is offered while work is in flight", async () => {
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "build-bar.tsx"),
      "utf8"
    );
    /* The same idleness proof the daemon restart uses, read off disk rather
       than asked of the daemon. */
    expect(bar).toMatch(/inspect_daemon_work/u);
    expect(bar).toMatch(/work\.work !== "idle"/u);
    expect(bar).toMatch(/Nothing offered while work is running/u);
  });

  test("the build and the install are separate acts", async () => {
    const source = await readFile(path.join(desktopRoot, ...SELF), "utf8");
    /* Windows locks a running executable, which `install-local.mjs` already
       names as the usual reason an install silently does not take. So the build
       runs while the app is open and the swap happens on the way out. */
    expect(source).toMatch(/pub async fn rebuild_app/u);
    expect(source).toMatch(/pub async fn install_built_and_restart/u);
    const rebuild = source.slice(
      source.indexOf("pub async fn rebuild_app"),
      source.indexOf("pub async fn install_built_and_restart")
    );
    expect(rebuild, "rebuilding must not install").not.toMatch(/app\.exit|spawn_swap/u);
    /* And the daemon is left alone: it outlives app close by design so a run is
       never orphaned, and it is a different process from the one replaced. */
    expect(source).toMatch(/daemon is deliberately NOT touched/u);
  });
});

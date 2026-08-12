import { readFile } from "node:fs/promises";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import replayData from "../tools/replay-data.json";
import { AgentGraph } from "../src/components/workspace/agent-graph";
import { ProjectTab } from "../src/components/workspace/project-tab";
import { WorkTab } from "../src/components/workspace/work-tab";
import {
  hasIdentifier,
  stripIdentifiers,
  taskTitleOrNull,
  IDENTIFIER_PATTERN
} from "../src/lib/identifiers";
import { attentionHeadline } from "../src/lib/work-presentation";
import { createBoardProjection, type BoardProjection } from "../src/lib/projection";
import type { WorkspaceInspection } from "../src/lib/workspace-actions";

/* The fifth ask, made unrepeatable.
 *
 * "Remove the task IDs" was asked four times and answered four times with "we
 * lead with the title and keep the identifier secondary", which is a different
 * thing. Reviewing markup by eye is what let that happen, so this RENDERS the
 * primary surfaces -- the real components, against real replayed trails, not
 * fixtures -- and scans the resulting HTML for the pattern.
 *
 * `react-dom/server` rather than a DOM: it needs no new dependency, and a
 * static render is exactly the right instrument for "does this string reach the
 * screen". Interaction is not what is being asserted.
 */

interface Scenario {
  id: string;
  projection?: unknown;
  inspection?: WorkspaceInspection | null;
}

const scenarios = (replayData as { scenarios: Scenario[] }).scenarios;

/** A scenario's projection, restored onto a real empty projection's shape. */
function projectionFor(scenario: Scenario): BoardProjection {
  return { ...createBoardProjection(), ...(scenario.projection as object | undefined) };
}

/* Every trail the corpus holds that projects any task at all, plus the two
   states a person actually stops in. Named rather than filtered so a scenario
   disappearing from the corpus fails loudly instead of shrinking the guard. */
const PRIMARY_SCENARIOS = [
  "e2e-textkit-parallel-run",
  "e2e-textkit-parallel-run@midrun",
  "e2e-textkit-parallel-run@ship",
  "e2e-textkit-parallel-run@ship-review",
  "walk4-prompt-to-shipped",
  "final-run-transcript-4",
  "m7-4-consolidation-behavioral",
  "firstrun-pending-plan",
  "gui-run",
  "empty-project"
];

/* The markup carries class names, and Tailwind emits things like `grid-cols-2`
   and `gap-3`. Only the TEXT can leak an identifier to a person, so tags and
   attributes are stripped before the scan -- otherwise the guard would either
   be noisy or have to be weakened until it stopped biting. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/gu, " ")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ");
}

function renderWork(scenario: Scenario, stage: "thread" | "graph"): string {
  return renderToStaticMarkup(
    createElement(WorkTab, {
      actionError: "",
      connectionDetail: "",
      connectionState: "connected",
      inspection: scenario.inspection ?? null,
      projection: projectionFor(scenario),
      stage,
      onAction: async () => undefined as never,
      onReconnect: async () => undefined,
      onSelectTask: () => undefined
    })
  );
}

describe("internal identifiers never reach a person", () => {
  test.each(PRIMARY_SCENARIOS)("the run thread on %s shows none", (id) => {
    const scenario = scenarios.find((entry) => entry.id === id);
    expect(scenario, `scenario ${id} is missing from the replay corpus`).toBeDefined();
    const text = visibleText(renderWork(scenario!, "thread"));
    expect(text.match(IDENTIFIER_PATTERN) ?? []).toEqual([]);
  });

  test.each(PRIMARY_SCENARIOS)("the agent graph on %s shows none", (id) => {
    const scenario = scenarios.find((entry) => entry.id === id)!;
    const text = visibleText(renderWork(scenario, "graph"));
    expect(text.match(IDENTIFIER_PATTERN) ?? []).toEqual([]);
  });

  test.each(PRIMARY_SCENARIOS)("the project record on %s shows none", (id) => {
    const scenario = scenarios.find((entry) => entry.id === id)!;
    const markup = renderToStaticMarkup(
      createElement(ProjectTab, {
        inspection: scenario.inspection ?? null,
        projectName: "textkit",
        onAction: async () => undefined as never
      })
    );
    expect(visibleText(markup).match(IDENTIFIER_PATTERN) ?? []).toEqual([]);
  });

  /* The guard has to be capable of failing. A scan that passes because the
     surfaces render nothing, or because the pattern matches nothing, is the
     vacuous-assertion failure this project has already shipped once. */
  test("the corpus really does contain identifiers to leak", () => {
    const offenders = scenarios.filter((scenario) => {
      const inspection = scenario.inspection;
      if (!inspection) return false;
      return [
        ...Object.keys(inspection.task_titles ?? {}),
        ...(inspection.needs_you ?? []).map((item) => item.title),
        ...(inspection.tasks ?? []).map((task) => task.task_id)
      ].some(hasIdentifier);
    });
    expect(offenders.length).toBeGreaterThan(3);
  });

  test("the surfaces really do render their content", () => {
    const scenario = scenarios.find((entry) => entry.id === "e2e-textkit-parallel-run@midrun")!;
    const text = visibleText(renderWork(scenario, "graph"));
    /* Real task titles from the real trail. If the scan above passes while
       these are absent, the components rendered nothing and proved nothing. */
    expect(text).toContain("Implement and test slugify helper");
    expect(text).toContain("Implement and test wordCount helper");
    expect(text).toContain("at the same time");
  });
});

/* The render scan cannot reach a dialog: the plan review and the guidance
 * dialogs open on a click, and a static render draws nothing for them. That
 * blind spot was real and cost a leak -- the plan review rendered `G-1` under
 * every stage heading, and a bare plan fingerprint in its footer, through the
 * whole of the pass that removed identifiers everywhere else.
 *
 * So the surfaces are ALSO scanned as source, categorically: no JSX expression
 * anywhere in them may render a field whose name ends in `_id` or `_hash`.
 * Enumerating the known ones would have missed `group_id` exactly the way the
 * render scan did.
 */
describe("no surface renders an identifier field at all", () => {
  const surfaces = [
    "src/components/workspace/work-tab.tsx",
    "src/components/workspace/agent-graph.tsx",
    "src/components/workspace/project-tab.tsx",
    "src/components/workspace/spec-review.tsx"
  ];

  test.each(surfaces)("%s", async (relative) => {
    const source = await readFile(path.join(import.meta.dirname, "..", relative), "utf8");
    /* What puts a string on screen is a BARE braced expression -- a JSX text
       child, or a `${}` inside a template literal a person will read. What
       does not is a prop (`selected={…}`), a callback, an object literal or a
       type annotation, and all four are excluded by shape rather than by name
       so a new one cannot quietly join the allowlist.
       This caught `# ${result.task_id}` heading every diff in the change
       viewer, which no render scan reaches. */
    const rendered = source
      .split(/\r?\n/u)
      /* A React list key is not a render, and it is the one place an
         identifier is exactly the right value to use. */
      .filter((line) => !/\bkey[:=]/u.test(line))
      .flatMap((line) =>
        [...line.matchAll(/(\w+=|\$)?\{[^{}\n]*\b\w+_(?:id|hash)\b[^{}\n]*\}/gu)]
          .filter((match) => match[1] === undefined || match[1] === "$")
          .map((match) => match[0])
      )
      .filter((text) => !text.includes(":") && !text.includes("=>"))
      /* `taskTitleOrNull(id, titles) ?? ANONYMOUS_TASK` is the sanctioned
         shape: the identifier goes IN, and a title or an honest anonymous
         label comes out. It is the resolver this whole guard exists to force
         people through. */
      .filter((text) => !text.includes("taskTitleOrNull("))
      /* The full-record dialog, which shows identifiers on purpose and says so
         in its own description. Asserted positively in the next test, so it
         cannot be silently deleted after being excused here. */
      .filter((text) => text !== '{event.task_id ?? "run"}');
    expect(rendered).toEqual([]);
  });

  /* A prop is not a render, with two exceptions: these two ARE read by a
     person, one of them by everyone using a screen reader. */
  test.each(surfaces)("%s puts none in a tooltip or an accessible name", async (relative) => {
    const source = await readFile(path.join(import.meta.dirname, "..", relative), "utf8");
    const labels = [...source.matchAll(/(?:title|aria-label)=\{?[^\n]*\b\w+_(?:id|hash)\b/gu)];
    expect(labels.map((match) => match[0])).toEqual([]);
  });

  /* The trail dialog is the deliberate exception, and it has to keep working:
     it is the one place a person can find an identifier when support asks. */
  test("the full-record dialog still shows them, on purpose", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "..", "src/components/workspace/project-tab.tsx"),
      "utf8"
    );
    expect(source).toMatch(/\{event\.task_id \?\? "run"\}/u);
    expect(source).toMatch(/including the\s*\n?\s*internal names for things/u);
  });
});

describe("the identifier pattern", () => {
  test("matches every shape Core writes and nothing that merely looks like one", () => {
    expect(hasIdentifier("T-001")).toBe(true);
    expect(hasIdentifier("G-1")).toBe(true);
    expect(hasIdentifier("S-001")).toBe(true);
    expect(hasIdentifier("V-335aa795")).toBe(true);
    expect(hasIdentifier("T-209 stopped")).toBe(true);

    expect(hasIdentifier("multi_agent_version v2")).toBe(false);
    expect(hasIdentifier("a well-formed sentence")).toBe(false);
    expect(hasIdentifier("UTF-8")).toBe(false);
    expect(hasIdentifier("gpt-5.6-terra")).toBe(false);
  });

  test("removes them without leaving the wreckage of a removed word", () => {
    expect(stripIdentifiers("T-209 stopped")).toBe("stopped");
    expect(stripIdentifiers("Add a helper (T-001)")).toBe("Add a helper");
    expect(stripIdentifiers("T-001 and T-002 disagree")).toBe("and disagree");
    expect(stripIdentifiers("nothing to remove")).toBe("nothing to remove");
  });

  test("a task with no known title is named, not numbered", () => {
    expect(taskTitleOrNull("T-001", { "T-001": "Add a greet helper" })).toBe(
      "Add a greet helper"
    );
    expect(taskTitleOrNull("T-001", {})).toBeNull();
    /* Core sometimes echoes the identifier back as the title. That is not a
       name, and treating it as one is how the identifier used to survive. */
    expect(taskTitleOrNull("T-001", { "T-001": "T-001" })).toBeNull();
    expect(taskTitleOrNull("T-001", { "T-001": "   " })).toBeNull();
  });
});

describe("the attention headline", () => {
  /* The exact sentence the brief quoted, from the trail that produces it. */
  test("says each thing once, and says no identifier at all", () => {
    const named = attentionHeadline(
      {
        title: "Initialize CLI package metadata and usage docs needs a revision",
        task_id: "T-001"
      },
      { "T-001": "Initialize CLI package metadata and usage docs" }
    );
    expect(named.headline).toBe("Initialize CLI package metadata and usage docs");
    expect(named.predicate).toBe("needs a revision");
    expect(hasIdentifier(`${named.headline} ${named.predicate ?? ""}`)).toBe(false);
  });

  test("an unnameable task is anonymous rather than numbered", () => {
    const named = attentionHeadline({ title: "T-209 stopped", task_id: "T-209" }, {});
    expect(named.headline).toBe("One of the tasks");
    expect(named.predicate).toBe("stopped");
  });

  test("a run-level item keeps its own sentence", () => {
    const named = attentionHeadline(
      { title: "This change needs fresh checks before it can ship", task_id: null },
      {}
    );
    expect(named.headline).toBe("This change needs fresh checks before it can ship");
    expect(named.predicate).toBeNull();
  });
});

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");

describe("React workspace boundary", () => {
  test("uses project-bound streams and the audited Tauri action bridge", async () => {
    const hook = await readFile(
      path.join(desktopRoot, "src", "hooks", "use-workspace.ts"),
      "utf8"
    );
    expect(hook).toMatch(/invoke\("select_project", \{ projectPath: selectedPath \}\)/u);
    expect(hook).toMatch(/\/events\/stream/u);
    expect(hook).toMatch(/\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/output\/stream/u);
    expect(hook).not.toMatch(/localStorage|sessionStorage|fetch\(|XMLHttpRequest/u);
    expect(hook).toMatch(/invokeWorkspaceAction<WorkspaceInspection>/u);
    expect(hook).not.toMatch(/submit_patch|integrate_shadow|request_lease|runGate/u);
  });

  test("client source cannot import Core authority or contain mutation routes", async () => {
    const files = [
      "src/App.tsx",
      "src/components/workspace/work-tab.tsx",
      "src/components/workspace/swarm-tab.tsx",
      "src/components/workspace/memory-tab.tsx",
      "src/components/workspace/history-tab.tsx",
      "src/hooks/use-workspace.ts",
      "src/lib/projection.ts",
      "src/lib/project-session.ts",
      "src/lib/swarm-model.ts"
    ];
    const source = (
      await Promise.all(
        files.map((file) => readFile(path.join(desktopRoot, file), "utf8"))
      )
    ).join("\n");

    expect(source).not.toMatch(/from ["'][.]{2,}\/[.]{2,}\/src\//u);
    expect(source).not.toMatch(
      /executeManagerAction|runGate|requestLease|integrateShadow|reviewMemoryProposal/u
    );
    expect(source).not.toMatch(
      /\/approve|\/ratify|\/redirect|\/run|\/submit|\/integrate|method:\s*["']POST/u
    );
  });

  test("typed actions cross only the Tauri bridge and contain no client-side gate logic", async () => {
    const actions = await readFile(path.join(desktopRoot, "src", "lib", "workspace-actions.ts"), "utf8");
    expect(actions).toMatch(/invoke<T>\("workspace_action", \{ projectPath, action \}\)/u);
    expect(actions).not.toMatch(/fetch\(|runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
  });

  test("old vanilla renderer is gone and one shadcn-style token path remains", async () => {
    await expect(access(path.join(desktopRoot, "app", "main.mjs"))).rejects.toThrow();
    const config = await readFile(
      path.join(desktopRoot, "components.json"),
      "utf8"
    );
    const styles = await readFile(
      path.join(desktopRoot, "src", "styles.css"),
      "utf8"
    );
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");

    expect(config).toMatch(/ui\.shadcn\.com/u);
    expect(styles).toMatch(/--field-ivory/u);
    expect(styles).toMatch(/--meridian/u);
    expect(styles).toMatch(/prefers-reduced-motion/u);
    for (const tab of ["Work", "Swarm", "Memory", "History"]) {
      expect(app).toContain(tab);
    }
  });

  test("primary labels use plain language and controls trace to the M8.3 registry", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const projection = await readFile(path.join(desktopRoot, "src", "lib", "projection.ts"), "utf8");
    const visibleSource = `${app}\n${work}`;

    for (const label of [
      "Project checks blocked",
      "Thin test coverage",
      "Files being edited",
      "Paused for capacity",
      "Worker stopped",
      "Needs you",
      "Guidance is read on the next step",
      "Approve and start"
    ]) {
      expect(visibleSource).toContain(label);
    }
    for (const forbidden of [
      "RESOURCE TETHERS",
      "PROVIDER EVIDENCE",
      "DURABLE TRAIL",
      "CANDIDATE WORK",
      "EXECUTION SET",
      "LIVE WORKSPACE",
      "Every agent stays inside a visible, deterministic path to merge"
    ]) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      expect(visibleSource).not.toMatch(
        new RegExp(`(?:>|(?:title|body)=")\\s*${escaped}`, "iu")
      );
    }
    expect(visibleSource).not.toMatch(/High-tier oracle floor|fake-metered reported this state/u);
    expect(visibleSource).not.toMatch(/Reached merge|Waiting to merge|blocked before merge|merge checks/iu);
    expect(work).toMatch(/merged:\s*\{ label: "Merged"/u);
    expect(projection).toMatch(/case "adoption\.completed":[\s\S]*state = "merged"/u);

    const audit = await readFile(path.resolve(desktopRoot, "..", "docs", "m8-action-routing-audit.md"), "utf8");
    const actions = [...work.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(new Set(actions)).toEqual(new Set([
      "autonomy.set",
      "change.inspect",
      "guidance.record",
      "manager.continue",
      "manager.start",
      "plan.amend",
      "plan.prepare",
      "plan.ratify",
      "plan.review",
      "task.redirect",
      "task.stop"
    ]));
    for (const action of actions) expect(audit).toContain(`\`${action}\``);
    const inspection = await readFile(path.resolve(desktopRoot, "..", "src", "workspace-inspection.ts"), "utf8");
    expect(inspection).toContain('type: "manager.approve_pending"');
    expect(inspection).toContain('type: "manager.retry_blocked"');
    expect(inspection).toContain('type: "adoption.review"');
    expect(inspection).toContain('type: "adoption.execute"');
    expect(audit).toContain("`adoption.review`");
    expect(audit).toContain("`adoption.execute`");
    expect(work).toMatch(/if \(!item\.action\) return;[\s\S]*await onAction<[^>]+>\(item\.action\)/u);
    expect(work).toMatch(/item\.action\.type === "manager\.retry_blocked"[\s\S]*type: "manager\.continue"/u);
    expect(audit).toContain("`manager.approve_pending`");
    expect(work).toMatch(/Guidance is read on the next step and does not change work already in progress/u);
    expect(work).toMatch(/Nothing starts until you review and approve this exact plan/u);
    expect(work).not.toMatch(/title="Later"|<h2>Routing<\/h2>|<h2>Draft comparisons<\/h2>/u);
    expect(work).toMatch(/change_set\.changed_files\.map/u);
    expect(work).toMatch(/type: "change\.inspect"/u);
  });

  test("prompt stays in the fixed Work layout and text does not truncate mid-word", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    expect(styles).toMatch(/\.work-tab[\s\S]*grid-template-rows:[^;]*minmax\(0, 1fr\) auto/u);
    expect(styles).toMatch(/\.prompt-dock\s*\{[^}]*z-index:\s*20/u);
    expect(styles).toMatch(/\.work-layout\s*\{[^}]*overflow:\s*hidden/u);
    expect(styles).not.toMatch(/text-overflow:\s*ellipsis/u);
  });

  test("Swarm controls use only audited actions and motion is event-bound", async () => {
    const swarm = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "swarm-tab.tsx"),
      "utf8"
    );
    const projection = await readFile(
      path.join(desktopRoot, "src", "lib", "projection.ts"),
      "utf8"
    );
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const audit = await readFile(path.resolve(desktopRoot, "..", "docs", "m8-action-routing-audit.md"), "utf8");

    const actions = [...swarm.matchAll(/type:\s*"([a-z_.]+)"/gu)]
      .map((match) => match[1])
      .filter((action) => action.includes("."));
    expect(new Set(actions)).toEqual(new Set([
      "change.inspect",
      "quality.cancel",
      "task.redirect",
      "task.stop"
    ]));
    for (const action of actions) expect(audit).toContain(`\`${action}\``);
    expect(swarm).not.toMatch(/runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
    expect(projection).toMatch(/message\.source === "live"[\s\S]*recordArtifactMovements/u);
    expect(styles).toMatch(/\.artifact-marker[\s\S]*animation:\s*artifact-travel/u);
    expect(styles).toMatch(/prefers-reduced-motion[\s\S]*\.artifact-marker\s*\{\s*display:\s*none/u);
  });

  test("Memory has no promotion surface and History exposes only the audited read-only trail", async () => {
    const memory = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "memory-tab.tsx"),
      "utf8"
    );
    const history = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "history-tab.tsx"),
      "utf8"
    );
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const source = `${memory}\n${history}`;
    const audit = await readFile(path.resolve(desktopRoot, "..", "docs", "m8-action-routing-audit.md"), "utf8");

    expect(memory).not.toMatch(/onAction|invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);
    expect(history).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);
    const historyActions = [...history.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(new Set(historyActions)).toEqual(new Set(["trail.inspect"]));
    expect(audit).toContain("`trail.inspect`");
    expect(source).not.toMatch(/reviewMemoryProposal|memory\.review_handoff|Promote|Approve/u);
    expect(memory).toMatch(/The app cannot approve this item/u);
    expect(memory).toMatch(/Review in a terminal/u);
    expect(memory).toMatch(/<h2>Later<\/h2>/u);
    expect(memory).toMatch(/title="Routing changes"/u);
    expect(memory).toMatch(/title="Draft tests"/u);
    expect(history).toMatch(/read-only project evidence/u);
    expect(source).not.toMatch(/Reached merge/iu);
    expect(history).toMatch(/run\.merged_tasks/u);
    const inspection = await readFile(path.resolve(desktopRoot, "..", "src", "workspace-inspection.ts"), "utf8");
    expect(inspection).toMatch(/event\.type === "adoption\.completed"[\s\S]*event\.data\.task_ids/u);
    expect(app).not.toMatch(/FutureWorkspaceTab/u);
  });
});

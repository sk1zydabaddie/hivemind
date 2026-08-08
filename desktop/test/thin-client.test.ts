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
    expect(hook).toMatch(/setInterval\(\(\) => void refreshInspection\(\), 5_000\)/u);
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
      "src/lib/swarm-model.ts",
      "src/lib/providers.ts",
      "src/lib/work-thread.ts",
      "src/components/settings-dialog.tsx",
      "src/components/agent-setup-dialog.tsx",
      "src/components/workspace/setup-screen.tsx"
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

  test("stale shell identity and dropped connections refuse or surface before project actions", async () => {
    const session = await readFile(path.join(desktopRoot, "src", "lib", "project-session.ts"), "utf8");
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const work = await readFile(path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"), "utf8");
    expect(session).toMatch(/shellBuildId !== expectedShellBuildId/u);
    expect(app).toContain("Project controls are disabled until the app is rebuilt and restarted.");
    expect(work).toContain("Project updates stopped");
    expect(work).toMatch(/onReconnect/u);
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
    expect(styles).toMatch(/prefers-reduced-motion/u);
    for (const tab of ["Work", "Swarm", "Memory", "History"]) {
      expect(app).toContain(tab);
    }
  });

  test("Tailwind is the single styling path and the shadcn CLI is wired to it", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const legacy = await readFile(path.join(desktopRoot, "src", "legacy.css"), "utf8");
    const config = JSON.parse(
      await readFile(path.join(desktopRoot, "components.json"), "utf8")
    ) as {
      tailwind?: { config?: string; css?: string; cssVariables?: boolean };
      aliases?: Record<string, string>;
      iconLibrary?: string;
    };
    const tsconfig = await readFile(path.join(desktopRoot, "tsconfig.json"), "utf8");
    const vite = await readFile(path.join(desktopRoot, "vite.config.ts"), "utf8");
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };

    expect(styles).toMatch(/@import "tailwindcss"/u);
    expect(vite).toMatch(/tailwindcss\(\)/u);
    expect(packageJson.dependencies).toHaveProperty("tailwindcss");

    // A CLI-added component resolves `@/…` and lands on this palette without edits.
    expect(config.tailwind?.config).toBe("");
    expect(config.tailwind?.css).toBe("src/styles.css");
    expect(config.tailwind?.cssVariables).toBe(true);
    expect(config.iconLibrary).toBe("lucide");
    expect(config.aliases).toMatchObject({
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui"
    });
    expect(tsconfig).toMatch(/"@\/\*":\s*\["\.\/src\/\*"\]/u);
    expect(vite).toMatch(/"@":\s*path\.resolve/u);
    for (const token of [
      "--primary",
      "--background",
      "--foreground",
      "--border",
      "--ring",
      "--radius"
    ]) {
      expect(styles).toContain(`${token}:`);
    }

    // Logo palette, and only the logo palette.
    for (const token of ["--ink: #1f2328", "--navy: #1b3a6b", "--amber: #b88936", "--clay: #b65b4f"]) {
      expect(styles).toContain(token);
    }
    expect(styles).not.toMatch(/--field-ivory|--meridian|linear-gradient|backdrop-filter/u);

    // The untouched tabs keep their class names, quarantined below Tailwind.
    expect(styles).toMatch(/@layer theme, base, legacy, components, utilities;/u);
    expect(legacy).toMatch(/@layer legacy \{/u);
    expect(legacy).toMatch(/--meridian: var\(--navy\)/u);
  });

  test("the four hand-ported primitives are Tailwind-native", async () => {
    const legacy = await readFile(path.join(desktopRoot, "src", "legacy.css"), "utf8");
    for (const component of ["badge", "scroll-area", "tabs", "tooltip"]) {
      const source = await readFile(
        path.join(desktopRoot, "src", "components", "ui", `${component}.tsx`),
        "utf8"
      );
      expect(source).toMatch(/from "@\/lib\/utils"/u);
      expect(source).toMatch(/data-slot=/u);
      // Styled by utilities on the shared tokens, not by a hand-written rule.
      expect(source).toMatch(/(?:text|bg|border|rounded)-[a-z]/u);
    }
    for (const dead of [
      ".badge-neutral",
      ".scroll-area",
      ".tabs-trigger",
      ".tabs-content",
      ".tooltip-content"
    ]) {
      expect(legacy).not.toContain(dead);
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
    // Merged still traces to adoption.completed and never to verification, but
    // it is now Core's answer read from the inspection payload. The projection
    // carries only the board banner and must not derive per-task state again.
    expect(projection).toMatch(/case "adoption\.completed":[\s\S]*integration\.status = "merged"/u);
    expect(projection).not.toMatch(/\.state = "merged"|\.state = "verified"/u);

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
      "run.stop"
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
    expect(work).toMatch(/change_set\??\.changed_files\.map/u);
    expect(work).toMatch(/type: "change\.inspect"/u);
  });

  test("plan ratification exposes the plan-authored conformance check", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    expect(work).toContain("How it is checked");
    expect(work).toMatch(/task\.deterministic_validity_check/u);
    expect(work).toMatch(/const displayedPlan = plan \?\? currentPlan/u);
    expect(work).toMatch(/ratificationPending=\{plan !== null\}/u);
    expect(work).toMatch(/Read-only record of the exact approved plan/u);
    expect(work).toMatch(/View plan/u);
    expect(work).toMatch(/task\.integration === "merged" \|\| task\.state === "merged"/u);
  });

  test("prompt is a fixed row of the work column and text does not truncate mid-word", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const work = await readFile(path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"), "utf8");

    // Two fixed rows: the interruption slot and the body. The body splits into the
    // work panel and the rail, and the work panel owns the composer as its own
    // trailing row, so tall content cannot displace it.
    expect(work).toMatch(
      /grid h-full min-h-0 grid-rows-\[auto_minmax\(0,1fr\)\] overflow-hidden/u
    );
    expect(work).toMatch(/grid min-h-0 grid-cols-\[minmax\(0,1fr\)_360px\] gap-4 overflow-hidden/u);
    expect(work).toMatch(
      /<Panel className="grid-rows-\[auto_minmax\(0,1fr\)_auto\]">[\s\S]*<PromptDock/u
    );
    // The interruption row is always rendered, even when empty, so the grid keeps
    // its shape and nothing below it can shift.
    expect(work).toMatch(/<div className="min-w-0">\s*\{shipItem \? \([\s\S]*<ShipBar/u);
    expect(work).toMatch(/<ShipBar[\s\S]*<AttentionBar[\s\S]*<PlanWaitingBar/u);

    // Content wraps; it never gets clipped mid-word.
    expect(styles).not.toMatch(/text-overflow:\s*ellipsis/u);
    expect(work).not.toMatch(/\btruncate\b|text-ellipsis|line-clamp/u);
  });

  test("a finished plan never captures the next request, and a pending plan has an exit", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );

    // A plan with nothing left to do must not swallow a new request: the composer
    // routes on unfinished work, not on whether a plan exists at all.
    expect(work).toMatch(/const planHasWorkLeft =/u);
    expect(work).toMatch(/task\.state !== "merged" && task\.state !== "cancelled"/u);
    expect(work).toMatch(/\} else if \(!planHasWorkLeft\) \{\s*await preparePlan\(message\);/u);
    expect(work).not.toMatch(
      /else if \(inspection\?\.current_plan === null \|\| inspection\?\.current_plan === undefined\)/u
    );

    // A plan the person does not want is not a dead end: their text becomes the
    // start of a different plan instead of being refused.
    expect(work).toMatch(/setReplanText\(message\);\s*setReplanOpen\(true\);/u);
    expect(work).toMatch(/Start over with a different plan/u);
    expect(work).toMatch(/onStartOver/u);
    expect(work).toMatch(/const preparePlan[\s\S]{0,400}type: "plan\.prepare"/u);

    // Nothing offers a control that cannot do anything.
    expect(work).toMatch(/if \(!canOpenAttention\(item\)\) return null;/u);
  });

  test("setup offers only what actually works, and asks for the roles the app really uses", async () => {
    const providers = await readFile(path.join(desktopRoot, "src", "lib", "providers.ts"), "utf8");
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const { PROVIDERS, REQUIRED_ROLES } = (await import("../src/lib/providers")) as typeof import("../src/lib/providers");

    // No provider picker implying integrations that do not exist: anything not
    // supported carries a specific reason and offers no profile to install.
    expect(PROVIDERS.filter((provider) => provider.status === "supported")).toHaveLength(1);
    for (const provider of PROVIDERS) {
      if (provider.status === "supported") {
        expect(provider.profile).not.toBeNull();
        continue;
      }
      expect(provider.profile).toBeNull();
      expect(provider.caveat ?? "").not.toBe("");
    }

    // Core resolves an adapter profile by the tool name the client sends, so the
    // setup instructions must name exactly the roles the Work tab asks for.
    const requested = [...work.matchAll(/tool: "([a-z]+)"/gu)].map((match) => match[1]);
    expect(new Set(requested)).toEqual(new Set(REQUIRED_ROLES.map((role) => role.tool)));

    // The catalogue is data, not a hard-coded shape in the UI.
    expect(providers).toMatch(/export const PROVIDERS/u);
  });

  test("the run thread is built from durable daemon events, not client memory", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const thread = await readFile(path.join(desktopRoot, "src", "lib", "work-thread.ts"), "utf8");

    // The thread renders the replayed event history, so it survives a reload.
    expect(work).toMatch(/buildRunThread\(events, taskTitles\)/u);
    expect(work).toMatch(/events=\{projection\.recentEvents\}/u);
    expect(thread).not.toMatch(/localStorage|sessionStorage|useState|fetch\(/u);

    // Guidance text and the shipped manifest come from the events themselves.
    expect(thread).toMatch(/event\.type === "human\.guidance_recorded"/u);
    expect(thread).toMatch(/readString\(event\.data\.message\)/u);
    expect(thread).toMatch(/event\.type === "adoption\.completed"/u);
    expect(thread).toMatch(/readStringArray\(event\.data\.changed_files\)/u);
    expect(thread).toMatch(/readString\(event\.data\.base_branch\)/u);

    // Core records only `prompt_hash` on plan.prepared today. The request entry
    // must stay hidden until Core emits the text — never reconstructed here.
    expect(thread).toMatch(/readString\(event\.data\.prompt\)/u);
    expect(thread).toMatch(/if \(text !== null\)/u);
  });

  test("no internal vocabulary reaches a primary Work or shell surface", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const source = `${app}\n${work}`;

    // Everything a person can actually read: JSX text runs plus the attributes
    // that get spoken or shown on hover.
    const readable = [
      ...[...source.matchAll(/>([^<>{}\n]+)</gu)].map((match) => match[1]),
      ...[...source.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/gu)].map(
        (match) => match[1]
      )
    ]
      .join(" | ")
      .toLowerCase();

    for (const banned of [
      "lease",
      "canon",
      "oracle",
      "tier-1",
      "tier-2",
      "write-intent",
      "write intent",
      "integrate_shadow",
      "adoption",
      "adopt",
      "execution group",
      "worktree",
      "task_type",
      "routing policy",
      "quality run",
      "admission"
    ]) {
      expect(readable).not.toContain(banned);
    }
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
      "run.stop",
      "task.redirect",
      "task.stop"
    ]));
    for (const action of actions) expect(audit).toContain(`\`${action}\``);
    expect(swarm).not.toMatch(/runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
    expect(swarm).toMatch(/const tree = buildSwarmTree\(projection, inspection\)/u);
    expect(swarm).toMatch(/type: "task\.stop"/u);
    expect(swarm).toMatch(/type: "run\.stop"/u);
    expect(swarm).toContain("Stop all working tasks");
    expect(swarm).not.toMatch(/useMemo\(\s*\(\) => buildSwarmTree/u);
    expect(projection).toMatch(/message\.source === "live"[\s\S]*recordArtifactMovements/u);
    const legacy = await readFile(path.join(desktopRoot, "src", "legacy.css"), "utf8");
    expect(legacy).toMatch(/\.artifact-marker[\s\S]*animation:\s*artifact-travel/u);
    expect(styles).toMatch(/prefers-reduced-motion[\s\S]*\.artifact-marker\s*\{\s*display:\s*none/u);
  });

  test("Work and Swarm share the daemon task projection and lead with task titles", async () => {
    const work = await readFile(path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"), "utf8");
    const swarm = await readFile(path.join(desktopRoot, "src", "components", "workspace", "swarm-tab.tsx"), "utf8");
    const model = await readFile(path.join(desktopRoot, "src", "lib", "swarm-model.ts"), "utf8");
    const memory = await readFile(path.join(desktopRoot, "src", "components", "workspace", "memory-tab.tsx"), "utf8");
    const history = await readFile(path.join(desktopRoot, "src", "components", "workspace", "history-tab.tsx"), "utf8");
    expect(work).toMatch(/const tasks = inspection\?\.tasks \?\? \[\]/u);
    expect(model).toMatch(/inspection\?\.tasks \?\? \[\]/u);
    expect(work).not.toMatch(/taskRows\(projection\)|projection\.tasks/u);
    expect(model).not.toMatch(/taskRows\(projection\)|projection\.tasks/u);
    // Rows lead with the title; the id is secondary metadata beneath it.
    expect(work).toMatch(/\{task\.title\}[\s\S]{0,500}\{task\.task_id\}/u);
    expect(work).not.toMatch(/\{task\.task_id\}[\s\S]{0,120}\{task\.title\}/u);
    expect(swarm).toMatch(/<strong>\{task\.task\.title\}<\/strong>\s*<small>\{task\.task\.task_id\}<\/small>/u);
    expect(memory).toMatch(/taskTitle\} test draft/u);
    expect(history).toMatch(/taskTitles\[taskId\] \?\? taskId/u);
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

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
      "src/components/workspace/agent-graph.tsx",
      "src/components/workspace/phase-spine.tsx",
      "src/components/workspace/project-tab.tsx",
      "src/hooks/use-workspace.ts",
      "src/lib/phases.ts",
      "src/lib/work-presentation.ts",
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

    /* Three places, each answering a different question: what happened and
       what you must decide, who is doing what right now, and every run before
       this one. Memory and History stay merged into Project -- they were two
       tabs over one subject that could not act -- and the agent graph is back,
       because a shape shows something a list cannot. */
    const triggers = [...app.matchAll(/<TabsTrigger value="([a-z]+)">/gu)].map(
      (match) => match[1]
    );
    expect(triggers).toEqual(["work", "agents", "project"]);
    for (const collapsed of ["swarm", "memory", "history"]) {
      expect(triggers).not.toContain(collapsed);
    }
  });

  test("Tailwind is the single styling path and the shadcn CLI is wired to it", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
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

    /* The legacy stylesheet existed only to serve the three tabs that have now
       been folded into Work and Project. Every surface is utility-only, so the
       quarantine layer is gone rather than merely empty. */
    await expect(access(path.join(desktopRoot, "src", "legacy.css"))).rejects.toThrow();
    expect(styles).toMatch(/@layer theme, base, components, utilities;/u);
    expect(styles).not.toMatch(/@import\s+"\.\/legacy\.css"/u);
  });

  test("the four hand-ported primitives are Tailwind-native", async () => {
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
    /* A CLI-added component must land styled with no manual conversion. `empty`
       was added by `npx shadcn add` and is kept verbatim, so it is the standing
       proof of that: if the token contract regresses, this renders unstyled. */
    const empty = await readFile(
      path.join(desktopRoot, "src", "components", "ui", "empty.tsx"),
      "utf8"
    );
    expect(empty).toMatch(/text-muted-foreground/u);
    expect(empty).toMatch(/from "@\/lib\/utils"/u);
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
    /* The product says ship. "Merged" is a git word that a person who typed a
       sentence into a build tool has no reason to know, and it was the last one
       left on a primary surface. */
    expect(work).toMatch(/merged:\s*\{ label: "Shipped"/u);
    expect(work).not.toMatch(/label: "Merged"/u);
    // The shipped state still traces to adoption.completed and never to
    // verification, and it is Core's answer read from the inspection payload.
    // The projection carries only the board banner and must not derive
    // per-task state again.
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
      // The one review signs the spec before it ratifies the plan, because
      // ratifying a plan requires a ratified spec. Ordering, not a second
      // decision -- the person acts once.
      "spec.draft",
      "spec.review",
      "spec.adopt",
      "task.redirect",
      // Stopping one task moved here from the tree tab that no longer exists,
      // so the app keeps exactly one inspector and one set of task controls.
      "task.stop",
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
    /* The rail is a fixed 360px beside a flexible work column -- except when
       there is no task to put in it, which a real trail does produce. Then the
       work column takes the width rather than holding an empty panel open. */
    expect(work).toMatch(/grid-cols-\[minmax\(0,1fr\)_360px\]/u);
    expect(work).toMatch(/tasks\.length === 0[\s\S]{0,120}grid-cols-\[minmax\(0,1fr\)\]/u);
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
    /* A first prompt drafts a spec before it plans, so the window is wider. Both
       calls are asserted, in order. */
    expect(work).toMatch(/const preparePlan[\s\S]{0,700}type: "spec\.draft"[\s\S]{0,400}type: "plan\.prepare"/u);

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

    // Core resolves an adapter profile by the tool name the client sends, so
    // every name the Work tab sends must have a setup instruction -- and every
    // role marked as sent by name must actually be sent by name.
    const requested = [...work.matchAll(/tool: "([a-z]+)"/gu)].map((match) => match[1]);
    expect(new Set(requested)).toEqual(
      new Set(REQUIRED_ROLES.filter((role) => role.requestedByName).map((role) => role.tool))
    );
    // A role the client never names still needs its profile on disk, because
    // routing has to find it. Setup has to hand it over even though no screen
    // sends its name.
    expect(REQUIRED_ROLES.filter((role) => !role.requestedByName).map((role) => role.tool))
      .toEqual(["worker"]);

    // The catalogue is data, not a hard-coded shape in the UI.
    expect(providers).toMatch(/export const PROVIDERS/u);
  });

  /**
   * The settings surface reads Core's catalogue rather than carrying its own,
   * so the honesty rule has to hold where the catalogue now lives. One harness
   * is proven; everything else states what specifically is missing and cannot
   * be connected while it is unproven.
   */
  test("the agent catalogue Core serves cannot imply an integration that does not exist", async () => {
    const catalogue = await readFile(
      path.resolve(desktopRoot, "..", "src", "agent-catalogue.ts"),
      "utf8"
    );
    const settings = await readFile(
      path.join(desktopRoot, "src", "components", "settings-dialog.tsx"),
      "utf8"
    );

    /* Every non-supported entry has a caveat and no invocation, so the UI can
       list it without offering a button that cannot work. */
    expect(catalogue).toMatch(/status: "unverified"[\s\S]{0,900}invoke: null/u);
    expect(catalogue).toMatch(/status: "unsupported"[\s\S]{0,900}invoke: null/u);
    expect(catalogue).toMatch(/never against a live run/u);
    expect(catalogue).toMatch(/permission-bypass flag/u);

    /* Hivemind is an ADE: the agent is a harness plus the subscription that
       pays for it, and Hivemind never asks for a key of its own. */
    expect(settings).toMatch(/never asks for a\s+key of its own/u);
    /* No credential input exists, which is the claim that matters. Asserting
       the WORDS never appear was wrong: "Auth, secrets, migrations" is the
       plain-language name of the most dangerous file scope, and banning the
       vocabulary would have banned the sentence that protects it. */
    expect(settings).not.toMatch(/type="password"/u);
    const inputLabels = [
      ...settings.matchAll(/(?:aria-label|placeholder|label)=["'{]([^"'}]+)/gu)
    ].map((match) => match[1].toLowerCase());
    for (const label of inputLabels) {
      expect(label).not.toMatch(/api key|access token|credential|password/u);
    }

    /* Settings dispatches only the four audited settings actions plus the
       interruption level it already owned. */
    const dispatched = [...settings.matchAll(/type: "([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(new Set(dispatched)).toEqual(
      new Set(["config.inspect", "config.set", "project.init", "adapter.connect", "autonomy.set"])
    );
    const audit = await readFile(
      path.resolve(desktopRoot, "..", "docs", "m8-action-routing-audit.md"),
      "utf8"
    );
    for (const action of dispatched) expect(audit).toContain(`\`${action}\``);

    /* An unproven capability is reported as unverified, never as supported --
       a spending limit built on unverified usage numbers is worse than none. */
    expect(settings).toMatch(/Unverified/u);
    expect(settings).toMatch(/what it reported against what was\s+asked for/u);
  });

  test("settings shows the measured cost of a real call, not a guess", async () => {
    const settings = await readFile(
      path.join(desktopRoot, "src", "components", "settings-dialog.tsx"),
      "utf8"
    );
    const core = await readFile(
      path.resolve(desktopRoot, "..", "src", "config-actions.ts"),
      "utf8"
    );
    /* The number comes from Core, measured on this project's own runs, so the
       ceiling warning cannot drift away from what a call actually costs. */
    expect(core).toMatch(/observed_worker_call_tokens: \{ low: 106_792, high: 179_698 \}/u);
    expect(settings).toMatch(/observed_worker_call_tokens/u);
    expect(settings).toMatch(/stops the run after you have paid for the call/u);
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

  test("the agent graph is a view, not a second inspector: it selects and never acts", async () => {
    const map = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "agent-graph.tsx"),
      "utf8"
    );
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const projection = await readFile(
      path.join(desktopRoot, "src", "lib", "projection.ts"),
      "utf8"
    );
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const spine = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "phase-spine.tsx"),
      "utf8"
    );
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");

    /* The graph dispatches nothing at all. Every control that acts on a task
       lives in the one rail inspector. THAT is what was wrong with the old
       Swarm tab and what stays fixed now the graph is a tab again: two
       inspectors with two vocabularies, not one view too many. */
    expect(map).not.toMatch(/onAction|type:\s*"[a-z]+\.[a-z_]+"|invokeWorkspaceAction/u);
    expect(map).not.toMatch(/runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
    expect(map).toMatch(/buildSwarmTree\(projection, inspection\)/u);
    expect(map).toMatch(/onSelectTask/u);

    // It reads Core's queue for what needs a person; it never decides that.
    expect(map).toMatch(/inspection\?\.needs_you/u);

    /* Caught by replaying a real trail: a verified task sitting behind a
       "needs fresh checks" queue item was drawn in failure red directly above
       the words "Checks passed, ready to ship". How far a task got is Core's
       task state; the queue is a separate fact and gets a separate mark. */
    expect(map).toMatch(/const standing = phase\.standing;/u);
    expect(map).not.toMatch(/flagged[^\n]*\?\s*"attention"/u);

    /* The shell owns which drawing is on screen, and there is no toggle: two
       renderings of one run presented as a choice made the person guess which
       one they wanted before they had seen either. */
    expect(work).toMatch(/stage === "graph" \? \(\s*<AgentGraph/u);
    expect(work).not.toMatch(/ViewToggle/u);
    expect(app).toMatch(/stage=\{value === "agents" \? "graph" : "thread"\}/u);

    /* Motion stays bound to a live record: the spine animates only where an
       artifact movement names that task, and reduced motion removes the
       overlay while the filled segment underneath survives. */
    expect(projection).toMatch(/message\.source === "live"[\s\S]*recordArtifactMovements/u);
    expect(map).toMatch(/projection\.artifactMovements/u);
    expect(spine).toMatch(/artifact-marker/u);
    /* The run's own progress bar is the same rule at run scale: a real track
       whose fill is cleared phases over total phases, with the marker as an
       overlay. Nothing in it is driven by a clock. */
    expect(work).toMatch(/function RunProgress/u);
    expect(work).not.toMatch(/setInterval|setTimeout\(\(\) => set/u);
    expect(styles).toMatch(/animation:\s*artifact-advance/u);
    expect(styles).toMatch(/prefers-reduced-motion[\s\S]*\.artifact-marker\s*\{\s*display:\s*none/u);
  });

  test("phases are a rendering of Core's task state and derive nothing", async () => {
    const phases = await readFile(path.join(desktopRoot, "src", "lib", "phases.ts"), "utf8");

    // A lookup table keyed by the state Core publishes, and nothing else. No
    // event inspection, no timers, no second opinion about where a task is.
    expect(phases).toMatch(/Record<TaskState, TaskPhase>/u);
    expect(phases).not.toMatch(/recentEvents|Date\.now|useState|useEffect|fetch\(/u);
    expect(phases).not.toMatch(/localStorage|sessionStorage/u);
  });

  test("every surface shares the daemon task projection and leads with titles", async () => {
    const work = await readFile(path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"), "utf8");
    const map = await readFile(path.join(desktopRoot, "src", "components", "workspace", "agent-graph.tsx"), "utf8");
    const model = await readFile(path.join(desktopRoot, "src", "lib", "swarm-model.ts"), "utf8");
    const project = await readFile(path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"), "utf8");
    expect(work).toMatch(/const tasks = inspection\?\.tasks \?\? \[\]/u);
    expect(model).toMatch(/inspection\?\.tasks \?\? \[\]/u);
    expect(work).not.toMatch(/taskRows\(projection\)|projection\.tasks/u);
    expect(model).not.toMatch(/taskRows\(projection\)|projection\.tasks/u);
    /* A task is identified by its title and by nothing else. "Lead with the
       title, keep the id secondary" was the answer given four times to a
       request to REMOVE them, so the assertion is now absence, and
       test/identifiers.test.ts renders the surfaces to prove it. */
    expect(work).toMatch(/\{task\.title\}/u);
    expect(map).toMatch(/\{task\.title\}/u);
    /* A React key is not a render, so it is allowed and nothing else is. */
    for (const source of [work, map]) {
      const rendered = [...source.matchAll(/(\w+=)?\{task\.task_id\}/gu)].filter(
        (match) => match[1] !== "key="
      );
      expect(rendered).toEqual([]);
    }
    expect(project).not.toMatch(/\?\? taskId/u);
    expect(project).not.toMatch(/\{run\.spec_id\}/u);
    // A past run leads with what it did, not with the id that names it.
    expect(project).toMatch(/\{run\.outcome_detail \|\| plainOutcome\(run\.outcome\)\}/u);

    /* Core composes queue titles as "T-001 needs a revision" beside a row
       reading "Initialize CLI package metadata". The bar leads with the title
       Core already handed over in `task_titles`. */
    expect(work).toMatch(/attentionHeadline\(item, taskTitles\)/u);
    expect(work).toMatch(/\{named\.headline\}/u);
  });

  test("the Project surface is read-only and offers no promotion", async () => {
    const project = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"),
      "utf8"
    );
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const audit = await readFile(path.resolve(desktopRoot, "..", "docs", "m8-action-routing-audit.md"), "utf8");

    /* Memory and History were two tabs describing one subject and neither could
       act. Merged, that must stay true: exactly one audited read, no writes. */
    const actions = [...project.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(new Set(actions)).toEqual(new Set(["trail.inspect"]));
    expect(audit).toContain("`trail.inspect`");
    expect(project).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);
    expect(project).not.toMatch(/reviewMemoryProposal|memory\.review_handoff/u);
    expect(project).not.toMatch(/>\s*(?:Promote|Approve)\s*</u);

    // The handoff stays explicit: the app shows the evidence and the command.
    expect(project).toMatch(/The app cannot approve this item/u);
    expect(project).toMatch(/Review this in a terminal/u);

    // All three memory kinds still have a reader after the merge.
    expect(project).toMatch(/pending_lessons/u);
    expect(project).toMatch(/routing_changes/u);
    expect(project).toMatch(/draft_tests/u);
    expect(project).toMatch(/memory\?\.canon/u);
    expect(project).toMatch(/history\.runs/u);
    expect(project).not.toMatch(/Reached merge/iu);

    const inspection = await readFile(path.resolve(desktopRoot, "..", "src", "workspace-inspection.ts"), "utf8");
    expect(inspection).toMatch(/event\.type === "adoption\.completed"[\s\S]*event\.data\.task_ids/u);
    expect(app).not.toMatch(/FutureWorkspaceTab/u);
  });

  test("no internal vocabulary reaches the graph or the Project surface either", async () => {
    const map = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "agent-graph.tsx"),
      "utf8"
    );
    const project = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"),
      "utf8"
    );
    const source = `${map}\n${project}`;
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
});

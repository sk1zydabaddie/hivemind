import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");

describe("React workspace boundary", () => {
  test("project selection offers the native folder browser and manual path entry", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const shell = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "main.rs"),
      "utf8"
    );
    const project = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );

    expect(app).toMatch(/invoke<string \| null>\("choose_project_folder"/u);
    expect(app).toContain("Browse folders");
    expect(app).toContain("Or enter the project folder");
    expect(app).toMatch(/onSubmit=\{submitProject\}/u);
    expect(shell).toMatch(/plugin\(tauri_plugin_dialog::init\(\)\)/u);
    expect(shell).toMatch(/choose_project_folder/u);
    expect(project).toMatch(/blocking_pick_folder\(\)/u);
    expect(project).toMatch(/picker\.set_directory\(initial\)/u);
  });

  test("the composer attaches only project-relative files through the native shell", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const shell = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "main.rs"),
      "utf8"
    );
    const project = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );

    expect(work).toMatch(/invoke<PromptAttachment\[\]?>\("choose_project_files"/u);
    expect(work).toMatch(/invoke<PromptAttachment\[\]?>\("choose_project_attachment_folder"/u);
    expect(work).toMatch(/Project references:/u);
    expect(work).toMatch(/aria-label="Attached project items"/u);
    expect(shell).toMatch(/choose_project_files/u);
    expect(shell).toMatch(/choose_project_attachment_folder/u);
    expect(project).toMatch(/strip_prefix\(project_root\)/u);
    expect(project).toMatch(/\.git/u);
    expect(project).toMatch(/\.hivemind/u);
    expect(project).not.toMatch(/read_to_string\(selected|fs::read\(selected/u);
  });

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
      "src/lib/dismissible.ts",
      "src/lib/swarm-model.ts",
      "src/lib/providers.ts",
      "src/lib/work-thread.ts",
      "src/components/settings-dialog.tsx",
      "src/lib/dismissible.ts",
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
    /* Plus Set up, which is not a fourth place: it is the same three, with the
       unfinished step kept reachable until there is an agent to run. It removes
       itself once one is connected -- see `runnable` in App. */
    expect(triggers).toEqual(["setup", "work", "agents", "project"]);
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

    // Orca-derived dark shell with Hivemind's brand navy retained explicitly.
    for (const token of [
      "--canvas: #07111c",
      "--panel: #0d1923",
      "--brand-navy: #1b3a6b",
      "--navy: #7fa9e4",
      "--amber: #d4a95f",
      "--clay: #df786d"
    ]) {
      expect(styles).toContain(token);
    }
    /* Dead tokens from the pre-Tailwind stylesheet, checked against DECLARATIONS
       rather than prose. This matched the word `backdrop-filter` inside a
       comment explaining why that property is the one cross-platform way to
       frost a floating surface -- catching the sentence that justified the rule,
       which is the word-ban failure this project has now recorded five times.
       Comments are stripped, and the ban keeps only what is genuinely dead.

       Gradient shape is governed precisely in `design-tokens.test.ts`; this
       test only owns removal of the legacy named paths. Two rules disagreeing
       about the same property is how they drift. */
    const declarations = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(declarations).not.toMatch(/--field-ivory|--meridian/u);

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

  test("prompt starts centered, then becomes a fixed row without truncating text", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const work = await readFile(path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"), "utf8");

    // Two fixed rows: the interruption slot and the body. The body splits into the
    // work panel and the rail. Empty Work owns one centered composer; Agents
    // names what will appear there without duplicating the prompt. Once work
    // exists, the same Work form becomes the panel's trailing row so tall
    // content cannot displace it.
    expect(work).toMatch(
      /grid h-full min-h-0 grid-rows-\[auto_minmax\(0,1fr\)\] overflow-hidden/u
    );
    /* The rail is a fixed 360px beside a flexible work column -- except when
       there is no task to put in it, which a real trail does produce. Then the
       work column takes the width rather than holding an empty panel open. */
    expect(work).toMatch(/grid-cols-\[minmax\(0,1fr\)_360px\]/u);
    expect(work).toMatch(/tasks\.length === 0[\s\S]{0,120}grid-cols-\[minmax\(0,1fr\)\]/u);
    expect(work).toMatch(/composerCentered[\s\S]{0,180}grid-rows-\[auto_minmax\(0,1fr\)\]/u);
    expect(work).toMatch(/grid-rows-\[auto_minmax\(0,1fr\)_auto\]/u);
    expect(work).toMatch(/place-items-center[\s\S]{0,180}\{form\}/u);
    expect(work).toMatch(/stage === "graph" && idle[\s\S]{0,500}Your agents will appear here/u);
    expect(work).toMatch(/Start a conversation in Work to see who is working/u);
    expect(work).toMatch(/setComposerHasMoved\(true\)[\s\S]{0,80}setBusy\(true\)/u);
    expect(work).toMatch(/\{composerCentered \? null : promptDock\}/u);
    expect(work).toMatch(/size="icon-round"/u);
    expect(work).toMatch(/<ArrowUp aria-hidden="true"/u);
    expect(work).toMatch(/rounded-2xl/u);
    expect(work).toMatch(/resize-none/u);
    expect(work).toMatch(/text-\[15px\]/u);
    expect(work).toMatch(/flex items-center justify-between/u);
    expect(work).toMatch(/subject === null && tasks\.length === 0 && !runActive[\s\S]{0,140}absolute inset-0 flex items-center justify-center/u);
    expect(work).not.toMatch(/Try one of these|EXAMPLE_ASKS/u);
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
    const { REQUIRED_ROLES } = (await import("../src/lib/providers")) as typeof import("../src/lib/providers");

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

    // The catalogue is Core data, not a second hard-coded shape in the UI.
    expect(providers).not.toMatch(/export const PROVIDERS/u);
    expect(providers).not.toMatch(/ProviderOption|ProviderCapability/u);
  });

  test("provider sign-in stays CLI-owned and provider checks report factual liveness", async () => {
    const setup = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    const core = await readFile(
      path.resolve(desktopRoot, "..", "src", "config-actions.ts"),
      "utf8"
    );

    expect(setup).toMatch(/type: "provider\.auth\.start"/u);
    expect(providerList).toMatch(/Open .* sign-in/u);
    expect(`${setup}\n${providerList}`).not.toMatch(/type="password"|api[_ -]?key|access[_ -]?token/iu);
    expect(core).toMatch(/externalTerminalInvocation/u);
    expect(core).toMatch(/providerAuthentication\(providerId\)/u);
    expect(core).not.toMatch(/auth status|login status|credentials\.json/iu);

    /* The spinner may be frozen by reduced motion. Provider name, sequence
       position and elapsed seconds must still change without relying on it. */
    expect(setup).toMatch(/index: index \+ 1/u);
    expect(setup).toMatch(/total: plan\.length/u);
    expect(setup).toMatch(/setElapsedSeconds/u);
    expect(setup).toMatch(/Checking \$\{busy\.label\} — \$\{busy\.index\} of \$\{busy\.total\}/u);
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
    const setup = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );

    /* An agent that has been MEASURED and refused has no invocation, so the UI
       can list it without offering a button that cannot work. An `unverified`
       one may now carry the argv the probe will run -- the probe is the gate,
       and that is how an agent earns a status instead of keeping one forever.
       `connectAdapter` still records nothing unless the probe passes. */
    expect(catalogue).not.toMatch(/status: "supported"[\s\S]{0,600}invoke: null/u);

    /* Every non-supported entry says specifically what is missing. There are
       deliberately NO `unsupported` entries right now: nothing has been
       measured and refused. A REFUSED verdict was published for one agent and
       withdrawn, because it had been measured against the wrong distribution —
       see the provenance rule in DESIGN-NOTES. */
    expect(catalogue).toMatch(/live Claude Code 2\.1\.233 probe verified all nine/u);
    expect(catalogue).toMatch(/completed paid 4\.6 probe[\s\S]{0,160}verified all nine capabilities/u);
    expect(catalogue).toMatch(/project-bounded file server[\s\S]{0,300}hosted provider run/u);

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

    /* Setup and Settings use one provider-row implementation. Settings renders
       Core-discovered slugs grouped by provider, never the old static
       cheap/balanced/strong presentation. */
    expect(setup).toMatch(/ProviderListRow/u);
    expect(settings).toMatch(/ProviderListRow/u);
    expect(settings).toMatch(/discovery\.models\.map/u);
    expect(settings).toMatch(/<optgroup/u);
    expect(settings).not.toMatch(/Codex\s*[—-]\s*(?:cheaper|balanced|strongest)/iu);
    expect(settings).toMatch(/Advanced project rules/u);
    expect(settings).toMatch(/open \? <div/u);

    /* Settings dispatches only its audited project/settings actions. Model
       discovery is read-only; model connection repeats discovery in Core
       before the selected slug can reach the existing paid probe. */
    const dispatched = [...settings.matchAll(/type: "([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(new Set(dispatched)).toEqual(
      new Set([
        "config.inspect",
        "config.set",
        "project.init",
        "provider.auth.start",
        "models.discover",
        "adapter.connect_model",
        "autonomy.set"
      ])
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
    /* The spine's marker is now `hex-advance`: the four grey rules became four
       hexagons, so the thing that animates is the hex the change just filled
       rather than an overlay sliding across a bar. Same binding — it is keyed
       on the live artifact movement naming that task — and the assertion is on
       the binding, not on the class name. */
    expect(spine).toMatch(/hex-advance/u);
    expect(spine).toMatch(/advanceKey !== null/u);
    expect(styles).toMatch(/animation:\s*hex-advance/u);
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
    /* The invariant is READ-ONLY, not "exactly one action". Project reads the
       durable trail and the connected agents; it writes nothing. Asserting the
       property rather than the list is what lets a second read be added without
       weakening the thing being protected. */
    const actions = [...project.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    const READS = new Set(["trail.inspect", "config.inspect", "status.inspect", "change.inspect"]);
    for (const action of actions) {
      expect(READS.has(action!), `${action} is not a read`).toBe(true);
    }
    expect(actions).toContain("trail.inspect");
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

  test("the diff view can read a change and can never approve one", async () => {
    const diff = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "diff-view.tsx"),
      "utf8"
    );
    const model = await readFile(path.join(desktopRoot, "src", "lib", "diff-model.ts"), "utf8");
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );

    /* A diff view that could stage, apply or approve what it is showing would
       be the adoption gate with an extra door in it. So it dispatches nothing
       at all: the only action the annotation flow reaches is `task.redirect`,
       and that is sent from the tab, not from here. */
    expect(diff).not.toMatch(/onAction|invokeWorkspaceAction|type:\s*"[a-z]+\.[a-z_]+"/u);
    expect(model).not.toMatch(/onAction|invokeWorkspaceAction|fetch\(/u);
    for (const forbidden of ["adoption.execute", "plan.ratify", "spec.adopt", "manager.approve_pending"]) {
      expect(diff).not.toContain(forbidden);
    }

    /* Annotations are guidance and the surface says so where a person is
       writing one, not in a footnote somewhere else. */
    expect(diff).toMatch(/Notes are guidance/u);
    expect(diff).toMatch(/do not approve or ship anything/u);

    /* They travel through M6.3's existing correction channel -- no new
       machinery, and every gate that was in the way still is. */
    expect(work).toMatch(/type:\s*"task\.redirect"[\s\S]{0,240}annotationsAsCorrection/u);
  });

  test("the file tree and the file viewer can read, and can do nothing else", async () => {
    const tree = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "file-tree.tsx"),
      "utf8"
    );
    const viewer = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "file-viewer.tsx"),
      "utf8"
    );

    /* The file tree is the surface most likely to grow a write. An IDE's tree
       creates, renames and deletes; ours must never, because there is no such
       action and inventing a path to one would be a write with no event behind
       it -- the same mistake the embedded terminal was refused for. Asserted by
       the ACTIONS these two dispatch: only the two reads exist. */
    const READS = new Set(["files.list", "files.read"]);
    for (const source of [tree, viewer]) {
      const actions = [...source.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(READS.has(action!), `${action} is not one of the two file reads`).toBe(true);
      }
      expect(source).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);
    }

    /* And no control offering one, in either. A tree that renders "New file"
       has already made the promise even if the handler is missing. */
    expect(tree).not.toMatch(/>\s*(?:New|Delete|Rename|Save|Add)\b/u);
    expect(viewer).not.toMatch(/<(?:textarea|input)\b|contentEditable/u);
  });

  test("the checks pane reads a record and cannot run one", async () => {
    const pane = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "checks-output.tsx"),
      "utf8"
    );
    const actions = [...pane.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(actions).toEqual(["checks.inspect"]);

    /* This pane is what the embedded terminal was refused in favour of, so the
       line it must not cross is the one the terminal would have: it reads what
       a command printed and never causes a command to run. Re-running is a
       different action behind a different gate, and it is not reachable here.
       COMMENTS ARE STRIPPED FIRST. The first version of this assertion failed
       on the comment above naming the very action it forbids -- the third time
       this trap has been sprung in this project, after "secrets" and
       "estimate". Prose explains the rule; code is what is constrained. */
    const paneCode = pane.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(paneCode).not.toMatch(/verification\.rerun|manager\.|adoption\./u);
    expect(paneCode).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);

    /* Core keeps the bytes beside the trail rather than inside it, and the
       action that serves them takes no fields -- both asserted at the source,
       so a later change that starts writing megabytes into events fails here. */
    const store = await readFile(path.resolve(desktopRoot, "..", "src", "check-output.ts"), "utf8");
    expect(store).toMatch(/CHECK_OUTPUT_LIMIT_BYTES/u);
    const core = await readFile(path.resolve(desktopRoot, "..", "src", "verification.ts"), "utf8");
    expect(core).toMatch(/checks_run_id: stored\.ok \? checksRunId : null/u);
    expect(core).not.toMatch(/data:\s*\{[\s\S]{0,400}stdout/u);
  });

  test("switching projects carries no project state across", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    const rust = await readFile(
      path.resolve(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );

    /* Recents are SHELL state. Storing them inside a project would make one
       project the registry of the others, which is the cross-project coupling
       the isolation work removed. */
    expect(rust).toMatch(/app_config_dir/u);
    expect(rust).toMatch(/recent-projects\.json/u);

    /* And they hold paths only. A capability, a connection or a run stored here
       would be a verification that could travel between projects. */
    const record = /pub struct RecentProject \{[\s\S]*?\}/u.exec(rust)?.[0] ?? "";
    expect(record).toMatch(/path: String/u);
    for (const forbidden of ["capabilit", "connection", "adapter", "token", "spend", "task"]) {
      expect(record.toLowerCase()).not.toContain(forbidden);
    }

    /* The daemon survives a switch -- a run in flight on the project you leave
       keeps running. Asserted at the comment that records the decision, because
       the behaviour is an ABSENCE (no shutdown hook) and an absence has no
       other place to be checked. */
    expect(rust).toMatch(/switching the app cannot kill it/u);

    /* The client's own view IS rebuilt, which is what keeps the two apart. */
    const hook = await readFile(
      path.join(desktopRoot, "src", "hooks", "use-workspace.ts"),
      "utf8"
    );
    expect(hook).toMatch(/onSwitchStart[\s\S]{0,320}createBoardProjection\(\)/u);
    expect(app).toMatch(/recent_projects/u);
    expect(app).toMatch(/aria-label=\{`Switch project, currently \$\{projectName\}`\}/u);
    expect(app).toMatch(/<DropdownMenuLabel>Projects<\/DropdownMenuLabel>/u);
    expect(app).toMatch(/recentProjects\.map[\s\S]{0,500}workspace\.switchProject\(entry\.path\)/u);
    expect(app).toMatch(/Open another project…/u);
  });

  test("navigation keeps only the centered underline selected state", async () => {
    const tabs = await readFile(
      path.join(desktopRoot, "src", "components", "ui", "tabs.tsx"),
      "utf8"
    );
    expect(tabs).toMatch(/after:left-2\.5/u);
    expect(tabs).toMatch(/after:right-2\.5/u);
    expect(tabs).toMatch(/after:origin-center/u);
    expect(tabs).not.toMatch(/clip-path|before:scale-100/u);
  });

  test("an untracked folder is offered git rather than refused", async () => {
    const setup = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    /* Explaining a requirement is not offering the step. This used to say
       "choose a folder that is a git repository" and stop. */
    expect(setup).toMatch(/action: "git"/u);
    expect(setup.replace(/\s+/gu, " ")).toMatch(/Start tracking this folder/u);

    /* And it refuses rather than guesses when the folder holds a secret: a
       first commit cannot be un-made without rewriting history. */
    const rust = await readFile(
      path.resolve(desktopRoot, "src-tauri", "src", "project.rs"),
      "utf8"
    );
    expect(rust).toMatch(/NEVER_COMMIT/u);
    expect(rust).toMatch(/\.env/u);
    expect(rust).toMatch(/if let Some\(reason\) = readiness\.refusal/u);
  });

  test("a passed result never renders without what it stood on, or without its limits", async () => {
    const note = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provenance-note.tsx"),
      "utf8"
    );

    /* Advisory: it reads, it never acts. */
    const actions = [...note.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    expect(actions).toEqual(["checks.inspect"]);
    expect(note).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);

    /* The blind spot is stated where it renders, not in a document nobody
       opens. This is the sentence that stops the label over-claiming. */
    /* Whitespace-tolerant: JSX wraps prose across lines, so a regex written
       with single spaces asserts the formatter's choices rather than the copy. */
    const prose = note.replace(/\s+/gu, " ");
    expect(prose).toMatch(/never sees inside a check/u);
    expect(prose).toMatch(/full of stand-ins/u);
    expect(prose).toMatch(/not known/u);

    /* The naming rule. "Depth" would be read as "no mocks", which this cannot
       support -- a worker-written suite full of doubles scores well on every
       axis Core can observe. Checked against the RENDERED strings only, since
       the comment above legitimately explains why the word is wrong. */
    const rendered = [...note.matchAll(/>([^<>{}]{4,})</gu)].map((match) => match[1]!.toLowerCase());
    for (const claim of ["depth", "deeply tested", "no mocks", "fully tested"]) {
      expect(rendered.some((text) => text.includes(claim))).toBe(false);
    }

    /* Both surfaces that claim a pass render it. */
    const ship = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    expect(ship).toMatch(/<ProvenanceNote compact onAction=\{onAction\} \/>/u);
    const checks = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "checks-output.tsx"),
      "utf8"
    );
    expect(checks).toMatch(/<ProvenanceNote onAction=\{onAction\} \/>/u);
  });

  test("the accounts surface can switch an account and can never carry a credential", async () => {
    const panel = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "accounts-panel.tsx"),
      "utf8"
    );
    const code = panel.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

    /* The whole promise: authentication stays with the harness. So this
       surface has no input of any kind -- a text field here is the beginning
       of a credential channel even if nothing reads it yet -- and dispatches
       only the three account actions. */
    /* Structural, not lexical. The first version of this banned the WORDS
       api_key/token/secret/password -- and failed on the panel's own visible
       sentence "never sees your password, key or token", which is the
       guarantee being enforced, rendered for the person who needs to read it.
       Fourth instance of this trap in this project, and the first where the
       offending prose was not a comment but UI copy, so stripping comments
       would not have saved it either. What actually matters is that there is
       nowhere to TYPE a secret and no action to send one. */
    expect(code).not.toMatch(/<(?:input|textarea)/u);
    expect(code).not.toMatch(/type=\{?["']password/u);
    const actions = [...code.matchAll(/type:\s*"([a-z_.]+)"/gu)].map((match) => match[1]);
    for (const action of actions) {
      expect(["accounts.inspect", "accounts.select"]).toContain(action!);
    }
    expect(code).not.toMatch(/invokeWorkspaceAction|fetch\(|method:\s*["']POST/u);

    /* And it says, where a person is looking at it, what it does not do. */
    expect(panel).toMatch(/never sees your password, key or token/u);

    /* Core's half: one allowlisted directory variable per harness, and a
       credential-shaped name refused twice. */
    /* The variable names live in the catalogue -- the file allowed to know how
       to start a provider, including which of its own homes to start it
       against. `provider-knowledge.test.ts` put them there by failing when they
       had their own module, and that was the right outcome. */
    const catalogue = await readFile(
      path.resolve(desktopRoot, "..", "src", "agent-catalogue.ts"),
      "utf8"
    );
    expect(catalogue).toMatch(/CODEX_HOME/u);
    expect(catalogue).toMatch(/CLAUDE_CONFIG_DIR/u);
    expect(catalogue).toMatch(/OPENCODE_CONFIG_DIR/u);
    const accounts = await readFile(
      path.resolve(desktopRoot, "..", "src", "provider-accounts.ts"),
      "utf8"
    );
    expect(accounts).toMatch(/isCredentialVariable/u);
    /* Switching invalidates the verification, which is the guardrail that
       makes a switch safe rather than merely possible. */
    const actionsSource = await readFile(
      path.resolve(desktopRoot, "..", "src", "workspace-actions.ts"),
      "utf8"
    );
    expect(actionsSource).toMatch(/invalidateVerificationForHarness/u);
  });

  test("the accounts panel refuses to draw a figure it cannot trust", async () => {
    const usage = await readFile(path.join(desktopRoot, "src", "lib", "provider-usage.ts"), "utf8");
    const project = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"),
      "utf8"
    );

    /* The rule the whole panel exists for. A provider whose `reports_usage` is
       not verified is marked unreadable rather than drawn as a confident zero,
       because a meter reading nought when it means "I cannot see" is how three
       days get lost to an exhausted quota. */
    expect(usage).toMatch(/entry\?\.status === "verified" \? "measured" : "unreadable"/u);
    expect(project).toMatch(/not readable/u);
    /* And the bar is only ever drawn from Core's own ledger, never from a sum
       of events -- the ledger is what the ceiling is enforced against. */
    expect(usage).toMatch(/inspection\?\.spend/u);
    /* Checked against CODE, not prose. The first version of this banned the
       word "estimate" outright and failed on the comment that says this module
       never estimates -- the same shape as the settings test that once banned
       "secrets" and caught the sentence protecting the most dangerous file
       scope. Comments explain; code is what is constrained. */
    const usageCode = usage.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(usageCode).not.toMatch(/Math\.round\([^)]*\*\s*1\.\d/u);
    expect(usageCode).not.toMatch(/estimate[A-Za-z]*\s*\(/u);
  });
});

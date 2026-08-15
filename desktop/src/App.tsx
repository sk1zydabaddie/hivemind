import {
  Check,
  FolderGit2,
  LayoutList,
  Library,
  Plug,
  Workflow,
  Search,
  Settings,
  Terminal
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import { SettingsDialog } from "@/components/settings-dialog";
import { SetupScreen } from "@/components/workspace/setup-screen";
import { ProjectTab } from "@/components/workspace/project-tab";
import { WorkTab } from "@/components/workspace/work-tab";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  displayProjectPath,
  projectNameFromPath,
  PROJECT_FAULT
} from "@/lib/project-session";
import { taskPhase } from "@/lib/phases";
import { REQUIRED_ROLES } from "@/lib/providers";
import type { ProjectConfigView } from "@/lib/workspace-actions";

/* Codes that mean "you have not finished setting this up", not "something
   went wrong". The distinction is the whole difference between a first run
   that reads as broken and one that reads as unfinished. */
const SETUP_CODES = new Set<string>([
  PROJECT_FAULT.noProjectSelected,
  PROJECT_FAULT.notInitialized,
  PROJECT_FAULT.notAGitRepository
]);

export default function App(): React.JSX.Element {
  const workspace = useWorkspace();
  const [projectInput, setProjectInput] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [section, setSection] = useState("setup");
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* Which projects have been opened. SHELL state, kept by the Tauri side in the
     app's own config directory -- never inside a project, because putting it
     there would make one project the registry of the others, which is the
     cross-project coupling the isolation work removed. It holds paths and
     nothing else: no task, no run, no capability. Switching therefore cannot
     carry a verification across, because there is nothing here that could. */
  const [recents, setRecents] = useState<{ path: string; opened_at: string }[]>([]);
  const projectPath = workspace.connection?.project_root ?? "";

  useEffect(() => {
    void invoke<{ path: string; opened_at: string }[]>("recent_projects")
      .then(setRecents)
      .catch(() => {
        /* Running outside the shell, e.g. the replay harness. The palette
           simply offers nothing rather than showing an error where a project
           list belongs. */
      });
  }, [projectPath]);

  useEffect(() => {
    if (projectPath === "") return;
    void invoke("remember_project", { projectPath }).catch(() => undefined);
  }, [projectPath]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const runCommand = (command: () => void): void => {
    setPaletteOpen(false);
    command();
  };

  const submitProject = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    if (projectInput.trim() === "") return;
    await workspace.switchProject(projectInput);
    setProjectInput("");
    setProjectOpen(false);
  };

  const visibleProjectPath = displayProjectPath(
    workspace.connection?.project_root ?? workspace.projectPath
  );
  const projectName = projectNameFromPath(visibleProjectPath);
  const shellUpdateRequired = workspace.connectionState === "update required";
  /* Only the daemon answering with real project state counts as live. Until
     then this is a setup problem, not an empty workspace. */
  const live = workspace.inspection !== null;

  /* Setup is not finished when the daemon answers. It is finished when there is
     an agent to run, and there is no agent until somebody connects one --
     Core deliberately writes no adapter profile, because a profile written by
     setup is a claim no probe has checked. The screen used to disappear at
     `live`, which dropped a person into a composer whose first submission
     failed on a missing file they had been told not to think about. */
  const [configView, setConfigView] = useState<ProjectConfigView | null>(null);
  const refreshConfig = useCallback(async (): Promise<void> => {
    if (!live) {
      setConfigView(null);
      return;
    }
    try {
      setConfigView(
        await workspace.performAction<ProjectConfigView>({
          type: "config.inspect",
          payload: {}
        })
      );
    } catch {
      /* Leave the last answer standing rather than claiming nothing is
         connected: a failed read is not evidence of an empty project. */
    }
    /* Deliberately keyed on `live` and the path rather than on `inspection`,
       which is replaced by a poll every five seconds. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, projectPath]);
  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const runnable =
    live &&
    configView !== null &&
    REQUIRED_ROLES.every((role) =>
      configView.adapters.some(
        (adapter) =>
          adapter.role === role.tool &&
          adapter.connected_at !== null &&
          adapter.problems.length === 0
      )
    );

  /* Once there is an agent, stop showing the setup step -- but only move
     somebody who is still standing on it. Navigating away deliberately is not
     something completing a step should undo. */
  useEffect(() => {
    if (runnable && section === "setup") setSection("work");
  }, [runnable, section]);
  /* A count on the tab, so a run in flight advertises itself from whichever
     view you are in. Core's task states counted -- nothing derived. */
  const agentsWorking = (workspace.inspection?.tasks ?? []).filter((task) =>
    taskPhase(task).standing === "working"
  ).length;

  return (
    <TooltipProvider delayDuration={180}>
      {/* One toolbar on the canvas carries the brand, the sections, the project
          and the connection. Everything below it is a panel. */}
      <Tabs
        className="h-screen overflow-hidden bg-canvas"
        value={section}
        onValueChange={setSection}
      >
        {/* Chrome, not a widget tray. White, ruled off from the canvas below,
            44px tall, and every control on it is the same height. */}
        <header className="flex h-11 shrink-0 items-stretch gap-4 border-b border-rule bg-panel pr-2.5 pl-3">
          <div className="flex shrink-0 items-center gap-2">
            <BrandMark />
            <span className="text-[13px] leading-none font-semibold tracking-tight text-ink">
              Hivemind
            </span>
          </div>

          {/* Three places, and each answers a different question. Work is what
              has happened and what you have to decide. Agents is who is doing
              what, right now. Project is every run you have had.

              Agents was demoted to a Story/Map toggle inside Work on the
              argument that its inputs are a subset of Work's. They are; the
              picture is not. A list can say three tasks are running, and only a
              shape can show three agents on one branch with a fourth waiting
              under them. It is a view worth navigating to, and the toggle it
              was folded into was a false choice between two drawings of one
              thing -- which is a worse question to ask than this one. */}
          {live ? (
          <TabsList aria-label="Workspace sections">
            {/* Stays until there is an agent to run, then leaves. The app is
                never blocked meanwhile: every other section is reachable. */}
            {runnable ? null : (
              <TabsTrigger value="setup">
                <Plug aria-hidden="true" />
                Set up
              </TabsTrigger>
            )}
            <TabsTrigger value="work">
              <LayoutList aria-hidden="true" />
              Work
            </TabsTrigger>
            <TabsTrigger value="agents">
              <Workflow aria-hidden="true" />
              Agents
              {agentsWorking > 0 ? (
                <span className="ml-0.5 font-mono text-[11px] text-navy">
                  {agentsWorking}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="project">
              <Library aria-hidden="true" />
              Project
            </TabsTrigger>
          </TabsList>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ConnectionReadout
              detail={workspace.connectionDetail}
              /* A project that has not been set up yet is not a fault, and the
                 chrome saying "Connection error" over a calm explanation of the
                 next step is how a first run starts out believing something is
                 broken. Setup-shaped codes read as what they are. */
              state={
                SETUP_CODES.has(workspace.connectionCode)
                  ? "not set up"
                  : workspace.connectionState
              }
            />
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-rule" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="h-7 max-w-[280px] gap-1.5 px-2"
                  type="button"
                  variant="ghost"
                  onClick={() => setProjectOpen(true)}
                >
                  <FolderGit2 aria-hidden="true" />
                  <span className="font-mono text-[12px] text-ink">{projectName}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="font-mono">{visibleProjectPath}</span>
                <br />
                Click to open a different project.
              </TooltipContent>
            </Tooltip>
            {/* The palette exists; nothing on screen said so. A keycap in the
                chrome is the cheapest way to teach a shortcut. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Commands"
                  className="h-7 gap-1.5 px-2"
                  type="button"
                  variant="ghost"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Search aria-hidden="true" />
                  <kbd className="rounded-sm border border-rule px-1 font-mono text-[11px] text-muted-foreground">
                    ⌘K
                  </kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Commands</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Settings"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Settings</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {shellUpdateRequired ? (
          <section
            className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-clay/25 bg-clay-wash px-4 py-2.5 text-[12px] text-clay"
            role="alert"
          >
            <strong className="font-semibold">Desktop update required</strong>
            <span className="min-w-0 flex-1 break-words text-clay/85">
              {workspace.connectionDetail}
            </span>
            <span className="font-medium">
              Project controls are disabled until the app is rebuilt and restarted.
            </span>
          </section>
        ) : null}

        {/* Before the daemon answers there is nothing to navigate to, so the
            setup screen is the whole window. After it answers the screen
            becomes one section among the others, so nothing is blocked. */}
        {live ? null : (
          <SetupScreen
            connectionCode={workspace.connectionCode}
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            initializing={workspace.initializing}
            live={false}
            projectPath={visibleProjectPath}
            view={null}
            onAction={workspace.performAction}
            onChooseProject={() => setProjectOpen(true)}
            onInitializeGit={() => void workspace.initializeGit()}
            onInitializeProject={() => void workspace.initializeProject()}
            onReload={refreshConfig}
          />
        )}

        {live ? (
        <>
        <TabsContent value="setup">
          <SetupScreen
            connectionCode={workspace.connectionCode}
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            initializing={workspace.initializing}
            live
            projectPath={visibleProjectPath}
            view={configView}
            onAction={workspace.performAction}
            onChooseProject={() => setProjectOpen(true)}
            onInitializeGit={() => void workspace.initializeGit()}
            onInitializeProject={() => void workspace.initializeProject()}
            onReload={refreshConfig}
          />
        </TabsContent>
        {/* One component renders both stages, which is what keeps the single
            inspector single: the rail, the attention bar, the ship bar and the
            composer are the same instances either way, so shipping never
            depends on which view you happen to be looking at. */}
        {(["work", "agents"] as const).map((value) => (
        <TabsContent key={value} value={value}>
          <WorkTab
            actionError={workspace.actionError}
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            inspection={workspace.inspection}
            projection={workspace.projection}
            stage={value === "agents" ? "graph" : "thread"}
            onAction={workspace.performAction}
            onReconnect={() =>
              workspace.switchProject(
                workspace.connection?.project_root ?? workspace.projectPath
              )
            }
            onSelectTask={workspace.selectTaskOutput}
          />
        </TabsContent>
        ))}
        <TabsContent value="project">
          <ProjectTab
            inspection={workspace.inspection}
            projection={workspace.projection}
            projectName={projectName}
            onAction={workspace.performAction}
          />
        </TabsContent>
        </>
        ) : null}
      </Tabs>

      <SettingsDialog
        busy={false}
        inspection={workspace.inspection}
        open={settingsOpen}
        projectPath={visibleProjectPath}
        onAction={workspace.performAction}
        onChooseProject={() => {
          setSettingsOpen(false);
          setProjectOpen(true);
        }}
        onConnectAgent={() => {
          setSettingsOpen(false);
          setSection("setup");
        }}
        onOpenChange={setSettingsOpen}
      />

      <CommandDialog
        description="Jump to a section or open a project"
        open={paletteOpen}
        title="Commands"
        onOpenChange={setPaletteOpen}
      >
        <CommandInput placeholder="What do you want to do?" />
        <CommandList>
          <CommandEmpty>Nothing matches that.</CommandEmpty>
          <CommandGroup heading="Work">
            <CommandItem
              onSelect={() =>
                runCommand(() => {
                  setSection("work");
                  window.setTimeout(
                    () => document.getElementById("work-composer")?.focus(),
                    0
                  );
                })
              }
            >
              <LayoutList aria-hidden="true" />
              Describe what you want built
              <CommandShortcut>/</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setProjectOpen(true))}>
              <FolderGit2 aria-hidden="true" />
              Open a different project
            </CommandItem>
          </CommandGroup>
          {/* Switching projects in one action. The daemon is per project and
              Tauri owns no shutdown hook, so a run in flight on the project you
              leave keeps running and its state is intact when you return --
              only this client's view is rebuilt, which is what keeps the two
              from bleeding into each other. */}
          <CommandGroup heading="Recent projects">
            {recents
              .filter((entry) => entry.path !== projectPath)
              .map((entry) => (
                <CommandItem
                  key={entry.path}
                  onSelect={() => runCommand(() => void workspace.switchProject(entry.path))}
                >
                  <FolderGit2 aria-hidden="true" />
                  {projectNameFromPath(entry.path)}
                  <CommandShortcut>{displayProjectPath(entry.path)}</CommandShortcut>
                </CommandItem>
              ))}
            {recents.filter((entry) => entry.path !== projectPath).length === 0 ? (
              <CommandItem disabled>
                No other project has been opened yet
              </CommandItem>
            ) : null}
            <CommandItem onSelect={() => runCommand(() => setSection("setup"))}>
              <Terminal aria-hidden="true" />
              Set up a coding agent
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setSettingsOpen(true))}>
              <Settings aria-hidden="true" />
              Settings
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Go to">
            {[
              { value: "work", label: "Work", icon: <LayoutList aria-hidden="true" /> },
              { value: "agents", label: "Agents", icon: <Workflow aria-hidden="true" /> },
              { value: "project", label: "Project", icon: <Library aria-hidden="true" /> }
            ].map((entry) => (
              <CommandItem
                key={entry.value}
                onSelect={() => runCommand(() => setSection(entry.value))}
              >
                {entry.icon}
                {entry.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <Dialog open={projectOpen} onOpenChange={setProjectOpen}>
        <DialogContent className="sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle>Open a project</DialogTitle>
            <DialogDescription>
              Hivemind works inside one project folder at a time. Everything it
              builds stays there until you ship it.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3.5" onSubmit={submitProject}>
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Project folder
              <input
                autoComplete="off"
                autoFocus
                className="h-9 rounded-md border border-rule bg-canvas px-2.5 font-mono text-[13px] text-ink transition-colors focus-visible:border-navy/40 focus-visible:bg-panel"
                id="project-path"
                onChange={(event) => setProjectInput(event.target.value)}
                placeholder="D:\\Projects\\my-app"
                spellCheck={false}
                value={projectInput}
              />
            </label>
            <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
              <span className="text-[11px] font-medium tracking-label uppercase">
                Currently open
              </span>
              <span className="min-w-0 break-all font-mono text-ink">
                {visibleProjectPath}
              </span>
            </p>
            <DialogFooter>
              <Button type="submit">
                <Check aria-hidden="true" />
                Open project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/* The product's own mark, reduced: two interlocking hexagons in the two
   identity colours. The four rounded squares this replaced were a generic
   swarm glyph and, literally, four cards in a grid. */
function BrandMark(): React.JSX.Element {
  const hex = (cx: number, cy: number): string => {
    const r = 6.1;
    const w = r * 0.866;
    return [
      `M${cx} ${cy - r}`,
      `L${cx + w} ${cy - r / 2}`,
      `L${cx + w} ${cy + r / 2}`,
      `L${cx} ${cy + r}`,
      `L${cx - w} ${cy + r / 2}`,
      `L${cx - w} ${cy - r / 2}`,
      "Z"
    ].join(" ");
  };
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="19"
      viewBox="0 0 20 20"
      width="19"
    >
      <defs>
        {/* The one crossing where the navy link passes in front, which is what
            makes the two read as linked rather than as overlapping. */}
        <clipPath id="hivemind-link">
          <rect height="6" width="7" x="10" y="4.5" />
        </clipPath>
      </defs>
      <path
        d={hex(11.6, 8.2)}
        stroke="var(--navy)"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        d={hex(8.4, 11.8)}
        stroke="var(--ink)"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        clipPath="url(#hivemind-link)"
        d={hex(11.6, 8.2)}
        stroke="var(--navy)"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}

function ConnectionReadout({
  state,
  detail
}: {
  state: string;
  detail: string;
}): React.JSX.Element {
  const live = state === "live";
  const broken = state === "connection error" || state === "update required";
  const dot = live ? "bg-navy" : broken ? "bg-clay" : "bg-amber";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-live="polite"
          className="flex cursor-default items-center gap-1.5 px-1 text-[12px] text-muted-foreground"
        >
          <span aria-hidden="true" className={`size-1.5 rounded-xs ${dot}`} />
          <span className="font-medium text-ink first-letter:uppercase">{state}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {live
          ? "This project's updates are arriving live."
          : detail || "Waiting for the project."}
      </TooltipContent>
    </Tooltip>
  );
}

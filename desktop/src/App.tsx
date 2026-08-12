import {
  Check,
  FolderGit2,
  LayoutList,
  Library,
  Workflow,
  Search,
  Settings,
  Terminal
} from "lucide-react";
import { useEffect, useState } from "react";

import { AgentSetupDialog } from "@/components/agent-setup-dialog";
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
import { displayProjectPath, projectNameFromPath } from "@/lib/project-session";
import { taskPhase } from "@/lib/phases";

export default function App(): React.JSX.Element {
  const workspace = useWorkspace();
  const [projectInput, setProjectInput] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [section, setSection] = useState("work");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

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
  /* Only the daemon answering with real project state counts as ready. Until
     then this is a setup problem, not an empty workspace. */
  const ready = workspace.inspection !== null;
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
          {ready ? (
          <TabsList aria-label="Workspace sections">
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
              state={workspace.connectionState}
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

        {ready ? null : (
          <SetupScreen
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            projectPath={visibleProjectPath}
            initializing={workspace.initializing}
            onChooseProject={() => setProjectOpen(true)}
            onConnectAgent={() => setAgentOpen(true)}
            onInitializeProject={() => void workspace.initializeProject()}
          />
        )}

        {ready ? (
        <>
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
          setAgentOpen(true);
        }}
        onOpenChange={setSettingsOpen}
      />

      <AgentSetupDialog open={agentOpen} onOpenChange={setAgentOpen} />

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
            <CommandItem onSelect={() => runCommand(() => setAgentOpen(true))}>
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

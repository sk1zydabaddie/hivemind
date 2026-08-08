import {
  BrainCircuit,
  Check,
  FolderGit2,
  History,
  LayoutList,
  Network,
  Settings,
  Terminal
} from "lucide-react";
import { useEffect, useState } from "react";

import { AgentSetupDialog } from "@/components/agent-setup-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { SetupScreen } from "@/components/workspace/setup-screen";
import { HistoryTab } from "@/components/workspace/history-tab";
import { MemoryTab } from "@/components/workspace/memory-tab";
import { SwarmTab } from "@/components/workspace/swarm-tab";
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
  CommandList
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

  return (
    <TooltipProvider delayDuration={180}>
      {/* One toolbar on the canvas carries the brand, the sections, the project
          and the connection. Everything below it is a panel. */}
      <Tabs
        className="h-screen overflow-hidden bg-canvas"
        value={section}
        onValueChange={setSection}
      >
        <header className="flex h-14 shrink-0 items-center gap-7 px-5">
          <div className="flex items-center gap-2.5 pr-1">
            <BrandMark />
            <span className="text-[16px] leading-none font-semibold tracking-[-0.015em] text-ink">
              Hivemind
            </span>
          </div>

          {ready ? (
          <TabsList aria-label="Workspace sections">
            <TabsTrigger value="work">
              <LayoutList aria-hidden="true" />
              Work
            </TabsTrigger>
            <TabsTrigger value="swarm">
              <Network aria-hidden="true" />
              Swarm
            </TabsTrigger>
            <TabsTrigger value="memory">
              <BrainCircuit aria-hidden="true" />
              Memory
            </TabsTrigger>
            <TabsTrigger value="history">
              <History aria-hidden="true" />
              History
            </TabsTrigger>
          </TabsList>
          ) : null}

          <div className="ml-auto flex items-center gap-2.5">
            <ConnectionReadout
              detail={workspace.connectionDetail}
              state={workspace.connectionState}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Settings"
                  className="size-9 bg-panel shadow-panel"
                  size="icon"
                  type="button"
                  variant="outline"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings aria-hidden="true" className="text-muted" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Settings</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="h-9 max-w-[300px] gap-2 bg-panel px-3 shadow-panel"
                  type="button"
                  variant="outline"
                  onClick={() => setProjectOpen(true)}
                >
                  <FolderGit2 aria-hidden="true" className="text-muted" />
                  <span className="text-[13px] font-medium">{projectName}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="font-mono">{visibleProjectPath}</span>
                <br />
                Click to open a different project.
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        {shellUpdateRequired ? (
          <section
            className="mx-4 mb-3 flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-clay/30 bg-clay-wash px-4 py-3 text-[13px] text-clay"
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
        <TabsContent value="work">
          <WorkTab
            actionError={workspace.actionError}
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            inspection={workspace.inspection}
            projection={workspace.projection}
            onAction={workspace.performAction}
            onReconnect={() =>
              workspace.switchProject(
                workspace.connection?.project_root ?? workspace.projectPath
              )
            }
            onSelectTask={workspace.selectTaskOutput}
          />
        </TabsContent>
        <TabsContent value="swarm">
          <SwarmTab
            actionError={workspace.actionError}
            inspection={workspace.inspection}
            projection={workspace.projection}
            onAction={workspace.performAction}
            onSelectTask={workspace.selectTaskOutput}
          />
        </TabsContent>
        <TabsContent value="memory">
          <MemoryTab inspection={workspace.inspection} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab
            inspection={workspace.inspection}
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
              { value: "swarm", label: "Swarm", icon: <Network aria-hidden="true" /> },
              { value: "memory", label: "Memory", icon: <BrainCircuit aria-hidden="true" /> },
              { value: "history", label: "History", icon: <History aria-hidden="true" /> }
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
          <form className="grid gap-4" onSubmit={submitProject}>
            <label className="grid gap-2 text-[13px] font-medium text-ink">
              Project folder
              <input
                autoComplete="off"
                autoFocus
                className="h-11 rounded-md border border-rule bg-canvas px-3 font-mono text-[13px] text-ink"
                id="project-path"
                onChange={(event) => setProjectInput(event.target.value)}
                placeholder="D:\\Projects\\my-app"
                spellCheck={false}
                value={projectInput}
              />
            </label>
            <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
              <span className="font-medium text-ink">Currently open</span>
              <span className="min-w-0 break-all font-mono text-[12px]">
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

/* Two identity colours, four cells: the swarm in the smallest possible mark. */
function BrandMark(): React.JSX.Element {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-panel shadow-panel">
      <svg aria-hidden="true" height="15" viewBox="0 0 15 15" width="15">
        <rect fill="var(--navy)" height="6.5" rx="1.5" width="6.5" x="0" y="0" />
        <rect fill="var(--ink)" height="6.5" rx="1.5" width="6.5" x="8.5" y="0" />
        <rect fill="var(--ink)" height="6.5" rx="1.5" width="6.5" x="0" y="8.5" />
        <rect fill="var(--navy)" height="6.5" rx="1.5" width="6.5" x="8.5" y="8.5" />
      </svg>
    </span>
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
          className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted"
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${dot}`} />
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

import { BrainCircuit, Check, FolderGit2, History, LayoutList, Network } from "lucide-react";
import { useState } from "react";

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

  return (
    <TooltipProvider delayDuration={180}>
      {/* One toolbar on the canvas carries the brand, the sections, the project
          and the connection. Everything below it is a panel. */}
      <Tabs className="h-screen overflow-hidden bg-canvas" defaultValue="work">
        <header className="flex h-14 shrink-0 items-center gap-7 px-5">
          <div className="flex items-center gap-2.5 pr-1">
            <BrandMark />
            <span className="text-[16px] leading-none font-semibold tracking-[-0.015em] text-ink">
              Hivemind
            </span>
          </div>

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

          <div className="ml-auto flex items-center gap-2.5">
            <ConnectionReadout
              detail={workspace.connectionDetail}
              state={workspace.connectionState}
            />
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
      </Tabs>

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

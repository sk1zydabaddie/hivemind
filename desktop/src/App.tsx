import {
  Activity,
  BrainCircuit,
  FolderGit2,
  History,
  Network,
  Wifi
} from "lucide-react";
import { useState } from "react";

import { WorkTab } from "./components/workspace/work-tab";
import { SwarmTab } from "./components/workspace/swarm-tab";
import { MemoryTab } from "./components/workspace/memory-tab";
import { HistoryTab } from "./components/workspace/history-tab";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { useWorkspace } from "./hooks/use-workspace";
import {
  displayProjectPath,
  projectNameFromPath
} from "./lib/project-session";

export default function App(): React.JSX.Element {
  const workspace = useWorkspace();
  const [projectInput, setProjectInput] = useState("");

  const submitProject = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    if (projectInput.trim() === "") return;
    await workspace.switchProject(projectInput);
    setProjectInput("");
  };

  const visibleProjectPath = displayProjectPath(
    workspace.connection?.project_root ?? workspace.projectPath
  );
  const projectName = projectNameFromPath(visibleProjectPath);

  return (
    <TooltipProvider delayDuration={180}>
      <main className="app-shell">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Network size={22} />
            </span>
            <h1>Hivemind</h1>
          </div>
          <form className="project-switcher" onSubmit={submitProject}>
            <span className="project-identity" title={visibleProjectPath}>
              <FolderGit2 size={15} aria-hidden="true" />
              <strong>{projectName}</strong>
            </span>
            <input
              id="project-path"
              value={projectInput}
              onChange={(event) => setProjectInput(event.target.value)}
              aria-label="Open another project"
              placeholder="Paste another project path"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit">Open</button>
          </form>
          <div className="connection-readout" aria-live="polite">
            <span
              className={`connection-dot ${
                workspace.connectionState === "live" ? "is-live" : ""
              }`}
              aria-hidden="true"
            />
            <span>
              <strong>{workspace.connectionState}</strong>
              <small>
                {workspace.connectionState === "live"
                  ? "Project updates are live"
                  : workspace.connectionDetail || "Waiting for the project"}
              </small>
            </span>
          </div>
        </header>

        <Tabs className="workspace-tabs" defaultValue="work">
          <div className="tab-rail">
            <TabsList aria-label="Workspace sections">
              <TabsTrigger value="work">
                <Activity size={16} aria-hidden="true" />
                Work
              </TabsTrigger>
              <TabsTrigger value="swarm">
                <Network size={16} aria-hidden="true" />
                Swarm
              </TabsTrigger>
              <TabsTrigger value="memory">
                <BrainCircuit size={16} aria-hidden="true" />
                Memory
              </TabsTrigger>
              <TabsTrigger value="history">
                <History size={16} aria-hidden="true" />
                History
              </TabsTrigger>
            </TabsList>
            <div className="workspace-presence">
              <Wifi size={14} aria-hidden="true" />
              {projectName}
            </div>
          </div>

          <TabsContent value="work">
            <WorkTab
              projection={workspace.projection}
              inspection={workspace.inspection}
              actionError={workspace.actionError}
              onSelectTask={workspace.selectTaskOutput}
              onAction={workspace.performAction}
            />
          </TabsContent>
          <TabsContent value="swarm">
            <SwarmTab
              projection={workspace.projection}
              inspection={workspace.inspection}
              actionError={workspace.actionError}
              onSelectTask={workspace.selectTaskOutput}
              onAction={workspace.performAction}
            />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryTab inspection={workspace.inspection} />
          </TabsContent>
          <TabsContent value="history">
            <HistoryTab inspection={workspace.inspection} onAction={workspace.performAction} />
          </TabsContent>
        </Tabs>
      </main>
    </TooltipProvider>
  );
}

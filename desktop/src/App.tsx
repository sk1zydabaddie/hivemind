import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  FolderGit2,
  History,
  Network,
  Radio,
  ShieldCheck
} from "lucide-react";
import { useEffect, useState } from "react";

import { WorkTab } from "./components/workspace/work-tab";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { useWorkspace } from "./hooks/use-workspace";

export default function App(): React.JSX.Element {
  const workspace = useWorkspace();
  const [projectInput, setProjectInput] = useState(workspace.projectPath);

  useEffect(() => {
    setProjectInput(workspace.projectPath);
  }, [workspace.projectPath]);

  const submitProject = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void workspace.switchProject(projectInput);
  };

  return (
    <TooltipProvider delayDuration={180}>
      <main className="app-shell">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Network size={22} />
            </span>
            <div>
              <p>Deterministic agent workspace</p>
              <h1>Hivemind</h1>
            </div>
          </div>
          <form className="project-switcher" onSubmit={submitProject}>
            <label htmlFor="project-path">
              <FolderGit2 size={14} aria-hidden="true" />
              Project
            </label>
            <input
              id="project-path"
              value={projectInput}
              onChange={(event) => setProjectInput(event.target.value)}
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
                {workspace.connection?.project_root ??
                  workspace.connectionDetail ??
                  "Waiting for a project-bound daemon"}
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
            <div className="read-only-mark">
              <ShieldCheck size={14} aria-hidden="true" />
              Observation only
            </div>
          </div>

          <TabsContent value="work">
            <WorkTab
              projection={workspace.projection}
              onSelectTask={workspace.selectTaskOutput}
            />
          </TabsContent>
          <TabsContent value="swarm">
            <FutureWorkspaceTab
              icon={<Network size={28} />}
              eyebrow="Swarm"
              title="The whole team, one view"
              body="The live task view is already available in Work. The full agent tree and relationship view arrives in the dedicated Swarm unit."
            />
          </TabsContent>
          <TabsContent value="memory">
            <FutureWorkspaceTab
              icon={<BrainCircuit size={28} />}
              eyebrow="Memory"
              title="Reviewed project knowledge"
              body="Things worth remembering and pending review will live here. This shell does not add a new approval path."
            />
          </TabsContent>
          <TabsContent value="history">
            <FutureWorkspaceTab
              icon={<Clock3 size={28} />}
              eyebrow="History"
              title="Runs, evidence, and spend"
              body="Past activity remains available through the live durable trail today. A focused history browser arrives in its own unit."
            />
          </TabsContent>
        </Tabs>
      </main>
    </TooltipProvider>
  );
}

function FutureWorkspaceTab({
  icon,
  eyebrow,
  title,
  body
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <section className="future-tab">
      <div className="future-tab-rail" aria-hidden="true">
        <span>{icon}</span>
        <i />
        <CheckCircle2 size={18} />
      </div>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="future-tab-status">
          <Radio size={14} aria-hidden="true" />
          Project connection remains live while you browse
        </div>
      </div>
    </section>
  );
}

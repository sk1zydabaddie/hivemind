import { ArrowRight, FolderGit2, Loader, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { displayProjectPath } from "@/lib/project-session";

/* Nobody had walked a clean install. Before this, an unconfigured folder
   produced "Project updates stopped" — an error about a connection that had
   never been made — over an empty workspace with no way forward. */
export function SetupScreen({
  projectPath,
  connectionState,
  connectionDetail,
  onChooseProject,
  onConnectAgent,
  onInitializeProject,
  initializing
}: {
  projectPath: string;
  connectionState: string;
  connectionDetail: string;
  onChooseProject: () => void;
  onConnectAgent: () => void;
  onInitializeProject: () => void;
  initializing: boolean;
}): React.JSX.Element {
  const connecting =
    connectionState === "connecting" ||
    connectionState === "daemon started" ||
    connectionState === "daemon found";
  const visiblePath = displayProjectPath(projectPath);
  const problem = connecting ? null : plainConnectionProblem(connectionState, connectionDetail);

  return (
    <ScrollArea className="min-h-0">
      <div className="px-8 py-10">
        <div className="max-w-[680px]">
          {connecting ? (
            <p className="m-0 flex items-center gap-2 text-[14px] text-muted-foreground">
              <Loader aria-hidden="true" className="size-4 animate-spin text-navy" />
              Opening {visiblePath}…
            </p>
          ) : (
            <>
              <h2 className="m-0 text-[32px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink">
                Set up this project.
              </h2>
              <p className="mt-4 mb-0 max-w-[560px] text-[15px] leading-[1.6] text-muted-foreground">
                Hivemind builds inside one project folder, using the coding agent
                you already pay for. Three things need to be in place before the
                first run.
              </p>

              {problem === null ? null : (
                <section className="mt-7 rounded-lg border border-amber/25 bg-amber-wash px-5 py-4">
                  <strong className="block text-[14px] font-semibold text-ink">
                    {problem.title}
                  </strong>
                  <p className="mt-1 mb-0 text-[13px] leading-relaxed text-muted-foreground">
                    {problem.detail}
                  </p>
                  {problem.action === "initialize" ? (
                    <Button
                      className="mt-3"
                      disabled={initializing}
                      onClick={onInitializeProject}
                      type="button"
                    >
                      {initializing ? "Setting up…" : "Set up this folder"}
                    </Button>
                  ) : null}
                  {problem.command === null ? null : (
                    <code className="mt-3 block rounded-md bg-panel/70 px-3 py-2 font-mono text-[12px] break-all text-ink">
                      {problem.command}
                    </code>
                  )}
                  {connectionDetail === "" || problem.detail === connectionDetail ? null : (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[12px] text-muted-foreground">
                        What Hivemind reported
                      </summary>
                      <code className="mt-2 block font-mono text-[12px] break-all text-muted-foreground">
                        {connectionDetail}
                      </code>
                    </details>
                  )}
                </section>
              )}

              <ol className="mt-8 mb-0 grid list-none gap-px overflow-hidden rounded-lg border border-rule bg-rule p-0">
                <SetupStep
                  action={
                    <Button size="sm" type="button" variant="outline" onClick={onChooseProject}>
                      <FolderGit2 aria-hidden="true" />
                      {visiblePath === "." ? "Choose a folder" : "Choose another"}
                    </Button>
                  }
                  detail={
                    visiblePath === "."
                      ? "Pick the git repository you want Hivemind to work in."
                      : visiblePath
                  }
                  index={1}
                  title="Your project folder"
                />
                <SetupStep
                  action={
                    <Button size="sm" type="button" variant="outline" onClick={onConnectAgent}>
                      <Terminal aria-hidden="true" />
                      Set it up
                    </Button>
                  }
                  detail="Hivemind runs Codex on your behalf. It needs to know how to start it."
                  index={2}
                  title="Your coding agent"
                />
                <SetupStep
                  action={
                    <Button size="sm" type="button" variant="outline" onClick={onConnectAgent}>
                      <ArrowRight aria-hidden="true" />
                      Show me
                    </Button>
                  }
                  detail="Without them, every file counts as high-risk and the most expensive model runs everything."
                  index={3}
                  title="Cost defaults"
                />
              </ol>

              <p className="mt-6 mb-0 max-w-[560px] text-[13px] leading-relaxed text-muted-foreground">
                Steps 2 and 3 are files in your project. Hivemind cannot write them
                for you yet, so it hands you exactly what to paste.
              </p>
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function SetupStep({
  index,
  title,
  detail,
  action
}: {
  index: number;
  title: string;
  detail: string;
  action: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-4 bg-panel px-5 py-4">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-md bg-canvas font-mono text-[12px] text-muted-foreground"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[14px] font-medium text-ink">{title}</strong>
        <span className="mt-0.5 block text-[13px] leading-relaxed break-words text-muted-foreground">
          {detail}
        </span>
      </div>
      {action}
    </li>
  );
}

/* The shell and the daemon already say what went wrong; this only translates the
   ones a person can act on, and shows the original underneath. */
export function plainConnectionProblem(
  state: string,
  detail: string
): { title: string; detail: string; command: string | null; action?: "initialize" } | null {
  if (state === "live") return null;
  if (/not initialized for Hivemind/iu.test(detail)) {
    return {
      title: "This folder has not been set up yet",
      detail:
        "Hivemind keeps its plans, checks and history inside the project. It can create that now, along with the cost tiers and agent profiles a first run needs.",
      command: null,
      action: "initialize"
    };
  }
  if (/not a git repository|git root/iu.test(detail)) {
    return {
      title: "Hivemind works inside a git repository",
      detail:
        "It needs git to keep your work separate until you ship it. Choose a folder that is a git repository.",
      command: null
    };
  }
  if (/daemon/iu.test(detail)) {
    return {
      title: "Hivemind's local service did not start",
      detail:
        "Nothing has been changed in your project. Try opening the project again; if it keeps failing, close any other copy of Hivemind that may be running.",
      command: null
    };
  }
  if (state === "selecting project" && detail === "") {
    return {
      title: "No project is open",
      detail: "Choose the folder you want Hivemind to build in.",
      command: null
    };
  }
  if (detail === "") return null;
  return {
    title: "Hivemind could not open this project",
    detail,
    command: null
  };
}

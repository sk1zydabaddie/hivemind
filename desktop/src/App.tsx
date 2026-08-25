import { shortcutLabel } from "@/lib/plain-language";
import { Check, ChevronDown, FolderGit2, LayoutList, Library, Plug, Search, Settings, Terminal, Workflow, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import markDark from "@/assets/mark-dark.png";
import { useCallback, useEffect, useState } from "react";

import { SettingsDialog } from "@/components/settings-dialog";
import { SetupScreen } from "@/components/workspace/setup-screen";
import { SharingBar } from "@/components/workspace/sharing-bar";
import { UpdateBar } from "@/components/workspace/update-bar";
import { useAttention } from "@/hooks/use-attention";
import { WindowControls, trafficLightInset } from "@/components/window-controls";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
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
import { list } from "@/lib/durable";
import { taskPhase } from "@/lib/phases";
import { REQUIRED_ROLES } from "@/lib/providers";
import { verificationResolved, type ProjectConfigView } from "@/lib/workspace-actions";

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
  const [projectPickerBusy, setProjectPickerBusy] = useState(false);
  const [projectPickerError, setProjectPickerError] = useState("");
  /* `?section=` opens the app on a named surface. The replay harness uses it to
     photograph one, and it is the same deep-link a notification or a shortcut
     would need. Anything unrecognised falls through to the ordinary default,
     so a bad link opens the app rather than a blank tab. */
  const requestedSection = new URLSearchParams(window.location.search).get("section");
  const [section, setSection] = useState(
    requestedSection !== null && ["setup", "work", "agents", "project"].includes(requestedSection)
      ? requestedSection
      : "setup"
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* Which projects have been opened. SHELL state, kept by the Tauri side in the
     app's own config directory -- never inside a project, because putting it
     there would make one project the registry of the others, which is the
     cross-project coupling the isolation work removed. It holds paths and
     nothing else: no task, no run, no capability. Switching therefore cannot
     carry a verification across, because there is nothing here that could. */
  const [recents, setRecents] = useState<{ path: string; opened_at: string }[]>([]);
  /* The CONNECTED root, for everything that needs a live project. */
  const projectPath = workspace.connection?.project_root ?? "";
  /* And the SELECTED one, which survives a failed connection. The update bar
     needs this: a daemon left over from the previous build fails the
     connection, which emptied `projectPath`, which removed the source route --
     so the one thing that would have fixed the stale daemon was hidden by the
     stale daemon. The chain only shows up when the whole path is walked. */
  const selectedPath = workspace.projectPath;

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

  const browseForProject = async (): Promise<void> => {
    setProjectPickerBusy(true);
    setProjectPickerError("");
    try {
      const selected = await invoke<string | null>("choose_project_folder", {
        initialPath: visibleProjectPath
      });
      if (selected === null) return;
      setProjectInput(selected);
      await workspace.switchProject(selected);
      setProjectInput("");
      setProjectOpen(false);
    } catch (cause) {
      setProjectPickerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectPickerBusy(false);
    }
  };

  const visibleProjectPath = displayProjectPath(
    workspace.connection?.project_root ?? workspace.projectPath
  );
  const projectName = projectNameFromPath(visibleProjectPath);
  const recentProjects = recents.filter(
    (entry) =>
      displayProjectPath(entry.path).toLocaleLowerCase() !== visibleProjectPath.toLocaleLowerCase()
  );
  const shellUpdateRequired = workspace.connectionState === "update required";
  /* Whether the chrome's project-scoped controls can do anything yet. */
  const projectReady =
    workspace.connectionState !== "connecting" &&
    workspace.connectionState !== "daemon started" &&
    workspace.connectionState !== "daemon found";
  /* Only the daemon answering with real project state counts as live. Until
     then this is a setup problem, not an empty workspace. */
  const live = workspace.inspection !== null;

  /* Setup is not finished when the daemon answers. It is finished when there is
     an agent to run, and there is no agent until somebody connects one --
     Core deliberately writes no adapter profile, because a profile written by
     setup is a claim no probe has checked. The screen used to disappear at
     `live`, which dropped a person into a composer whose first submission
     failed on a missing file they had been told not to think about. */
  /* Stored answers name the project they were fetched for, and the rendered
     value is DERIVED -- the same shape as the settings dialog (A-08), for the
     same reason: "leave the last answer standing" is right for a failed poll
     of the SAME project and wrong across a switch, where the previous
     project's config decided `runnable` for the new one. */
  const [loadedConfig, setLoadedConfig] = useState<{
    forProject: string;
    view: ProjectConfigView;
  } | null>(null);
  const configView =
    loadedConfig !== null && loadedConfig.forProject === projectPath ? loadedConfig.view : null;
  const refreshConfig = useCallback(async (): Promise<void> => {
    if (!live) {
      return;
    }
    const requested = projectPath;
    try {
      const view = await workspace.performAction<ProjectConfigView>({
        type: "config.inspect",
        payload: {}
      });
      setLoadedConfig({ forProject: requested, view });
    } catch {
      /* Leave the last answer standing rather than claiming nothing is
         connected: a failed read is not evidence of an empty project. The
         derived read above keeps that grace within one project only. */
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
    /* Setup cannot read complete while a value integration will later
       require is absent (A-03): either a verification command exists, or the
       person has recorded that this project has no tests. Without this term,
       Work was enabled and integration rejected the project after planning
       and worker calls were paid for. */
    verificationResolved(configView.config) &&
    REQUIRED_ROLES.every((role) =>
      list(configView.adapters).some(
        (adapter) =>
          adapter.role === role.tool &&
          adapter.connected_at !== null &&
          adapter.problems.length === 0
      )
    );

  /* Leave the setup step when it stops being the thing to do -- but only move
     somebody who is still standing on it. Navigating away deliberately is not
     something completing a step should undo.

     A run in flight also ends it. A project with three agents working is not a
     project waiting to be set up, whatever the adapter records say, and landing
     on a setup checklist while work is running is the app arguing with what is
     on screen. Found by a replayed trail at peak concurrency opening on Set up. */
  const hasWork = (workspace.inspection?.tasks ?? []).length > 0;
  /* A switch resets the landing. `section` is app state and survived project
     changes, so arriving from a project that lived on Work opened the NEXT
     project on Work too -- past a setup screen that still had a question
     (A-03's ask was on screen for a cold open and invisible after a switch).
     Reset to setup and let the promotion below move it forward the moment
     the new project proves runnable or already working. Declared BEFORE the
     promotion effect deliberately: when both fire in one pass, reset must
     lose to promotion -- the reversed order netted the promotion's own dep
     values unchanged and deadlocked replayed runs on the setup screen. A
     deep link still wins, and navigation within one project is untouched. */
  useEffect(() => {
    if (requestedSection !== null) return;
    setSection("setup");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);
  useEffect(() => {
    /* An explicit `?section=` is somebody asking for that surface, so it is not
       something a default may overrule. This quietly redirected the deep link
       to Work whenever a run existed -- which meant the reachability harness
       believed it was checking the setup screen and was checking Work three
       times over. An instrument that never gets the condition cannot fail on
       it, and that is exactly how the unscrollable setup screen shipped. */
    if (requestedSection !== null) return;
    if ((runnable || hasWork) && section === "setup") setSection("work");
  }, [requestedSection, runnable, hasWork, section]);
  /* An OS notification when something stops and needs deciding, and a click
     that lands on it. Work is where every queue item is actioned, so that is
     where the click goes. */
  useAttention(workspace.inspection, () => {
    setSection("work");
  });

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
        className="brand-canvas h-screen overflow-hidden"
        value={section}
        onValueChange={setSection}
      >
        {/* Chrome, not a widget tray. It uses the first raised surface step,
            ruled off from the darker workbench below.

            It is also the window's title bar now: `decorations: false` removes
            the system caption that was painted in the system's colour above a
            dark app, and this row runs to the window edge instead.

            `data-tauri-drag-region` is bare rather than "deep" ON PURPOSE. Bare
            means only direct clicks on the header itself begin a drag, so every
            child -- tabs, buttons, the project switcher -- is untouched. Tauri's
            own rule already excludes clickable elements and `role="tab"`, and
            this is the second half of the same guarantee: dragging cannot
            activate a tab because a tab is not this element, and clicking a tab
            cannot drag because a tab is clickable. Double-click to maximise
            comes from the same script.

            The left inset is macOS only: its traffic lights are drawn by the
            system over our content, at the top left, so the brand mark starts
            to their right. Windows and Linux put the controls on the right,
            where this app renders them. */}
        <header
          className={`flex h-11 shrink-0 items-stretch gap-4 border-b border-rule bg-panel shadow-[var(--glass-edge-far)] pr-2.5 ${
            trafficLightInset() ? "pl-[78px]" : "pl-3"
          }`}
          data-tauri-drag-region
        >
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
                <span className="ml-0.5 font-mono text-[11px]">
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Switch project, currently ${projectName}`}
                  className="max-w-[280px]"
                  size="sm"
                  title={visibleProjectPath}
                  type="button"
                  variant="ghost"
                >
                  <FolderGit2 aria-hidden="true" />
                  <span className="font-mono text-[12px] text-ink">{projectName}</span>
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[360px]">
                <DropdownMenuLabel>Projects</DropdownMenuLabel>
                {selectedPath === "" ? null : (
                  <div
                    aria-label="Current project"
                    className="flex items-start gap-2 px-2.5 py-2 text-[13px]"
                  >
                    <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-navy" />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{projectName}</span>
                      <span className="block break-all font-mono text-[11px] text-muted-foreground">
                        {visibleProjectPath}
                      </span>
                    </span>
                  </div>
                )}
                {recentProjects.length === 0 ? null : (
                  <>
                    <DropdownMenuSeparator />
                    {recentProjects.map((entry) => (
                      /* The row opens; the X only removes the ENTRY. Deleting
                         nothing of the person's own is the whole point, so the
                         label says which of the two things it does rather than
                         leaving "remove" to be guessed at. */
                      <div className="flex items-stretch gap-1" key={entry.path}>
                        <DropdownMenuItem
                          className="min-w-0 flex-1"
                          onSelect={() => void workspace.switchProject(entry.path)}
                        >
                          <FolderGit2 aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block font-medium text-ink">
                              {projectNameFromPath(entry.path)}
                            </span>
                            <span className="block break-all font-mono text-[11px] text-muted-foreground">
                              {displayProjectPath(entry.path)}
                            </span>
                          </span>
                        </DropdownMenuItem>
                        <Button
                          aria-label={`Remove ${projectNameFromPath(entry.path)} from this list`}
                          className="self-center"
                          size="icon-xs"
                          title="Remove from this list. The folder and its history are not touched."
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void invoke("forget_project", { projectPath: entry.path })
                              .then(() => invoke<{ path: string; opened_at: string }[]>("recent_projects"))
                              .then(setRecents)
                              .catch(() => undefined);
                          }}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                    <p className="m-0 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      Removing an entry forgets the folder here only. Nothing in
                      it is deleted — its plans, history and settings stay where
                      they are, and opening it again brings it back.
                    </p>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setProjectOpen(true)}>
                  <FolderGit2 aria-hidden="true" />
                  Open another project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* The palette exists; nothing on screen said so. A keycap in the
                chrome is the cheapest way to teach a shortcut. */}
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Both of these act on a project, so neither is offered
                    before one is open. They used to be pressable over an empty
                    window reading "Opening C:\…", where the palette listed
                    sections that were not there and Settings had nothing to
                    show. A control that cannot do anything yet says so. */}
                <Button
                  aria-label="Commands"
                  disabled={!projectReady}
                  size="sm"
                  title={projectReady ? "Commands" : "Opens once the project is open"}
                  type="button"
                  variant="ghost"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Search aria-hidden="true" />
                  {/* `inline-flex` with its own line-height and a fixed
                      height: as a bare inline `kbd` inside a flex button it was
                      stretched to the button's cross-axis, which distorted the
                      glyph and the K rather than fitting them in a box. */}
                  <kbd className="inline-flex h-[18px] shrink-0 items-center rounded-sm border border-rule px-1 font-mono text-[11px] leading-none text-muted-foreground">
                    {shortcutLabel("K")}
                  </kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Commands</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Settings"
                  disabled={!projectReady}
                  size="icon-sm"
                  title={projectReady ? "Settings" : "Opens once the project is open"}
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
          <WindowControls />
        </header>

        {/* The build bar was a second answer to the one question the update bar
            asks. "Your checkout is ahead" and "a release is available" are both
            "a newer version exists", and a person should never have to know
            which mechanism produced the answer -- `newer_version` picks the
            source and `UpdateBar` renders one line. */}
        {/* Above the sharing bar: a stale build is the thing that makes every
            other message on screen untrustworthy. Not gated on `live` -- an
            update matters whether or not a project is open, and the endpoint
            being unreachable is exactly the state that must not be silent. */}
        <UpdateBar projectPath={selectedPath} />
        {live ? <SharingBar onAction={workspace.performAction} /> : null}

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
            actionError={workspace.actionError}
            gitReadiness={workspace.gitReadiness}
            gitSetupFailure={workspace.gitSetupFailure}
            gitSetupDone={workspace.gitSetupDone}
            initializing={workspace.initializing}
            live={false}
            projectPath={visibleProjectPath}
            view={null}
            onAction={workspace.performAction}
            onChooseProject={() => setProjectOpen(true)}
            onInitializeGit={() => void workspace.initializeGit()}
            onInitializeProject={() => void workspace.initializeProject()}
            onRestartDaemon={() => void workspace.restartDaemon()}
            onReload={refreshConfig}
            /* The last screen of onboarding used to have no way forward: with
               every step checked, the connect step hid its own Continue button
               and nothing else offered an exit. Auto-promotion covers the case
               where `runnable` is true, but when a step LOOKS done and runnable
               is false the screen simply stood still. Both get an answer now:
               a button when it can be taken, and a reason when it cannot. */
            runnable={runnable}
            onStartWorking={() => setSection("work")}
          />
        )}

        {live ? (
        <>
        <TabsContent className="flex min-h-0 flex-col" value="setup">
          <SetupScreen
            connectionCode={workspace.connectionCode}
            connectionDetail={workspace.connectionDetail}
            connectionState={workspace.connectionState}
            actionError={workspace.actionError}
            gitReadiness={workspace.gitReadiness}
            gitSetupFailure={workspace.gitSetupFailure}
            gitSetupDone={workspace.gitSetupDone}
            initializing={workspace.initializing}
            live
            projectPath={visibleProjectPath}
            view={configView}
            onAction={workspace.performAction}
            onChooseProject={() => setProjectOpen(true)}
            onInitializeGit={() => void workspace.initializeGit()}
            onInitializeProject={() => void workspace.initializeProject()}
            onRestartDaemon={() => void workspace.restartDaemon()}
            onReload={refreshConfig}
            /* The last screen of onboarding used to have no way forward: with
               every step checked, the connect step hid its own Continue button
               and nothing else offered an exit. Auto-promotion covers the case
               where `runnable` is true, but when a step LOOKS done and runnable
               is false the screen simply stood still. Both get an answer now:
               a button when it can be taken, and a reason when it cannot. */
            runnable={runnable}
            onStartWorking={() => setSection("work")}
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
            draftStream={workspace.draftStream}
            inspection={workspace.inspection}
            projectRoot={workspace.connection?.project_root ?? workspace.projectPath}
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
            <div className="grid gap-2">
              <Button
                disabled={projectPickerBusy}
                type="button"
                variant="outline"
                onClick={() => void browseForProject()}
              >
                <FolderGit2 aria-hidden="true" />
                {projectPickerBusy ? "Opening folders…" : "Browse folders"}
              </Button>
              <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
                Choose with your computer's folder browser, or enter the full path below.
              </p>
            </div>
            {projectPickerError === "" ? null : (
              <p
                className="m-0 rounded-md border border-clay/25 border-l-2 border-l-clay bg-clay-wash px-3 py-2 text-[12px] break-words text-clay"
                role="status"
              >
                {projectPickerError}
              </p>
            )}
            <label className="grid gap-1.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
              Or enter the project folder
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

/* The real dark-surface brand asset, not a CSS approximation. The application
 * now owns a dark visual skin regardless of the OS colour preference, so the
 * mark follows the app surface rather than an unrelated system setting. */
function BrandMark(): React.JSX.Element {
  return (
    <img
      alt=""
      className="block size-[19px] shrink-0 select-none"
      draggable={false}
      height={19}
      src={markDark}
      width={19}
    />
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
  /* One event, one word. The chrome said "Connecting" while the body underneath
     said "Opening <path>…" -- two vocabularies for the same moment, which reads
     as two things happening. The body's word wins because it is the one with
     the project name next to it. */
  const shown =
    state === "connecting" || state === "daemon started" || state === "daemon found"
      ? "opening"
      : state;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-live="polite"
          className="flex cursor-default items-center gap-1.5 px-1 text-[12px] text-muted-foreground"
        >
          <span aria-hidden="true" className={`size-1.5 rounded-xs ${dot}`} />
          <span className="font-medium text-ink first-letter:uppercase">{shown}</span>
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

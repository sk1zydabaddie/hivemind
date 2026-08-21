import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyEventMessage,
  applyOutputMessage,
  createBoardProjection,
  selectTask,
  taskRows,
  type BoardProjection,
  type EventMessage,
  type OutputMessage
} from "../lib/projection";
import {
  createProjectSession,
  createProjectStreamGuard,
  actionErrorAfterDurableProgress,
  PROJECT_FAULT,
  projectFaultFrom,
  validateProjectConnection,
  type GitReadiness,
  type ProjectConnection
} from "../lib/project-session";
import {
  invokeWorkspaceAction,
  type WorkspaceAction,
  type WorkspaceInspection
} from "../lib/workspace-actions";

interface WorkspaceView {
  projection: BoardProjection;
  projectPath: string;
  connection: ProjectConnection | null;
  connectionState: string;
  /** Why, as a code. The interface branches on this, never on the message. */
  connectionCode: string;
  connectionDetail: string;
  inspection: WorkspaceInspection | null;
  actionError: string;
  gitReadiness: GitReadiness | null;
  switchProject: (projectPath: string) => Promise<void>;
  initializeProject: () => Promise<void>;
  initializeGit: () => Promise<void>;
  restartDaemon: () => Promise<void>;
  initializing: boolean;
  selectTaskOutput: (taskId: string) => void;
  performAction: <T>(action: WorkspaceAction) => Promise<T>;
}

export function useWorkspace(): WorkspaceView {
  /* What to open before anybody has chosen anything.
   *
   * This used to be `"."`. For an installed app that is the process working
   * directory, which the Start menu shortcut sets to the INSTALLATION
   * directory -- so a brand-new install's first act was to try to open
   * Hivemind itself as a project, fail, and present the failure as though the
   * person had chosen badly.
   *
   * Now: an explicit `?project=` wins (the replay harness and any deep link),
   * then the most recently opened project, and otherwise NOTHING. A first run
   * shows a chooser rather than the wreckage of an attempt nobody asked for. */
  const requestedPath = new URLSearchParams(window.location.search).get("project");
  const [projectPath, setProjectPath] = useState(requestedPath ?? "");
  const [connection, setConnection] = useState<ProjectConnection | null>(null);
  const [connectionState, setConnectionState] = useState("selecting project");
  const [connectionCode, setConnectionCode] = useState<string>(
    PROJECT_FAULT.noProjectSelected
  );
  const [connectionDetail, setConnectionDetail] = useState("");
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [actionError, setActionError] = useState("");
  const actionErrorRef = useRef("");
  const [gitReadiness, setGitReadiness] = useState<GitReadiness | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [revision, setRevision] = useState(0);
  const projectionRef = useRef(createBoardProjection());
  const eventSourceRef = useRef<EventSource | null>(null);
  const outputSourceRef = useRef<EventSource | null>(null);
  const streamGuardRef = useRef(createProjectStreamGuard());
  const connectionRef = useRef<ProjectConnection | null>(null);
  const inspectionTimerRef = useRef<number | null>(null);
  const inspectionPollRef = useRef<number | null>(null);
  const inspectionInFlightRef = useRef(false);
  const renderFrameRef = useRef<number | null>(null);

  const closeStreams = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    outputSourceRef.current?.close();
    outputSourceRef.current = null;
    if (inspectionPollRef.current !== null) {
      window.clearInterval(inspectionPollRef.current);
      inspectionPollRef.current = null;
    }
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  }, []);

  const render = useCallback(() => {
    /* Opening a project replays its durable event history as fast as the
       loopback stream can deliver it. Rendering once per historical record
       eventually trips React's nested-update guard on a completed real run.
       The projection still applies every event synchronously; only paint is
       coalesced to one update per frame, so the next paint is the full state. */
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      setRevision((value) => value + 1);
    });
  }, []);

  const recordActionError = useCallback((next: string) => {
    /* History and output streams replay hundreds or thousands of records on
       open. Most arrive while there is no transport error to clear. Dispatching
       the same empty state for every record filled React's nested update queue;
       the next Radix animation event was merely where React detected it. */
    if (actionErrorRef.current === next) return;
    actionErrorRef.current = next;
    setActionError(next);
  }, []);

  const clearTransportErrorAfterProgress = useCallback(() => {
    recordActionError(actionErrorAfterDurableProgress(actionErrorRef.current));
  }, [recordActionError]);

  const refreshInspection = useCallback(async () => {
    const currentConnection = connectionRef.current;
    if (!currentConnection || inspectionInFlightRef.current) return;
    inspectionInFlightRef.current = true;
    const isCurrentProject = streamGuardRef.current.capture();
    try {
      const value = await invokeWorkspaceAction<WorkspaceInspection>(
        currentConnection.project_root,
        { type: "status.inspect", payload: {} }
      );
      if (isCurrentProject()) {
        setInspection(value);
        recordActionError("");
      }
    } catch (error) {
      if (isCurrentProject()) {
        recordActionError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      inspectionInFlightRef.current = false;
    }
  }, [recordActionError]);

  const scheduleInspection = useCallback(() => {
    if (inspectionTimerRef.current !== null) {
      window.clearTimeout(inspectionTimerRef.current);
    }
    inspectionTimerRef.current = window.setTimeout(() => {
      inspectionTimerRef.current = null;
      void refreshInspection();
    }, 80);
  }, [refreshInspection]);

  const openOutputStream = useCallback(
    (taskId: string) => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) {
        return;
      }
      outputSourceRef.current?.close();
      outputSourceRef.current = null;
      selectTask(projectionRef.current, taskId);
      const isCurrentProject = streamGuardRef.current.capture();
      const source = new EventSource(
        `${currentConnection.daemon_url}/tasks/${encodeURIComponent(taskId)}/output/stream`
      );
      outputSourceRef.current = source;
      source.onmessage = (event) => {
        if (!isCurrentProject()) {
          return;
        }
        const message = parseMessage<OutputMessage>(event.data);
        if (message) {
          clearTransportErrorAfterProgress();
          applyOutputMessage(projectionRef.current, message);
          render();
        }
      };
      render();
    },
    [clearTransportErrorAfterProgress, render]
  );

  const connectEventStream = useCallback(
    (nextConnection: ProjectConnection) => {
      const isCurrentProject = streamGuardRef.current.capture();
      setConnectionState("connecting");
      const source = new EventSource(
        `${nextConnection.daemon_url}/events/stream`
      );
      eventSourceRef.current = source;
      source.onopen = () => {
        if (isCurrentProject()) {
          clearTransportErrorAfterProgress();
          setConnectionState("live");
          void refreshInspection();
          if (inspectionPollRef.current !== null) window.clearInterval(inspectionPollRef.current);
          inspectionPollRef.current = window.setInterval(() => void refreshInspection(), 5_000);
        }
      };
      source.onerror = () => {
        if (isCurrentProject()) {
          setConnectionState("connection interrupted");
        }
      };
      source.onmessage = (event) => {
        if (!isCurrentProject()) {
          return;
        }
        const message = parseMessage<EventMessage>(event.data);
        if (!message) {
          return;
        }
        clearTransportErrorAfterProgress();
        applyEventMessage(projectionRef.current, message);
        scheduleInspection();
        if (
          projectionRef.current.selectedTaskId === null &&
          outputSourceRef.current === null
        ) {
          const candidate =
            taskRows(projectionRef.current).find(
              (task) => task.state === "running"
            ) ?? taskRows(projectionRef.current)[0];
          if (candidate) {
            openOutputStream(candidate.task_id);
          }
        }
        render();
      };
      render();
    },
    [clearTransportErrorAfterProgress, openOutputStream, refreshInspection, render, scheduleInspection]
  );

  /* Set while a recovery is in flight, so a mismatch reported again by the
     re-open cannot start a second one. */
  const recoveringRef = useRef(false);
  const sessionRef = useRef<{ adopt: (connection: ProjectConnection) => void } | null>(null);

  const recoverFromBuildMismatch = useCallback(async (): Promise<void> => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    try {
      const standing = await invoke<{ work: string; detail: string }>(
        "inspect_daemon_work",
        { projectPath: connectionRef.current?.project_root ?? projectPath }
      );
      /* Only `idle` is provable. `unknown` is deliberately not treated as safe:
         the reason the daemon outlives the app is to avoid orphaning workers,
         and a guess in this direction abandons somebody's run. */
      if (standing.work !== "idle") return;
      const next = validateProjectConnection(
        await invoke("restart_daemon", {
          projectPath: connectionRef.current?.project_root ?? projectPath
        })
      );
      sessionRef.current?.adopt(next);
    } catch {
      /* The button in the setup screen is the fallback, and the message
         already on screen is the one to keep. */
    } finally {
      recoveringRef.current = false;
    }
  }, [projectPath]);

  const session = useMemo(
    () =>
      createProjectSession({
        selectProject: (selectedPath) =>
          invoke("select_project", { projectPath: selectedPath }),
        initializeProject: (selectedPath) =>
          invoke("initialize_project", { projectPath: selectedPath }),
        onSwitchStart: () => {
          streamGuardRef.current.advance();
          closeStreams();
          connectionRef.current = null;
          setConnection(null);
          setInspection(null);
          recordActionError("");
          setGitReadiness(null);
          projectionRef.current = createBoardProjection();
          setConnectionState("selecting project");
          setConnectionCode(PROJECT_FAULT.noProjectSelected);
          setConnectionDetail("");
          render();
        },
        onConnected: (nextConnection) => {
          connectionRef.current = nextConnection;
          setConnection(nextConnection);
          setProjectPath(nextConnection.project_root);
          setConnectionState(
            nextConnection.status === "started"
              ? "daemon started"
              : "daemon found"
          );
          setConnectionDetail(nextConnection.project_root);
          setConnectionCode("");
          connectEventStream(nextConnection);
        },
        /* The code decides; the message is only ever shown. This used to test
           the message text for "desktop shell build mismatch", which is the
           same rule being broken one line above where it was broken again. */
        onError: (fault) => {
          setConnectionState(
            fault.code === PROJECT_FAULT.desktopUpdateRequired
              ? "update required"
              : "connection error"
          );
          setConnectionCode(fault.code);
          setConnectionDetail(fault.message);
          render();
          /* A build mismatch after an update is recoverable, and asking a
             person to press a button about it is asking them a question the
             machine can answer. The Rust side only restarts when it can PROVE
             nothing is in flight — reading the resource ledger and the worktree
             directory off disk — and refuses otherwise, so this cannot orphan a
             worker. If it refuses, its reason replaces this one and the button
             is still there. */
          if (fault.code === PROJECT_FAULT.daemonBuildMismatch) {
            void recoverFromBuildMismatch();
          }
        }
      }),
    [closeStreams, connectEventStream, recordActionError, render]
  );

  sessionRef.current = session;

  const switchProject = useCallback(
    async (selectedPath: string) => {
      setProjectPath(selectedPath);
      await session.switchProject(selectedPath);
    },
    [session]
  );

  const initializeProject = useCallback(async () => {
    setInitializing(true);
    try {
      await session.initializeProject(projectPath);
    } finally {
      setInitializing(false);
    }
  }, [session, projectPath]);

  /* Start tracking an untracked folder, then re-open it.
     Two separate steps on purpose: git init can succeed where Hivemind setup
     would still refuse, and vice versa, so collapsing them would report one
     failure as the other. The re-open is what turns the new repository into a
     live connection -- nothing here assumes it worked. */
  /**
   * Stop the previous version's daemon and open the project on the matching one.
   *
   * The Rust side refuses unless it can PROVE nothing is in flight, reading the
   * resource ledger and the worktree directory off disk rather than asking the
   * old daemon about itself — the old daemon being the thing under suspicion.
   */
  const restartDaemon = useCallback(async () => {
    setInitializing(true);
    try {
      const next = validateProjectConnection(
        await invoke("restart_daemon", { projectPath })
      );
      session.adopt(next);
    } catch (error) {
      const fault = projectFaultFrom(error);
      setConnectionState("connection error");
      setConnectionCode(fault.code);
      setConnectionDetail(fault.message);
      render();
    } finally {
      setInitializing(false);
    }
  }, [projectPath, render, session]);

  /* A daemon left over from the previous build is a CONSEQUENCE of updating,
     never a decision. It used to be a box on the first screen explaining that
     "the background process from the previous version is still running" -- to
     somebody who had not asked for a background process and could not act on
     one. If the project is provably idle the restart happens without asking;
     the button remains only for the case where it could not.

     Guarded against looping: one automatic attempt per project per mount. A
     restart that fails leaves the explanation and the button, which is the
     honest end of the automatic path rather than a retry storm. */
  const autoRestarted = useRef<string | null>(null);
  useEffect(() => {
    if (connectionCode !== PROJECT_FAULT.daemonBuildMismatch) return;
    if (projectPath === "" || autoRestarted.current === projectPath) return;
    autoRestarted.current = projectPath;
    void (async () => {
      try {
        const standing = await invoke<{ work: string }>("inspect_daemon_work", { projectPath });
        /* Anything but idle is left alone and left visible -- restarting into a
           run in flight is the one thing this must never do. */
        if (standing.work !== "idle") return;
      } catch {
        /* Cannot tell, so do not act. The button stays. */
        return;
      }
      await restartDaemon();
    })();
  }, [connectionCode, projectPath, restartDaemon]);

  const initializeGit = useCallback(async () => {
    setInitializing(true);
    recordActionError("");
    try {
      await invoke("initialize_git", { projectPath });
      await session.switchProject(projectPath);
    } catch (error) {
      recordActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitializing(false);
    }
  }, [recordActionError, session, projectPath]);

  /* The shell owns this decision. React only asks for and renders its answer.
     Without this call, the setup screen offered an action that the shell was
     guaranteed to refuse for folders containing dependencies, build output,
     or likely secrets -- and the rejection then disappeared. */
  useEffect(() => {
    if (connectionCode !== PROJECT_FAULT.notAGitRepository || projectPath === "") {
      setGitReadiness(null);
      return undefined;
    }
    let abandoned = false;
    setGitReadiness(null);
    void invoke<GitReadiness>("inspect_git_readiness", { projectPath })
      .then((readiness) => {
        if (!abandoned) setGitReadiness(readiness);
      })
      .catch((error) => {
        if (!abandoned) {
          recordActionError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      abandoned = true;
    };
  }, [connectionCode, projectPath, recordActionError]);

  useEffect(() => {
    let abandoned = false;
    /* `setProjectPath` before connecting, on BOTH launch routes.
       `session.switchProject` opens the project; the hook's wrapper is what
       records WHICH project was selected, and the launch path called the
       session directly -- so on a failed connection the app knew it had a
       connection error and no longer knew what it had tried to open. That
       emptied the path the update bar needs, and the commonest failure here is
       a daemon left by the previous build: the stale build hid the one control
       that replaces it. */
    const openSomething = async (): Promise<void> => {
      if (requestedPath !== null && requestedPath.trim() !== "") {
        setProjectPath(requestedPath);
        await session.switchProject(requestedPath);
        return;
      }
      /* Outside the shell (the replay harness) this rejects, which is the same
         answer as an empty list: open nothing and show the chooser. */
      const recents = await invoke<{ path: string }[]>("recent_projects").catch(
        () => [] as { path: string }[]
      );
      if (abandoned) return;
      const mostRecent = recents[0]?.path;
      if (mostRecent === undefined || mostRecent.trim() === "") return;
      setProjectPath(mostRecent);
      await session.switchProject(mostRecent);
    };
    void openSomething();
    return () => {
      abandoned = true;
      closeStreams();
      if (inspectionTimerRef.current !== null) {
        window.clearTimeout(inspectionTimerRef.current);
      }
    };
  }, [closeStreams, requestedPath, session]);

  const performAction = useCallback(
    async <T,>(action: WorkspaceAction): Promise<T> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) {
        throw new Error("Connect to a project before taking an action.");
      }
      recordActionError("");
      try {
        const result = await invokeWorkspaceAction<T>(
          currentConnection.project_root,
          action
        );
        await refreshInspection();
        return result;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        recordActionError(normalized.message);
        await refreshInspection().catch(() => undefined);
        throw normalized;
      }
    },
    [recordActionError, refreshInspection]
  );

  return {
    projection: projectionRef.current,
    projectPath,
    connection,
    connectionState,
    connectionCode,
    connectionDetail,
    inspection,
    actionError,
    gitReadiness,
    switchProject,
    initializeProject,
    initializeGit,
    restartDaemon,
    initializing,
    selectTaskOutput: openOutputStream,
    performAction
  };
}

function parseMessage<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

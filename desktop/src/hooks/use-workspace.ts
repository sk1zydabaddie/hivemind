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
  connectionDetail: string;
  inspection: WorkspaceInspection | null;
  actionError: string;
  switchProject: (projectPath: string) => Promise<void>;
  initializeProject: () => Promise<void>;
  initializeGit: () => Promise<void>;
  initializing: boolean;
  selectTaskOutput: (taskId: string) => void;
  performAction: <T>(action: WorkspaceAction) => Promise<T>;
}

export function useWorkspace(): WorkspaceView {
  const initialPath =
    new URLSearchParams(window.location.search).get("project") ?? ".";
  const [projectPath, setProjectPath] = useState(initialPath);
  const [connection, setConnection] = useState<ProjectConnection | null>(null);
  const [connectionState, setConnectionState] = useState("selecting project");
  const [connectionDetail, setConnectionDetail] = useState("");
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [actionError, setActionError] = useState("");
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

  const closeStreams = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    outputSourceRef.current?.close();
    outputSourceRef.current = null;
    if (inspectionPollRef.current !== null) {
      window.clearInterval(inspectionPollRef.current);
      inspectionPollRef.current = null;
    }
  }, []);

  const render = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

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
        setActionError("");
      }
    } catch (error) {
      if (isCurrentProject()) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      inspectionInFlightRef.current = false;
    }
  }, []);

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
          setActionError(actionErrorAfterDurableProgress);
          applyOutputMessage(projectionRef.current, message);
          render();
        }
      };
      render();
    },
    [render]
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
          setActionError(actionErrorAfterDurableProgress);
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
        setActionError(actionErrorAfterDurableProgress);
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
    [openOutputStream, refreshInspection, render, scheduleInspection]
  );

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
          setActionError("");
          projectionRef.current = createBoardProjection();
          setConnectionState("selecting project");
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
          connectEventStream(nextConnection);
        },
        onError: (error) => {
          setConnectionState(
            /desktop shell build mismatch|Desktop update required/iu.test(error.message)
              ? "update required"
              : "connection error"
          );
          setConnectionDetail(error.message);
          render();
        }
      }),
    [closeStreams, connectEventStream, render]
  );

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
  const initializeGit = useCallback(async () => {
    setInitializing(true);
    try {
      await invoke("initialize_git", { projectPath });
      await session.switchProject(projectPath);
    } finally {
      setInitializing(false);
    }
  }, [session, projectPath]);

  useEffect(() => {
    void session.switchProject(initialPath);
    return () => {
      closeStreams();
      if (inspectionTimerRef.current !== null) {
        window.clearTimeout(inspectionTimerRef.current);
      }
    };
  }, [closeStreams, initialPath, session]);

  const performAction = useCallback(
    async <T,>(action: WorkspaceAction): Promise<T> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) {
        throw new Error("Connect to a project before taking an action.");
      }
      setActionError("");
      try {
        const result = await invokeWorkspaceAction<T>(
          currentConnection.project_root,
          action
        );
        await refreshInspection();
        return result;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        setActionError(normalized.message);
        await refreshInspection().catch(() => undefined);
        throw normalized;
      }
    },
    [refreshInspection]
  );

  return {
    projection: projectionRef.current,
    projectPath,
    connection,
    connectionState,
    connectionDetail,
    inspection,
    actionError,
    switchProject,
    initializeProject,
    initializeGit,
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

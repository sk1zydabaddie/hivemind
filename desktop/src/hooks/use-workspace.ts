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
  type ProjectConnection
} from "../lib/project-session";

interface WorkspaceView {
  projection: BoardProjection;
  projectPath: string;
  connection: ProjectConnection | null;
  connectionState: string;
  connectionDetail: string;
  switchProject: (projectPath: string) => Promise<void>;
  selectTaskOutput: (taskId: string) => void;
}

export function useWorkspace(): WorkspaceView {
  const initialPath =
    new URLSearchParams(window.location.search).get("project") ?? ".";
  const [projectPath, setProjectPath] = useState(initialPath);
  const [connection, setConnection] = useState<ProjectConnection | null>(null);
  const [connectionState, setConnectionState] = useState("selecting project");
  const [connectionDetail, setConnectionDetail] = useState("");
  const [revision, setRevision] = useState(0);
  const projectionRef = useRef(createBoardProjection());
  const eventSourceRef = useRef<EventSource | null>(null);
  const outputSourceRef = useRef<EventSource | null>(null);
  const streamGuardRef = useRef(createProjectStreamGuard());
  const connectionRef = useRef<ProjectConnection | null>(null);

  const closeStreams = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    outputSourceRef.current?.close();
    outputSourceRef.current = null;
  }, []);

  const render = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

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
          setConnectionState("live");
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
        applyEventMessage(projectionRef.current, message);
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
    [openOutputStream, render]
  );

  const session = useMemo(
    () =>
      createProjectSession({
        selectProject: (selectedPath) =>
          invoke("select_project", { projectPath: selectedPath }),
        onSwitchStart: () => {
          streamGuardRef.current.advance();
          closeStreams();
          connectionRef.current = null;
          setConnection(null);
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
          setConnectionState("connection error");
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

  useEffect(() => {
    void session.switchProject(initialPath);
    return closeStreams;
  }, [closeStreams, initialPath, session]);

  return {
    projection: projectionRef.current,
    projectPath,
    connection,
    connectionState,
    connectionDetail,
    switchProject,
    selectTaskOutput: openOutputStream
  };
}

function parseMessage<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export interface ProjectConnection {
  project_root: string;
  daemon_url: string;
  status: "attached" | "started";
}

interface ProjectSessionOptions {
  selectProject: (projectPath: string) => Promise<unknown>;
  onSwitchStart: () => void;
  onConnected: (connection: ProjectConnection) => void;
  onError: (error: Error) => void;
}

export function createProjectSession({
  selectProject,
  onSwitchStart,
  onConnected,
  onError
}: ProjectSessionOptions): {
  switchProject: (
    projectPath: string
  ) => Promise<
    | { ok: true; value: ProjectConnection }
    | { ok: false; reason?: string; stale?: true }
  >;
} {
  let generation = 0;

  return {
    async switchProject(projectPath) {
      const selectedPath = String(projectPath ?? "").trim();
      const currentGeneration = ++generation;
      onSwitchStart();
      if (selectedPath === "") {
        const error = new Error("Select a project directory.");
        onError(error);
        return { ok: false, reason: error.message };
      }

      let connection: ProjectConnection;
      try {
        connection = validateProjectConnection(
          await selectProject(selectedPath)
        );
      } catch (error) {
        if (currentGeneration !== generation) {
          return { ok: false, stale: true };
        }
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        onError(normalized);
        return { ok: false, reason: normalized.message };
      }
      if (currentGeneration !== generation) {
        return { ok: false, stale: true };
      }
      onConnected(connection);
      return { ok: true, value: connection };
    }
  };
}

export function createProjectStreamGuard(): {
  advance: () => void;
  capture: () => () => boolean;
} {
  let generation = 0;
  return {
    advance() {
      generation += 1;
    },
    capture() {
      const captured = generation;
      return () => captured === generation;
    }
  };
}

export function validateProjectConnection(value: unknown): ProjectConnection {
  if (!value || typeof value !== "object") {
    throw new Error("The desktop shell returned an invalid project connection.");
  }
  const record = value as Record<string, unknown>;
  const projectRoot =
    typeof record.project_root === "string"
      ? record.project_root.trim()
      : "";
  const daemonUrl =
    typeof record.daemon_url === "string"
      ? record.daemon_url.trim().replace(/\/+$/u, "")
      : "";
  const status =
    record.status === "attached" || record.status === "started"
      ? record.status
      : "";
  if (projectRoot === "" || daemonUrl === "" || status === "") {
    throw new Error("The desktop shell returned an incomplete project connection.");
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(daemonUrl)) {
    throw new Error("The desktop shell returned a non-loopback daemon URL.");
  }
  return {
    project_root: projectRoot,
    daemon_url: daemonUrl,
    status
  };
}

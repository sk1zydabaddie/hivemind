export interface ProjectConnection {
  project_root: string;
  daemon_url: string;
  build_id: string;
  shell_build_id: string;
  expected_shell_build_id: string;
  status: "attached" | "started";
}

interface ProjectSessionOptions {
  selectProject: (projectPath: string) => Promise<unknown>;
  /* Sets a folder up and opens it. Same flow as selecting one; only the shell
     command differs, so the two share every generation and error rule. */
  initializeProject: (projectPath: string) => Promise<unknown>;
  onSwitchStart: () => void;
  onConnected: (connection: ProjectConnection) => void;
  onError: (error: Error) => void;
}

type OpenResult =
  | { ok: true; value: ProjectConnection }
  | { ok: false; reason?: string; stale?: true };

export function createProjectSession({
  selectProject,
  initializeProject,
  onSwitchStart,
  onConnected,
  onError
}: ProjectSessionOptions): {
  switchProject: (projectPath: string) => Promise<OpenResult>;
  initializeProject: (projectPath: string) => Promise<OpenResult>;
} {
  let generation = 0;

  async function open(
    projectPath: string,
    invokeShell: (path: string) => Promise<unknown>
  ): Promise<OpenResult> {
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
        connection = validateProjectConnection(await invokeShell(selectedPath));
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

  return {
    switchProject: (projectPath) => open(projectPath, selectProject),
    initializeProject: (projectPath) => open(projectPath, initializeProject)
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
  const buildId = typeof record.build_id === "string" ? record.build_id.trim() : "";
  const shellBuildId = typeof record.shell_build_id === "string" ? record.shell_build_id.trim() : "";
  const expectedShellBuildId = typeof record.expected_shell_build_id === "string" ? record.expected_shell_build_id.trim() : "";
  if (
    projectRoot === "" ||
    daemonUrl === "" ||
    status === "" ||
    !/^[a-f0-9]{64}$/u.test(buildId) ||
    !/^[a-f0-9]{64}$/u.test(shellBuildId) ||
    !/^[a-f0-9]{64}$/u.test(expectedShellBuildId)
  ) {
    throw new Error("The desktop shell returned an incomplete project connection.");
  }
  if (shellBuildId !== expectedShellBuildId) {
    throw new Error("Desktop update required: the running shell does not match Hivemind Core. Rebuild and restart the app before using project controls.");
  }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(daemonUrl)) {
    throw new Error("The desktop shell returned a non-loopback daemon URL.");
  }
  return {
    project_root: projectRoot,
    daemon_url: daemonUrl,
    build_id: buildId,
    shell_build_id: shellBuildId,
    expected_shell_build_id: expectedShellBuildId,
    status
  };
}

export function displayProjectPath(projectPath: string): string {
  const value = String(projectPath ?? "").trim();
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice(8)}`;
  }
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

export function projectNameFromPath(projectPath: string): string {
  const visible = displayProjectPath(projectPath).replace(/[\\/]+$/u, "");
  if (visible === "" || visible === ".") {
    return "Select a project";
  }
  const parts = visible.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? visible;
}

export function actionErrorAfterDurableProgress(current: string): string {
  return /daemon action response failed|connection attempt failed|failed to fetch|headers timeout|timed out connecting/iu.test(current)
    ? ""
    : current;
}

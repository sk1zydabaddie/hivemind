export interface ProjectConnection {
  project_root: string;
  daemon_url: string;
  build_id: string;
  shell_build_id: string;
  expected_shell_build_id: string;
  status: "attached" | "started";
}

/** The shell's read-only answer about whether it is safe to create a first commit. */
export interface GitReadiness {
  is_repo: boolean;
  starts_empty: boolean;
  would_commit: string[];
  would_ignore: string[];
  refusal: string | null;
}

/**
 * Why opening a project failed, as a code rather than as a sentence.
 *
 * These are the shell's codes, assigned in `project.rs` where each failure is
 * created. Nothing in the interface may branch on `message` -- that is the rule
 * this exists to enforce, and the fourth violation of it is the reason it now
 * exists. Reading a message and deciding what to offer put an unreachable
 * button in front of the most ordinary first-run case there is for as long as
 * that button had existed.
 */
export const PROJECT_FAULT = {
  notAGitRepository: "not_a_git_repository",
  noProjectSelected: "no_project_selected",
  notInitialized: "not_initialized_for_hivemind",
  desktopUpdateRequired: "desktop_update_required",
  daemonUnavailable: "daemon_unavailable",
  /** New shell, old background process. Recoverable, and now recovered from. */
  daemonBuildMismatch: "daemon_build_mismatch",
  unknown: "unknown"
} as const;

export interface ProjectFault {
  code: string;
  /** For a person to read. Never for the interface to decide on. */
  message: string;
}

/** An Error that carries a code, for the checks the shell makes on this side. */
export function faultError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Whatever a rejected `invoke` produced, as a fault.
 *
 * Tauri rejects with the serialized `Err` value, so a typed failure arrives as
 * a plain `{ code, message }` object rather than as an Error. Anything without
 * a code is `unknown`, which renders as the generic message and offers no
 * action — the safe direction, because a wrong button is worse than none.
 */
export function projectFaultFrom(value: unknown): ProjectFault {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const code = typeof record.code === "string" && record.code !== "" ? record.code : null;
    const message =
      typeof record.message === "string" ? record.message : String(value);
    if (code !== null) return { code, message };
    if (value instanceof Error) return { code: PROJECT_FAULT.unknown, message: value.message };
  }
  return { code: PROJECT_FAULT.unknown, message: String(value) };
}

interface ProjectSessionOptions {
  selectProject: (projectPath: string) => Promise<unknown>;
  /* Sets a folder up and opens it. Same flow as selecting one; only the shell
     command differs, so the two share every generation and error rule. */
  initializeProject: (projectPath: string) => Promise<unknown>;
  onSwitchStart: () => void;
  onConnected: (connection: ProjectConnection) => void;
  onError: (fault: ProjectFault) => void;
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
  adopt: (connection: ProjectConnection) => void;
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
        const fault: ProjectFault = {
          code: PROJECT_FAULT.noProjectSelected,
          message: "No project folder has been chosen."
        };
        onError(fault);
        return { ok: false, reason: fault.message };
      }

      let connection: ProjectConnection;
      try {
        connection = validateProjectConnection(await invokeShell(selectedPath));
      } catch (error) {
        if (currentGeneration !== generation) {
          return { ok: false, stale: true };
        }
        const fault = projectFaultFrom(error);
        onError(fault);
        return { ok: false, reason: fault.message };
      }
      if (currentGeneration !== generation) {
        return { ok: false, stale: true };
      }
      onConnected(connection);
      return { ok: true, value: connection };
  }

  return {
    switchProject: (projectPath) => open(projectPath, selectProject),
    initializeProject: (projectPath) => open(projectPath, initializeProject),
    /* A connection obtained outside `open` — the daemon restart returns one
       directly. It still advances the generation, so streams opened against
       the process that was just stopped are ignored rather than reconnected. */
    adopt(connection: ProjectConnection) {
      generation += 1;
      onSwitchStart();
      onConnected(connection);
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
    throw faultError(
      PROJECT_FAULT.desktopUpdateRequired,
      "Desktop update required: the running shell does not match Hivemind Core. Rebuild and restart the app before using project controls."
    );
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

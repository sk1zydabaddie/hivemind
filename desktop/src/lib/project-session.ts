export interface ProjectConnection {
  project_root: string;
  daemon_url: string;
  build_id: string;
  shell_build_id: string;
  expected_shell_build_id: string;
  status: "attached" | "started";
}

/** The shell's read-only answer about whether it is safe to create a first commit. */
/**
 * What the shell saw at the chosen path.
 *
 * One classification, computed before anything else, from which the heading,
 * the step tick, the git offer and the commit preview all derive. Before this
 * each of those assumed a project, so a missing path, a file and a folder of
 * holiday photos all got the same "Set up this project" screen with step one
 * ticked above a heading about git.
 *
 * `exists` and `is_directory` are optional because a shell older than the field
 * is a permanent input; absent means "not reported", never "false".
 */
export interface GitReadiness {
  exists?: boolean;
  is_directory?: boolean;
  is_repo: boolean;
  /** What the folder appears to hold. */
  content?: "empty" | "source" | "documents" | "media" | "built" | "unrecognised";
  /** Examples of what led to that reading, so a refusal can name them. */
  saw?: string[];
  starts_empty: boolean;
  would_commit: string[];
  would_ignore: string[];
  refusal: string | null;
}

/**
 * Whether the chosen path is a folder Hivemind could work in at all.
 *
 * The step-one tick used to mean "a path was typed", which is why it showed a
 * green check for a folder that did not exist and for a file. It means "the
 * shell looked and found a usable folder" now, and an unreported classification
 * falls back to the old behaviour rather than un-ticking every project.
 */
export function pathIsUsableFolder(readiness: GitReadiness | null): boolean {
  if (readiness === null) return true;
  return readiness.exists !== false && readiness.is_directory !== false;
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

/**
 * How one-click git setup failed, as a code rather than as a sentence (A-07).
 *
 * "Nothing changed." is a claim about durable state, and the screen used to
 * make it for every failure -- including the ones that had already rewritten
 * `.gitignore` and left a half-made `.git` behind. The shell now measures the
 * claim: `nothing_changed` means the folder was put back byte-identical, and
 * `partial_state` means it was not (or could not be confirmed), with the
 * leftovers named. The copy branches on this code and never on the message.
 */
export interface GitSetupFailure {
  code: "nothing_changed" | "partial_state";
  message: string;
  /** What is still on disk when `code` is "partial_state". */
  remaining: string[];
}

/** Whatever a rejected `initialize_git` produced, as a typed setup failure. */
export function gitSetupFailureFrom(value: unknown): GitSetupFailure {
  if (typeof value === "object" && value !== null) {
    const record = value as { code?: unknown; message?: unknown; remaining?: unknown };
    if (
      (record.code === "nothing_changed" || record.code === "partial_state") &&
      typeof record.message === "string"
    ) {
      return {
        code: record.code,
        message: record.message,
        remaining: Array.isArray(record.remaining)
          ? record.remaining.filter((entry): entry is string => typeof entry === "string")
          : []
      };
    }
  }
  /* An answer with no recognized code cannot prove the folder was put back,
     so it must not let the screen say so. Unprovable cleanliness is claimed
     by nobody -- the same direction every other gate here fails in. */
  return {
    code: "partial_state",
    message: value instanceof Error ? value.message : String(value),
    remaining: []
  };
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
  onSwitchStart: (selectedPath: string) => void;
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
      /* The path travels with the signal. Without it the hook could only reset
         to "no project selected", so every switch rendered the chooser for as
         long as the connect took -- including the switch that FOLLOWS a
         successful action, which made a correct step forward look like the
         action being undone. */
      onSwitchStart(selectedPath);
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
      /* An adopted connection already names its project, so this is an
         opening rather than a deselection for the same reason `open` is. */
      onSwitchStart(connection.project_root);
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

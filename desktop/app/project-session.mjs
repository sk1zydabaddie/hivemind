export function createProjectSession({ selectProject, onSwitchStart, onConnected, onError }) {
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

      let connection;
      try {
        connection = validateProjectConnection(await selectProject(selectedPath));
      } catch (error) {
        if (currentGeneration !== generation) {
          return { ok: false, stale: true };
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
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

export function createProjectStreamGuard() {
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

export function validateProjectConnection(value) {
  if (!value || typeof value !== "object") {
    throw new Error("The desktop shell returned an invalid project connection.");
  }
  const projectRoot = typeof value.project_root === "string" ? value.project_root.trim() : "";
  const daemonUrl = typeof value.daemon_url === "string" ? value.daemon_url.trim().replace(/\/+$/u, "") : "";
  const status = value.status === "attached" || value.status === "started" ? value.status : "";
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

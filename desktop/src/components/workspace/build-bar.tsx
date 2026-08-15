import { invoke } from "@tauri-apps/api/core";
import { Loader } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * "You are testing a build that does not contain the fix."
 *
 * Three rounds were lost to one sequence: a commit lands, the app is opened,
 * and the app is the previous build. `install:local` existed the whole time and
 * verifies that it took — it did not help, because the step that fails is
 * *remembering to run it*. A fix whose first requirement is remembering is not
 * a fix for that.
 *
 * So the app checks itself, and the check is the automatic part. Rebuilding
 * costs minutes of CPU and installing replaces the running binary, so neither
 * happens without a click; what stops being a memory problem is knowing.
 *
 * ## Two steps, not one, and why
 *
 * Windows holds a running executable locked, which `install-local.mjs` already
 * names as the usual reason an install silently does not take. So the build
 * runs while the app is open, and the install happens on the way out: a
 * detached helper waits for this process to exit, installs, and starts the new
 * copy. Presenting it as one button that quietly ends the session would be
 * worse than presenting the two things that are actually happening.
 *
 * ## The guard
 *
 * Idleness is proved before anything is offered, from the resource ledger and
 * the worktree directory ON DISK — the same proof the daemon restart uses, for
 * the same reason. Rebuilding is safe mid-run; restarting the app is not the
 * danger either, since the daemon survives app close by design. The danger is
 * a person restarting into a new build while a run is live and losing track of
 * which build produced what. If anything is running, this says so and offers
 * nothing.
 */
export function BuildBar({ projectPath }: { projectPath: string }): React.JSX.Element | null {
  const [standing, setStanding] = useState<{
    is_own_source: boolean;
    stale: boolean;
    running_version: string;
    detail: string;
  } | null>(null);
  const [work, setWork] = useState<{ work: string; detail: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "building" | "built" | "installing">("idle");
  const [problem, setProblem] = useState("");

  const look = useCallback(async () => {
    if (projectPath === "") return;
    try {
      setStanding(
        await invoke("inspect_build_staleness", { projectPath })
      );
      setWork(await invoke("inspect_daemon_work", { projectPath }));
    } catch {
      /* Outside the shell, or a folder that cannot be read. The bar simply does
         not appear -- it is a convenience, and a convenience that renders an
         error where it should be absent is worse than no convenience. */
      setStanding(null);
    }
  }, [projectPath]);

  useEffect(() => {
    void look();
  }, [look]);

  if (standing === null || !standing.is_own_source || !standing.stale) return null;

  const busy = work !== null && work.work !== "idle";

  const build = async (): Promise<void> => {
    setPhase("building");
    setProblem("");
    try {
      await invoke("rebuild_app", { projectPath });
      setPhase("built");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  };

  const install = async (): Promise<void> => {
    setPhase("installing");
    setProblem("");
    try {
      await invoke("install_built_and_restart", { projectPath });
      /* No success path: the app exits and the helper takes over. */
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setPhase("built");
    }
  };

  return (
    <section
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber/25 bg-amber-wash px-4 py-2 text-[12px]"
      role="status"
    >
      <strong className="font-semibold text-ink">
        You are running an older build
      </strong>
      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        {standing.detail} Running{" "}
        <span className="font-mono text-ink">{standing.running_version}</span>.
      </span>

      {busy ? (
        /* The one case where nothing is offered. Rebuilding mid-run is safe;
           what is not safe is losing track of which build produced a result. */
        <span className="shrink-0 text-clay">{work?.detail} Nothing offered while work is running.</span>
      ) : phase === "building" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Loader aria-hidden="true" className="size-3.5 animate-spin text-navy" />
          Building — this takes a couple of minutes
        </span>
      ) : phase === "built" ? (
        <Button size="sm" type="button" onClick={() => void install()}>
          Install it and restart
        </Button>
      ) : phase === "installing" ? (
        <span className="shrink-0 text-muted-foreground">Installing, then reopening…</span>
      ) : (
        <Button size="sm" type="button" onClick={() => void build()}>
          Build the current source
        </Button>
      )}

      {problem === "" ? null : (
        <span className="w-full break-words text-clay">{problem}</span>
      )}
    </section>
  );
}

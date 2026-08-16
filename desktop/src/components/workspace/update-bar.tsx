import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDownToLine, Loader, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "There is a newer build, and here is why you can or cannot take it."
 *
 * ## The failure this exists to remove
 *
 * Running a four-hour-old build without knowing, four sessions in a row, each
 * time with the fix already written. **Silence read as up to date.** So the one
 * state this bar may never be in is absent-because-something-went-wrong: an
 * endpoint it cannot reach, a check that failed, an install refused because
 * work is running — each of those is a sentence on screen, not a quiet no-op.
 *
 * It is invisible only when it has checked and there is genuinely nothing to
 * offer, which is the single case where saying nothing is true.
 *
 * ## Why this is not the build bar
 *
 * They answer different questions and both are worth having:
 *
 * - **Build bar:** your checkout is ahead of the binary you are running. Only
 *   meaningful to somebody building from source, and it is the honest fallback
 *   when the update endpoint cannot be reached at all.
 * - **This:** a published build is newer than the one installed. Meaningful to
 *   everybody, including people who will never clone the repository.
 *
 * ## The gate is not here
 *
 * `install_update` refuses while work is in flight, and it decides that in Rust
 * from the on-disk proof. This renders the refusal; it does not compute it. The
 * button stays enabled on purpose — pressing it and being told "three agents are
 * working" is more useful than a disabled control that explains nothing, and it
 * keeps the decision on the side that can actually see the reservations.
 */

type UpdateStanding =
  | { state: "up_to_date"; running: string }
  | { state: "available"; running: string; offered: string; notes: string | null }
  | { state: "unreachable"; running: string; detail: string };

type InstallStanding =
  | { state: "installing"; version: string }
  | { state: "work_in_flight"; detail: string }
  | { state: "nothing_offered" }
  | { state: "failed"; detail: string };

export function UpdateBar({ projectPath }: { projectPath: string }): React.JSX.Element | null {
  const [standing, setStanding] = useState<UpdateStanding | null>(null);
  const [outcome, setOutcome] = useState<InstallStanding | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      setStanding(await invoke<UpdateStanding>("check_for_update"));
    } catch (cause) {
      /* The command itself failed, which is different from the endpoint being
         unreachable -- and both must be visible rather than swallowed. */
      setStanding({
        state: "unreachable",
        running: "",
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (standing === null) return null;
  /* The one silence that is true. */
  if (standing.state === "up_to_date" && outcome === null) return null;

  const install = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await invoke<InstallStanding>("install_update", { projectPath }));
    } catch (cause) {
      setOutcome({
        state: "failed",
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      setBusy(false);
    }
  };

  const tone =
    standing.state === "unreachable" || outcome?.state === "failed"
      ? "border-clay/30 bg-clay-wash"
      : outcome?.state === "work_in_flight"
        ? "border-amber/30 bg-amber-wash"
        : "border-navy/25 bg-navy-wash";

  return (
    <section
      className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-[12px] ${tone}`}
      role="status"
    >
      <strong className="font-semibold text-ink">
        {standing.state === "available"
          ? `Version ${standing.offered} is available`
          : standing.state === "unreachable"
            ? "Could not check for updates"
            : "Update"}
      </strong>

      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        {outcome?.state === "work_in_flight" ? (
          <>
            Not installed — {outcome.detail} Hivemind never restarts into a new
            build while work is in flight.
          </>
        ) : outcome?.state === "failed" ? (
          outcome.detail
        ) : outcome?.state === "nothing_offered" ? (
          "The endpoint offered nothing to install."
        ) : outcome?.state === "installing" ? (
          `Installing ${outcome.version}. Hivemind will close and reopen.`
        ) : standing.state === "available" ? (
          <>
            You are running {standing.running}. Installing closes Hivemind and
            reopens it.
          </>
        ) : standing.state === "unreachable" ? (
          <>
            {standing.detail} You are running {standing.running || "an unknown version"}, and
            this is <em>not</em> confirmation that it is current.
          </>
        ) : (
          `You are running ${standing.running}.`
        )}
      </span>

      {standing.state === "available" && outcome?.state !== "installing" ? (
        <Button disabled={busy} size="sm" type="button" onClick={() => void install()}>
          {busy ? (
            <Loader aria-hidden="true" className="animate-spin" />
          ) : (
            <ArrowDownToLine aria-hidden="true" />
          )}
          {busy ? "Installing…" : "Install and restart"}
        </Button>
      ) : null}

      {standing.state === "unreachable" ? (
        <Button
          disabled={busy}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void check()}
        >
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { ArrowDownToLine, Loader, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "A newer version exists." One bar, one button, one answer.
 *
 * ## What this replaces, and why
 *
 * Three surfaces used to be on screen at once: an update bar, a build bar, and
 * a box explaining that "the background process from the previous version is
 * still running". Each was built to patch the gap the last one left, each was
 * verified on its own, and the composed path had never worked on a shipping
 * build — opening the real artifact produced an update error, a connection
 * error and a daemon box, two buttons, and no route to a newer version at all.
 *
 * A person does not have a build-bar problem or an updater problem. They have
 * one question. Where the newer version comes from — a published release, or
 * this machine's own checkout being ahead — is an implementation detail, and
 * `newer_version` decides it. This renders the answer.
 *
 * ## Nothing here may fail silently
 *
 * That has been the failure mode of every piece of this: the bar hid, the catch
 * swallowed, the button did nothing. So:
 *
 * - every click sets a visible state before it awaits anything;
 * - a thrown command is rendered, not caught into nothing;
 * - the only silence is `none` — checked, and genuinely current.
 *
 * `unknown` is deliberately NOT silence. Not being able to check is not the
 * same as being current, and conflating them is what put a four-hour-old build
 * in front of somebody four sessions running.
 */

type NewerVersion =
  | { source: "did_not_take"; running: string; attempted: string; detail: string }
  | { source: "none"; running: string; caveat: string | null }
  | { source: "release"; running: string; offered: string }
  | { source: "source"; running: string; detail: string }
  | { source: "unknown"; running: string; detail: string };

type UpdateOutcome =
  | { state: "restarting"; version: string }
  | { state: "work_in_flight"; detail: string }
  | { state: "failed"; detail: string };

type UpdateProgress =
  | { kind: "stage"; label: string }
  | { kind: "download"; downloaded_bytes: number; total_bytes: number | null };

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressText(progress: UpdateProgress | null, source: NewerVersion["source"]): string {
  if (progress?.kind === "stage") return progress.label;
  if (progress?.kind === "download") {
    if (progress.total_bytes !== null && progress.total_bytes > 0) {
      const percent = Math.min(
        100,
        Math.floor((progress.downloaded_bytes / progress.total_bytes) * 100)
      );
      return `${percent}% downloaded (${formatBytes(progress.downloaded_bytes)} of ${formatBytes(progress.total_bytes)})`;
    }
    return `${formatBytes(progress.downloaded_bytes)} downloaded`;
  }
  return source === "source" ? "Preparing the source build" : "Preparing the update";
}

export function UpdateBar({ projectPath }: { projectPath: string }): React.JSX.Element | null {
  const [answer, setAnswer] = useState<NewerVersion | null>(null);
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkedAgain, setCheckedAgain] = useState(false);

  const look = useCallback(async (showActivity = false) => {
    if (showActivity) {
      setChecking(true);
      setCheckedAgain(false);
    }
    try {
      setAnswer(await invoke<NewerVersion>("newer_version", { projectPath }));
    } catch (cause) {
      /* The command itself failed. Rendered rather than swallowed — a bar that
         hides on error is the exact bug this file exists to remove. */
      setAnswer({
        source: "unknown",
        running: "",
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      if (showActivity) {
        setChecking(false);
        setCheckedAgain(true);
      }
    }
  }, [projectPath]);

  useEffect(() => {
    void look();
  }, [look]);

  /* Reduced motion can legitimately stop the glyph. It must never stop the
     REPORT. Elapsed time is discrete liveness, not animation: two captures
     three seconds apart differ even when Windows asks for no motion. */
  useEffect(() => {
    if (startedAt === null || !busy) return undefined;
    const tick = (): void => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  if (answer === null) return null;

  /* THREE STATES, THREE TREATMENTS.

     1. Something newer exists -> prominent and actionable, below.
     2. Nothing newer found -> silent, or NEARLY silent when one source could
        not be consulted. A caveat is worth having available and is not worth
        a coloured bar; a standing alarm about a non-problem is ignored within
        a week, and then the real one is ignored with it.
     3. Neither source could answer -> visible, because that is a fault.

     The one true silence: both agree there is nothing newer. */
  if (answer.source === "none" && answer.caveat === null && outcome === null) return null;

  /* The near-silence: a single muted line, no tint, no border, no button. The
     caveat is on the element rather than in the sentence, so it is available
     to anybody who wonders and invisible to everybody who does not. */
  if (answer.source === "none" && outcome === null) {
    return (
      <p
        className="m-0 shrink-0 truncate px-4 py-1 text-[11px] text-muted-foreground/70"
        title={answer.caveat ?? undefined}
      >
        Nothing newer found. You are running {answer.running}.
      </p>
    );
  }

  const take = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    setProgress(null);
    setElapsedSeconds(0);
    setStartedAt(Date.now());
    const onProgress = new Channel<UpdateProgress>();
    onProgress.onmessage = setProgress;
    try {
      setOutcome(
        await invoke<UpdateOutcome>("take_newer_version", { projectPath, onProgress })
      );
    } catch (cause) {
      setOutcome({
        state: "failed",
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      setBusy(false);
      setStartedAt(null);
    }
  };

  const bad =
    answer.source === "unknown" ||
    answer.source === "did_not_take" ||
    outcome?.state === "failed";
  const warn = outcome?.state === "work_in_flight";
  const tone = bad
    ? "border-clay/30 bg-clay-wash"
    : warn
      ? "border-amber/30 bg-amber-wash"
      : "border-navy/25 bg-navy-wash";

  const heading =
    answer.source === "did_not_take"
      ? "The last update did not take"
      : outcome?.state === "restarting"
      ? "Updating"
      : answer.source === "release"
        ? `Version ${answer.offered} is available`
        : answer.source === "source"
          ? "A newer version is ready to build"
          : answer.source === "unknown"
            ? "Could not check for updates"
            : "Update";

  /* One button, and its label says how long it will take, because the two
     routes differ by minutes and a person deserves to know which they are
     getting before they press it. */
  const takes =
    answer.source === "did_not_take"
      ? /* Not "Try again", which reads as re-running the whole thing. The build
           is already done and on disk; only the install is repeated. */
        "Install it again"
      : answer.source === "source"
        ? "Build and restart"
        : "Update and restart";

  return (
    <section
      className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-[12px] ${tone}`}
      role="status"
    >
      {/* The heading is the whole message for somebody scanning: it names the
          state, never the mechanism that produced it. */}
      <strong className="font-semibold text-ink">{heading}</strong>

      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        {busy && outcome === null ? (
          <>
            <span data-update-progress="true">{progressText(progress, answer.source)}</span>
            {` · ${elapsedSeconds}s elapsed. `}
            {answer.source === "source"
              ? "This build can report its current step, but not a truthful percentage. Hivemind will restart itself."
              : "Hivemind will restart itself."}
          </>
        ) : outcome?.state === "work_in_flight" ? (
          <>
            Not updated — {outcome.detail} Hivemind never replaces itself while
            work is running.
          </>
        ) : outcome?.state === "failed" ? (
          outcome.detail
        ) : outcome?.state === "restarting" ? (
          <>Installing {outcome.version}. Hivemind will close and reopen.</>
        ) : answer.source === "did_not_take" ? (
          <>
            Hivemind tried to update to {answer.attempted} and is still running{" "}
            {answer.running}. The installer said: {answer.detail}
            {/* The report was the whole of this state, and a report you cannot
                act on is a dead end with a good error message in it. What
                failed was the swap, not the build, so the retry re-runs only
                the swap — seconds, not minutes. With no project open there is
                no installer to re-run, so say what would change that instead
                of offering a button that repeats the same answer. */}
            {projectPath === "" ? (
              <> Open your Hivemind project to try the install again.</>
            ) : null}
          </>
        ) : answer.source === "release" ? (
          <>You are running {answer.running}. This takes a few seconds.</>
        ) : answer.source === "source" ? (
          <>
            You are running {answer.running}. {answer.detail} Building takes a few
            minutes; Hivemind restarts itself when it is done.
          </>
        ) : (
          <>
            {answer.source === "unknown" ? answer.detail : ""}. You are running{" "}
            {answer.running || "an unknown version"}, and this is <em>not</em> confirmation
            that it is current.
            {/* A dead end names its exit. With no project open there is no
                source to build from, so "Try again" would repeat forever with
                the same answer — the shape that trains people to ignore the
                bar. Say the thing that would actually change the outcome. */}
            {projectPath === "" ? (
              <> Open your Hivemind project and it can build a newer version from your own source.</>
            ) : null}
            {checkedAgain ? <> Checked again just now; the result did not change.</> : null}
          </>
        )}
      </span>

      {(answer.source === "release" ||
        answer.source === "source" ||
        /* A failed swap is retryable, and this is the case that was missing.
            It needs the project, because the installer to re-run lives in its
            build output. */
        (answer.source === "did_not_take" && projectPath !== "")) &&
      outcome?.state !== "restarting" ? (
        <Button disabled={busy} size="sm" type="button" onClick={() => void take()}>
          {busy ? (
            <Loader aria-hidden="true" className="animate-spin" />
          ) : answer.source === "did_not_take" ? (
            <RefreshCw aria-hidden="true" />
          ) : (
            <ArrowDownToLine aria-hidden="true" />
          )}
          {/* A multi-minute build behind a label that says "Working…" is
              indistinguishable from a hang, which is the same silence in a
              smaller place. Say which of the two things is happening. */}
          {busy
            ? answer.source === "source"
              ? "Building…"
              : "Installing…"
            : takes}
        </Button>
      ) : null}

      {answer.source === "unknown" && !busy ? (
        <Button disabled={checking} size="sm" type="button" variant="outline" onClick={() => void look(true)}>
          {checking ? <Loader aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {checking ? "Checking…" : "Check again"}
        </Button>
      ) : null}
    </section>
  );
}

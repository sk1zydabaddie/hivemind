import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

type NewerVersion =
  | { source: "none"; running: string }
  | { source: "release"; running: string; offered: string }
  | { source: "unknown"; running: string; detail: string };

/**
 * Read-only update news.
 *
 * Installation is intentionally absent while the release pipeline is being
 * rebuilt around one machine-wide lease and one provenance-bound artifact.
 * React renders the shell's answer and can repeat the check; it owns no update
 * gate.
 */
export function UpdateBar(): React.JSX.Element | null {
  const [answer, setAnswer] = useState<NewerVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAgain, setCheckedAgain] = useState(false);

  const look = useCallback(async (showActivity = false) => {
    if (showActivity) {
      setChecking(true);
      setCheckedAgain(false);
    }
    try {
      setAnswer(await invoke<NewerVersion>("newer_version"));
    } catch (cause) {
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
  }, []);

  useEffect(() => {
    void look();
  }, [look]);

  if (answer === null || answer.source === "none") return null;

  const failed = answer.source === "unknown";
  return (
    <section
      className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-[12px] ${
        failed ? "border-clay/30 bg-clay-wash" : "border-navy/25 bg-navy-wash"
      }`}
      role="status"
    >
      <strong className="font-semibold text-ink">
        {failed ? "Could not check for updates" : `Version ${answer.offered} is available`}
      </strong>

      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        {failed ? (
          <>
            {answer.detail}. You are running {answer.running || "an unknown version"}, and this is
            not confirmation that it is current.
            {checkedAgain ? <> Checked again just now; the result did not change.</> : null}
          </>
        ) : (
          <>
            You are running {answer.running}. Updates are temporarily paused while Hivemind
            rebuilds its release safety checks. This screen cannot install or run update code.
          </>
        )}
      </span>

      {failed ? (
        <Button
          disabled={checking}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void look(true)}
        >
          {checking ? <Loader aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {checking ? "Checking…" : "Check again"}
        </Button>
      ) : null}
    </section>
  );
}

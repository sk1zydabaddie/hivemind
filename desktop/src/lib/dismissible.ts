import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * "Show me this once."
 *
 * The flag lives in the app's own config directory, next to the recent-project
 * list, for the same reason: it is about this installation and this person, not
 * about any project. A dismissal written into a project would make whichever
 * project you happened to open first the authority on what you have read, would
 * re-appear the moment you switched, and would be committed and shared with
 * everybody else on the repository.
 *
 * Three rules this encodes, and they are the constraints guidance has to meet
 * before it is allowed on screen at all:
 *
 * 1. **It must be skippable**, so every caller gets `dismiss`.
 * 2. **It must never come back once dismissed**, so the flag is durable rather
 *    than session state.
 * 3. **It must not block the app.** Nothing here gates anything: the hook
 *    starts as "not dismissed but not yet known", and a caller renders in
 *    place rather than over the top.
 *
 * Reading fails toward SHOWING. A missing file, a corrupt file, or running
 * outside the shell all read as "nothing has been dismissed", because the
 * failure that matters is a person stuck with no guidance -- not a person
 * shown a note twice.
 */
export function useDismissed(hint: string): {
  dismissed: boolean;
  /** Null until the stored answer is known, so nothing flashes on first paint. */
  known: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState(false);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let abandoned = false;
    void invoke<Record<string, boolean>>("dismissed_hints")
      .catch(() => ({}) as Record<string, boolean>)
      .then((all) => {
        if (abandoned) return;
        setDismissed(all[hint] === true);
        setKnown(true);
      });
    return () => {
      abandoned = true;
    };
  }, [hint]);

  const dismiss = useCallback(() => {
    /* Hidden immediately, recorded afterwards. If the write fails the note
       comes back next launch, which is the right way round -- the alternative
       is a control that appears not to work. */
    setDismissed(true);
    void invoke("dismiss_hint", { hint }).catch(() => undefined);
  }, [hint]);

  return { dismissed, known, dismiss };
}

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ProviderAuthenticationStanding,
  ProviderAuthenticationStatusView,
  WorkspaceAction
} from "@/lib/workspace-actions";

export function useProviderAuthentication({
  active,
  onAction
}: {
  active: boolean;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): {
  standings: ReadonlyMap<string, ProviderAuthenticationStanding>;
  error: string;
  refresh: () => Promise<void>;
  watchForCompletion: (providerId: string | null) => void;
} {
  const [standings, setStandings] = useState<ReadonlyMap<string, ProviderAuthenticationStanding>>(
    new Map()
  );
  const [error, setError] = useState("");
  const watchedProvider = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const view = await onAction<ProviderAuthenticationStatusView>({
        type: "provider.auth.inspect",
        payload: {}
      });
      const next = new Map(view.providers.map((provider) => [provider.provider_id, provider]));
      setStandings(next);
      setError("");
      const watched = watchedProvider.current;
      const watchedStanding = watched === null ? undefined : next.get(watched);
      if (
        watchedStanding?.status === "signed_in" ||
        watchedStanding?.status === "unverifiable" ||
        watchedStanding?.status === "missing"
      ) {
        /* Some harnesses publish no safe account-status command. One refresh
           after the person returns is still useful (it catches install/path
           changes), but repeating that same intrinsically unverifiable probe
           on every later click can never turn it into a sign-in verdict. */
        watchedProvider.current = null;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onAction]);

  /* WHY NOT `focus`. This used to refresh on `window`'s focus event, and that
     event never arrives.

     Measured on the installed app: a real terminal window -- the same thing
     `externalTerminalInvocation` opens for a sign-in -- was brought to the
     front and then closed while the webview recorded every event it received.
     It saw NOTHING: no `focus`, no `blur`, no `visibilitychange`, and
     `document.hasFocus()` stayed `true` the whole time another window was in
     front. So the only trigger that could refresh provider sign-in state was
     one this webview does not deliver, and a row could only go stale until
     something else happened to re-read.

     What does fire is the person coming back and doing something. Interaction
     is the honest signal here: it means they have returned, it needs no timer,
     and it cannot fire while they are still in the provider's window. `focus`
     is kept alongside it -- costless, and correct if a future wry delivers it.

     Deliberately NOT a poll. A timer would re-read a provider CLI on a
     schedule forever to catch a state change that happens at most once per
     sign-in. */
  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const refreshIfWatching = (): void => {
      if (watchedProvider.current !== null) void refresh();
    };
    window.addEventListener("focus", refreshIfWatching);
    window.addEventListener("pointerdown", refreshIfWatching, true);
    window.addEventListener("keydown", refreshIfWatching, true);
    return () => {
      window.removeEventListener("focus", refreshIfWatching);
      window.removeEventListener("pointerdown", refreshIfWatching, true);
      window.removeEventListener("keydown", refreshIfWatching, true);
    };
  }, [active, refresh]);

  return {
    standings,
    error,
    refresh,
    watchForCompletion: (providerId) => {
      watchedProvider.current = providerId;
    }
  };
}

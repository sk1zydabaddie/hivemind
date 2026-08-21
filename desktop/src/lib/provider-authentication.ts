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
  watchForCompletion: (providerId: string | null) => void;
} {
  const [standings, setStandings] = useState<ReadonlyMap<string, ProviderAuthenticationStanding>>(
    new Map()
  );
  const watchedProvider = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const view = await onAction<ProviderAuthenticationStatusView>({
      type: "provider.auth.inspect",
      payload: {}
    });
    const next = new Map(view.providers.map((provider) => [provider.provider_id, provider]));
    setStandings(next);
    const watched = watchedProvider.current;
    if (watched !== null && next.get(watched)?.status === "signed_in") {
      watchedProvider.current = null;
    }
  }, [onAction]);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const onFocus = (): void => {
      if (watchedProvider.current !== null) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh]);

  return {
    standings,
    watchForCompletion: (providerId) => {
      watchedProvider.current = providerId;
    }
  };
}

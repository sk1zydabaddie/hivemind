import { useEffect, useRef, useSyncExternalStore } from "react";
import { ComposerDraftSession, type ComposerDraftSnapshot } from "@/lib/composer-draft";
import { invokeWorkspaceAction } from "@/lib/workspace-actions";

const empty: ComposerDraftSnapshot = { view: null, saving: false, sending: false, selecting: false, startedAt: null, error: "" };
const unidentified: ComposerDraftSnapshot = { ...empty, error: "Hivemind could not identify this conversation. Reconnect before editing its saved draft." };
const emptySnapshot = (): ComposerDraftSnapshot => empty;
const noSubscription = (): (() => void) => () => undefined;

export function useComposerDraft(projectRoot: string, conversationId: string | null, eventCount: number): {
  session: ComposerDraftSession | null;
  snapshot: ComposerDraftSnapshot;
} {
  const sessions = useRef(new Map<string, ComposerDraftSession>());
  const key = projectRoot !== "" && conversationId !== null ? JSON.stringify([projectRoot, conversationId]) : null;
  let session = key === null ? null : sessions.current.get(key) ?? null;
  if (key !== null && session === null && conversationId !== null) {
    session = new ComposerDraftSession(conversationId, action => invokeWorkspaceAction(projectRoot, action));
    sessions.current.set(key, session);
  }
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? emptySnapshot);
  useEffect(() => {
    // Retain unsaved/in-flight owners across switches; settled inactive owners
    // can be reloaded from the project instead of accumulating a global cache.
    for (const [otherKey, other] of sessions.current) {
      if (otherKey !== key && other.canRelease) sessions.current.delete(otherKey);
    }
    void session?.refresh();
  }, [key, session, eventCount]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (![...sessions.current.values()].some(owner => owner.unsaved)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  return { session, snapshot: session === null && projectRoot !== "" ? unidentified : snapshot };
}

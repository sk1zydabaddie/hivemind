import type { ConversationDraft, ConversationDraftView } from "../../../src/conversation-draft";
import type { WorkspaceAction } from "./workspace-actions";

export type { ConversationDraft, ConversationDraftView };

export interface ComposerDraftSnapshot {
  view: ConversationDraftView | null;
  saving: boolean;
  sending: boolean;
  selecting: boolean;
  startedAt: number | null;
  error: string;
}

/** One advisory draft, bound to one canonical project and durable conversation.
 * The owner lives above tabs; every async callback retains this exact owner. */
export class ComposerDraftSession {
  private snapshot: ComposerDraftSnapshot = { view: null, saving: false, sending: false, selecting: false, startedAt: null, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private savedGeneration = 0;
  private savePromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly conversationId: string, private action: <T>(action: WorkspaceAction) => Promise<T>) {}

  getSnapshot = (): ComposerDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get unsaved(): boolean { return this.generation !== this.savedGeneration; }
  get canRelease(): boolean { return !this.unsaved && !this.snapshot.saving && !this.snapshot.sending && !this.snapshot.selecting; }

  beginAttachmentSelection(): boolean {
    if (this.snapshot.view === null || this.snapshot.selecting || this.snapshot.sending) return false;
    this.publish({ selecting: true });
    return true;
  }

  finishAttachmentSelection(): void { this.publish({ selecting: false }); }

  private publish(next: Partial<ComposerDraftSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private acceptView(view: ConversationDraftView): void {
    if (view.conversation_id !== this.conversationId) throw new Error("The saved draft belongs to a different conversation.");
    this.publish({ view, error: "" });
  }

  refresh = (): Promise<void> => {
    if (this.loadPromise !== null) {
      this.refreshAgain = true;
      return this.loadPromise;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          this.refreshAgain = false;
          await this.flush();
          const generation = this.generation;
          const view = await this.action<ConversationDraftView>({ type: "draft.inspect", payload: { conversation_id: this.conversationId } });
          // A slow read may not replace anything typed after it began.
          if (generation === this.generation && !this.unsaved) this.acceptView(view);
        } while (this.refreshAgain);
      } catch (error) {
        this.publish({ error: error instanceof Error ? error.message : String(error) });
      }
    };
    this.loadPromise = run().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  };

  update(change: (draft: ConversationDraft) => ConversationDraft): void {
    const view = this.snapshot.view;
    if (view === null) return;
    this.generation += 1;
    this.publish({ saving: true, view: { ...view, draft: { ...change(view.draft), content_id: crypto.randomUUID() } } });
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush().catch(() => undefined); }, 150);
  }

  flush = (): Promise<void> => {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePromise !== null) return this.savePromise;
    if (!this.unsaved || this.snapshot.view === null) return Promise.resolve();
    const run = async (): Promise<void> => {
      this.publish({ saving: true, error: "" });
      try {
        while (this.unsaved && this.snapshot.view !== null) {
          const generation = this.generation;
          const sent = this.snapshot.view;
          const saved = await this.action<ConversationDraftView>({ type: "draft.save", payload: {
            conversation_id: this.conversationId, expected_revision: sent.revision, draft: sent.draft
          } });
          if (saved.conversation_id !== this.conversationId) throw new Error("The saved draft belongs to a different conversation.");
          this.savedGeneration = generation;
          if (generation === this.generation) this.acceptView(saved);
          else this.publish({ view: { ...this.snapshot.view, revision: saved.revision, receipt: saved.receipt } });
        }
      } catch (error) {
        this.publish({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        this.publish({ saving: false });
      }
    };
    this.savePromise = run().finally(() => { this.savePromise = null; });
    return this.savePromise;
  };

  /** Persist the idempotency identity BEFORE dispatch. Reload never invents a
   * second request for an uncertain send. No draft is cleared by a UI timer. */
  async beginSubmission(): Promise<{ request_id: string; prompt: string; attachments: ConversationDraft["attachments"] } | null> {
    const view = this.snapshot.view;
    if (view === null || view.draft.text.trim() === "" || this.snapshot.sending || this.snapshot.selecting) return null;
    const previous = view.draft.submission;
    let requestId: string | null = null;
    this.publish({ sending: true, startedAt: Date.now() });
    try {
      if (previous !== null && previous.content_id !== view.draft.content_id && !view.receipt?.accepted && !view.receipt?.finished) {
        throw new Error("The previous send is not confirmed. Reconnect to check its delivery before sending this draft; your text is retained.");
      }
      requestId = previous !== null && previous.content_id === view.draft.content_id && !view.receipt?.finished
        ? previous.request_id : crypto.randomUUID();
      // Submission identity changes do not change the user's content identity.
      this.generation += 1;
      this.publish({ view: { ...view, draft: { ...view.draft, submission: { request_id: requestId, content_id: view.draft.content_id } } } });
      await this.flush();
      return { request_id: requestId, prompt: view.draft.text.trim(), attachments: view.draft.attachments };
    } catch (error) {
      // This method has not returned a dispatch payload: a failed save cannot
      // have sent this newly allocated request. Retain current edits but undo
      // its provisional identity; do not erase an earlier uncertain request.
      if (requestId !== null && requestId !== previous?.request_id &&
          this.snapshot.view?.draft.submission?.request_id === requestId) {
        this.generation += 1;
        this.publish({ view: { ...this.snapshot.view, receipt: view.receipt,
          draft: { ...this.snapshot.view.draft, submission: previous } } });
      }
      this.publish({ sending: false, startedAt: null });
      throw error;
    }
  }

  async finishSubmission(): Promise<void> {
    await this.refresh();
    this.publish({ sending: false, startedAt: null });
  }

  /** Saving may finish after navigation. Dispatch through this owner's bound
   * project action, never a callback that resolves the newly selected project. */
  async submit(): Promise<void> {
    const submitted = await this.beginSubmission();
    if (submitted === null) return;
    try {
      await this.action({ type: "conversation.submit", payload: { ...submitted, tool: "planner" } });
    } finally {
      await this.finishSubmission();
    }
  }
}

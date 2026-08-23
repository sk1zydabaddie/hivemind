import { useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Loader } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SelectionControl } from "@/components/ui/selection-control";
import { PROVIDER_MARKS } from "@/lib/provider-marks";
import type {
  CatalogueProvider,
  InnerProviderStanding,
  ModelDiscoveryView,
  ProviderAuthenticationStanding,
  WorkspaceAction
} from "@/lib/workspace-actions";

/** Verified first, then probeable, then providers this build cannot run. */
export function providerRank(status: CatalogueProvider["status"]): number {
  if (status === "supported") return 0;
  return status === "unverified" ? 1 : 2;
}

export function providerStanding(
  provider: CatalogueProvider,
  authenticationStatus: ProviderAuthenticationStanding["status"]
): string {
  return provider.checked_here
    ? "Checked here"
    : authenticationStatus === "signed_in"
      ? "Signed in"
    : provider.status === "supported"
      ? "Proven end to end"
      : provider.connectable
        ? "Ready to check"
        : "Cannot connect yet";
}

export function providerIsConnected(
  provider: CatalogueProvider,
  authenticationStatus: ProviderAuthenticationStanding["status"]
): boolean {
  return provider.checked_here || authenticationStatus === "signed_in";
}

/**
 * The provider row shared by Setup and Settings.
 *
 * The leading control is supplied by the caller because Setup is choosing a
 * set of subscriptions while Settings is reporting connection standing. Every
 * other part remains one implementation: mark, name, subscription, provider-
 * owned sign-in handoff, evidence wording, and the unchanged caveat disclosure.
 */
export function ProviderListRow({
  provider,
  expanded,
  authenticationBusy,
  authenticationStatus,
  reaches = null,
  checksBusy,
  leading,
  selected = false,
  onExpand,
  onAuthenticate
}: {
  provider: CatalogueProvider;
  expanded: boolean;
  authenticationBusy: boolean;
  authenticationStatus: ProviderAuthenticationStanding["status"];
  /** Which vendors this harness's own sign-ins reach, for multiplier rows. */
  reaches?: ProviderAuthenticationStanding["reaches"];
  checksBusy: boolean;
  leading: React.ReactNode;
  selected?: boolean;
  onExpand: () => void;
  onAuthenticate: () => void;
}): React.JSX.Element {
  const connected = providerIsConnected(provider, authenticationStatus);
  /* The disclosure behind the chevron: the caveat as before, plus the tier
     claim and — for a multiplier — which vendors its sign-ins reach. */
  const expandable =
    provider.caveat !== null || provider.tier_claim !== undefined || reaches != null;
  return (
    <div className="border-b border-rule last:border-b-0">
      <div
        className={`flex items-center gap-2.5 px-2.5 py-2 ${selected ? "bg-navy-wash" : "bg-panel"}`}
      >
        {leading}
        <ProviderMark provider={provider.id} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {provider.label}
          {provider.support_tier === "multiplier" ? (
            <span
              className="ml-1.5 rounded-sm border border-rule bg-canvas px-1 py-px align-middle text-[9px] font-medium tracking-label text-muted-foreground uppercase"
              title={provider.tier_claim}
            >
              Multiplier
            </span>
          ) : null}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block">
          {provider.subscription}
        </span>
        {connected ? (
          <span
            aria-label={`${provider.label} connected`}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-navy/35 bg-navy-wash px-2 text-[11px] font-medium text-navy"
            role="status"
            title={provider.checked_here ? "Connected and checked in this project" : "The provider CLI reports an active sign-in"}
          >
            <Check aria-hidden="true" className="size-3.5" />
            Connected
          </span>
        ) : (
          <Button
            aria-label={`Open ${provider.label} sign-in`}
            disabled={authenticationBusy || checksBusy}
            size="xs"
            title={provider.authentication.detail}
            type="button"
            variant="outline"
            onClick={onAuthenticate}
          >
            {authenticationBusy ? (
              <Loader aria-hidden="true" />
            ) : (
              <ExternalLink aria-hidden="true" />
            )}
            {authenticationBusy ? "Opening…" : "Sign in"}
          </Button>
        )}
        <span
          className={`shrink-0 text-[11px] font-medium ${
            provider.checked_here || provider.status === "supported"
              ? "text-navy"
              : provider.connectable
                ? "text-amber"
                : "text-muted-foreground"
          }`}
        >
          {providerStanding(provider, authenticationStatus)}
        </span>
        {!expandable ? (
          <span aria-hidden="true" className="size-5 shrink-0" />
        ) : (
          <Button
            aria-expanded={expanded}
            aria-label={`What is unverified about ${provider.label}`}
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={onExpand}
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
      {expanded && expandable ? (
        <div className="grid gap-1.5 border-t border-rule bg-canvas px-2.5 py-2">
          {provider.tier_claim === undefined ? null : (
            <p className="m-0 text-[11px] leading-relaxed break-words text-ink">
              {provider.tier_claim}
            </p>
          )}
          {provider.caveat === null ? null : (
            <p className="m-0 text-[11px] leading-relaxed break-words text-muted-foreground">
              {provider.caveat}
            </p>
          )}
          {reaches == null ? null : (
            <p className="m-0 text-[11px] leading-relaxed break-words text-muted-foreground">
              <span className="font-medium text-ink">Its sign-ins reach:</span>{" "}
              {reaches.providers.length === 0
                ? "no provider Hivemind recognises"
                : reaches.providers.map((entry, index) => (
                    <span key={entry.id} title={entry.why}>
                      {index > 0 ? " · " : ""}
                      {entry.label}{" "}
                      <span
                        className={
                          entry.sanction === "prohibited"
                            ? "text-clay"
                            : entry.sanction === "unchecked"
                              ? "text-amber"
                              : "text-navy"
                        }
                      >
                        ({entry.sanction})
                      </span>
                    </span>
                  ))}
              {reaches.unrecognised > 0
                ? ` · ${reaches.unrecognised} more Hivemind does not recognise`
                : ""}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Don't see your provider?" — the disclosure that makes the multiplier tier
 * the answer rather than a workaround someone has to discover. Shown on the
 * setup screen and in settings, and honest about both halves of the claim:
 * what holds through a multiplier, and what goes dark.
 *
 * Live where the daemon can carry it, and the automation stops exactly at the
 * two lines the provenance and credential rules draw: the vendor's install
 * command is OFFERED with a copy button, never run; and every credential
 * prompt happens in the harness's own window — a provider key is pasted there,
 * never into anything Hivemind renders. Sign-in preselection sends one
 * registry id through the fixed-command mechanism; prohibited providers
 * render as the refusals they are, and unchecked ones say so before a pick.
 */
export function MultiplierDisclosure({
  provider = null,
  standing = null,
  busy = false,
  onAction = null,
  onReload = null
}: {
  /** The multiplier row (OpenCode), when the catalogue carries one. */
  provider?: CatalogueProvider | null;
  standing?: ProviderAuthenticationStanding | null;
  busy?: boolean;
  onAction?: (<T>(action: WorkspaceAction) => Promise<T>) | null;
  onReload?: (() => Promise<void>) | null;
}): React.JSX.Element {
  const [signInBusy, setSignInBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const [discovery, setDiscovery] = useState<ModelDiscoveryView | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [filter, setFilter] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);

  const live = provider !== null && onAction !== null;
  const notInstalled = standing?.installed === false;
  const reachable = provider?.reachable_providers ?? [];
  const models =
    discovery?.providers.find((entry) => entry.provider_id === provider?.id)?.models ?? null;
  const shown =
    models?.filter((model) => model.slug.toLowerCase().includes(filter.trim().toLowerCase())) ??
    null;

  const signIn = async (inner: InnerProviderStanding): Promise<void> => {
    if (!live || provider === null || onAction === null) return;
    setSignInBusy(inner.id);
    setFailure("");
    setNotice("");
    try {
      await onAction({
        type: "provider.auth.start",
        payload: { provider_id: provider.id, inner_provider_id: inner.id }
      });
      setNotice(
        inner.access === "oauth"
          ? `${inner.label}'s own sign-in opened — finish there, then come back.`
          : `${provider.label} is asking for ${inner.label}'s key in its own window — paste it there, never into Hivemind.`
      );
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSignInBusy(null);
    }
  };

  const findModels = async (): Promise<void> => {
    if (!live || onAction === null) return;
    setDiscovering(true);
    setFailure("");
    try {
      setDiscovery(await onAction<ModelDiscoveryView>({ type: "models.discover", payload: {} }));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscovering(false);
    }
  };

  const connect = async (slug: string): Promise<void> => {
    if (!live || provider === null || onAction === null) return;
    setConnecting(slug);
    setFailure("");
    setNotice("");
    try {
      await onAction({
        type: "adapter.connect_model",
        payload: { role: "worker", provider_id: provider.id, model_slug: slug }
      });
      setNotice(`${slug} connected and checked as a worker.`);
      await onReload?.();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <details className="rounded-sm border border-rule bg-canvas px-2.5 py-2">
      <summary className="cursor-pointer text-[12px] font-medium text-ink">
        Don&apos;t see your provider?
      </summary>
      <div className="mt-1.5 grid gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <p className="m-0">
          Hivemind runs a handful of agents directly. Anything else can still work
          through <span className="text-ink">OpenCode</span>, which signs in to many
          more providers and passes Hivemind&apos;s checks as a harness. The claim is
          different and worth knowing: the gates hold — writes confined to this
          project, no shell, nothing committed without your approval, spending limits
          in tokens — while tier routing, per-task cost prediction and model
          provenance are off, because OpenCode does not report which model answered.
        </p>

        {/* Step 1 — the vendor's install command, offered and never run. */}
        {!live || notInstalled ? (
          <div className="grid gap-1">
            <strong className="text-[11px] font-medium text-ink">
              1. Install OpenCode — using its own instructions, not from here
            </strong>
            {provider?.install != null ? (
              <>
                <span className="flex flex-wrap items-center gap-1.5">
                  <code className="rounded-sm border border-rule bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink">
                    {provider.install.command}
                  </code>
                  <Button
                    aria-label="Copy OpenCode's install command"
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(provider.install!.command);
                      setCopied(true);
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </span>
                <span>
                  {provider.install.detail} Documented at{" "}
                  <span className="font-mono text-ink">{provider.install.url}</span>, checked{" "}
                  {provider.install.checked}.
                </span>
              </>
            ) : (
              <span>
                Install OpenCode using its own instructions at{" "}
                <span className="font-mono text-ink">opencode.ai</span> — not from here.
              </span>
            )}
          </div>
        ) : null}

        {/* Step 2 — sign in, inside OpenCode's own window. */}
        <div className="grid gap-1">
          <strong className="text-[11px] font-medium text-ink">
            2. Sign in to your provider — the credential stays with OpenCode
          </strong>
          {live && !notInstalled && reachable.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {reachable.map((inner) => (
                <Button
                  disabled={inner.sanction === "prohibited" || signInBusy !== null || busy}
                  key={inner.id}
                  size="xs"
                  title={
                    inner.sanction === "prohibited" || inner.access === "oauth" || inner.access === undefined
                      ? inner.why
                      : `${inner.label} signs in with a key. ${provider?.label ?? "The harness"} asks for it in its own window — paste it there, never into Hivemind.`
                  }
                  type="button"
                  variant="outline"
                  onClick={() => void signIn(inner)}
                >
                  {signInBusy === inner.id ? <Loader aria-hidden="true" className="animate-spin" /> : null}
                  {inner.label}
                  {inner.sanction === "prohibited" ? (
                    <span className="text-[9px] font-medium tracking-label text-clay uppercase">Not allowed</span>
                  ) : inner.sanction === "unchecked" ? (
                    <span className="text-[9px] font-medium tracking-label text-amber uppercase">Unchecked</span>
                  ) : null}
                </Button>
              ))}
            </div>
          ) : (
            <span>
              In a terminal, run <span className="font-mono text-ink">opencode auth login</span>,
              pick your provider, and finish that provider&apos;s own sign-in. The credential
              stays with OpenCode; Hivemind never sees it.
            </span>
          )}
          <span>
            Browser sign-ins finish in the browser. Key-based providers ask for their key
            in OpenCode&apos;s own window — paste it there, never into Hivemind.
          </span>
        </div>

        {/* Step 3 — pick the model by its full provider/model name. */}
        <div className="grid gap-1">
          <strong className="text-[11px] font-medium text-ink">
            3. Pick your model by its full name (<span className="font-mono">provider/model</span>)
          </strong>
          {live && !notInstalled ? (
            models === null ? (
              <span className="flex items-center gap-1.5">
                <Button
                  disabled={discovering || busy}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => void findModels()}
                >
                  {discovering ? <Loader aria-hidden="true" className="animate-spin" /> : null}
                  {discovering ? "Asking OpenCode…" : "List the models OpenCode reaches"}
                </Button>
                <span>No model call — OpenCode prints its own list.</span>
              </span>
            ) : (
              <div className="grid gap-1">
                <input
                  aria-label="Filter models"
                  className="h-7 w-full rounded-sm border border-input bg-panel px-2 font-mono text-[11px] text-ink focus-visible:border-navy/55"
                  placeholder="Filter: openai/, openrouter/…"
                  type="text"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <div className="grid max-h-44 gap-0.5 overflow-y-auto">
                  {(shown ?? []).slice(0, 60).map((model) => (
                    <SelectionControl
                      active={false}
                      disabled={model.selectable === false || connecting !== null || busy}
                      key={model.slug}
                      shape="chip"
                      title={
                        model.inner_provider != null && model.inner_provider.sanction !== "blessed"
                          ? `${model.inner_provider.label} is ${model.inner_provider.sanction}: ${model.inner_provider.why}`
                          : undefined
                      }
                      onClick={() => void connect(model.slug)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {connecting === model.slug ? (
                          <Loader aria-hidden="true" className="size-3 animate-spin" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{model.slug}</span>
                        {model.inner_provider?.sanction === "prohibited" ? (
                          <span className="shrink-0 text-[9px] font-medium tracking-label text-clay uppercase">Not allowed</span>
                        ) : model.inner_provider?.sanction === "unchecked" ? (
                          <span className="shrink-0 text-[9px] font-medium tracking-label text-amber uppercase">Unchecked</span>
                        ) : null}
                      </span>
                    </SelectionControl>
                  ))}
                  {shown !== null && shown.length === 0 ? (
                    <span>Nothing matches. OpenCode reported {models.length} models.</span>
                  ) : null}
                </div>
                <span>
                  Connecting runs the agent once for real to check what it can do — about
                  40K tokens on your own subscription. Providers marked{" "}
                  <span className="text-amber">unchecked</span> are documented by OpenCode and
                  unverified by us; their own terms decide whether that path is allowed.
                </span>
              </div>
            )
          ) : (
            <span>
              Back here, tick OpenCode and pick your model by its full name. Providers
              Hivemind has not verified are marked{" "}
              <span className="text-amber">unchecked</span> — their own terms decide whether
              that path is allowed.
            </span>
          )}
        </div>

        <p className="m-0">
          One refusal, by name: Claude subscriptions cannot be connected through
          OpenCode — Anthropic prohibits routing subscription credentials through
          third-party apps, and OpenCode removed that sign-in. Claude Code is
          integrated directly; connect it in the list above.
        </p>

        {failure === "" ? null : (
          <p className="m-0 rounded-sm border-l-2 border-clay bg-clay-wash px-2 py-1 text-[11px] text-clay">
            {failure}
          </p>
        )}
        {notice === "" ? null : (
          <p className="m-0 rounded-sm border-l-2 border-navy bg-navy-wash px-2 py-1 text-[11px] text-ink" role="status">
            {notice}
          </p>
        )}
      </div>
    </details>
  );
}

/** Provider artwork remains source-coloured and scales with its label. */
export function ProviderMark({ provider }: { provider: string }): React.JSX.Element {
  const mark = PROVIDER_MARKS[provider];
  if (mark === undefined) {
    /* Provider identities are not ours to invent. Older daemons can return an
       id this desktop does not know, so reserve the alignment without drawing
       a made-up monogram. */
    return <span aria-hidden="true" className="size-[1.15em] shrink-0" />;
  }
  return (
    <picture className="flex size-[1.15em] shrink-0 items-center">
      {mark.dark === undefined ? null : (
        <source media="(prefers-color-scheme: dark)" srcSet={mark.dark} />
      )}
      <img
        alt=""
        className="block size-[1.15em] rounded-[0.2em]"
        draggable={false}
        src={mark.light}
      />
    </picture>
  );
}

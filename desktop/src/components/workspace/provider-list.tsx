import { Check, ChevronDown, ExternalLink, Loader } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PROVIDER_MARKS } from "@/lib/provider-marks";
import type {
  CatalogueProvider,
  ProviderAuthenticationStanding
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
 */
export function MultiplierDisclosure(): React.JSX.Element {
  return (
    <details className="rounded-sm border border-rule bg-canvas px-2.5 py-2">
      <summary className="cursor-pointer text-[12px] font-medium text-ink">
        Don&apos;t see your provider?
      </summary>
      <div className="mt-1.5 grid gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <p className="m-0">
          Hivemind runs a handful of agents directly. Anything else can still work
          through <span className="text-ink">OpenCode</span>, which signs in to many
          more providers and passes Hivemind&apos;s checks as a harness. The claim is
          different and worth knowing: the gates hold — writes confined to this
          project, no shell, nothing committed without your approval, spending limits
          in tokens — while tier routing, per-task cost prediction and model
          provenance are off, because OpenCode does not report which model answered.
        </p>
        <ol className="m-0 grid list-decimal gap-1 pl-4">
          <li>
            Install OpenCode using its own instructions at{" "}
            <span className="font-mono text-ink">opencode.ai</span> — not from here.
          </li>
          <li>
            In a terminal, run <span className="font-mono text-ink">opencode auth login</span>,
            pick your provider, and finish that provider&apos;s own sign-in. The
            credential stays with OpenCode; Hivemind never sees it.
          </li>
          <li>
            Back here, tick OpenCode and pick your model by its full name
            (<span className="font-mono">provider/model</span>). Providers Hivemind has
            not verified are marked <span className="text-amber">unchecked</span> — their
            own terms decide whether that path is allowed.
          </li>
        </ol>
        <p className="m-0">
          One refusal, by name: Claude subscriptions cannot be connected through
          OpenCode — Anthropic prohibits routing subscription credentials through
          third-party apps, and OpenCode removed that sign-in. Claude Code is
          integrated directly; connect it in the list above.
        </p>
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

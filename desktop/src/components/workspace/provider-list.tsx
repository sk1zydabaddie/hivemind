import { ChevronDown, ExternalLink, Loader } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PROVIDER_MARKS } from "@/lib/provider-marks";
import type { CatalogueProvider } from "@/lib/workspace-actions";

/** Verified first, then probeable, then providers this build cannot run. */
export function providerRank(status: CatalogueProvider["status"]): number {
  if (status === "supported") return 0;
  return status === "unverified" ? 1 : 2;
}

export function providerStanding(provider: CatalogueProvider): string {
  return provider.checked_here
    ? "Checked here"
    : provider.status === "supported"
      ? "Proven end to end"
      : provider.connectable
        ? "Ready to check"
        : "Cannot connect yet";
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
  checksBusy,
  leading,
  selected = false,
  onExpand,
  onAuthenticate
}: {
  provider: CatalogueProvider;
  expanded: boolean;
  authenticationBusy: boolean;
  checksBusy: boolean;
  leading: React.ReactNode;
  selected?: boolean;
  onExpand: () => void;
  onAuthenticate: () => void;
}): React.JSX.Element {
  return (
    <div className="border-b border-rule last:border-b-0">
      <div
        className={`flex items-center gap-2.5 px-2.5 py-2 ${selected ? "bg-navy-wash" : "bg-panel"}`}
      >
        {leading}
        <ProviderMark provider={provider.id} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {provider.label}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block">
          {provider.subscription}
        </span>
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
          {authenticationBusy
            ? "Opening…"
            : provider.checked_here
              ? "Sign in again"
              : "Sign in"}
        </Button>
        <span
          className={`shrink-0 text-[11px] font-medium ${
            provider.checked_here || provider.status === "supported"
              ? "text-navy"
              : provider.connectable
                ? "text-amber"
                : "text-muted-foreground"
          }`}
        >
          {providerStanding(provider)}
        </span>
        {provider.caveat === null ? (
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
      {expanded && provider.caveat !== null ? (
        <p className="m-0 border-t border-rule bg-canvas px-2.5 py-2 text-[11px] leading-relaxed break-words text-muted-foreground">
          {provider.caveat}
        </p>
      ) : null}
    </div>
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

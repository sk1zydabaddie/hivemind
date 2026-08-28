import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

/** One visual contract for a client action that could not produce evidence. */
export function ActionFailure({
  title,
  detail,
  retryLabel = "Try again",
  busy = false,
  onRetry
}: {
  title: string;
  detail: string;
  retryLabel?: string;
  busy?: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-clay/30 bg-clay-wash p-2.5" role="alert">
      <div className="grid gap-0.5">
        <strong className="text-[12px] font-semibold text-ink">{title}</strong>
        <span className="text-[11px] leading-relaxed text-clay">{detail}</span>
      </div>
      <Button className="justify-self-start" disabled={busy} size="xs" type="button" variant="outline-destructive" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        {busy ? "Trying…" : retryLabel}
      </Button>
    </div>
  );
}

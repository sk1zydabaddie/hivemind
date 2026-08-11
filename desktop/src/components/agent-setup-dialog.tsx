import { AlertTriangle, Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CAPABILITIES,
  PROVIDERS,
  REQUIRED_ROLES,
  costDefaultsSnippet,
  profileFileFor,
  profilePathFor,
  type ProviderOption
} from "@/lib/providers";

/* "Which coding agent do you have?" — not "paste your configuration".
 *
 * Hivemind cannot write these files itself yet: no audited action accepts an
 * adapter profile or a config change, and the desktop must not write project
 * state behind Core's back. So this hands over the exact file, already filled
 * in, rather than asking anyone to invent one. See DESIGN-NOTES.md for the
 * Core actions that would remove the copying.
 */
export function AgentSetupDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(PROVIDERS[0]?.id ?? "codex");
  const provider = PROVIDERS.find((entry) => entry.id === selected) ?? PROVIDERS[0]!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(820px,calc(100vh-48px))] w-[min(880px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule px-5 py-4">
          <DialogTitle className="text-[20px] leading-tight font-semibold tracking-tighter">
            Which coding agent do you have?
          </DialogTitle>
          <DialogDescription className="max-w-[640px]">
            Hivemind runs the agent you already pay for. It never asks for your
            API keys — it starts the same command-line tool you use yourself.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="grid gap-6 px-8 py-6">
            <div className="grid gap-3 sm:grid-cols-2">
              {PROVIDERS.map((entry) => (
                <ProviderCard
                  key={entry.id}
                  provider={entry}
                  selected={entry.id === provider.id}
                  onSelect={() => setSelected(entry.id)}
                />
              ))}
            </div>

            {provider.status === "supported" ? (
              <SupportedProvider provider={provider} />
            ) : (
              <section className="rounded-md border border-amber/25 border-l-2 border-l-amber bg-amber-wash p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
                  <div className="min-w-0">
                    <strong className="block text-[13px] font-semibold text-ink">
                      {provider.label} is not something you can pick yet
                    </strong>
                    <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-muted-foreground">
                      {provider.caveat}
                    </p>
                  </div>
                </div>
              </section>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  provider,
  selected,
  onSelect
}: {
  provider: ProviderOption;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-pressed={selected}
      className={`cursor-pointer rounded-md border p-3.5 text-left transition-colors ${
        selected ? "border-navy bg-navy-wash" : "border-rule bg-panel hover:border-navy/40"
      }`}
      type="button"
      onClick={onSelect}
    >
      <div className="flex items-baseline justify-between gap-3">
        <strong className="text-[14px] font-semibold text-ink">{provider.label}</strong>
        <span
          className={`text-[12px] font-medium ${
            provider.status === "supported" ? "text-navy" : "text-amber"
          }`}
        >
          {provider.status === "supported" ? "Ready to use" : "Not available yet"}
        </span>
      </div>
      <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">
        {provider.summary}
      </span>
    </button>
  );
}

function SupportedProvider({ provider }: { provider: ProviderOption }): React.JSX.Element {
  return (
    <>
      <section>
        <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          What Hivemind requires of it
        </h3>
        <p className="mt-1 mb-3 text-[13px] leading-relaxed text-muted-foreground">
          These are the properties the run depends on. Hivemind refuses a profile
          that carries bypass flags before it ever starts the agent; the rest are
          set by the file below.
        </p>
        <ul className="m-0 grid list-none gap-px overflow-hidden rounded-md border border-rule bg-rule p-0">
          {CAPABILITIES.map((capability) => {
            const setting = provider.capabilities[capability.id];
            return (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 bg-panel px-4 py-3"
                key={capability.id}
              >
                <div className="min-w-0">
                  <strong className="block text-[13px] font-medium text-ink">
                    {capability.label}
                  </strong>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                    {capability.why}
                  </span>
                </div>
                <code className="font-mono text-[12px] break-all text-navy">
                  {setting ?? "—"}
                </code>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          Create these two files in your project
        </h3>
        <p className="mt-1 mb-3 text-[13px] leading-relaxed text-muted-foreground">
          Hivemind asks for two roles by name. Both run {provider.label}; they are
          separate files so you can point them at different models later.
        </p>
        <div className="grid gap-3">
          {REQUIRED_ROLES.map((role) => (
            <CopyBlock
              key={role.tool}
              label={profilePathFor(role)}
              note={role.purpose}
              value={profileFileFor(provider, role)}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">
          Then add these cost defaults
        </h3>
        <p className="mt-1 mb-3 max-w-[640px] text-[13px] leading-relaxed text-muted-foreground">
          Without them Hivemind treats every file as high-risk, and high-risk work
          refuses anything below the strongest model — so a new project runs
          everything on the most expensive setting it has. Add these keys to{" "}
          <code className="font-mono text-[12px] text-ink">.hivemind/config.json</code>{" "}
          and ordinary edits run on cheaper models.
        </p>
        <CopyBlock
          label=".hivemind/config.json"
          note="Merge these keys into the object that is already there"
          value={costDefaultsSnippet()}
        />
      </section>
    </>
  );
}

function CopyBlock({
  label,
  note,
  value
}: {
  label: string;
  note: string;
  value: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-rule bg-panel">
      <div className="flex items-center gap-3 border-b border-rule bg-canvas px-3.5 py-2">
        <div className="min-w-0 flex-1">
          <code className="block font-mono text-[12px] break-all text-ink">{label}</code>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">{note}</span>
        </div>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="m-0 max-h-[220px] overflow-auto bg-canvas px-4 py-3 font-mono text-[12px] leading-[1.7] text-ink">
        {value}
      </pre>
    </div>
  );
}

import { FolderGit2, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { displayProjectPath } from "@/lib/project-session";
import { REQUIRED_ROLES, profilePathFor } from "@/lib/providers";
import type {
  AutonomyLevel,
  WorkspaceAction,
  WorkspaceInspection
} from "@/lib/workspace-actions";

const LEVELS: Array<{ value: AutonomyLevel; label: string; detail: string }> = [
  {
    value: "auto",
    label: "Only what needs me",
    detail: "Work runs start to finish. You are asked when something is stuck, rejected, or out of budget."
  },
  {
    value: "review_plan",
    label: "The plan, then what needs me",
    detail: "You approve the plan before anything starts, then it runs as above."
  },
  {
    value: "review_everything",
    label: "Every step",
    detail: "Nothing advances without you. Slowest, and the most control."
  }
];

/* Everything the app can genuinely change lives here. What it cannot change yet
   says so, and says where the setting actually lives. */
export function SettingsDialog({
  open,
  inspection,
  projectPath,
  busy,
  onOpenChange,
  onChooseProject,
  onConnectAgent,
  onAction
}: {
  open: boolean;
  inspection: WorkspaceInspection | null;
  projectPath: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseProject: () => void;
  onConnectAgent: () => void;
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const level = inspection?.autonomy.configured_level ?? "auto";
  const spend = inspection?.spend ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(760px,calc(100vh-48px))] w-[min(760px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-rule px-5 py-4">
          <DialogTitle className="text-[20px] leading-tight font-semibold tracking-tighter">
            Settings
          </DialogTitle>
          <DialogDescription>
            Settings belong to the project you have open, not to the app.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 bg-canvas">
          <div className="grid gap-6 px-8 py-6">
            <Section title="Project">
              <div className="flex items-center gap-4">
                <code className="min-w-0 flex-1 font-mono text-[13px] break-all text-ink">
                  {displayProjectPath(projectPath)}
                </code>
                <Button size="sm" type="button" variant="outline" onClick={onChooseProject}>
                  <FolderGit2 aria-hidden="true" />
                  Change
                </Button>
              </div>
            </Section>

            <Section title="How often Hivemind interrupts you">
              <div className="grid gap-2">
                {LEVELS.map((entry) => (
                  <button
                    aria-pressed={entry.value === level}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      entry.value === level
                        ? "border-navy bg-navy-wash"
                        : "border-rule bg-panel hover:border-navy/40"
                    }`}
                    disabled={busy || inspection === null}
                    key={entry.value}
                    type="button"
                    onClick={() => {
                      void onAction({ type: "autonomy.set", payload: { level: entry.value } });
                    }}
                  >
                    <strong className="block text-[13px] font-medium text-ink">
                      {entry.label}
                    </strong>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                      {entry.detail}
                    </span>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Your coding agent">
              <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
                Hivemind starts the agent you already pay for. It reads how to do
                that from two files in your project:
              </p>
              <ul className="mt-2 mb-3 grid list-none gap-1 p-0">
                {REQUIRED_ROLES.map((role) => (
                  <li className="font-mono text-[12px] break-all text-muted-foreground" key={role.tool}>
                    {profilePathFor(role)}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3">
                <Button size="sm" type="button" variant="outline" onClick={onConnectAgent}>
                  <Terminal aria-hidden="true" />
                  Set up an agent
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Hivemind cannot read these from here yet.
                </span>
              </div>
            </Section>

            <Section title="Spending">
              {spend === null ? (
                <p className="m-0 text-[13px] text-muted-foreground">
                  Open a project to see its limits.
                </p>
              ) : (
                <>
                  <dl className="m-0 grid grid-cols-2 gap-3">
                    <Fact label="Most one call may use" value={`${spend.run_ceiling_tokens.toLocaleString()} tokens`} />
                    <Fact label="Most this session may use" value={`${spend.session_ceiling_tokens.toLocaleString()} tokens`} />
                    <Fact label="Used so far" value={`${spend.effective_tokens.toLocaleString()} tokens`} />
                    <Fact label="Calls so far" value={`${spend.calls}`} />
                  </dl>
                  <p className="mt-3 mb-0 text-[12px] leading-relaxed text-muted-foreground">
                    Limits stop a run before it overspends. Changing them means
                    editing <code className="font-mono text-ink">.hivemind/config.json</code>;
                    the app cannot change them yet.
                  </p>
                </>
              )}
            </Section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-rule bg-panel p-4">
      <h3 className="m-0 mb-2.5 text-[11px] font-medium tracking-label text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-sm border border-rule bg-canvas px-2.5 py-2">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="m-0 mt-0.5 font-mono text-[13px] text-ink">{value}</dd>
    </div>
  );
}

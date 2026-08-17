import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Panel, PanelCount, PanelHeader, PanelLabel } from "@/components/ui/panel";
import type { AccountsView, WorkspaceAction } from "@/lib/workspace-actions";

/* Which account each provider runs as, and switching between them.
 *
 * Built for a reported failure: three days lost to an exhausted Codex quota
 * with nothing on screen saying so. Seeing what is left is half of it; being
 * able to move to another account is the other half.
 *
 * What this surface can do: read the registered accounts, and ask Core to point
 * a harness at a different one. What it cannot do: hold, read, enter or
 * transmit a credential. There is no field for one here and no action behind
 * one — an account is a directory the harness itself owns and logged into with
 * its own command, and Hivemind only names which of them to use.
 *
 * The honesty rule from the usage panel is extended rather than duplicated: a
 * connection whose verification no longer describes what is running says so, in
 * the same amber, instead of showing a confident state it cannot support.
 */

export function AccountsPanel({
  onAction
}: {
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element | null {
  const [view, setView] = useState<AccountsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setView(await onAction<AccountsView>({ type: "accounts.inspect", payload: {} }));
    } catch {
      /* The panel simply does not appear. A surface that renders an error
         where an account belongs is worse than one that is absent. */
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over onAction only
  }, [onAction]);

  /* Shape, not presence. An action that resolves with nothing -- a daemon
     older than this panel, a replayed trail from before accounts existed --
     stored `undefined`, which is not `null`, so the null guard passed it
     straight through and the panel crashed reading `.roles`. The same defect
     took the ship surface down through `provenance`, found the same way: by
     replaying a real trail instead of a fixture that always had the field. */
  if (
    view === null ||
    typeof view !== "object" ||
    !Array.isArray(view.roles) ||
    !Array.isArray(view.accounts) ||
    view.roles.length === 0
  ) {
    return null;
  }

  const switchable = (harness: string | null): boolean =>
    harness !== null && Object.hasOwn(view.switchable, harness);

  const select = async (accountId: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      setView(await onAction<AccountsView>({ type: "accounts.select", payload: { account_id: accountId } }));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader className="bg-panel/82">
        <PanelLabel className="text-ink">Accounts</PanelLabel>
        <PanelCount>{view.accounts.length}</PanelCount>
      </PanelHeader>
      <div className="grid gap-2.5 px-3 py-3">
        {view.roles.map((entry) => {
          const options = view.accounts.filter((account) => account.harness === entry.tool);
          return (
            <article className="grid gap-1" key={entry.role}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="text-[13px] font-semibold text-ink">{entry.role}</strong>
                {entry.tool === null ? null : (
                  <span className="font-mono text-[11px] text-muted-foreground">{entry.tool}</span>
                )}
                <span className="ml-auto">
                  {options.length === 0 || !switchable(entry.tool) ? (
                    <span className="text-[12px] text-muted-foreground">
                      {entry.account?.label ?? "the agent's own login"}
                    </span>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button disabled={busy} size="sm" type="button" variant="ghost">
                          {entry.account?.label ?? "choose an account"}
                          <ChevronDown aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {options.map((account) => (
                          <DropdownMenuItem key={account.id} onSelect={() => void select(account.id)}>
                            {account.id === entry.account?.id ? (
                              <Check aria-hidden="true" />
                            ) : (
                              <span aria-hidden="true" className="size-4" />
                            )}
                            <span className="grid">
                              <span>{account.label}</span>
                              {/* The directory, so two accounts are tellable
                                  apart. A path, never a credential — nothing
                                  here reads inside it. */}
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {account.home_dir}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </span>
              </div>

              {entry.capabilities_stale === null ? null : (
                <span className="text-[11px] leading-relaxed text-amber">
                  What Hivemind checked about this agent was measured under a different
                  account, so it no longer describes what would run. A different plan can
                  change which model it can be pinned to and whether it reports what it
                  spends. Reconnect it to check again.
                </span>
              )}

              {entry.tool !== null && !switchable(entry.tool) ? (
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  Hivemind cannot switch accounts for this agent. It runs as whoever is
                  logged in to it.
                </span>
              ) : null}
            </article>
          );
        })}

        {problem === null ? null : (
          <p className="m-0 border-t border-rule pt-2 text-[11px] leading-relaxed text-clay" role="status">
            {problem}
          </p>
        )}

        <p className="m-0 border-t border-rule pt-2 text-[11px] leading-relaxed text-muted-foreground">
          An account is a folder the agent logged itself into. Hivemind points the agent
          at one of them and never sees your password, key or token.
        </p>
      </div>
    </Panel>
  );
}

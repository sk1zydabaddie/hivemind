import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, FolderOpen, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ActionFailure } from "@/components/ui/action-failure";
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
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [harness, setHarness] = useState("");
  const [homeDir, setHomeDir] = useState("");

  const load = async (): Promise<void> => {
    setProblem(null);
    try {
      const next = await onAction<AccountsView>({ type: "accounts.inspect", payload: {} });
      if (
        typeof next !== "object" ||
        next === null ||
        !Array.isArray(next.roles) ||
        !Array.isArray(next.accounts)
      ) {
        throw new Error("Core returned an unreadable account record.");
      }
      setView(next);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
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
  if (view === null) {
    return problem === null ? null : (
      <Panel>
        <PanelHeader><PanelLabel className="text-ink">Accounts</PanelLabel></PanelHeader>
        <div className="px-3 py-3">
          <ActionFailure
            busy={busy}
            detail={problem}
            title="Hivemind could not read the account choices"
            onRetry={() => void load()}
          />
        </div>
      </Panel>
    );
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

  const switchableHarnesses = Object.keys(view.switchable).sort();

  const chooseHome = async (): Promise<void> => {
    try {
      const selected = await invoke<string | null>("choose_project_folder", { initialPath: homeDir });
      if (selected !== null) setHomeDir(selected);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const addAccount = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (label.trim() === "" || harness === "" || homeDir.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      setView(await onAction<AccountsView>({
        type: "accounts.add",
        payload: { label: label.trim(), harness, home_dir: homeDir.trim() }
      }));
      setAdding(false);
      setLabel("");
      setHomeDir("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <PanelLabel className="text-ink">Accounts</PanelLabel>
        <PanelCount>{view.accounts.length}</PanelCount>
        {switchableHarnesses.length === 0 ? null : (
          <Button
            aria-label={adding ? "Close account form" : "Add an account"}
            className="ml-auto"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={() => {
              setAdding(!adding);
              setHarness(harness || switchableHarnesses[0] || "");
            }}
          >
            {adding ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
          </Button>
        )}
      </PanelHeader>
      <div className="grid gap-2.5 px-3 py-3">
        {adding ? (
          <form className="grid gap-2 rounded-md border border-rule bg-canvas p-2.5" onSubmit={(event) => void addAccount(event)}>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              Account name
              <input
                className="h-8 rounded-md border border-input bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20"
                disabled={busy}
                placeholder="Work account"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              Coding agent
              <select
                className="h-8 rounded-md border border-input bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20"
                disabled={busy}
                value={harness}
                onChange={(event) => setHarness(event.target.value)}
              >
                {switchableHarnesses.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              Agent account folder
              <span className="flex gap-1.5">
                <input
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-canvas px-2.5 font-mono text-[11px] text-ink outline-none focus:border-navy focus:ring-2 focus:ring-navy/20"
                  disabled={busy}
                  value={homeDir}
                  onChange={(event) => setHomeDir(event.target.value)}
                />
                <Button aria-label="Choose account folder" disabled={busy} size="icon-sm" type="button" variant="outline" onClick={() => void chooseHome()}>
                  <FolderOpen aria-hidden="true" />
                </Button>
              </span>
            </label>
            <Button
              className="justify-self-start"
              disabled={busy || label.trim() === "" || harness === "" || homeDir.trim() === ""}
              size="sm"
              type="submit"
            >
              {busy ? "Adding…" : "Add account"}
            </Button>
          </form>
        ) : null}
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

import { stat } from "node:fs/promises";
import path from "node:path";

import { ACCOUNT_HOME_VARIABLES, harnessForAgentId } from "./agent-catalogue.js";
import { writeJsonAtomic } from "./atomic.js";
import { readFile } from "node:fs/promises";

/**
 * Which account a provider runs as, without Hivemind ever holding a credential.
 *
 * Built for one reported failure: three days lost to an exhausted Codex quota
 * with nothing on screen saying so. Seeing the quota is half of it; being able
 * to switch to another account is the other half.
 *
 * **Hivemind never handles credentials.** It may launch one fixed harness-owned
 * `login` command, but the CLI and browser remain the sole credential owners.
 * Every harness keeps its own credentials in its own directory, written by
 * that provider-owned command.
 * An "account" here is therefore nothing but *a directory the harness already
 * owns*, named so a person can pick between them. Hivemind sets exactly one
 * environment variable to point the harness at one of its own homes, and that
 * is the entire mechanism. It never reads inside the directory, never writes
 * one, and never sees a token.
 *
 * The variable names live in `agent-catalogue.ts`, which is the file allowed to
 * know how to start a provider — including which of its own homes to start it
 * against. They are measured rather than assumed; that table records where each
 * was confirmed. This module holds the MECHANISM and names no provider at all.
 *
 *
 * That table is the allowlist. Anything not in it is refused, which is what
 * keeps this from becoming a general "set any environment variable" hole — and
 * in particular keeps it away from `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY` and
 * friends, which sit right next to these names in the same binaries and are
 * exactly what "no credential handling in the client" forbids.
 */

export interface ProviderAccount {
  id: string;
  /** What a person calls it. "work", "personal" — theirs, not ours. */
  label: string;
  /** The harness this account belongs to, e.g. `codex`. */
  harness: string;
  /** The harness's own home directory. Hivemind points at it, never into it. */
  home_dir: string;
  added_at: string;
}

export interface AccountsFile {
  version: 1;
  accounts: ProviderAccount[];
  /**
   * Which account each HARNESS currently runs as, by account id.
   *
   * Keyed by harness rather than by role, for a reason that is not cosmetic:
   * the only thing known at the moment a provider process is spawned is its
   * profile's `tool`. Keying by role would leave the spawn unable to resolve an
   * account without every call site threading one through -- eight call sites,
   * each able to forget. Keyed by harness, `runAdapterProcess` resolves it
   * itself and nothing can bypass it.
   *
   * It also matches the question a person actually asks: "which Codex account
   * is this project using", not "which account does the planner use".
   */
  selected: Record<string, string>;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };


/* Names that carry a secret rather than select a home. Listed explicitly and
   refused by name as well as by absence from the allowlist, because a rule
   enforced only by an allowlist is one careless widening away from gone. */
const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "CODEX_API_KEY",
  "AWS_SECRET_ACCESS_KEY"
];

export function accountHomeVariable(harness: string): string | null {
  return ACCOUNT_HOME_VARIABLES[harness.toLowerCase()] ?? null;
}

export function isCredentialVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    CREDENTIAL_VARIABLES.includes(upper) ||
    /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/u.test(upper)
  );
}

function accountsPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "adapters", "accounts.json");
}

export async function readAccounts(repoRoot: string): Promise<AccountsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(accountsPath(repoRoot), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return emptyAccounts();
    const record = parsed as Partial<AccountsFile>;
    return {
      version: 1,
      accounts: Array.isArray(record.accounts) ? record.accounts.filter(isAccount) : [],
      selected:
        typeof record.selected === "object" && record.selected !== null
          ? (record.selected as Record<string, string>)
          : {}
    };
  } catch {
    return emptyAccounts();
  }
}

function emptyAccounts(): AccountsFile {
  return { version: 1, accounts: [], selected: {} };
}

/**
 * Register one of the harness's own homes under a name.
 *
 * Validated as *a directory that exists*, and nothing more — Hivemind does not
 * look inside to see whether it holds a login, because looking inside is the
 * thing it has promised not to do. A directory with no credential in it simply
 * fails at the harness's own auth step, with the harness's own message, which
 * is where that failure belongs.
 */
export async function addAccount(
  repoRoot: string,
  input: { label: string; harness: string; home_dir: string }
): Promise<Result<ProviderAccount>> {
  const variable = accountHomeVariable(input.harness);
  if (variable === null) {
    return {
      ok: false,
      reason: `Hivemind does not know how to select an account for ${input.harness}; the harnesses it can are ${Object.keys(ACCOUNT_HOME_VARIABLES).join(", ")}`
    };
  }
  if (input.label.trim() === "") return { ok: false, reason: "an account needs a name you will recognise" };

  let stats;
  try {
    stats = await stat(input.home_dir);
  } catch {
    return { ok: false, reason: `there is no directory at ${input.home_dir}` };
  }
  if (!stats.isDirectory()) return { ok: false, reason: `${input.home_dir} is not a directory` };

  const file = await readAccounts(repoRoot);
  const existing = file.accounts.find(
    (account) =>
      account.harness === input.harness &&
      path.resolve(account.home_dir) === path.resolve(input.home_dir)
  );
  if (existing !== undefined) {
    return { ok: false, reason: `that directory is already registered as "${existing.label}"` };
  }
  const account: ProviderAccount = {
    id: `A-${input.harness}-${file.accounts.length + 1}-${Date.now().toString(36)}`,
    label: input.label.trim(),
    harness: input.harness,
    home_dir: path.resolve(input.home_dir),
    added_at: new Date().toISOString()
  };
  file.accounts.push(account);
  await writeJsonAtomic(accountsPath(repoRoot), file);
  return { ok: true, value: account };
}

/**
 * Point a role at a different account.
 *
 * **This invalidates that role's capability verification, and that is the
 * point.** See `docs/PROVIDER-DISCOVERY.md`: a probe result is evidence about
 * the tool, the profile *and the account it ran under*. A different plan can
 * mean a different set of models available to pin, and can change whether the
 * harness reports usage at all — so carrying a verification across a switch
 * would assert something nobody measured. That is the version-staleness rule
 * in a different hat, and it is answered the same way: mark it stale and ask
 * for a reconnect rather than run on a verification that no longer refers to
 * what is running.
 */
export async function selectAccount(
  repoRoot: string,
  accountId: string
): Promise<Result<{ account: ProviderAccount; invalidated: boolean }>> {
  const file = await readAccounts(repoRoot);
  const account = file.accounts.find((entry) => entry.id === accountId);
  if (account === undefined) return { ok: false, reason: "no such account" };

  const previous = file.selected[account.harness] ?? null;
  file.selected[account.harness] = accountId;
  await writeJsonAtomic(accountsPath(repoRoot), file);
  return { ok: true, value: { account, invalidated: previous !== accountId } };
}

/** The account a harness runs as, or null when nobody has chosen one. */
export function selectedAccount(file: AccountsFile, harness: string | null): ProviderAccount | null {
  if (harness === null) return null;
  const id = file.selected[harness];
  if (id === undefined) return null;
  return file.accounts.find((entry) => entry.id === id) ?? null;
}

/** Resolve straight from a repo and a tool name, for the spawn path. */
export async function accountEnvironmentForTool(
  repoRoot: string,
  tool: string
): Promise<Record<string, string>> {
  const file = await readAccounts(repoRoot);
  /* `tool` is the ROLE, so the harness has to be looked up through the
     connection record. Passing the role straight in matched no harness and
     silently applied no account at all -- the bug this indirection exists to
     prevent, and one the fixtures hid by writing a `tool` no real profile has. */
  return accountEnvironment(selectedAccount(file, await harnessForRole(repoRoot, tool)));
}

/** The harness a role is connected to, via its recorded agent. */
export async function harnessForRole(repoRoot: string, role: string): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(repoRoot, ".hivemind", "adapters", `${role}.connection.json`), "utf8")
    );
    if (typeof raw !== "object" || raw === null) return null;
    const agentId = (raw as { agent_id?: unknown }).agent_id;
    return harnessForAgentId(typeof agentId === "string" ? agentId : null);
  } catch {
    return null;
  }
}

/**
 * The environment additions for one account, or `{}` for none.
 *
 * The only function in this module that produces something a process will run
 * with, so it is the one that has to be airtight: exactly one variable, chosen
 * from the allowlist by harness, and refused outright if the resolved name
 * looks like a credential.
 */
export function accountEnvironment(account: ProviderAccount | null): Record<string, string> {
  if (account === null) return {};
  const variable = accountHomeVariable(account.harness);
  if (variable === null || isCredentialVariable(variable)) return {};
  return { [variable]: account.home_dir };
}

function isAccount(value: unknown): value is ProviderAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.harness === "string" &&
    typeof record.home_dir === "string"
  );
}

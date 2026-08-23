import { execFile } from "node:child_process";

import {
  PROVIDER_AUTHENTICATION_STATUS_SPECS,
  catalogueProviders,
  innerProviderStandingForAuthName,
  type InnerProviderStanding,
  type ProviderAuthenticationStatusSpec
} from "./agent-catalogue.js";
import {
  accountEnvironment,
  readAccounts,
  selectedAccount
} from "./provider-accounts.js";
import { spawnEnvironment } from "./spawn-environment.js";

const STATUS_TIMEOUT_MS = 5_000;
const MAX_STATUS_OUTPUT_BYTES = 64 * 1024;

export interface ProviderAuthenticationStanding {
  provider_id: string;
  status: "signed_in" | "signed_out" | "unknown";
  detail: string;
  /**
   * For a multiplier harness that lists its own sign-ins: which vendors those
   * sign-ins reach, with each vendor's recorded sanction. Only names matching
   * Hivemind's own registry cross this boundary — anything user-configured
   * and unrecognised is COUNTED, never carried, so account names and raw
   * provider output still never leave this module.
   */
  reaches?: { providers: InnerProviderStanding[]; unrecognised: number } | null;
}

export interface ProviderAuthenticationStatusView {
  providers: ProviderAuthenticationStanding[];
}

interface AuthenticationStatusProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason: string | null;
}

export type AuthenticationStatusRunner = (
  spec: ProviderAuthenticationStatusSpec,
  context: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<AuthenticationStatusProcessResult>;

/**
 * Ask provider CLIs for login standing without reading their credential stores.
 * Output is reduced to a tri-state; account names, email addresses, tokens and
 * raw provider output never cross this boundary.
 */
export async function inspectProviderAuthentication(
  repoRoot: string,
  options: { runner?: AuthenticationStatusRunner } = {}
): Promise<ProviderAuthenticationStatusView> {
  const accounts = await readAccounts(repoRoot);
  const runner = options.runner ?? runAuthenticationStatusProcess;
  const providers = await Promise.all(
    catalogueProviders().map(async (provider): Promise<ProviderAuthenticationStanding> => {
      const spec = PROVIDER_AUTHENTICATION_STATUS_SPECS[provider.id];
      if (spec === undefined) {
        return {
          provider_id: provider.id,
          status: "unknown",
          detail: "This provider CLI does not publish a safe login-status command."
        };
      }
      const chosen = selectedAccount(accounts, provider.id);
      const result = await runner(spec, {
        cwd: repoRoot,
        env: spawnEnvironment(process.env, accountEnvironment(chosen))
      });
      if (!result.ok) {
        const combined = `${result.stdout}\n${result.stderr}`;
        if (/not logged in|not authenticated|signed out/iu.test(combined)) {
          return signedOut(provider.id);
        }
        return {
          provider_id: provider.id,
          status: "unknown",
          detail: result.reason ?? "The provider CLI did not report its login status."
        };
      }
      /* Codex on Windows writes its successful `login status` sentence to
         stderr through the .cmd wrapper. Both streams are provider-owned
         status output and neither crosses this boundary, so parse both. */
      return parseAuthenticationStatus(
        provider.id,
        spec.kind,
        `${result.stdout}\n${result.stderr}`
      );
    })
  );
  return { providers };
}

export function parseAuthenticationStatus(
  providerId: string,
  kind: ProviderAuthenticationStatusSpec["kind"],
  output: string
): ProviderAuthenticationStanding {
  if (kind === "login-text") {
    if (/^logged in\b/imu.test(output)) return signedIn(providerId);
    if (/not logged in|signed out/iu.test(output)) return signedOut(providerId);
    return unknown(providerId);
  }
  if (kind === "logged-in-json") {
    try {
      const parsed: unknown = JSON.parse(output);
      if (isRecord(parsed) && typeof parsed.loggedIn === "boolean") {
        return parsed.loggedIn ? signedIn(providerId) : signedOut(providerId);
      }
    } catch {
      return unknown(providerId);
    }
    return unknown(providerId);
  }
  const plain = output.replaceAll(/\u001b\[[0-9;]*m/gu, "");
  const match = /\b(\d+) credentials?\b/iu.exec(plain);
  if (match === null) return unknown(providerId);
  const standing = Number(match[1]) > 0 ? signedIn(providerId) : signedOut(providerId);
  /* Environment-variable entries are sign-ins too — a key in the environment
     reaches its vendor exactly as a stored credential does — so both sections'
     bullet lines are read. Measured against `opencode auth list` on 1.18.x:
     each entry is one bullet line, name first, kind or variable name last. */
  const reached = new Map<string, InnerProviderStanding>();
  let unrecognised = 0;
  for (const line of plain.split(/\r?\n/u)) {
    const entry = /^[^\p{L}\p{N}]*[•·]\s+(.+)$/u.exec(line.trim());
    if (entry === null) continue;
    const words = entry[1]!.trim().split(/\s+/u);
    const name = (words.length > 1 ? words.slice(0, -1) : words).join(" ");
    if (name === "") continue;
    const known = innerProviderStandingForAuthName(name);
    if (known === null) unrecognised += 1;
    else reached.set(known.id, known);
  }
  return reached.size === 0 && unrecognised === 0
    ? standing
    : { ...standing, reaches: { providers: [...reached.values()], unrecognised } };
}

function signedIn(providerId: string): ProviderAuthenticationStanding {
  return {
    provider_id: providerId,
    status: "signed_in",
    detail: "The provider CLI reports an active sign-in."
  };
}

function signedOut(providerId: string): ProviderAuthenticationStanding {
  return {
    provider_id: providerId,
    status: "signed_out",
    detail: "The provider CLI reports that it is not signed in."
  };
}

function unknown(providerId: string): ProviderAuthenticationStanding {
  return {
    provider_id: providerId,
    status: "unknown",
    detail: "The provider CLI returned an unrecognised login-status response."
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runAuthenticationStatusProcess(
  spec: ProviderAuthenticationStatusSpec,
  context: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<AuthenticationStatusProcessResult> {
  return new Promise((resolve) => {
    const [command, ...args] = spec.invocation;
    execFile(
      command,
      args,
      {
        cwd: context.cwd,
        env: context.env,
        encoding: "utf8",
        maxBuffer: MAX_STATUS_OUTPUT_BYTES,
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout,
          stderr,
          reason:
            error === null
              ? null
              : error.message.includes("ENOENT")
                ? "The provider CLI is not installed or is not on PATH."
                : error.killed
                  ? "The provider login-status check took too long and was stopped."
                  : "The provider CLI could not report its login status."
        });
      }
    );
  });
}

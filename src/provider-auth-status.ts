import { execFile } from "node:child_process";

import {
  PROVIDER_AUTHENTICATION_STATUS_SPECS,
  catalogueProviders,
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
  return Number(match[1]) > 0 ? signedIn(providerId) : signedOut(providerId);
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

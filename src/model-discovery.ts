import { spawn } from "node:child_process";

import {
  MODEL_DISCOVERY_SPECS,
  catalogueProviders,
  judgeInnerProvider,
  validDiscoveredModelSlug,
  type InnerProviderStanding,
  type ModelDiscoverySpec
} from "./agent-catalogue.js";
import {
  accountEnvironment,
  readAccounts,
  selectedAccount
} from "./provider-accounts.js";
import { terminateProcessTreeAndVerify } from "./process-control.js";
import { spawnEnvironment } from "./spawn-environment.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_OUTPUT_BYTES = 1_000_000;

export interface DiscoveredModel {
  slug: string;
  label: string;
  /**
   * For a multiplier harness, whose service this slug's requests go to and
   * whether that vendor sanctions the path. Null on integrated harnesses.
   */
  inner_provider: InnerProviderStanding | null;
  /**
   * False exactly when the inner provider is prohibited. The picker must not
   * offer it, and `adapter.connect` refuses it independently — the flag is
   * presentation, the gate is the mechanism.
   */
  selectable: boolean;
}

export interface ProviderModelDiscovery {
  provider_id: string;
  status: "detected" | "empty" | "unavailable";
  models: DiscoveredModel[];
  source: string;
  detail: string;
}

export interface ModelDiscoveryView {
  providers: ProviderModelDiscovery[];
}

export interface DiscoveryProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason: string | null;
}

export type ModelDiscoveryRunner = (
  spec: ModelDiscoverySpec,
  context: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<DiscoveryProcessResult>;

/**
 * Ask each installed CLI which model identifiers it presently publishes.
 *
 * This is deliberately a read-only CLI boundary. No credential file is read,
 * no model prompt is sent, and output/runtime are bounded. A selected provider
 * home is passed through the same allowlisted environment mechanism as a real
 * connection so the answer belongs to the account that project would use.
 */
export async function discoverProviderModels(
  repoRoot: string,
  options: { runner?: ModelDiscoveryRunner } = {}
): Promise<ModelDiscoveryView> {
  const accounts = await readAccounts(repoRoot);
  const runner = options.runner ?? runDiscoveryProcess;
  const providers = await Promise.all(
    catalogueProviders().map(async (provider): Promise<ProviderModelDiscovery> => {
      const spec = MODEL_DISCOVERY_SPECS[provider.id];
      if (spec === undefined) {
        return {
          provider_id: provider.id,
          status: "unavailable",
          models: [],
          source: "No model-list contract in this build",
          detail: "This Hivemind build does not know a no-cost way to ask this CLI for models."
        };
      }
      const chosen = selectedAccount(accounts, provider.id);
      const result = await runner(spec, {
        cwd: repoRoot,
        env: spawnEnvironment(process.env, accountEnvironment(chosen))
      });
      if (!result.ok) {
        return {
          provider_id: provider.id,
          status: "unavailable",
          models: [],
          source: spec.source,
          detail: result.reason ?? "The installed CLI did not return a model list."
        };
      }
      let models: DiscoveredModel[];
      try {
        models = parseDiscoveryOutput(spec.kind, result.stdout).map((model) => {
          /* Judged per slug so the picker can say, before anything is picked,
             whose service a model reaches and whether that vendor sanctions
             the path. `selectable: false` is presentation only — the connect
             action re-judges and refuses on its own. */
          const judgement = judgeInnerProvider(provider.id, model.slug);
          return {
            ...model,
            inner_provider: judgement.standing,
            selectable: judgement.refusal === null
          };
        });
      } catch (cause) {
        return {
          provider_id: provider.id,
          status: "unavailable",
          models: [],
          source: spec.source,
          detail: `The installed CLI returned a model list Hivemind could not read: ${cause instanceof Error ? cause.message : String(cause)}`
        };
      }
      return models.length === 0
        ? {
            provider_id: provider.id,
            status: "empty",
            models: [],
            source: spec.source,
            detail:
              spec.emptyDetail ??
              "The installed CLI returned no selectable models for this account."
          }
        : {
            provider_id: provider.id,
            status: "detected",
            models,
            source: spec.source,
            detail: `${models.length} model${models.length === 1 ? "" : "s"} detected without running a model.`
          };
    })
  );
  return { providers };
}

export function parseDiscoveryOutput(
  kind: ModelDiscoverySpec["kind"],
  output: string
): Array<Pick<DiscoveredModel, "slug" | "label">> {
  const models: Array<Pick<DiscoveredModel, "slug" | "label">> = [];
  if (kind === "app-server") {
    const parsed: unknown = JSON.parse(output);
    const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
    for (const entry of data) {
      if (!isRecord(entry) || entry.hidden === true || typeof entry.model !== "string") continue;
      models.push({
        slug: entry.model,
        label: typeof entry.displayName === "string" ? entry.displayName : entry.model
      });
    }
    return uniqueValidModels(models);
  }
  if (kind === "help-aliases") {
    const start = output.indexOf("alias for the latest model");
    const end = output.indexOf("model's full name", Math.max(0, start));
    const scope = start >= 0 ? output.slice(start, end > start ? end : start + 500) : "";
    for (const match of scope.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._:/-]*)['"]/gu)) {
      models.push({ slug: match[1]!, label: titleCase(match[1]!) });
    }
    return uniqueValidModels(models);
  }
  if (kind === "line-list") {
    for (const line of output.split(/\r?\n/gu)) {
      const slug = line.trim();
      if (validDiscoveredModelSlug(slug)) models.push({ slug, label: slug });
    }
    return uniqueValidModels(models);
  }
  if (kind === "headed-list") {
    const list = output.split("Available models:")[1] ?? "";
    for (const line of list.split(/\r?\n/gu)) {
      const match = /^\s*[/*-]\s+([^\s(]+)/u.exec(line);
      if (match !== null) models.push({ slug: match[1]!, label: match[1]! });
    }
    return uniqueValidModels(models);
  }
  const parsed: unknown = JSON.parse(output);
  const configured = isRecord(parsed) && isRecord(parsed.models) ? parsed.models : {};
  for (const [alias, value] of Object.entries(configured)) {
    const resolved = isRecord(value) && typeof value.model === "string" ? value.model : alias;
    models.push({ slug: alias, label: alias === resolved ? alias : `${alias} · ${resolved}` });
  }
  return uniqueValidModels(models);
}

function uniqueValidModels(
  models: Array<Pick<DiscoveredModel, "slug" | "label">>
): Array<Pick<DiscoveredModel, "slug" | "label">> {
  const unique = new Map<string, Pick<DiscoveredModel, "slug" | "label">>();
  for (const model of models) {
    if (!validDiscoveredModelSlug(model.slug) || unique.has(model.slug)) continue;
    unique.set(model.slug, model);
  }
  return [...unique.values()];
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

async function runDiscoveryProcess(
  spec: ModelDiscoverySpec,
  context: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<DiscoveryProcessResult> {
  return new Promise((resolve) => {
    const [command, ...args] = spec.invocation;
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: context.cwd,
      env: context.env,
      detached,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopping = false;
    let appResponseReceived = false;
    let appBuffer = "";

    const stopTree = async (): Promise<void> => {
      if (child.pid === undefined) return;
      await terminateProcessTreeAndVerify({
        pid: child.pid,
        process_instance_id: `model-discovery-${child.pid}`,
        process_group_id: detached ? child.pid : null
      });
    };
    const finish = (result: DiscoveryProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const stopAndFinish = (result: DiscoveryProcessResult): void => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timeout);
      void stopTree()
        .then(() => finish(result))
        .catch((cause: unknown) =>
          finish({
            ok: false,
            stdout,
            stderr,
            reason: `${result.reason ?? "Model discovery finished, but its process remained live"}: ${cause instanceof Error ? cause.message : String(cause)}`
          })
        );
    };
    const failAndStop = (reason: string): void => {
      stopAndFinish({ ok: false, stdout, stderr, reason });
    };
    const timeout = setTimeout(
      () => failAndStop("Model discovery took too long and was stopped."),
      DISCOVERY_TIMEOUT_MS
    );

    child.once("error", (error) => {
      if (settled || stopping) return;
      finish({
        ok: false,
        stdout,
        stderr,
        reason: error.message.includes("ENOENT")
          ? "This provider CLI is not installed or is not on the app's PATH."
          : `Could not start the provider CLI: ${error.message}`
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_DISCOVERY_OUTPUT_BYTES) {
        failAndStop("The provider CLI returned too much diagnostic output, so discovery was stopped.");
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (Buffer.byteLength(stdout, "utf8") > MAX_DISCOVERY_OUTPUT_BYTES) {
        failAndStop("The provider CLI returned too much model data, so discovery was stopped.");
        return;
      }
      if (spec.kind !== "app-server") return;
      appBuffer += text;
      for (;;) {
        const newline = appBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = appBuffer.slice(0, newline).trim();
        appBuffer = appBuffer.slice(newline + 1);
        if (line === "") continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          failAndStop("The app server returned an unreadable response.");
          return;
        }
        if (!isRecord(message)) continue;
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: {} })}\n`);
        }
        if (message.id === 2) {
          if (!isRecord(message.result)) {
            failAndStop("The app server did not return a model/list result.");
            return;
          }
          appResponseReceived = true;
          const resultText = JSON.stringify(message.result);
          stopAndFinish({ ok: true, stdout: resultText, stderr, reason: null });
          return;
        }
      }
    });
    child.once("close", (code) => {
      if (settled || stopping || spec.kind === "app-server") {
        if (!settled && spec.kind === "app-server" && !appResponseReceived) {
          finish({
            ok: false,
            stdout,
            stderr,
            reason: `Model discovery ended before model/list replied${code === null ? "" : ` (exit ${code})`}.`
          });
        }
        return;
      }
      finish(
        code === 0
          ? { ok: true, stdout, stderr, reason: null }
          : {
              ok: false,
              stdout,
              stderr,
              reason: `The provider CLI could not list models${code === null ? "" : ` (exit ${code})`}.`
            }
      );
    });

    if (spec.kind === "app-server") {
      child.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "hivemind_model_discovery",
              title: "Hivemind model discovery",
              version: "1.0.0"
            }
          }
        })}\n`
      );
    } else {
      child.stdin.end();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

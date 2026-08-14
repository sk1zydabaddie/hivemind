import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNT_HOME_VARIABLES,
  ENDPOINT_SURFACE,
  HARNESS_DEFAULT_HOME
} from "./agent-catalogue.js";

/**
 * Where a harness actually sends your code.
 *
 * The contract's blind spot until 2026-08-14. Every one of the eight other
 * capabilities is about what an agent may DO — which flags it carries, where it
 * may write, whether it commits. None of them asked **where the prompt goes**,
 * and a prompt carries the contents of every file in the task's scope.
 *
 * `ANTHROPIC_BASE_URL`, Codex's `model_providers[].base_url`, OpenCode's
 * `baseURL`: set any of them and the agent talks to that host instead of the
 * vendor's. Every existing capability still reads `verified`. Nothing noticed.
 *
 * **This is not a local-model concern.** Anyone who has set one of those
 * variables is in this state today and was before local models came up. Local
 * models make it common; they did not make it possible.
 *
 * ## What can actually be determined, stated honestly
 *
 * The obvious design is to read the endpoint back from the harness's own
 * startup report, the way `pins_one_model` reads the model. **That is not
 * available.** Codex's `turn_context` — the richest readback any of these
 * harnesses produces — carries the model, the sandbox, the approval policy and
 * the workspace roots, and no endpoint at all. Checked in the shipped binary
 * rather than assumed.
 *
 * The per-harness table lives in `agent-catalogue.ts`, which is the file
 * allowed to know how to start a provider -- and which endpoint it starts
 * against is startup knowledge, the same argument that put the account
 * variables there. This module holds the MECHANISM and names no provider.
 *
 * So this is determined from **configuration**, and the evidence class says so:
 * `static`, not `readback`. Three inputs, in the order they override:
 *
 * 1. the profile's own argv, which Hivemind holds;
 * 2. the environment the process will be spawned with;
 * 3. the harness's own configuration file, in the home it will run against.
 *
 * The absence of an override across all three is a positive finding: the
 * harness uses its vendor default, and that default is known. The presence of
 * one is also a positive finding — it names a host. Only *not being able to
 * look* is unknown.
 *
 * ## Why unknown refuses
 *
 * Because "Hivemind cannot tell you where your code is going" is not a
 * degradation anyone can accept on your behalf. It is the same asymmetry as
 * `confined_to_project`: being wrong is unbounded, so unsure fails closed. A
 * harness Hivemind does not know how to inspect is refused rather than run
 * hopefully.
 */

export type EndpointStanding =
  /** No override anywhere: the vendor's own documented endpoint. */
  | "vendor_default"
  /** An override is configured. Not a violation — but it must be named. */
  | "configured"
  /** Hivemind cannot inspect this harness. Refuses. */
  | "unknown";

export interface EndpointFinding {
  standing: EndpointStanding;
  /** The host your code goes to, where one could be determined. */
  host: string | null;
  /** Where that was found: argv, environment, or the harness's own config. */
  source: "argv" | "environment" | "harness_config" | "vendor_default" | null;
  /** One sentence for a person, in the product's voice. */
  detail: string;
}


/** Whether Hivemind knows how to inspect this harness at all. */
export function endpointSurfaceKnown(tool: string): boolean {
  return Object.hasOwn(ENDPOINT_SURFACE, tool.toLowerCase());
}

/**
 * Determine where a harness will send prompts.
 *
 * `environment` is the environment the process will actually be spawned with,
 * not `process.env` read here — the account mechanism can change the home the
 * harness reads its config from, and an endpoint determined against the wrong
 * home would be worse than none.
 */
export async function resolveProviderEndpoint(input: {
  tool: string;
  invoke: string[];
  environment: NodeJS.ProcessEnv;
}): Promise<EndpointFinding> {
  const surface = ENDPOINT_SURFACE[input.tool.toLowerCase()];
  if (surface === undefined) {
    return {
      standing: "unknown",
      host: null,
      source: null,
      detail: `Hivemind does not know how to check where ${input.tool} sends your code, so it will not run it.`
    };
  }

  /* 1. argv, which Hivemind holds and can read exactly. */
  const flag = surface.flags.find((entry) => input.invoke.includes(entry));
  if (flag !== undefined) {
    const at = input.invoke.indexOf(flag);
    const named = input.invoke[at + 1];
    const host = flag === "--oss" ? (named ?? "a local model") : (named ?? "a local provider");
    return {
      standing: "configured",
      host,
      source: "argv",
      detail: `This agent is pointed at ${host} rather than its vendor. Your code goes there.`
    };
  }

  /* 2. the environment it will be spawned with. */
  for (const variable of surface.variables) {
    const value = input.environment[variable];
    if (value === undefined || value.trim() === "") continue;
    return {
      standing: "configured",
      host: hostOf(value),
      source: "environment",
      detail: `${variable} is set, so this agent sends your code to ${hostOf(value)} rather than to its vendor.`
    };
  }

  /* 3. the harness's own config, in the home it will actually read. */
  const home = homeFor(input.tool, input.environment);
  if (surface.configFile !== null && home !== null) {
    const found = await findConfiguredUrl(
      path.join(home, surface.configFile),
      surface.configKeys
    );
    if (found === "unreadable") {
      return {
        standing: "unknown",
        host: null,
        source: null,
        detail: `Hivemind could not read ${input.tool}'s own configuration, so it cannot tell where your code would be sent.`
      };
    }
    if (found !== null) {
      return {
        standing: "configured",
        host: hostOf(found),
        source: "harness_config",
        detail: `${input.tool}'s own configuration points it at ${hostOf(found)}. Your code goes there.`
      };
    }
  }

  return {
    standing: "vendor_default",
    host: surface.vendorHost,
    source: "vendor_default",
    detail: `Nothing repoints this agent, so it sends your code to ${surface.vendorHost}.`
  };
}

/* The home the harness reads its config from -- which the account mechanism
   may have changed. Resolved from the same variable that selects an account, so
   the two cannot disagree. */
function homeFor(harness: string, environment: NodeJS.ProcessEnv): string | null {
  const variable = ACCOUNT_HOME_VARIABLES[harness.toLowerCase()];
  if (variable === undefined) return null;
  const configured = environment[variable];
  if (configured !== undefined && configured.trim() !== "") return configured;
  const home = environment.USERPROFILE ?? environment.HOME;
  if (home === undefined) return null;
  /* A harness's default home is not always its name -- the table lives in the
     catalogue with the rest of the how-to-start-it knowledge. */
  const dir = HARNESS_DEFAULT_HOME[harness.toLowerCase()];
  return dir === undefined ? null : path.join(home, dir);
}

/**
 * A URL under any of the given keys, `null` for "the file says nothing",
 * `"unreadable"` for "the file exists and could not be parsed".
 *
 * The distinction matters: a file that is not there means no override, and a
 * file that cannot be read means we do not know — and those get opposite
 * answers.
 */
async function findConfiguredUrl(
  file: string,
  keys: string[]
): Promise<string | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    /* Absent is a real answer. Anything else is not. */
    return isMissing(error) ? null : "unreadable";
  }
  for (const key of keys) {
    /* Deliberately textual rather than a TOML/JSON parse: these files come in
       three formats across three harnesses, and a parser that fails on an
       unfamiliar dialect would report "no override" for a file that has one.
       A regex over the raw text errs toward FINDING an override, which is the
       safe direction here. */
    const match = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, "iu").exec(text);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The host part, for showing a person. Falls back to the whole value. */
function hostOf(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

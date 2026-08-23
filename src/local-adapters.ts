import { mkdir } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { describeCapabilityCorpus } from "./capability-corpus.js";
import type { AdapterProfile } from "./adapter.js";

/**
 * The tier ladder this repository runs on, written for the platform it is
 * written on.
 *
 * These three profiles used to be committed. That made the repository
 * platform-biased in a way nothing caught until a Linux checkout: the files
 * named `cmd.exe`, so a Linux clone held three adapter profiles it could never
 * spawn. It was also the same mistake `project.init` already refuses to make --
 * a profile on disk that no probe has checked is a declaration, not a fact.
 *
 * So the ladder stays in Core, where `profileSpecs` already owns the model
 * pins, tiers and cost ranks, and only the argv is computed here. One source of
 * truth, and the part that differs between machines is generated on the machine
 * it is for.
 *
 * A person's own project does not use this at all -- `adapter.connect` writes
 * their profiles and probes them first. This exists because Hivemind's own
 * repository is also a Hivemind project, and its corpus needs the ladder.
 */
export function corpusInvoke(model: string): string[] {
  const args = [
    "exec",
    "--model",
    model,
    "--sandbox",
    "workspace-write",
    /* The `-c model_reasoning_effort` override that used to sit here was
       measured inert on 2026-08-23 -- accepted, self-reported as applied, and
       echoed in the event stream while having no effect. Every corpus number
       taken while it was here, the 212K call included, was therefore measured
       at Codex's own default effort rather than at "pinned high". Removed
       rather than replaced: see codexInvoke in agent-catalogue.ts for the
       mechanism that would actually apply it and why it waits for behavioural
       proof. */
    "--ephemeral",
    "--json",
    "-"
  ];
  /* Windows installs `codex.cmd` and cannot spawn it without an interpreter;
     every other platform installs an executable `codex` on PATH. */
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "codex.cmd", ...args]
    : ["codex", ...args];
}

export function corpusProfile(tool: string, model: string, routingTier: string, costRank: number): AdapterProfile {
  return {
    tool,
    invoke: corpusInvoke(model),
    prompt_arg: "stdin",
    verified_on: "generated-for-this-platform",
    context_window: 272_000,
    timeout_ms: 900_000,
    routing_tier: routingTier as AdapterProfile["routing_tier"],
    cost_rank: costRank,
    usage_parser: "codex-jsonl"
  };
}

/** Writes the ladder into `<repoRoot>/.hivemind/adapters`. */
export async function writeLocalAdapterProfiles(repoRoot: string): Promise<string[]> {
  const dir = path.join(repoRoot, ".hivemind", "adapters");
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const spec of describeCapabilityCorpus().profiles) {
    const profile = corpusProfile(spec.tool, spec.model, spec.routing_tier, spec.cost_rank);
    await writeJsonAtomic(path.join(dir, `${spec.tool}.profile.json`), profile);
    written.push(spec.tool);
  }
  return written;
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { HARNESS_CONFIG_INPUTS, HARNESS_DEFAULT_HOME } from "./agent-catalogue.js";

/**
 * A fingerprint of everything the harness reads that Hivemind does not write.
 *
 * ## The hole this closes
 *
 * The probe verifies at connect time. User configuration can change one minute
 * later with no version change at all, so `provider_version` is unmoved,
 * `capabilities_stale` never fires, and the record still reads `verified` while
 * the thing that actually runs is governed by settings nobody measured.
 *
 * The sequence, concretely: probe at 10:00 against a clean config; add a
 * `UserPromptSubmit` hook at 10:05; every run after that has its prompt
 * rewritten before the model reads it, under a verdict earned at 10:00.
 *
 * ## Why a digest rather than a re-probe
 *
 * Re-probing on a schedule costs a paid call per interval and still cannot see
 * a change made a minute after it runs. A digest is exact, and it is nearly
 * free here because the file access already happens: `provider-endpoint.ts`
 * opens each harness's own config at connect time to look for an endpoint
 * override. This reads the same files.
 *
 * ## Absent files are part of the fingerprint
 *
 * A missing file hashes as `absent` rather than being skipped, and that is the
 * direction that matters. The dangerous change is not editing a hook, it is
 * ADDING one — a `settings.local.json` that did not exist at connect time and
 * does now. Skipping absent files would make exactly that invisible.
 *
 * ## It fails toward re-probing, never toward refusing
 *
 * A changed digest means "the ground moved, check again", not "stop". The
 * capability contract refuses on unbounded uncertainty; this is bounded — the
 * remedy is one probe, and a person who has just edited their own settings on
 * purpose should be told, not blocked. An unreadable file is recorded as
 * unreadable and also asks for a re-probe, because not being able to look is
 * the one state that is never evidence of anything.
 *
 * ## What it cannot see, and that limit is permanent
 *
 * Server-delivered feature flags. Claude Code caches 502 of them in
 * `~/.claude.json` under `cachedGrowthBookFeatures`, refreshed from the vendor,
 * and behaviour changes with no version change and no config change. Hashing
 * that cache would fingerprint a value the vendor rotates rather than a choice
 * anybody made. See docs/STATE.md — the contract measures a moment, not a state.
 */

/** One file's contribution: its content hash, or why there is none. */
async function contribution(full: string): Promise<string> {
  try {
    const text = await readFile(full, "utf8");
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  } catch (cause) {
    /* Absent and unreadable are different facts and hash differently. A file
       that appears between two runs must change the digest; a file that became
       unreadable is a reason to look again, not the same as never existing. */
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/**
 * The digest to store beside `provider_version`, or null for a harness with no
 * known configuration surface.
 *
 * Null rather than an empty hash on purpose: "this harness has no inputs we
 * know how to watch" and "this harness's inputs are all absent" are different
 * claims, and only the second one is evidence.
 */
export async function harnessConfigDigest(
  repoRoot: string,
  /* Null when the role's harness cannot be resolved -- an adapter with no
     connection record yet. There is nothing to fingerprint and nothing to
     compare it against, which is not the same as a match. */
  harness: string | null,
  accountHome: string | null
): Promise<string | null> {
  if (harness === null) return null;
  const inputs = HARNESS_CONFIG_INPUTS[harness];
  if (inputs === undefined) return null;

  const home =
    accountHome ??
    (HARNESS_DEFAULT_HOME[harness] === undefined
      ? null
      : path.join(homeDirectory(), HARNESS_DEFAULT_HOME[harness]));

  const parts: string[] = [];
  for (const relative of inputs.project) {
    parts.push(`project:${relative}=${await contribution(path.join(repoRoot, relative))}`);
  }
  if (home !== null) {
    for (const relative of inputs.home) {
      parts.push(`home:${relative}=${await contribution(path.join(home, relative))}`);
    }
  }
  /* Sorted, so the digest depends on what the files say and not on the order
     this happened to read them in. */
  parts.sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/**
 * Why the recorded capabilities no longer describe what would run, or null.
 *
 * A record written before digests existed carries none, and that is a permanent
 * input rather than a transitional one: it reports "not recorded" instead of
 * pretending the configuration matches. Saying nothing there would be the
 * stronger claim and the false one.
 */
export function configStanding(recorded: string | null | undefined, current: string | null): string | null {
  if (recorded === null || recorded === undefined) return null;
  if (current === null) return null;
  if (recorded === current) return null;
  return "the settings this agent reads have changed since it was checked — hooks, instruction files or its own config. Reconnect to re-measure what it can do.";
}

function homeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

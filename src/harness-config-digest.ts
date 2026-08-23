import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNT_HOME_VARIABLES,
  HARNESS_CONFIG_INPUTS,
  HARNESS_DEFAULT_HOME,
  HOSTILE_HARNESS_SETTINGS,
  SHARED_INSTRUCTION_SOURCES
} from "./agent-catalogue.js";

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
 * ## Scoped to the PROJECT, not to one harness -- the correction
 *
 * This first hashed each harness's own files and nothing else, which was a
 * mitigation scoped to one component against an exposure that is shared. The
 * measurement that broke it: every harness reads every other harness's
 * instruction files. `CLAUDE.md` is not Claude Code's file, it is the
 * project's, and OpenCode obeys it.
 *
 * So the digest is now the union, computed once and stored on every record:
 * the shared instruction sources, plus every known harness's own config. A
 * change to any of them marks every harness's verdict stale.
 *
 * That over-stales on purpose. Editing `~/.codex/config.toml` will ask you to
 * reconnect an unrelated harness, and the alternative is a verdict that has
 * quietly stopped holding. The remedy for over-staling is one probe; the
 * remedy for under-staling is finding out later. Same asymmetry the contract
 * uses everywhere else, and it is also the honest position: Grok already reads
 * another harness's config directory, and nothing tells us which harness will
 * read which file two versions from now.
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
  /* Which home each harness will run against, when an account has been chosen
     for it. A function rather than a map so this module stays clear of the
     account machinery -- it needs the answer, not the mechanism. */
  homeFor: (harness: string) => string | null = () => null
): Promise<string> {
  const parts: string[] = [];

  /* The project's own instruction files, read ONCE rather than once per
     harness -- they are the same files, and every harness reads them. */
  for (const relative of SHARED_INSTRUCTION_SOURCES) {
    parts.push(`shared:${relative}=${await contribution(path.join(repoRoot, relative))}`);
  }

  for (const [harness, inputs] of Object.entries(HARNESS_CONFIG_INPUTS)) {
    for (const relative of inputs.project) {
      parts.push(
        `${harness}:project:${relative}=${await contribution(path.join(repoRoot, relative))}`
      );
    }
    const defaultHome = HARNESS_DEFAULT_HOME[harness];
    const home =
      homeFor(harness) ??
      (defaultHome === undefined ? null : path.join(homeDirectory(), defaultHome));
    if (home === null) continue;
    for (const relative of inputs.home) {
      parts.push(`${harness}:home:${relative}=${await contribution(path.join(home, relative))}`);
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
export function configStanding(
  recorded: string | null | undefined,
  current: string | null
): string | null {
  if (recorded === null || recorded === undefined) return null;
  if (current === null) return null;
  if (recorded === current) return null;
  return "the instruction files and harness settings this project runs against have changed since this agent was checked. Any harness reads any of them, so the change may not be to this one's own config. Reconnect to re-measure what it can do.";
}

function homeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

/**
 * Hostile settings in a harness's own config, found before anything spawns.
 *
 * The mechanism half of `HOSTILE_HARNESS_SETTINGS`: this module already opens
 * exactly these files for the digest, so detection costs one more read and no
 * provider call. It names no harness -- the spec does that -- and it reports
 * findings rather than deciding, so the refusal stays with the connect path
 * that owns every other refusal.
 *
 * Comment lines are stripped before matching, so a setting written down as an
 * example and left commented out does not refuse a connection. Absence of a
 * file is not a finding: a harness with no config has nothing hostile in it.
 */
export async function findHostileHarnessSettings(
  harness: string,
  homeDir: string | null
): Promise<Array<{ file: string; why: string; remedy: string }>> {
  const declared = HOSTILE_HARNESS_SETTINGS[harness];
  if (declared === undefined || declared.length === 0) return [];
  /* Three sources, in the order the HARNESS itself resolves them: the account
     home Hivemind will point it at, then that harness's own home variable if
     the environment already sets one, then its default. The middle one is not
     optional -- a check that reads a different directory from the one the
     harness will read is a check of nothing, and `adapter-probe` already
     resolves the rollout path the same way. */
  const variable = ACCOUNT_HOME_VARIABLES[harness];
  const fromEnvironment =
    variable === undefined ? undefined : process.env[variable]?.trim() || undefined;
  const defaultHome = HARNESS_DEFAULT_HOME[harness];
  const home =
    homeDir ??
    fromEnvironment ??
    (defaultHome === undefined ? null : path.join(homeDirectory(), defaultHome));
  if (home === null) return [];

  const found: Array<{ file: string; why: string; remedy: string }> = [];
  for (const setting of declared) {
    let text: string;
    try {
      text = await readFile(path.join(home, setting.file), "utf8");
    } catch {
      continue;
    }
    const active = text
      .split(/\r?\n/u)
      .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
      .join("\n");
    if (setting.pattern.test(active)) {
      found.push({ file: setting.file, why: setting.why, remedy: setting.remedy });
    }
  }
  return found;
}

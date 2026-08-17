import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HARNESS_PROJECT_CONFIG } from "./agent-catalogue.js";

/**
 * The project file a harness needs before its denial is a denial.
 *
 * ## The gap this closes
 *
 * `agent-catalogue.ts` said, in a comment, that OpenCode's shell denial "lives
 * in the project's own `opencode.json`, which `project.init` writes". Nothing
 * wrote it. The only two mentions of that filename in the whole repository were
 * that sentence and an unrelated table of which file to inspect for an endpoint
 * override.
 *
 * Measured in the Hivemind repository itself, which has no such file:
 *
 * ```
 * opencode agent list  ->  *: allow,  bash: (no rule),  task: (no rule)
 * ```
 *
 * A wildcard allow and no rule for the shell. So on any project Hivemind has
 * actually set up, OpenCode's shell was permitted.
 *
 * ## What was NOT wrong, and it matters
 *
 * The contract did not lie. `readOpenCodePermissions` reads the RESOLVED table
 * that `opencode agent list` prints, not the file and not the profile, so with
 * no rule present it returns `sandbox: null` and `subagents: "available"` --
 * the capability comes back unverified, and an unverified confinement is
 * refused rather than admitted. The measurement was right; there was simply
 * nothing to measure, and OpenCode could never have passed.
 *
 * That distinction is the reason this file writes the config instead of
 * downgrading the capability: the capability was already honest. What was
 * missing was the mechanism it was honestly reporting the absence of.
 *
 * ## Written at CONNECT, not at init
 *
 * Two reasons, both learned here. A file dropped into every project at init
 * would land in the repositories of people who have never installed OpenCode --
 * an unannounced write into somebody's source tree, which is the shape that put
 * `.hivemind/` into a git history unasked. And the probe reads the resolved
 * table during the connect it is part of, so the file has to exist before the
 * probe runs or the connect measures the state it was meant to create.
 *
 * ## Never overwritten
 *
 * Same rule as `ensureRequiredAdapterProfiles`: a file that already exists is
 * somebody's choice. If it is there and does not deny the shell, that is not
 * repaired silently -- the probe reads the resolved table, finds no denial, and
 * refuses. A person who has deliberately allowed the shell in their own
 * OpenCode config gets told, rather than edited.
 */

/** What `ensureHarnessProjectConfig` did, so the caller can say so. */
export interface HarnessConfigOutcome {
  /** The path written, relative to the repository root. Null when nothing was. */
  written: string | null;
  /** Present and left alone, which is a choice rather than a problem. */
  keptExisting: string | null;
  /** Why the write happened, for the connection to report. */
  because: string | null;
}

const NOTHING: HarnessConfigOutcome = { written: null, keptExisting: null, because: null };

/**
 * Put the file there if the harness needs one and the project has none.
 *
 * Deliberately does not verify its own write. The probe that runs immediately
 * after reads the resolved table and will report a denial that did not land --
 * checking here as well would be a second answer to the same question, and the
 * one worth trusting is the one that reads what the harness resolved rather
 * than what we wrote.
 */
export async function ensureHarnessProjectConfig(
  repoRoot: string,
  harness: string
): Promise<HarnessConfigOutcome> {
  const wanted = HARNESS_PROJECT_CONFIG[harness];
  if (wanted === undefined) return NOTHING;

  const full = path.join(repoRoot, wanted.file);
  try {
    await readFile(full, "utf8");
    return { written: null, keptExisting: wanted.file, because: null };
  } catch {
    /* Absent. Anything else -- a directory, a permission error -- throws from
       the write below, where the connect can refuse with the real reason. */
  }

  const contents =
    typeof wanted.contents === "string"
      ? wanted.contents.endsWith("\n") ? wanted.contents : `${wanted.contents}\n`
      : `${JSON.stringify(wanted.contents, null, 2)}\n`;
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return { written: wanted.file, keptExisting: null, because: wanted.because };
}

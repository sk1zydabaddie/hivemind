import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Which parts of `.hivemind/` are facts about the PROJECT and which are
 * evidence about a MACHINE.
 *
 * `.hivemind/` mixed two kinds of thing with different homes, and the mixture
 * was the defect. A team sharing a repository genuinely does want the same tier
 * globs, the same ceilings and the same promoted routing policy — those are
 * true regardless of whose laptop is open. A connection record is the opposite:
 * it proves capabilities were measured on one binary, at one version, under one
 * account, on one machine.
 *
 * Sharing the second kind is the capability contract accepting a declaration
 * again. The contract exists because a flag being ACCEPTED is not a flag being
 * APPLIED; a verdict arriving by `git pull` is the same category of claim, made
 * by somebody else's computer instead of by a config file.
 *
 * And it was the default, not a hazard somebody had to opt into: `initProject`
 * never wrote an ignore rule, and `initialize_git` — Hivemind's own first-run
 * button for an untracked folder — runs `git add -A`. Hivemind committed its
 * own machine evidence on behalf of the person who pressed it.
 *
 * ## What stays tracked, and why
 *
 * - `config.json` — tier globs, ceilings, the test command. Project facts.
 * - `canon/` — promoted routing policy and standing guidance. Decisions about
 *   the project, made deliberately, and worth arriving with a clone.
 *
 * ## What is ignored
 *
 * Everything else. Adapter profiles carry a platform-shaped argv (`cmd.exe …`
 * on Windows), which already left a Linux clone holding three profiles it could
 * never spawn; connection records are verdicts about one binary; `accounts.json`
 * holds absolute home directories; `daemon.json` names a pid and a port;
 * `resource/` is the spend ledger; and `worktrees/`, `leases/`, `intents/`,
 * `tasks/`, `patches/`, `integration/`, `replans/`, `orchestrator/`, `spec/`,
 * `probe/` and `cache/` are the live state of one run on one machine.
 *
 * ## `log/events.jsonl` — a decision, not a default
 *
 * **Ignored**, and this is the one genuinely arguable entry.
 *
 * The founding rule is that the trail must rebuild state. A trail merged from
 * two machines rebuilds a state that never existed: two runs that never
 * coexisted, interleaved by commit order, with leases and reservations from
 * both. That is worse than no history, because it is history that looks real.
 *
 * It is also append-only and shared-write, which is the single worst shape for
 * a file under version control — every concurrent run is a conflict.
 *
 * The cost is real and worth stating: a clone starts with no history, so
 * "what has this project done" is per-machine. Captured trails under
 * `docs/evidence/` are unaffected — those are deliberate artifacts, committed
 * on purpose, and they are how a run gets shared when somebody means to share
 * it.
 */
/**
 * The allowlist, deliberately, rather than a list of what to exclude.
 *
 * The first version of this was a denylist and it was already wrong when it was
 * written: `.hivemind/` has fifteen subdirectories — `integration`, `intents`,
 * `leases`, `orchestrator`, `probe`, `replans`, `spec` among them — and seven
 * of them were missing. A denylist has to be updated every time Core writes
 * somewhere new, and nothing fails when somebody forgets; the consequence is
 * silently sharing whatever the new directory holds.
 *
 * Inverting it makes the default safe. A directory added next year is not
 * shared until somebody decides it should be, which is the same closed-world
 * posture `validateConfig` already takes: an unrecognised key is refused rather
 * than passed through.
 */
export const SHARED_PROJECT_FACTS = [
  ".gitignore",
  "config.json",
  "canon/"
] as const;

const HEADER = [
  "# Written by `hivemind init`. Everything under .hivemind/ is ignored EXCEPT",
  "# the few things that are facts about this PROJECT rather than evidence",
  "# about one machine.",
  "#",
  "# Shared on purpose: config.json (tier globs, ceilings, test command) and",
  "# canon/ (promoted routing policy, standing guidance). A team wants those",
  "# identical.",
  "#",
  "# Everything else -- connection records, adapter profiles, accounts, the",
  "# daemon record, the spend ledger, leases, worktrees, the trail -- describes",
  "# ONE binary on ONE machine under ONE account. A connection record that",
  "# travels is a capability claim made by somebody else's computer.",
  "#",
  "# An allowlist rather than a list of exclusions, so a directory Core adds",
  "# later is not shared until somebody decides it should be.",
  "#",
  "# See src/project-sharing.ts, including why log/ is not shared."
];

/** The file's full contents, so re-running init converges rather than appends. */
export function ignoreFileContents(): string {
  /* `*` then re-inclusions. The directory itself has to be re-included before
     git will descend into it, which is why `canon/` and `canon/**` are both
     here — without the first, the second never matches anything. */
  const rules = [
    "*",
    ...SHARED_PROJECT_FACTS.map((entry) => `!${entry}`),
    "!canon/**"
  ];
  return `${[...HEADER, "", ...rules].join("\n")}\n`;
}

/**
 * Write `.hivemind/.gitignore`.
 *
 * Nested rather than appended to the project's root `.gitignore`: this is
 * Hivemind's own file to own, and editing a file the person maintains — with
 * their comments and their ordering — is not something a tool should do to be
 * tidy. Git reads nested ignore files natively.
 *
 * Rewritten rather than merged. The contents are generated, so converging on
 * them is right; anything a person wants to add belongs in the root file, where
 * nothing rewrites it.
 */
export async function writeIgnoreRules(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, ".hivemind", ".gitignore"),
    ignoreFileContents(),
    "utf8"
  );
}

/**
 * Machine evidence that is ALREADY tracked, and therefore still travelling.
 *
 * Adding an ignore rule does nothing to a file git already has. A repository
 * that committed connection records before this existed keeps sharing them —
 * on every clone, on every pull — until somebody runs `git rm --cached`. That
 * is a silent state, which is the reason this is detected and offered rather
 * than left in a release note nobody reads.
 */
export async function trackedMachineFiles(repoRoot: string): Promise<string[]> {
  let listed: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-files", "--", ".hivemind"],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    listed = result.stdout;
  } catch {
    /* Not a repository, or no git. Nothing is tracked, so nothing travels. */
    return [];
  }
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((file) => isMachineSpecific(file))
    .sort();
}

/**
 * Whether a repo-relative path under `.hivemind` is machine evidence.
 *
 * Defined as "not one of the shared project facts", so a path nobody has
 * thought about is machine evidence by default. That is the direction that
 * fails safe: the cost of a wrong answer here is either an unnecessary offer to
 * untrack a file, or silently sharing somebody's verification.
 */
export function isMachineSpecific(file: string): boolean {
  const posix = file.replace(/\\/gu, "/");
  if (!posix.startsWith(".hivemind/")) return false;
  const relative = posix.slice(".hivemind/".length);
  return !SHARED_PROJECT_FACTS.some((rule) =>
    rule.endsWith("/") ? relative.startsWith(rule) : relative === rule
  );
}

/**
 * Stop tracking machine evidence, keeping the files on disk.
 *
 * `git rm --cached` and nothing else: the files are live state this project is
 * using right now, so deleting them would break the running daemon and lose a
 * verification somebody paid for. It stages the removal and leaves the commit
 * to the person, because a commit is theirs to make.
 */
export async function untrackMachineFiles(
  repoRoot: string
): Promise<{ ok: true; removed: string[] } | { ok: false; reason: string }> {
  const files = await trackedMachineFiles(repoRoot);
  if (files.length === 0) return { ok: true, removed: [] };
  try {
    await execFileAsync("git", ["-C", repoRoot, "rm", "--cached", "--quiet", "--", ...files], {
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `git could not stop tracking these files: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  return { ok: true, removed: files };
}

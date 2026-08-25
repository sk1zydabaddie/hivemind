/**
 * A starter AGENTS.md, proposed from what the repository actually contains.
 *
 * ## Why detection rather than generation
 *
 * A detected fact beats a generated sentence. "This project is checked with
 * `npm test`" is true because a script of that name was read out of
 * package.json; the same sentence produced by a model is a guess that reads
 * identically and is wrong some of the time. So Phase A makes ZERO model calls:
 * every line below traces to a file on disk, and where nothing was found the
 * file says nothing rather than inventing a plausible convention.
 *
 * ## Knowledge, never authority
 *
 * AGENTS.md is repo substrate, which means every harness reads it verbatim as
 * UNTRUSTED context. It may carry knowledge and must never carry permission.
 * Nothing in it may widen a lease, narrow a gate, or change what gets checked,
 * and the rule is enforced here rather than described: `findAuthorityLanguage`
 * refuses to emit a proposal containing permission or gate vocabulary, and the
 * property a test pins is stronger than the wording -- the same run with and
 * without this file must produce identical gates, leases and checks. If a
 * sentence would change what Hivemind PERMITS by being present, it does not
 * belong, at any strength of phrasing.
 *
 * ## A document that looks like enforcement and is not
 *
 * The general form of the rule above, worth stating on its own because it
 * outlives this file: a document that LOOKS like enforcement and is not is
 * worse than one that does not try. A boundary written in prose that no gate
 * reads will be believed by the reader and ignored by the system, and the gap
 * between the two is invisible until something crosses it. AGENTS.md therefore
 * carries no boundaries at all -- not weakly-worded ones, not ones marked
 * advisory. A boundary belongs where it is enforced: the lease, the contract,
 * the gate. Anything that cannot be enforced is stated as knowledge or not at
 * all.
 *
 * ## The user's file
 *
 * Hivemind proposes; a person accepts. Nothing here writes unasked, nothing
 * replaces a file somebody else wrote, and an edit inside a previously accepted
 * block is treated as the person's decision: the block is left alone and the
 * proposal is withheld rather than overwriting it.
 *
 * ## Size
 *
 * It sits at the top of the worker prompt's stable prefix, so it caches and a
 * warm call bills it at roughly a tenth. Measured on this repository: the
 * shared prefix is 334 bytes with no AGENTS.md and 7,050 bytes with a 6,981-byte
 * one. But it is injected into EVERY worker call, so "nearly free" is not free
 * -- see `SIZE_TARGET_BYTES` for where the ceiling sits and why.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { detectCheckCandidates, packageScriptRunner, type CheckCandidate } from "./check-candidates.js";

/**
 * The size the generated block aims to stay under, and the size it refuses.
 *
 * Set by READABILITY, not by token arithmetic. The arithmetic does not bind:
 * this sits in the worker prompt's stable prefix, so a 4 KB file costs roughly
 * 350 uncached tokens once and about 35 per call after that. At those numbers
 * cost would justify a far larger file than is good for anyone.
 *
 * What binds is attention. Every additional line makes the important lines
 * easier to skip, and a worker that skims past "tests live in test/" because it
 * is buried on page three has been given less than a shorter file would have
 * given it. So the ceiling is the point past which a person -- or a model --
 * stops reading carefully, and the generator refuses beyond it rather than
 * quietly shipping a wall of text into every task.
 */
export const SIZE_TARGET_BYTES = 8 * 1024;
export const SIZE_REFUSAL_BYTES = 16 * 1024;

const BEGIN = "<!-- hivemind:generated:begin";
const END = "<!-- hivemind:generated:end -->";

export interface RepoFacts {
  project_name: string | null;
  stack: string | null;
  module_kind: string | null;
  package_manager: string | null;
  checks: CheckCandidate[];
  source_dirs: string[];
  test_dirs: string[];
  test_file_pattern: string | null;
  entry_point: string | null;
  /** Config files present, named only -- never their contents. */
  config_files: string[];
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listShallow(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * What is actually in this repository. No model call, no guessing.
 *
 * Everything returned traces to a file that exists; anything that could not be
 * determined comes back null or empty, which the renderer turns into silence
 * rather than a hedge.
 */
export async function detectRepoFacts(repoRoot: string): Promise<RepoFacts> {
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    pkg = null;
  }

  const stack = pkg !== null
    ? "Node.js"
    : (await exists(path.join(repoRoot, "Cargo.toml")))
      ? "Rust"
      : (await exists(path.join(repoRoot, "go.mod")))
        ? "Go"
        : (await exists(path.join(repoRoot, "pyproject.toml"))) || (await exists(path.join(repoRoot, "requirements.txt")))
          ? "Python"
          : null;

  const sourceDirs: string[] = [];
  for (const candidate of ["src", "lib", "app", "cmd", "internal"]) {
    if (await exists(path.join(repoRoot, candidate))) sourceDirs.push(candidate);
  }
  const testDirs: string[] = [];
  for (const candidate of ["test", "tests", "spec", "__tests__"]) {
    if (await exists(path.join(repoRoot, candidate))) testDirs.push(candidate);
  }

  /* The naming convention, counted rather than assumed: whichever suffix the
     majority of test files actually use. A convention nobody follows is not a
     convention, so a tie or a near-tie reports nothing. */
  let testPattern: string | null = null;
  const testNames: string[] = [];
  for (const dir of testDirs) testNames.push(...(await listShallow(path.join(repoRoot, dir))));
  const suffixes = new Map<string, number>();
  for (const name of testNames) {
    const match = /(\.(test|spec)\.[a-z]+)$/iu.exec(name);
    if (match) suffixes.set(match[1], (suffixes.get(match[1]) ?? 0) + 1);
  }
  const ranked = [...suffixes.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length > 0 && ranked[0][1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0)) {
    testPattern = `*${ranked[0][0]}`;
  }

  const configFiles: string[] = [];
  for (const candidate of [
    "tsconfig.json",
    "eslint.config.js",
    ".eslintrc.json",
    "vite.config.ts",
    "vitest.config.ts",
    "Makefile",
    "Dockerfile",
    ".editorconfig"
  ]) {
    if (await exists(path.join(repoRoot, candidate))) configFiles.push(candidate);
  }

  const bin = pkg?.bin;
  return {
    project_name: typeof pkg?.name === "string" ? pkg.name : null,
    stack,
    module_kind: pkg?.type === "module" ? "ES modules" : pkg !== null ? "CommonJS" : null,
    package_manager: pkg === null ? null : await packageScriptRunner(repoRoot),
    checks: await detectCheckCandidates(repoRoot),
    source_dirs: sourceDirs,
    test_dirs: testDirs,
    test_file_pattern: testPattern,
    entry_point:
      typeof pkg?.main === "string"
        ? pkg.main
        : typeof bin === "string"
          ? bin
          : bin !== null && typeof bin === "object"
            ? (Object.values(bin as Record<string, unknown>).find((v) => typeof v === "string") as string | undefined) ?? null
            : null,
    config_files: configFiles
  };
}

/**
 * Vocabulary that turns a note into a permission, refused on sight.
 *
 * This file is read by every harness as untrusted context. A sentence that
 * grants, excuses, or waives is the failure this guards: not because a harness
 * would necessarily obey it, but because a repository whose substrate says
 * "skip the tests for docs" has written down an intention that the gates will
 * then contradict, and the only honest place for that intention is a gate.
 *
 * Matched against generated content AND against anything a caller supplies, so
 * a later phase cannot route around it.
 */
const AUTHORITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\byou (?:may|can|are allowed to|are permitted to)\b/iu, why: "grants permission" },
  { pattern: /\b(?:feel free|it(?:'s| is) (?:fine|ok|okay|safe) to)\b/iu, why: "grants permission" },
  { pattern: /\bskip(?:ping)? (?:the )?(?:test|check|verification|gate|review)/iu, why: "waives a check" },
  { pattern: /\bno need to (?:test|check|verify|run)/iu, why: "waives a check" },
  { pattern: /\b(?:without|bypass(?:ing)?|ignore) (?:the )?(?:approval|gate|lease|review|verification)/iu, why: "bypasses a gate" },
  { pattern: /\b(?:don'?t|do not) (?:bother )?(?:run|running) (?:the )?(?:test|check)/iu, why: "waives a check" },
  { pattern: /\ballowed[_ ]files\b/iu, why: "restates a lease scope; the lease is the authority" },
  { pattern: /\byou (?:have|are granted) (?:access|permission)\b/iu, why: "grants access" },
  { pattern: /\bpre[- ]approved\b/iu, why: "claims approval" },
  { pattern: /\bauto[- ]?approve\b/iu, why: "claims approval" }
];

export interface AuthorityFinding {
  line: number;
  text: string;
  why: string;
}

/** Every line that reads as authority rather than knowledge. */
export function findAuthorityLanguage(content: string): AuthorityFinding[] {
  const findings: AuthorityFinding[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    for (const { pattern, why } of AUTHORITY_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ line: index + 1, text: line.trim(), why });
        break;
      }
    }
  }
  return findings;
}

function sectionHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/** The generated block, delimited so a later proposal can find exactly what it wrote. */
export function wrapGeneratedSection(body: string): string {
  return `${BEGIN} sha=${sectionHash(body)} -->\n${body}\n${END}`;
}

export interface ExistingSection {
  /** The block's body as it stands on disk. */
  body: string;
  /** The hash recorded when Hivemind wrote it. */
  recorded_hash: string;
  /** Whether the body still hashes to what was recorded. */
  untouched: boolean;
  start: number;
  end: number;
}

export function findGeneratedSection(content: string): ExistingSection | null {
  const start = content.indexOf(BEGIN);
  if (start === -1) return null;
  const headerEnd = content.indexOf("-->", start);
  const end = content.indexOf(END, start);
  if (headerEnd === -1 || end === -1) return null;
  const header = content.slice(start, headerEnd);
  const recorded = /sha=([0-9a-f]+)/u.exec(header)?.[1] ?? "";
  const body = content.slice(headerEnd + 3, end).replace(/^\n/u, "").replace(/\n$/u, "");
  return { body, recorded_hash: recorded, untouched: sectionHash(body) === recorded, start, end: end + END.length };
}

/** The markdown itself: detected facts, and silence where nothing was found. */
export function renderStarterBody(facts: RepoFacts): string {
  const lines: string[] = [];
  lines.push("## What this project is");
  const identity = [facts.project_name, facts.stack, facts.module_kind].filter((v) => v !== null);
  lines.push(
    identity.length > 0
      ? `${identity.join(" — ")}.`
      : "Hivemind could not detect the stack from this repository."
  );

  if (facts.source_dirs.length > 0 || facts.test_dirs.length > 0 || facts.entry_point !== null) {
    lines.push("", "## Where things are");
    if (facts.source_dirs.length > 0) lines.push(`- Source lives in ${facts.source_dirs.map((d) => `\`${d}/\``).join(", ")}.`);
    if (facts.test_dirs.length > 0) lines.push(`- Tests live in ${facts.test_dirs.map((d) => `\`${d}/\``).join(", ")}.`);
    if (facts.test_file_pattern !== null) lines.push(`- Test files are named \`${facts.test_file_pattern}\`.`);
    if (facts.entry_point !== null) lines.push(`- The entry point is \`${facts.entry_point}\`.`);
  }

  if (facts.checks.length > 0) {
    lines.push("", "## How this project is checked");
    for (const check of facts.checks) {
      const what =
        check.kind === "tests" ? "runs the tests" : check.kind === "typecheck" ? "checks the types" : "builds the project";
      lines.push(`- \`${check.command}\` ${what} (${check.source}).`);
    }
  }

  if (facts.package_manager !== null || facts.config_files.length > 0) {
    lines.push("", "## Tooling present");
    if (facts.package_manager !== null) lines.push(`- Package manager: \`${facts.package_manager}\` (from the lockfile).`);
    if (facts.config_files.length > 0) lines.push(`- Config files: ${facts.config_files.map((f) => `\`${f}\``).join(", ")}.`);
  }

  return lines.join("\n");
}

export interface AgentsFileProposal {
  /** null when the repository has no AGENTS.md yet. */
  existing: string | null;
  /** The full file content being proposed. */
  proposed: string;
  /** A unified diff from existing (or empty) to proposed. */
  diff: string;
  facts: RepoFacts;
  bytes: number;
  /** Over the target but under the refusal ceiling. */
  over_target: boolean;
  /** What the person is being asked to accept, in one line. */
  summary: string;
}

/**
 * Propose a starter file, or explain why there is nothing honest to propose.
 *
 * Refuses rather than writing a hedge when the repository yielded nothing worth
 * saying, when a previously accepted block has been edited by hand, or when the
 * generated content would carry authority.
 */
export async function proposeAgentsFile(repoRoot: string): Promise<Result<AgentsFileProposal>> {
  const facts = await detectRepoFacts(repoRoot);
  const detected =
    facts.stack !== null || facts.checks.length > 0 || facts.source_dirs.length > 0 || facts.test_dirs.length > 0;
  if (!detected) {
    return {
      ok: false,
      reason:
        "nothing was detected in this repository yet, so there is nothing to propose; a file of guesses is worse than no file"
    };
  }

  const body = renderStarterBody(facts);
  const authority = findAuthorityLanguage(body);
  if (authority.length > 0) {
    /* Unreachable from detection alone -- it is here so the rule holds for
       whatever a later phase renders through the same door. */
    return {
      ok: false,
      reason: `generated content reads as authority rather than knowledge: ${authority
        .map((f) => `line ${f.line} ${f.why}`)
        .join("; ")}`
    };
  }

  const filePath = path.join(repoRoot, "AGENTS.md");
  let existing: string | null = null;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = null;
  }

  const section = existing === null ? null : findGeneratedSection(existing);
  if (section !== null && !section.untouched) {
    return {
      ok: false,
      reason:
        "the Hivemind section in AGENTS.md has been edited by hand; that edit is your decision and Hivemind will not overwrite it"
    };
  }

  let proposed: string;
  let summary: string;
  if (existing === null) {
    proposed = `# ${facts.project_name ?? path.basename(repoRoot)}\n\n${wrapGeneratedSection(body)}\n`;
    summary = "create AGENTS.md with a detected-facts section";
  } else if (section === null) {
    /* Somebody else's file. Append, never touch what they wrote. */
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    proposed = `${existing}${separator}${wrapGeneratedSection(body)}\n`;
    summary = "append a detected-facts section to your existing AGENTS.md, leaving the rest untouched";
  } else {
    proposed = `${existing.slice(0, section.start)}${wrapGeneratedSection(body)}${existing.slice(section.end)}`;
    summary = "update the detected-facts section Hivemind wrote earlier";
  }

  const bytes = Buffer.byteLength(proposed, "utf8");
  if (bytes > SIZE_REFUSAL_BYTES) {
    return {
      ok: false,
      reason: `the proposed file is ${bytes} bytes, over the ${SIZE_REFUSAL_BYTES}-byte ceiling; it is injected into every worker call, so it must stay small enough to be read rather than skimmed`
    };
  }

  return {
    ok: true,
    value: {
      existing,
      proposed,
      diff: unifiedDiff(existing ?? "", proposed, "AGENTS.md"),
      facts,
      bytes,
      over_target: bytes > SIZE_TARGET_BYTES,
      summary
    }
  };
}

/**
 * Write the proposal, and only when the file still looks the way it did when
 * the proposal was made.
 *
 * `expected_existing_sha` is the caller's proof that the person accepted THIS
 * diff. If the file changed in between, the write is refused rather than
 * resolved -- a race here silently destroys somebody's editing.
 */
export async function applyAgentsFileProposal(
  repoRoot: string,
  proposed: string,
  expectedExistingSha: string | null
): Promise<Result<{ bytes: number; path: string }>> {
  const filePath = path.join(repoRoot, "AGENTS.md");
  let current: string | null = null;
  try {
    current = await readFile(filePath, "utf8");
  } catch {
    current = null;
  }
  const currentSha = current === null ? null : sectionHash(current);
  if (currentSha !== expectedExistingSha) {
    return {
      ok: false,
      reason:
        current === null
          ? "AGENTS.md no longer exists as it did when this was proposed; review the proposal again"
          : "AGENTS.md changed since this was proposed, so the write was refused rather than overwriting the newer version"
    };
  }
  const authority = findAuthorityLanguage(proposed);
  if (authority.length > 0) {
    return {
      ok: false,
      reason: `refused: the content reads as authority rather than knowledge (line ${authority[0].line}: ${authority[0].why})`
    };
  }
  if (Buffer.byteLength(proposed, "utf8") > SIZE_REFUSAL_BYTES) {
    return { ok: false, reason: `refused: over the ${SIZE_REFUSAL_BYTES}-byte ceiling` };
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, proposed, "utf8");
  return { ok: true, value: { bytes: Buffer.byteLength(proposed, "utf8"), path: "AGENTS.md" } };
}

/** The hash a caller passes back to prove it is accepting the file it was shown. */
export function contentSha(content: string | null): string | null {
  return content === null ? null : sectionHash(content);
}

/**
 * A unified diff good enough to review by.
 *
 * The changes this module makes are creations, appends, and replacements of one
 * delimited block, so the changed region is found by trimming the common head
 * and tail rather than by a general edit-distance search. Exact for those
 * shapes, and it does not pretend to be a general differ.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after.split("\n");
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = beforeLines.slice(head, beforeLines.length - tail);
  const added = afterLines.slice(head, afterLines.length - tail);
  const context = 2;
  const contextStart = Math.max(0, head - context);
  const lines = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${contextStart + 1},${removed.length + (head - contextStart)} +${contextStart + 1},${added.length + (head - contextStart)} @@`
  ];
  for (const line of beforeLines.slice(contextStart, head)) lines.push(` ${line}`);
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  for (const line of afterLines.slice(afterLines.length - tail, afterLines.length - tail + context)) {
    lines.push(` ${line}`);
  }
  return lines.join("\n");
}

/**
 * `agents.propose` / `agents.apply`, server side.
 *
 * The client never supplies file CONTENT. It receives a proposal, shows the
 * diff, and sends back only the two hashes it was shown; Core re-derives the
 * proposal and refuses if either has moved. That keeps this from becoming a
 * door through which a surface could write arbitrary text into a file every
 * harness reads.
 */
export async function proposeAgentsFileAction(
  repoRoot: string
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const proposal = await proposeAgentsFile(repoRoot);
  if (!proposal.ok) return proposal;
  return {
    ok: true,
    value: {
      summary: proposal.value.summary,
      diff: proposal.value.diff,
      bytes: proposal.value.bytes,
      over_target: proposal.value.over_target,
      size_target_bytes: SIZE_TARGET_BYTES,
      facts: proposal.value.facts,
      has_existing_file: proposal.value.existing !== null,
      existing_sha: contentSha(proposal.value.existing),
      proposed_sha: contentSha(proposal.value.proposed)
    }
  };
}

export async function applyAgentsFileAction(
  repoRoot: string,
  expectedExistingSha: string | null,
  expectedProposedSha: string
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const proposal = await proposeAgentsFile(repoRoot);
  if (!proposal.ok) return proposal;
  if (contentSha(proposal.value.existing) !== expectedExistingSha) {
    return {
      ok: false,
      reason: "AGENTS.md changed since this was proposed, so the write was refused rather than overwriting the newer version"
    };
  }
  /* The repository itself can move between proposing and accepting, which would
     silently change what gets written. Refuse and re-propose instead. */
  if (contentSha(proposal.value.proposed) !== expectedProposedSha) {
    return {
      ok: false,
      reason: "the project changed since this was proposed, so the file would not match what you reviewed; look at the new proposal"
    };
  }
  const applied = await applyAgentsFileProposal(repoRoot, proposal.value.proposed, expectedExistingSha);
  return applied.ok ? { ok: true, value: applied.value } : applied;
}

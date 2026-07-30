import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { VerificationCoverageConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const supportedExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const coordinateSpace = "post_patch_applied_tree" as const;
const limitations = [
  "LCOV DA records define executable lines; changed lines absent from DA are ignored only when the changed file has an LCOV source record",
  "the configured coverage command is responsible for executing against the supplied shadow worktree; Hivemind binds its fresh report to the unchanged staged tree before and after execution"
];

export interface CoverageCommandResult {
  id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeCoverageCommandSummary {
  id: string;
  command: string;
  exit_code: number;
}

export interface RuntimeCoverageLine {
  file: string;
  line: number;
  hits: number;
}

export interface IgnoredRuntimeCoverageLine {
  file: string;
  line: number;
  reason: "not_listed_as_executable_by_lcov";
}

export interface RuntimeCoverageMeasurement {
  kind: "runtime_changed_line";
  status: "unconfigured" | "strong" | "weak" | "unknown";
  advisory_only: true;
  coordinate_space: typeof coordinateSpace;
  configured: boolean;
  command: string | null;
  report_path: string | null;
  report_hash: string | null;
  applied_tree: string | null;
  executable_changed_lines: number;
  hit_changed_lines: number;
  ratio: number | null;
  covered_lines: RuntimeCoverageLine[];
  uncovered_lines: RuntimeCoverageLine[];
  ignored_non_executable_lines: IgnoredRuntimeCoverageLine[];
  unknown_files: string[];
  unknown_reasons: string[];
  command_result: RuntimeCoverageCommandSummary | null;
  limitations: string[];
}

export type RuntimeCoverageResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function measureRuntimeCoverage(
  worktreeRoot: string,
  changedFiles: string[],
  coverage: VerificationCoverageConfig | undefined,
  executeCoverage: (command: string) => Promise<CoverageCommandResult>
): Promise<RuntimeCoverageMeasurement> {
  if (coverage === undefined) {
    return unconfiguredMeasurement();
  }

  const normalizedChanges = normalizePaths(changedFiles);
  if (normalizedChanges.length !== changedFiles.length || normalizedChanges.length === 0) {
    return unknownMeasurement(coverage, null, [], "changed files are empty, invalid, or unconfined");
  }
  const unsupportedFiles = normalizedChanges.filter((file) => !supportedExtensions.has(path.posix.extname(file).toLowerCase()));
  if (unsupportedFiles.length > 0) {
    return unknownMeasurement(
      coverage,
      null,
      unsupportedFiles,
      `changed files are outside configured JS/TS coverage instrumentation: ${unsupportedFiles.join(", ")}`
    );
  }

  const reportPath = normalizeRepoPath(coverage.report_path);
  if (reportPath === null) {
    return unknownMeasurement(coverage, null, [], "coverage report path is invalid or unconfined");
  }

  const before = await readAppliedTreeState(worktreeRoot);
  if (!before.ok) {
    return unknownMeasurement(coverage, null, normalizedChanges, before.reason);
  }
  if (!samePaths(before.value.changed_files, normalizedChanges)) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      normalizedChanges,
      `configured changed files do not match the staged applied tree (expected ${normalizedChanges.join(", ")}, found ${before.value.changed_files.join(", ")})`
    );
  }

  const reportTracked = await git(worktreeRoot, ["ls-files", "--error-unmatch", "--", reportPath]);
  if (reportTracked.exit_code === 0) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      normalizedChanges,
      `coverage report path "${reportPath}" is tracked and cannot be safely replaced as an execution artifact`
    );
  }

  const prepared = await prepareFreshReportPath(worktreeRoot, reportPath);
  if (!prepared.ok) {
    return unknownMeasurement(coverage, before.value.tree, normalizedChanges, prepared.reason);
  }

  const changedLines = await readChangedPostPatchLines(worktreeRoot, normalizedChanges);
  if (!changedLines.ok) {
    return unknownMeasurement(coverage, before.value.tree, normalizedChanges, changedLines.reason);
  }
  const deletionOnly = [...changedLines.value.entries()]
    .filter(([, lines]) => lines.size === 0)
    .map(([file]) => file);
  if (deletionOnly.length > 0) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      deletionOnly,
      `post-patch runtime coordinates are unavailable for deletion-only changes: ${deletionOnly.join(", ")}`
    );
  }

  const commandResult = await executeCoverage(coverage.command);
  if (commandResult.exit_code !== 0) {
    const detail = commandResult.stderr.trim() || commandResult.stdout.trim();
    return unknownMeasurement(
      coverage,
      before.value.tree,
      normalizedChanges,
      `coverage command exited with code ${commandResult.exit_code}${detail === "" ? "" : `: ${truncate(detail)}`}`,
      commandResult
    );
  }

  const after = await readAppliedTreeState(worktreeRoot);
  if (!after.ok) {
    return unknownMeasurement(coverage, before.value.tree, normalizedChanges, after.reason, commandResult);
  }
  if (after.value.tree !== before.value.tree || !samePaths(after.value.changed_files, before.value.changed_files)) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      normalizedChanges,
      `coverage execution changed the applied tree (before ${before.value.tree}, after ${after.value.tree})`,
      commandResult
    );
  }

  const report = await readFreshReport(worktreeRoot, reportPath);
  if (!report.ok) {
    return unknownMeasurement(coverage, before.value.tree, normalizedChanges, report.reason, commandResult);
  }
  const parsed = await parseLcov(worktreeRoot, report.value);
  if (!parsed.ok) {
    return unknownMeasurement(coverage, before.value.tree, normalizedChanges, parsed.reason, commandResult);
  }
  const finalTree = await readAppliedTreeState(worktreeRoot);
  if (
    !finalTree.ok ||
    finalTree.value.tree !== before.value.tree ||
    !samePaths(finalTree.value.changed_files, before.value.changed_files)
  ) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      normalizedChanges,
      finalTree.ok
        ? `applied tree changed while coverage evidence was being ingested (before ${before.value.tree}, after ${finalTree.value.tree})`
        : finalTree.reason,
      commandResult,
      report.value
    );
  }

  const unknownFiles = normalizedChanges.filter((file) => !parsed.value.has(file));
  if (unknownFiles.length > 0) {
    return unknownMeasurement(
      coverage,
      before.value.tree,
      unknownFiles,
      `coverage report does not instrument changed files: ${unknownFiles.join(", ")}`,
      commandResult,
      report.value
    );
  }

  const coveredLines: RuntimeCoverageLine[] = [];
  const uncoveredLines: RuntimeCoverageLine[] = [];
  const ignoredLines: IgnoredRuntimeCoverageLine[] = [];
  for (const file of normalizedChanges) {
    const executableLines = parsed.value.get(file)!;
    for (const line of [...changedLines.value.get(file)!].sort((left, right) => left - right)) {
      const hits = executableLines.get(line);
      if (hits === undefined) {
        ignoredLines.push({ file, line, reason: "not_listed_as_executable_by_lcov" });
      } else if (hits > 0) {
        coveredLines.push({ file, line, hits });
      } else {
        uncoveredLines.push({ file, line, hits });
      }
    }
  }

  const executableChangedLines = coveredLines.length + uncoveredLines.length;
  return {
    kind: "runtime_changed_line",
    status: uncoveredLines.length === 0 ? "strong" : "weak",
    advisory_only: true,
    coordinate_space: coordinateSpace,
    configured: true,
    command: coverage.command,
    report_path: reportPath,
    report_hash: sha256(report.value),
    applied_tree: before.value.tree,
    executable_changed_lines: executableChangedLines,
    hit_changed_lines: coveredLines.length,
    ratio: executableChangedLines === 0 ? null : coveredLines.length / executableChangedLines,
    covered_lines: coveredLines,
    uncovered_lines: uncoveredLines,
    ignored_non_executable_lines: ignoredLines,
    unknown_files: [],
    unknown_reasons: [],
    command_result: summarizeCommandResult(commandResult),
    limitations
  };
}

function unconfiguredMeasurement(): RuntimeCoverageMeasurement {
  return {
    kind: "runtime_changed_line",
    status: "unconfigured",
    advisory_only: true,
    coordinate_space: coordinateSpace,
    configured: false,
    command: null,
    report_path: null,
    report_hash: null,
    applied_tree: null,
    executable_changed_lines: 0,
    hit_changed_lines: 0,
    ratio: null,
    covered_lines: [],
    uncovered_lines: [],
    ignored_non_executable_lines: [],
    unknown_files: [],
    unknown_reasons: [],
    command_result: null,
    limitations
  };
}

function unknownMeasurement(
  coverage: VerificationCoverageConfig,
  appliedTree: string | null,
  unknownFiles: string[],
  reason: string,
  commandResult: CoverageCommandResult | null = null,
  report: string | null = null
): RuntimeCoverageMeasurement {
  return {
    kind: "runtime_changed_line",
    status: "unknown",
    advisory_only: true,
    coordinate_space: coordinateSpace,
    configured: true,
    command: coverage.command,
    report_path: coverage.report_path,
    report_hash: report === null ? null : sha256(report),
    applied_tree: appliedTree,
    executable_changed_lines: 0,
    hit_changed_lines: 0,
    ratio: null,
    covered_lines: [],
    uncovered_lines: [],
    ignored_non_executable_lines: [],
    unknown_files: normalizePaths(unknownFiles),
    unknown_reasons: [reason],
    command_result: commandResult === null ? null : summarizeCommandResult(commandResult),
    limitations
  };
}

async function readAppliedTreeState(
  worktreeRoot: string
): Promise<RuntimeCoverageResult<{ tree: string; changed_files: string[] }>> {
  const unstaged = await git(worktreeRoot, ["diff", "--quiet", "--"]);
  if (unstaged.exit_code === 1) {
    return { ok: false, reason: "worktree content diverges from the staged applied tree" };
  }
  if (unstaged.exit_code !== 0) {
    return { ok: false, reason: `failed to compare worktree and staged tree: ${gitReason(unstaged)}` };
  }
  const tree = await git(worktreeRoot, ["write-tree"]);
  if (tree.exit_code !== 0 || tree.stdout.trim() === "") {
    return { ok: false, reason: `failed to identify the staged applied tree: ${gitReason(tree)}` };
  }
  const changed = await git(worktreeRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (changed.exit_code !== 0) {
    return { ok: false, reason: `failed to identify staged changed files: ${gitReason(changed)}` };
  }
  return {
    ok: true,
    value: {
      tree: tree.stdout.trim(),
      changed_files: normalizePaths(changed.stdout.split("\0").filter(Boolean))
    }
  };
}

async function readChangedPostPatchLines(
  worktreeRoot: string,
  changedFiles: string[]
): Promise<RuntimeCoverageResult<Map<string, Set<number>>>> {
  const result = new Map<string, Set<number>>();
  for (const file of changedFiles) {
    const diff = await git(worktreeRoot, [
      "diff",
      "--cached",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--",
      file
    ]);
    if (diff.exit_code !== 0) {
      return { ok: false, reason: `failed to read applied diff for "${file}": ${gitReason(diff)}` };
    }
    const lines = new Set<number>();
    let postPatchLine: number | null = null;
    for (const diffLine of diff.stdout.split(/\r?\n/u)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(diffLine);
      if (hunk !== null) {
        postPatchLine = Number.parseInt(hunk[1], 10);
        continue;
      }
      if (postPatchLine === null || diffLine.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
        lines.add(postPatchLine);
        postPatchLine += 1;
      } else if (diffLine.startsWith("-") && !diffLine.startsWith("---")) {
        continue;
      } else if (diffLine.startsWith(" ")) {
        postPatchLine += 1;
      }
    }
    result.set(file, lines);
  }
  return { ok: true, value: result };
}

async function prepareFreshReportPath(
  worktreeRoot: string,
  reportPath: string
): Promise<RuntimeCoverageResult<null>> {
  const checked = await checkPathWithoutSymlinks(worktreeRoot, reportPath);
  if (!checked.ok) {
    return checked;
  }
  if (!checked.value.leaf_exists) {
    return { ok: true, value: null };
  }
  if (!checked.value.leaf_is_file) {
    return { ok: false, reason: `coverage report path "${reportPath}" is not a regular file` };
  }
  try {
    await unlink(checked.value.absolute_path);
    return { ok: true, value: null };
  } catch (error: unknown) {
    return { ok: false, reason: `failed to remove prior coverage report: ${errorMessage(error)}` };
  }
}

async function readFreshReport(
  worktreeRoot: string,
  reportPath: string
): Promise<RuntimeCoverageResult<string>> {
  const checked = await checkPathWithoutSymlinks(worktreeRoot, reportPath);
  if (!checked.ok) {
    return checked;
  }
  if (!checked.value.leaf_exists || !checked.value.leaf_is_file) {
    return { ok: false, reason: `coverage command did not produce fresh report "${reportPath}"` };
  }
  try {
    return { ok: true, value: await readFile(checked.value.absolute_path, "utf8") };
  } catch (error: unknown) {
    return { ok: false, reason: `failed to read fresh coverage report: ${errorMessage(error)}` };
  }
}

async function checkPathWithoutSymlinks(
  root: string,
  relativePath: string
): Promise<RuntimeCoverageResult<{
  absolute_path: string;
  leaf_exists: boolean;
  leaf_is_file: boolean;
}>> {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (!isPathInside(absoluteRoot, absolutePath)) {
    return { ok: false, reason: `coverage report path "${relativePath}" escapes the worktree` };
  }
  let current = absoluteRoot;
  const segments = path.relative(absoluteRoot, absolutePath).split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        return { ok: false, reason: `coverage report path "${relativePath}" traverses a symbolic link` };
      }
      if (index === segments.length - 1) {
        return {
          ok: true,
          value: { absolute_path: absolutePath, leaf_exists: true, leaf_is_file: entry.isFile() }
        };
      }
      if (!entry.isDirectory()) {
        return { ok: false, reason: `coverage report parent for "${relativePath}" is not a directory` };
      }
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return {
          ok: true,
          value: { absolute_path: absolutePath, leaf_exists: false, leaf_is_file: false }
        };
      }
      return { ok: false, reason: `failed to inspect coverage report path: ${errorMessage(error)}` };
    }
  }
  return { ok: false, reason: "coverage report path resolves to the worktree root" };
}

async function parseLcov(
  worktreeRoot: string,
  report: string
): Promise<RuntimeCoverageResult<Map<string, Map<number, number>>>> {
  const records = new Map<string, Map<number, number>>();
  let current: string | null = null;
  let sawRecord = false;
  for (const rawLine of report.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("SF:")) {
      if (current !== null) {
        return { ok: false, reason: "malformed LCOV: source record is missing end_of_record" };
      }
      const mapped = await mapLcovSource(worktreeRoot, line.slice(3));
      if (!mapped.ok) {
        return mapped;
      }
      current = mapped.value;
      if (!records.has(current)) {
        records.set(current, new Map());
      }
      sawRecord = true;
      continue;
    }
    if (line.startsWith("DA:")) {
      if (current === null) {
        return { ok: false, reason: "malformed LCOV: DA record appears outside a source record" };
      }
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/u.exec(line);
      if (match === null) {
        return { ok: false, reason: `malformed LCOV line record "${line}"` };
      }
      const lineNumber = Number.parseInt(match[1], 10);
      const hits = Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(hits)) {
        return { ok: false, reason: `malformed LCOV line record "${line}"` };
      }
      const lines = records.get(current)!;
      lines.set(lineNumber, (lines.get(lineNumber) ?? 0) + hits);
      continue;
    }
    if (line === "end_of_record") {
      if (current === null) {
        return { ok: false, reason: "malformed LCOV: end_of_record has no source record" };
      }
      current = null;
    }
  }
  if (current !== null) {
    return { ok: false, reason: "malformed LCOV: final source record is missing end_of_record" };
  }
  if (!sawRecord) {
    return { ok: false, reason: "malformed LCOV: no source records" };
  }
  return { ok: true, value: records };
}

async function mapLcovSource(worktreeRoot: string, source: string): Promise<RuntimeCoverageResult<string>> {
  const trimmed = source.trim();
  if (trimmed === "") {
    return { ok: false, reason: "malformed LCOV: source path is empty" };
  }
  const absoluteRoot = path.resolve(worktreeRoot);
  const absoluteSource = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(absoluteRoot, ...trimmed.replace(/\\/gu, "/").split("/"));
  if (!isPathInside(absoluteRoot, absoluteSource)) {
    return { ok: false, reason: `LCOV source path is outside the applied worktree: "${trimmed}"` };
  }
  const relative = normalizeRepoPath(path.relative(absoluteRoot, absoluteSource).replace(/\\/gu, "/"));
  if (relative === null) {
    return { ok: false, reason: `LCOV source path is unmappable: "${trimmed}"` };
  }
  try {
    const sourceEntry = await lstat(absoluteSource);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
      return { ok: false, reason: `LCOV source path is not a regular worktree file: "${trimmed}"` };
    }
  } catch (error: unknown) {
    return { ok: false, reason: `LCOV source path is unavailable: "${trimmed}" (${errorMessage(error)})` };
  }
  return { ok: true, value: relative };
}

async function git(cwd: string, args: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 32
    });
    return { exit_code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    return {
      exit_code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "",
      stderr: typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
    };
  }
}

function gitReason(result: { stdout: string; stderr: string; exit_code: number }): string {
  return result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exit_code}`;
}

function normalizePaths(files: string[]): string[] {
  const normalized = files.map(normalizeRepoPath).filter((file): file is string => file !== null);
  return [...new Set(normalized)].sort(compareText);
}

function normalizeRepoPath(file: string): string | null {
  const normalized = file.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  const segments = normalized.split("/");
  const canonical = path.posix.normalize(normalized);
  return normalized === "" ||
    segments.includes("..") ||
    canonical === "." ||
    canonical === ".." ||
    canonical.startsWith("../") ||
    path.posix.isAbsolute(canonical) ||
    /^[A-Za-z]:\//u.test(canonical)
    ? null
    : canonical;
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function summarizeCommandResult(result: CoverageCommandResult): RuntimeCoverageCommandSummary {
  return {
    id: result.id,
    command: result.command,
    exit_code: result.exit_code
  };
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}...`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

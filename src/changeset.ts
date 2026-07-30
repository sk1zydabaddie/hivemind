import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const patchDoesNotApplyReason = "patch does not apply to declared base";

export type ChangesetOpType = "add" | "modify" | "delete" | "chmod" | "symlink" | "submodule" | "gitattr";

export interface ChangesetOp {
  path: string;
  op: ChangesetOpType;
}

export interface ResolvedChangesetCheckouts {
  ops: ChangesetOp[];
  baseCheckoutPath: string;
  appliedCheckoutPath: string;
}

export type ApplyPatchResult = { ok: true } | { ok: false; reason: string };

export async function resolveChangeset(
  repoRoot: string,
  baseCommit: string,
  patchPath: string
): Promise<{ ok: true; ops: ChangesetOp[] } | { ok: false; reason: string }> {
  const result = await withResolvedChangesetCheckouts(repoRoot, baseCommit, patchPath, async ({ ops }) => ops);
  if (!result.ok) {
    return result;
  }

  return { ok: true, ops: result.value };
}

export async function withResolvedChangesetCheckouts<T>(
  repoRoot: string,
  baseCommit: string,
  patchPath: string,
  callback: (context: ResolvedChangesetCheckouts) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hivemind-changeset-"));
  const baseCheckoutPath = path.join(tempRoot, "base");
  const appliedCheckoutPath = path.join(tempRoot, "applied");

  try {
    const baseWorktreeResult = await git(repoRoot, ["worktree", "add", "--detach", baseCheckoutPath, baseCommit]);
    if (!baseWorktreeResult.ok) {
      return { ok: false, reason: baseWorktreeResult.reason };
    }

    const appliedWorktreeResult = await git(repoRoot, ["worktree", "add", "--detach", appliedCheckoutPath, baseCommit]);
    if (!appliedWorktreeResult.ok) {
      return { ok: false, reason: appliedWorktreeResult.reason };
    }

    const patchResult = await applyPatchToCheckout(appliedCheckoutPath, patchPath);
    if (!patchResult.ok) {
      return patchResult;
    }

    return {
      ok: true,
      value: await callback({
        ops: await readChangesetOps(appliedCheckoutPath),
        baseCheckoutPath,
        appliedCheckoutPath
      })
    };
  } finally {
    await git(repoRoot, ["worktree", "remove", "--force", baseCheckoutPath]);
    await git(repoRoot, ["worktree", "remove", "--force", appliedCheckoutPath]);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function applyPatchToCheckout(checkoutPath: string, patchPath: string): Promise<ApplyPatchResult> {
  if (await isEmptyPatch(patchPath)) {
    return { ok: true };
  }

  const checkResult = await git(checkoutPath, ["apply", "--check", "--index", patchPath]);
  if (!checkResult.ok) {
    return { ok: false, reason: patchDoesNotApplyReason };
  }

  const applyResult = await git(checkoutPath, ["apply", "--index", patchPath]);
  return applyResult.ok ? { ok: true } : { ok: false, reason: patchDoesNotApplyReason };
}

async function isEmptyPatch(patchPath: string): Promise<boolean> {
  try {
    return (await readFile(patchPath, "utf8")).trim() === "";
  } catch {
    return false;
  }
}

async function readChangesetOps(checkoutPath: string): Promise<ChangesetOp[]> {
  const nameStatusResult = await git(checkoutPath, ["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"]);
  if (!nameStatusResult.ok) {
    throw new Error(nameStatusResult.reason);
  }

  const modeOnly = await readModeOnlyPaths(checkoutPath);
  const tokens = nameStatusResult.stdout.split("\0").filter((token) => token.length > 0);
  const ops: ChangesetOp[] = [];

  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const filePath = tokens[index + 1];
    if (status === undefined || filePath === undefined) {
      throw new Error("unexpected git name-status output");
    }

    ops.push({ path: normalizeGitPath(filePath), op: await classifyPath(checkoutPath, status, filePath, modeOnly) });
  }

  return ops;
}

async function readModeOnlyPaths(checkoutPath: string): Promise<Set<string>> {
  const summaryResult = await git(checkoutPath, ["diff", "--cached", "--summary", "--no-renames", "HEAD"]);
  if (!summaryResult.ok) {
    throw new Error(summaryResult.reason);
  }

  const paths = new Set<string>();
  for (const line of summaryResult.stdout.split(/\r?\n/)) {
    const match = line.match(/^ mode change \d+ => \d+ (.+)$/);
    if (match) {
      paths.add(normalizeGitPath(match[1]));
    }
  }
  return paths;
}

async function classifyPath(
  checkoutPath: string,
  status: string,
  filePath: string,
  modeOnly: Set<string>
): Promise<ChangesetOpType> {
  const normalizedPath = normalizeGitPath(filePath);
  if (normalizedPath === ".gitattributes") {
    return "gitattr";
  }
  if (await isGitlink(checkoutPath, filePath)) {
    return "submodule";
  }
  if (await isSymlink(checkoutPath, filePath)) {
    return "symlink";
  }
  if (modeOnly.has(normalizedPath)) {
    return "chmod";
  }

  if (status.startsWith("A")) {
    return "add";
  }
  if (status.startsWith("D")) {
    return "delete";
  }
  return "modify";
}

async function isGitlink(checkoutPath: string, filePath: string): Promise<boolean> {
  const result = await git(checkoutPath, ["ls-files", "-s", "--", filePath]);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.stdout.split(/\r?\n/).some((line) => line.startsWith("160000 "));
}

async function isSymlink(checkoutPath: string, filePath: string): Promise<boolean> {
  const result = await git(checkoutPath, ["ls-files", "-s", "--", filePath]);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.stdout.split(/\r?\n/).some((line) => line.startsWith("120000 "));
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, stdout: result.stdout };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

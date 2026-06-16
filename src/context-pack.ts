import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CachedReadResult } from "./prompt-cache.js";
import { writeJsonAtomic } from "./atomic.js";
import type { TaskContract } from "./contract.js";
import { readJsonFile } from "./json.js";
import { validateRequestedTaskId } from "./task-id.js";

const contextPackVersion = 1;

export interface ContextPackFile {
  path: string;
  content_hash: string;
  bytes: number;
  cache_path: string;
}

export interface ContextPack {
  version: 1;
  task_id: string;
  base_commit: string;
  tool: string;
  created_at: string;
  cited_files: ContextPackFile[];
  read_cache: {
    reads: number;
    hits: number;
    misses: number;
  };
  scout: {
    stdout: string;
    stderr: string;
  };
  markdown: string;
}

export interface WriteContextPackInput {
  taskId: string;
  baseCommit: string;
  tool: string;
  createdAt: string;
  reads: CachedReadResult[];
  stdout: string;
  stderr: string;
}

export async function writeContextPack(
  repoRoot: string,
  input: WriteContextPackInput
): Promise<{ ok: true; value: { pack: ContextPack; context_pack_path: string; knowledge_path: string } } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(input.taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const pack: ContextPack = {
    version: contextPackVersion,
    task_id: input.taskId,
    base_commit: input.baseCommit,
    tool: input.tool,
    created_at: input.createdAt,
    cited_files: input.reads.map((read) => ({
      path: read.path,
      content_hash: read.content_hash,
      bytes: read.bytes,
      cache_path: read.cache_path
    })),
    read_cache: {
      reads: input.reads.length,
      hits: input.reads.filter((read) => read.cache === "hit").length,
      misses: input.reads.filter((read) => read.cache === "miss").length
    },
    scout: {
      stdout: input.stdout,
      stderr: input.stderr
    },
    markdown: renderContextPackMarkdown(input)
  };

  const packPath = contextPackPath(repoRoot, input.taskId);
  await writeJsonAtomic(packPath, pack);
  const knowledgePath = taskKnowledgePath(repoRoot, input.taskId);
  await mkdir(path.dirname(knowledgePath), { recursive: true });
  await appendFile(knowledgePath, renderKnowledgeAppendix(pack, contextPackRelativePath(input.taskId)), "utf8");
  return {
    ok: true,
    value: {
      pack,
      context_pack_path: contextPackRelativePath(input.taskId),
      knowledge_path: taskKnowledgeRelativePath(input.taskId)
    }
  };
}

export async function loadContextPackForContract(
  repoRoot: string,
  contract: TaskContract
): Promise<{ ok: true; value: ContextPack | null } | { ok: false; reason: string }> {
  let raw: unknown;
  try {
    raw = await readJsonFile(contextPackPath(repoRoot, contract.task_id));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: null };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${contextPackRelativePath(contract.task_id)}` };
    }
    throw error;
  }

  const validation = validateContextPack(raw, contract);
  return validation.ok ? { ok: true, value: validation.value } : validation;
}

export function contextPackRelativePath(taskId: string): string {
  return `.hivemind/cache/context-packs/${taskId}.json`;
}

export function taskKnowledgeRelativePath(taskId: string): string {
  return `.hivemind/tasks/${taskId}.knowledge.md`;
}

export function taskKnowledgePath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, taskKnowledgeRelativePath(taskId));
}

function contextPackPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, contextPackRelativePath(taskId));
}

function validateContextPack(raw: unknown, contract: TaskContract): { ok: true; value: ContextPack | null } | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: `context pack ${contextPackRelativePath(contract.task_id)} must be a JSON object` };
  }
  if (raw.version !== contextPackVersion) {
    return { ok: false, reason: `context pack ${contextPackRelativePath(contract.task_id)} version must be 1` };
  }
  if (raw.task_id !== contract.task_id) {
    return { ok: false, reason: `context pack task_id must be ${contract.task_id}` };
  }
  if (raw.base_commit !== contract.base_commit) {
    return { ok: true, value: null };
  }
  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    return { ok: false, reason: "context pack tool must be a non-empty string" };
  }
  if (typeof raw.created_at !== "string" || Number.isNaN(Date.parse(raw.created_at))) {
    return { ok: false, reason: "context pack created_at must be an ISO timestamp string" };
  }
  if (!Array.isArray(raw.cited_files) || !raw.cited_files.every(isContextPackFile)) {
    return { ok: false, reason: "context pack cited_files must be an array of cached file refs" };
  }
  if (!isRecord(raw.read_cache) || !isSafeCount(raw.read_cache.reads) || !isSafeCount(raw.read_cache.hits) || !isSafeCount(raw.read_cache.misses)) {
    return { ok: false, reason: "context pack read_cache must contain safe integer reads, hits, and misses" };
  }
  if (!isRecord(raw.scout) || typeof raw.scout.stdout !== "string" || typeof raw.scout.stderr !== "string") {
    return { ok: false, reason: "context pack scout output must contain stdout and stderr strings" };
  }
  if (typeof raw.markdown !== "string" || raw.markdown.trim() === "") {
    return { ok: false, reason: "context pack markdown must be a non-empty string" };
  }
  return { ok: true, value: raw as unknown as ContextPack };
}

function renderContextPackMarkdown(input: WriteContextPackInput): string {
  return [
    "Scout context pack:",
    `Task ID: ${input.taskId}`,
    `Base commit: ${input.baseCommit}`,
    `Scout tool: ${input.tool}`,
    "",
    "Cited files:",
    ...formatCitedFiles(input.reads),
    "",
    "Scout findings:",
    fenced(input.stdout.trim() === "" ? "(no stdout)" : input.stdout),
    "",
    "Scout diagnostics:",
    fenced(input.stderr.trim() === "" ? "(no stderr)" : input.stderr)
  ].join("\n");
}

function renderKnowledgeAppendix(pack: ContextPack, packRelativePath: string): string {
  return [
    "",
    `## Scout findings (${pack.created_at})`,
    "",
    `Context pack: ${packRelativePath}`,
    `Scout tool: ${pack.tool}`,
    "",
    "Cited files:",
    ...pack.cited_files.map((file) => `- ${file.path} (${file.content_hash})`),
    "",
    "Findings:",
    fenced(pack.scout.stdout.trim() === "" ? "(no stdout)" : pack.scout.stdout),
    ""
  ].join("\n");
}

function formatCitedFiles(reads: CachedReadResult[]): string[] {
  if (reads.length === 0) {
    return ["- (none)"];
  }
  return reads.map((read) => `- ${read.path} (${read.content_hash}, ${read.cache})`);
}

function fenced(value: string): string {
  return ["```", value.replace(/\r\n/g, "\n"), "```"].join("\n");
}

function isContextPackFile(value: unknown): value is ContextPackFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.trim() !== "" &&
    typeof value.content_hash === "string" &&
    value.content_hash.trim() !== "" &&
    typeof value.cache_path === "string" &&
    value.cache_path.trim() !== "" &&
    isSafeCount(value.bytes)
  );
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

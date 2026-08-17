import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.js";
import { canonicalizeIntentPath } from "./canonicalize.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 500;
const PROTECTED_TOP_LEVEL = new Set([".git", ".hivemind"]);

export const boundedFileToolNames = [
  "read_file",
  "write_file",
  "replace_in_file",
  "list_files",
  "search_files"
] as const;

export async function boundedFilesMcpCommand(cwd: string): Promise<number> {
  const server = createBoundedFilesServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  return 0;
}

function createBoundedFilesServer(root: string): McpServer {
  const server = new McpServer(
    { name: "hivemind-files", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions: `Project-bounded file tools rooted at ${root}. Absolute paths, traversal, symlink escapes, .git, and .hivemind are refused.`
    }
  );

  server.registerTool(
    "read_file",
    tool("Read file", "Read one UTF-8 project file.", { path: z.string() }, true),
    async ({ path: file }) => resultOf(async () => ({ path: await boundedPath(root, file), content: await readText(root, file) }))
  );
  server.registerTool(
    "write_file",
    tool("Write file", "Atomically write one UTF-8 project file.", { path: z.string(), content: z.string() }, false),
    async ({ path: file, content }) => resultOf(async () => {
      const relative = await boundedPath(root, file);
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("content exceeds the 1 MiB file limit");
      await writeFileAtomic(path.join(root, relative), content);
      return { path: relative, bytes: Buffer.byteLength(content, "utf8") };
    })
  );
  server.registerTool(
    "replace_in_file",
    tool(
      "Replace in file",
      "Atomically replace one unique UTF-8 text occurrence in a project file.",
      { path: z.string(), old_text: z.string().min(1), new_text: z.string() },
      false
    ),
    async ({ path: file, old_text, new_text }) => resultOf(async () => {
      const relative = await boundedPath(root, file);
      const content = await readText(root, file);
      const first = content.indexOf(old_text);
      if (first < 0) throw new Error("old_text was not found");
      if (content.indexOf(old_text, first + old_text.length) >= 0) throw new Error("old_text is not unique");
      const next = `${content.slice(0, first)}${new_text}${content.slice(first + old_text.length)}`;
      if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) throw new Error("result exceeds the 1 MiB file limit");
      await writeFileAtomic(path.join(root, relative), next);
      return { path: relative, replacements: 1 };
    })
  );
  server.registerTool(
    "list_files",
    tool("List files", "List project files below a directory, deterministically and without following symlinks.", { path: z.string().default(".") }, true),
    async ({ path: directory }) => resultOf(async () => ({ files: await walkFiles(root, directory) }))
  );
  server.registerTool(
    "search_files",
    tool("Search files", "Search UTF-8 project files for literal text without following symlinks.", { query: z.string().min(1), path: z.string().default(".") }, true),
    async ({ query, path: directory }) => resultOf(async () => ({ matches: await searchFiles(root, directory, query) }))
  );

  return server;
}

function tool<Schema extends Record<string, z.ZodType>>(
  title: string,
  description: string,
  inputSchema: Schema,
  readOnly: boolean
) {
  return {
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: false as const
    }
  };
}

async function boundedPath(root: string, value: string): Promise<string> {
  if (path.isAbsolute(value) || path.posix.isAbsolute(value.replaceAll("\\", "/"))) {
    throw new Error("absolute paths are not allowed");
  }
  const canonical = await canonicalizeIntentPath(root, value);
  if (!canonical.ok) throw new Error(canonical.reason);
  const top = canonical.resolved.split("/")[0]!.toLowerCase();
  if (PROTECTED_TOP_LEVEL.has(top)) throw new Error(`${top} is protected Hivemind state`);
  return canonical.resolved;
}

async function boundedDirectory(root: string, value: string): Promise<string> {
  if (value === ".") return ".";
  return boundedPath(root, value);
}

async function readText(root: string, value: string): Promise<string> {
  const relative = await boundedPath(root, value);
  const full = path.join(root, relative);
  const info = await stat(full);
  if (!info.isFile()) throw new Error("path is not a file");
  if (info.size > MAX_FILE_BYTES) throw new Error("file exceeds the 1 MiB read limit");
  const content = await readFile(full, "utf8");
  if (content.includes("\0")) throw new Error("binary files are not supported");
  return content;
}

async function walkFiles(root: string, requested: string): Promise<string[]> {
  const relative = await boundedDirectory(root, requested);
  const base = relative === "." ? root : path.join(root, relative);
  const found: string[] = [];
  await walk(base, relative === "." ? "" : relative, found);
  return found.sort((left, right) => left.localeCompare(right));
}

async function walk(full: string, relative: string, found: string[]): Promise<void> {
  const entries = await readdir(full, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (found.length >= MAX_RESULTS) return;
    if (entry.isSymbolicLink()) continue;
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const top = childRelative.split("/")[0]!.toLowerCase();
    if (PROTECTED_TOP_LEVEL.has(top)) continue;
    const childFull = path.join(full, entry.name);
    if (entry.isDirectory()) await walk(childFull, childRelative, found);
    else if (entry.isFile()) found.push(childRelative);
  }
}

async function searchFiles(root: string, requested: string, query: string): Promise<Array<{ path: string; line: number; text: string }>> {
  const files = await walkFiles(root, requested);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of files) {
    if (matches.length >= MAX_RESULTS) break;
    let content: string;
    try {
      content = await readText(root, file);
    } catch {
      continue;
    }
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (line.includes(query)) matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
      if (matches.length >= MAX_RESULTS) break;
    }
  }
  return matches;
}

async function resultOf(run: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const value = await run();
    return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "bounded file operation failed";
    const value = { ok: false, reason };
    return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }], isError: true };
  }
}

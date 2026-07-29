import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import { writeJsonAtomic } from "./atomic.js";
import { findGitRoot } from "./repo.js";

const execFileAsync = promisify(execFile);
const graphVersion = 2;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export type RepoSymbolKind = "function" | "class" | "interface" | "type" | "enum" | "namespace" | "variable" | "method";
export type RepoDependencyKind = "import" | "reexport" | "require" | "dynamic_import";

export interface RepoGraphSymbol {
  name: string;
  kind: RepoSymbolKind;
  line: number;
}

export interface RepoGraphDependency {
  specifier: string;
  kind: RepoDependencyKind;
  target: string | null;
}

export interface RepoGraphFile {
  path: string;
  content_hash: string;
  symbols: RepoGraphSymbol[];
  dependencies: RepoGraphDependency[];
}

export interface RepoGraphArtifact {
  version: 2;
  source_fingerprint: string;
  files: RepoGraphFile[];
}

export interface RepoGraphBuildResult {
  path: string;
  source_fingerprint: string;
  files: number;
  symbols: number;
  dependency_edges: number;
}

export type DependencyClosureResult =
  | { available: true; file: string; closure: string[]; source_fingerprint: string }
  | { available: false; file: string; closure: []; reason: string };

export type VerifiedRepoGraphResult =
  | { ok: true; value: RepoGraphArtifact }
  | { ok: false; reason: string };

interface NormalizedQueryFile {
  requested: string;
  normalized: string | null;
}

interface SourceFile {
  path: string;
  content: string;
  contentHash: string;
}

type GraphResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function repoGraphCommand(cwd: string, args: string[]): Promise<number> {
  const [action, file, ...rest] = args;
  if ((action !== "rebuild" && action !== "closure") || (action === "rebuild" && file !== undefined) || rest.length > 0 || (action === "closure" && !file)) {
    console.error("error: usage: hivemind graph rebuild | hivemind graph closure <file>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  if (action === "rebuild") {
    const result = await rebuildRepoGraph(repoRoot);
    if (!result.ok) {
      console.error(`error: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify(result.value, null, 2));
    return 0;
  }

  const result = await queryDependencyClosure(repoRoot, file);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

export async function rebuildRepoGraph(repoRoot: string): Promise<GraphResult<RepoGraphBuildResult>> {
  const sourcesResult = await readTrackedSources(repoRoot);
  if (!sourcesResult.ok) {
    return sourcesResult;
  }

  const knownPaths = new Set(sourcesResult.value.map((source) => source.path));
  const files: RepoGraphFile[] = [];
  for (const source of sourcesResult.value) {
    const parsed = parseSourceFile(source, knownPaths);
    if (!parsed.ok) {
      return parsed;
    }
    files.push(parsed.value);
  }

  const artifact: RepoGraphArtifact = {
    version: graphVersion,
    source_fingerprint: fingerprintSources(sourcesResult.value),
    files
  };

  try {
    await writeJsonAtomic(repoGraphArtifactPath(repoRoot), artifact);
  } catch (error: unknown) {
    return { ok: false, reason: `failed to write repo graph: ${errorMessage(error)}` };
  }

  return {
    ok: true,
    value: {
      path: ".hivemind/cache/repo-graph.json",
      source_fingerprint: artifact.source_fingerprint,
      files: files.length,
      symbols: files.reduce((total, file) => total + file.symbols.length, 0),
      dependency_edges: files.reduce((total, file) => total + file.dependencies.length, 0)
    }
  };
}

export async function queryDependencyClosure(repoRoot: string, requestedFile: string): Promise<DependencyClosureResult> {
  const results = await queryDependencyClosures(repoRoot, [requestedFile]);
  return results[0] ?? unavailable(requestedFile, "repo graph query did not produce a result");
}

export async function queryDependencyClosures(repoRoot: string, requestedFiles: string[]): Promise<DependencyClosureResult[]> {
  const queryFiles: NormalizedQueryFile[] = requestedFiles.map((requested) => ({
    requested,
    normalized: normalizeRequestedPath(requested)
  }));
  if (queryFiles.every((file) => file.normalized === null)) {
    return queryFiles.map((file) => unavailable(file.requested, "repo graph query path must be repo-relative and confined"));
  }

  const graphResult = await loadVerifiedRepoGraph(repoRoot);
  if (!graphResult.ok) {
    return unavailableQueryResults(queryFiles, graphResult.reason);
  }

  const filesByPath = new Map(graphResult.value.files.map((file) => [file.path, file]));
  return queryFiles.map((file) =>
    file.normalized === null
      ? unavailable(file.requested, "repo graph query path must be repo-relative and confined")
      : dependencyClosureFromGraph(file.normalized, filesByPath, graphResult.value.source_fingerprint)
  );
}

export async function loadVerifiedRepoGraph(repoRoot: string): Promise<VerifiedRepoGraphResult> {
  const artifactResult = await readRepoGraphArtifact(repoRoot);
  if (!artifactResult.ok) {
    return artifactResult;
  }
  const sourcesResult = await readTrackedSources(repoRoot);
  if (!sourcesResult.ok) {
    return sourcesResult;
  }
  if (fingerprintSources(sourcesResult.value) !== artifactResult.value.source_fingerprint) {
    return { ok: false, reason: "repo graph is stale: tracked source fingerprint changed" };
  }
  return artifactResult;
}

function dependencyClosureFromGraph(
  normalizedFile: string,
  filesByPath: Map<string, RepoGraphFile>,
  sourceFingerprint: string
): DependencyClosureResult {
  if (!filesByPath.has(normalizedFile)) {
    return unavailable(normalizedFile, `repo graph has no supported tracked source file "${normalizedFile}"`);
  }

  const visited = new Set<string>([normalizedFile]);
  const pending = [normalizedFile];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const file = filesByPath.get(current);
    if (!file) {
      continue;
    }
    for (const dependency of file.dependencies) {
      if (dependency.target === null || visited.has(dependency.target)) {
        continue;
      }
      visited.add(dependency.target);
      pending.push(dependency.target);
    }
  }

  visited.delete(normalizedFile);
  return {
    available: true,
    file: normalizedFile,
    closure: [...visited].sort(compareText),
    source_fingerprint: sourceFingerprint
  };
}

function unavailableQueryResults(queryFiles: NormalizedQueryFile[], reason: string): DependencyClosureResult[] {
  return queryFiles.map((file) =>
    file.normalized === null
      ? unavailable(file.requested, "repo graph query path must be repo-relative and confined")
      : unavailable(file.normalized, reason)
  );
}

export function repoGraphArtifactPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "cache", "repo-graph.json");
}

async function readTrackedSources(repoRoot: string): Promise<GraphResult<SourceFile[]>> {
  let stdout: string;
  try {
    const result = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8"
    });
    stdout = result.stdout;
  } catch (error: unknown) {
    return { ok: false, reason: `failed to list tracked source files: ${errorMessage(error)}` };
  }

  const tracked = stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map(toRepoPath)
    .filter(isSupportedSourcePath)
    .sort(compareText);
  const sources: SourceFile[] = [];
  for (const repoPath of tracked) {
    try {
      const content = await readFile(path.join(repoRoot, ...repoPath.split("/")), "utf8");
      sources.push({ path: repoPath, content, contentHash: hashText(content) });
    } catch (error: unknown) {
      return { ok: false, reason: `failed to read tracked source "${repoPath}": ${errorMessage(error)}` };
    }
  }
  return { ok: true, value: sources };
}

function parseSourceFile(source: SourceFile, knownPaths: Set<string>): GraphResult<RepoGraphFile> {
  const parser = new Parser();
  parser.setLanguage(languageFor(source.path));
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source.content, undefined, {
      bufferSize: Math.max(32 * 1024, Buffer.byteLength(source.content, "utf8") + 1)
    });
  } catch (error: unknown) {
    return { ok: false, reason: `tree-sitter parse failed for "${source.path}": ${errorMessage(error)}` };
  }
  if (tree.rootNode.hasError) {
    return { ok: false, reason: `tree-sitter parse failed for "${source.path}"` };
  }

  return {
    ok: true,
    value: {
      path: source.path,
      content_hash: source.contentHash,
      symbols: collectSymbols(tree.rootNode),
      dependencies: collectDependencies(tree.rootNode, source.path, knownPaths)
    }
  };
}

function languageFor(repoPath: string): unknown {
  const extension = path.posix.extname(repoPath).toLowerCase();
  if (extension === ".tsx") {
    return TypeScript.tsx;
  }
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return TypeScript.typescript;
  }
  return JavaScript;
}

function collectSymbols(root: Parser.SyntaxNode): RepoGraphSymbol[] {
  const symbols: RepoGraphSymbol[] = [];
  walk(root, (node) => {
    const kind = declarationKind(node.type);
    if (kind !== null) {
      const name = node.childForFieldName("name");
      if (name && name.text.trim() !== "") {
        symbols.push({ name: name.text, kind, line: node.startPosition.row + 1 });
      }
      return;
    }

    if ((node.type === "lexical_declaration" || node.type === "variable_declaration") && isModuleLevel(node)) {
      for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const pattern = declarator.childForFieldName("name");
        if (!pattern) {
          continue;
        }
        for (const name of collectPatternNames(pattern)) {
          symbols.push({ name, kind: "variable", line: declarator.startPosition.row + 1 });
        }
      }
    }
  });

  return deduplicateSymbols(symbols).sort(
    (left, right) => left.line - right.line || compareText(left.name, right.name) || compareText(left.kind, right.kind)
  );
}

function collectDependencies(root: Parser.SyntaxNode, sourcePath: string, knownPaths: Set<string>): RepoGraphDependency[] {
  const dependencies: RepoGraphDependency[] = [];
  walk(root, (node) => {
    if (node.type === "import_statement") {
      addDependency(dependencies, node.childForFieldName("source"), "import", sourcePath, knownPaths);
      return;
    }
    if (node.type === "export_statement") {
      addDependency(dependencies, node.childForFieldName("source"), "reexport", sourcePath, knownPaths);
      return;
    }
    if (node.type !== "call_expression") {
      return;
    }

    const callable = node.childForFieldName("function");
    const argumentsNode = node.childForFieldName("arguments");
    const source = argumentsNode?.namedChildren[0] ?? null;
    if (callable?.type === "identifier" && callable.text === "require") {
      if (!addDependency(dependencies, source, "require", sourcePath, knownPaths)) {
        dependencies.push({ specifier: "<computed>", kind: "require", target: null });
      }
    } else if (callable?.type === "import") {
      if (!addDependency(dependencies, source, "dynamic_import", sourcePath, knownPaths)) {
        dependencies.push({ specifier: "<computed>", kind: "dynamic_import", target: null });
      }
    }
  });

  return deduplicateDependencies(dependencies).sort(
    (left, right) =>
      compareText(left.specifier, right.specifier) ||
      compareText(left.kind, right.kind) ||
      compareText(left.target ?? "", right.target ?? "")
  );
}

function addDependency(
  dependencies: RepoGraphDependency[],
  sourceNode: Parser.SyntaxNode | null,
  kind: RepoDependencyKind,
  sourcePath: string,
  knownPaths: Set<string>
): boolean {
  const specifier = sourceNode ? stringNodeValue(sourceNode) : null;
  if (specifier === null) {
    return false;
  }
  dependencies.push({
    specifier,
    kind,
    target: resolveLocalDependency(sourcePath, specifier, knownPaths)
  });
  return true;
}

function resolveLocalDependency(sourcePath: string, specifier: string, knownPaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  if (unresolved === ".." || unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
    return null;
  }

  for (const candidate of dependencyCandidates(unresolved)) {
    if (knownPaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function dependencyCandidates(unresolved: string): string[] {
  const extension = path.posix.extname(unresolved).toLowerCase();
  const candidates = [unresolved];
  if (extension !== "") {
    const stem = unresolved.slice(0, -extension.length);
    if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
      candidates.push(...sourceExtensions.map((sourceExtension) => `${stem}${sourceExtension}`));
    }
  } else {
    candidates.push(...sourceExtensions.map((sourceExtension) => `${unresolved}${sourceExtension}`));
    candidates.push(...sourceExtensions.map((sourceExtension) => path.posix.join(unresolved, `index${sourceExtension}`)));
  }
  return [...new Set(candidates)];
}

async function readRepoGraphArtifact(repoRoot: string): Promise<GraphResult<RepoGraphArtifact>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(repoGraphArtifactPath(repoRoot), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "repo graph is missing; run `hivemind graph rebuild`" };
    }
    return { ok: false, reason: `repo graph is unreadable: ${errorMessage(error)}` };
  }

  return isRepoGraphArtifact(raw)
    ? { ok: true, value: raw }
    : { ok: false, reason: "repo graph is invalid; rebuild it from source" };
}

function isRepoGraphArtifact(value: unknown): value is RepoGraphArtifact {
  if (!isRecord(value) || value.version !== graphVersion || typeof value.source_fingerprint !== "string" || !Array.isArray(value.files)) {
    return false;
  }
  return value.files.every(
    (file) =>
      isRecord(file) &&
      typeof file.path === "string" &&
      typeof file.content_hash === "string" &&
      Array.isArray(file.symbols) &&
      file.symbols.every(
        (symbol) =>
          isRecord(symbol) &&
          typeof symbol.name === "string" &&
          isSymbolKind(symbol.kind) &&
          Number.isSafeInteger(symbol.line) &&
          Number(symbol.line) > 0
      ) &&
      Array.isArray(file.dependencies) &&
      file.dependencies.every(
        (dependency) =>
          isRecord(dependency) &&
          typeof dependency.specifier === "string" &&
          isDependencyKind(dependency.kind) &&
          (dependency.target === null || typeof dependency.target === "string")
      )
  );
}

function fingerprintSources(sources: SourceFile[]): string {
  return hashText(JSON.stringify(sources.map((source) => [source.path, source.contentHash])));
}

function normalizeRequestedPath(requestedFile: string): string | null {
  const normalized = path.posix.normalize(toRepoPath(requestedFile.trim()));
  if (normalized === "" || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function isSupportedSourcePath(repoPath: string): boolean {
  return sourceExtensions.includes(path.posix.extname(repoPath).toLowerCase() as (typeof sourceExtensions)[number]);
}

function declarationKind(nodeType: string): RepoSymbolKind | null {
  switch (nodeType) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "internal_module":
      return "namespace";
    case "method_definition":
    case "method_signature":
      return "method";
    default:
      return null;
  }
}

function isModuleLevel(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "program" || node.parent?.type === "export_statement";
}

function collectPatternNames(node: Parser.SyntaxNode): string[] {
  if (
    node.type === "identifier" ||
    node.type === "shorthand_property_identifier_pattern" ||
    node.type === "shorthand_property_identifier"
  ) {
    return [node.text];
  }
  return node.namedChildren.flatMap(collectPatternNames);
}

function stringNodeValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== "string") {
    return null;
  }
  if (node.namedChildren.length === 0) {
    return "";
  }
  if (node.namedChildren.some((child) => child.type !== "string_fragment" && child.type !== "escape_sequence")) {
    return null;
  }
  return node.namedChildren.map((child) => child.text).join("");
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function deduplicateSymbols(symbols: RepoGraphSymbol[]): RepoGraphSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}\0${symbol.name}\0${symbol.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateDependencies(dependencies: RepoGraphDependency[]): RepoGraphDependency[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = `${dependency.kind}\0${dependency.specifier}\0${dependency.target ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function unavailable(file: string, reason: string): DependencyClosureResult {
  return { available: false, file, closure: [], reason };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toRepoPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSymbolKind(value: unknown): value is RepoSymbolKind {
  return (
    value === "function" ||
    value === "class" ||
    value === "interface" ||
    value === "type" ||
    value === "enum" ||
    value === "namespace" ||
    value === "variable" ||
    value === "method"
  );
}

function isDependencyKind(value: unknown): value is RepoDependencyKind {
  return value === "import" || value === "reexport" || value === "require" || value === "dynamic_import";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unexpected failure";
}

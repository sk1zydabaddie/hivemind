import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { loadIntegrationQueue, type IntegrationStatus } from "./integration-state.js";
import { readJsonFile } from "./json.js";
import { readActiveLeases, type LeaseStore } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { validateRequestedTaskId } from "./task-id.js";
import { hasFailureCode } from "./failure-code.js";

const schemaVersion = 1;

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;
type SqliteLoadResult = { ok: true; module: SqliteModule } | { ok: false; reason: string };

export interface CacheRebuildResult {
  path: string;
  tasks: number;
  leases: number;
  events: number;
  patches: number;
  integration_queue: number;
  integration_status: boolean;
}

export interface CacheSnapshot {
  tasks: CacheTaskRow[];
  leases: CacheLeaseRow[];
  events: CacheEventRow[];
  patches: CachePatchRow[];
  integration_queue: CacheIntegrationQueueRow[];
  integration_status: IntegrationStatus | null;
}

export interface CacheTaskRow {
  task_id: string;
  title: string;
  agent_role: string;
  base_commit: string;
  contract: TaskContract;
}

export interface CacheLeaseRow {
  file_path: string;
  task_id: string;
}

export interface CacheEventRow {
  seq: number;
  event: HivemindEvent;
}

export interface CachePatchRow {
  task_id: string;
  bundle_present: boolean;
  diff_hash: string | null;
  changed_files: number | null;
}

export interface CacheIntegrationQueueRow {
  position: number;
  task_id: string;
}

interface CacheSourceState {
  tasks: TaskContract[];
  leases: LeaseStore;
  events: HivemindEvent[];
  patches: CachePatchRow[];
  integrationQueue: string[];
  integrationStatus: IntegrationStatus | null;
}

export async function cacheCommand(cwd: string, args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "rebuild" || rest.length > 0) {
    console.error("error: usage: hivemind cache rebuild");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await rebuildCache(repoRoot);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function rebuildCache(
  repoRoot: string
): Promise<{ ok: true; value: CacheRebuildResult } | { ok: false; reason: string }> {
  const sourceResult = await readCacheSourceState(repoRoot);
  if (!sourceResult.ok) {
    return sourceResult;
  }

  const sqliteResult = await loadSqlite();
  if (!sqliteResult.ok) {
    return sqliteResult;
  }

  const finalPath = cacheDbPath(repoRoot);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(finalPath), { recursive: true });
  await rm(tempPath, { force: true });

  let db: DatabaseSync | null = null;
  try {
    db = new sqliteResult.module.DatabaseSync(tempPath);
    writeCacheDatabase(db, sourceResult.value);
    db.close();
    db = null;
    await replaceCacheFile(tempPath, finalPath);
  } catch (error: unknown) {
    if (db !== null) {
      db.close();
    }
    await rm(tempPath, { force: true });
    return { ok: false, reason: error instanceof Error ? error.message : "failed to rebuild cache" };
  }

  return {
    ok: true,
    value: {
      path: path.relative(repoRoot, finalPath).replaceAll("\\", "/"),
      tasks: sourceResult.value.tasks.length,
      leases: Object.keys(sourceResult.value.leases).length,
      events: sourceResult.value.events.length,
      patches: sourceResult.value.patches.length,
      integration_queue: sourceResult.value.integrationQueue.length,
      integration_status: sourceResult.value.integrationStatus !== null
    }
  };
}

export async function readCacheSnapshot(repoRoot: string): Promise<CacheSnapshot> {
  const sqliteResult = await loadSqlite();
  if (!sqliteResult.ok) {
    throw new Error(sqliteResult.reason);
  }

  const db = new sqliteResult.module.DatabaseSync(cacheDbPath(repoRoot));
  try {
    const tasks = selectRows(db, "SELECT task_id, title, agent_role, base_commit, contract_json FROM tasks ORDER BY task_id").map((row) => ({
      task_id: readStringColumn(row, "task_id"),
      title: readStringColumn(row, "title"),
      agent_role: readStringColumn(row, "agent_role"),
      base_commit: readStringColumn(row, "base_commit"),
      contract: JSON.parse(readStringColumn(row, "contract_json")) as TaskContract
    }));
    const leases = selectRows(db, "SELECT file_path, task_id FROM leases ORDER BY file_path").map((row) => ({
      file_path: readStringColumn(row, "file_path"),
      task_id: readStringColumn(row, "task_id")
    }));
    const events = selectRows(db, "SELECT seq, event_json FROM events ORDER BY seq").map((row) => ({
      seq: readNumberColumn(row, "seq"),
      event: JSON.parse(readStringColumn(row, "event_json")) as HivemindEvent
    }));
    const patches = selectRows(db, "SELECT task_id, bundle_present, diff_hash, changed_files FROM patches ORDER BY task_id").map((row) => ({
      task_id: readStringColumn(row, "task_id"),
      bundle_present: readNumberColumn(row, "bundle_present") === 1,
      diff_hash: readNullableStringColumn(row, "diff_hash"),
      changed_files: readNullableNumberColumn(row, "changed_files")
    }));
    const integration_queue = selectRows(db, "SELECT position, task_id FROM integration_queue ORDER BY position").map((row) => ({
      position: readNumberColumn(row, "position"),
      task_id: readStringColumn(row, "task_id")
    }));
    const integrationStatusRows = selectRows(db, "SELECT status_json FROM integration_status WHERE id = 1");
    const integration_status =
      integrationStatusRows.length === 0 ? null : (JSON.parse(readStringColumn(integrationStatusRows[0], "status_json")) as IntegrationStatus);

    return { tasks, leases, events, patches, integration_queue, integration_status };
  } finally {
    db.close();
  }
}

export function cacheDbPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "cache", "state.sqlite");
}

async function readCacheSourceState(repoRoot: string): Promise<{ ok: true; value: CacheSourceState } | { ok: false; reason: string }> {
  const tasksResult = await readTaskContracts(repoRoot);
  if (!tasksResult.ok) {
    return tasksResult;
  }

  const leaseResult = await readActiveLeases(repoRoot);
  if (!leaseResult.ok) {
    return leaseResult;
  }

  const eventResult = await readEvents(repoRoot);
  if (!eventResult.ok) {
    return eventResult;
  }

  const queueResult = await readCacheIntegrationQueue(repoRoot);
  if (!queueResult.ok) {
    return queueResult;
  }

  const statusResult = await readCacheIntegrationStatus(repoRoot);
  if (!statusResult.ok) {
    return statusResult;
  }

  return {
    ok: true,
    value: {
      tasks: tasksResult.value,
      leases: leaseResult.store,
      events: eventResult.value,
      patches: await readPatchRows(repoRoot, tasksResult.value.map((task) => task.task_id)),
      integrationQueue: queueResult.value,
      integrationStatus: statusResult.value
    }
  };
}

async function readTaskContracts(repoRoot: string): Promise<{ ok: true; value: TaskContract[] } | { ok: false; reason: string }> {
  const taskIds = await listTaskIds(repoRoot);
  const tasks: TaskContract[] = [];
  for (const taskId of taskIds) {
    const result = await loadAndValidateContract(repoRoot, taskId);
    if (!result.ok) {
      return { ok: false, reason: `failed to load ${taskId}: ${result.reason}` };
    }
    tasks.push(result.contract);
  }
  return { ok: true, value: tasks };
}

async function readCacheIntegrationQueue(repoRoot: string): Promise<{ ok: true; value: string[] } | { ok: false; reason: string }> {
  const result = await loadIntegrationQueue(repoRoot);
  if (!result.ok) {
    // No queue FILE means no queued work; anything else is a real failure.
    return hasFailureCode(result, "integration_queue_not_found") ? { ok: true, value: [] } : result;
  }
  return { ok: true, value: result.value.map((entry) => entry.task_id) };
}

async function readCacheIntegrationStatus(repoRoot: string): Promise<{ ok: true; value: IntegrationStatus | null } | { ok: false; reason: string }> {
  try {
    const raw = await readJsonFile(path.join(repoRoot, ".hivemind", "integration", "status.json"));
    if (!isIntegrationStatus(raw)) {
      return { ok: false, reason: "integration status must contain branch, applied, tests, and report" };
    }
    return { ok: true, value: raw };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: null };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/integration/status.json" };
    }
    throw error;
  }
}

async function readPatchRows(repoRoot: string, taskIds: string[]): Promise<CachePatchRow[]> {
  const patchTaskIds = new Set(taskIds);
  for (const taskId of await listPatchTaskIds(repoRoot)) {
    patchTaskIds.add(taskId);
  }

  const rows: CachePatchRow[] = [];
  for (const taskId of [...patchTaskIds].sort((left, right) => left.localeCompare(right))) {
    const diffPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
    if (!(await exists(diffPath))) {
      rows.push({ task_id: taskId, bundle_present: false, diff_hash: null, changed_files: null });
      continue;
    }
    const diff = await readFile(diffPath, "utf8");
    rows.push({
      task_id: taskId,
      bundle_present: true,
      diff_hash: createHash("sha256").update(diff).digest("hex"),
      changed_files: countDiffFileHeaders(diff)
    });
  }
  return rows;
}

function writeCacheDatabase(db: DatabaseSync, source: CacheSourceState): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      contract_json TEXT NOT NULL
    );
    CREATE TABLE leases (
      file_path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      task_id TEXT,
      event_json TEXT NOT NULL
    );
    CREATE TABLE patches (
      task_id TEXT PRIMARY KEY,
      bundle_present INTEGER NOT NULL,
      diff_hash TEXT,
      changed_files INTEGER
    );
    CREATE TABLE integration_queue (
      position INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL
    );
    CREATE TABLE integration_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status_json TEXT NOT NULL
    );
  `);

  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("schema_version", String(schemaVersion));
    const insertTask = db.prepare(
      "INSERT INTO tasks (task_id, title, agent_role, base_commit, contract_json) VALUES (?, ?, ?, ?, ?)"
    );
    for (const task of source.tasks) {
      insertTask.run(task.task_id, task.title, task.agent_role, task.base_commit, JSON.stringify(task));
    }

    const insertLease = db.prepare("INSERT INTO leases (file_path, task_id) VALUES (?, ?)");
    for (const [filePath, taskId] of Object.entries(source.leases).sort(([left], [right]) => left.localeCompare(right))) {
      insertLease.run(filePath, taskId);
    }

    const insertEvent = db.prepare("INSERT INTO events (seq, ts, type, task_id, event_json) VALUES (?, ?, ?, ?, ?)");
    for (const [index, event] of source.events.entries()) {
      insertEvent.run(index + 1, event.ts, event.type, event.task_id, JSON.stringify(event));
    }

    const insertPatch = db.prepare("INSERT INTO patches (task_id, bundle_present, diff_hash, changed_files) VALUES (?, ?, ?, ?)");
    for (const patch of source.patches) {
      insertPatch.run(patch.task_id, patch.bundle_present ? 1 : 0, patch.diff_hash, patch.changed_files);
    }

    const insertQueue = db.prepare("INSERT INTO integration_queue (position, task_id) VALUES (?, ?)");
    for (const [index, taskId] of source.integrationQueue.entries()) {
      insertQueue.run(index + 1, taskId);
    }

    if (source.integrationStatus !== null) {
      db.prepare("INSERT INTO integration_status (id, status_json) VALUES (1, ?)").run(JSON.stringify(source.integrationStatus));
    }
    db.exec("COMMIT");
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function replaceCacheFile(tempPath: string, finalPath: string): Promise<void> {
  await rename(tempPath, finalPath);
}

async function loadSqlite(): Promise<SqliteLoadResult> {
  try {
    return { ok: true, module: await import("node:sqlite") };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? `failed to load node:sqlite: ${error.message}` : "failed to load node:sqlite" };
  }
}

function selectRows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function readStringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`cache column ${key} must be a string`);
  }
  return value;
}

function readNullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`cache column ${key} must be a string or null`);
  }
  return value;
}

function readNumberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`cache column ${key} must be a number`);
  }
  return value;
}

function readNullableNumberColumn(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`cache column ${key} must be a number or null`);
  }
  return value;
}

async function listTaskIds(repoRoot: string): Promise<string[]> {
  const tasksDir = path.join(repoRoot, ".hivemind", "tasks");
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".contract.json"))
      .map((entry) => entry.name.slice(0, -".contract.json".length))
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function listPatchTaskIds(repoRoot: string): Promise<string[]> {
  const patchesDir = path.join(repoRoot, ".hivemind", "patches");
  try {
    const entries = await readdir(patchesDir, { withFileTypes: true });
    const taskIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const validation = validateRequestedTaskId(entry.name);
      if (validation.ok) {
        taskIds.push(entry.name);
      }
    }
    return taskIds.sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function countDiffFileHeaders(diff: string): number {
  return diff.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length;
}

function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return (
    isRecord(value) &&
    typeof value.branch === "string" &&
    Array.isArray(value.applied) &&
    value.applied.every((entry) => typeof entry === "string") &&
    (value.tests === "pass" || value.tests === "fail" || value.tests === "blocked") &&
    typeof value.report === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

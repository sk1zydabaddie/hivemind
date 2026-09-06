import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import {
  listProjectFiles,
  readProjectFile,
  PROJECT_FILE_READ_LIMIT_BYTES
} from "../src/project-files.js";
import { executeWorkspaceAction, workspaceActionTypes } from "../src/workspace-actions.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/* The file tree's Core action.
 *
 * `files.list` and `files.read` are the first actions added to the surface
 * whose entire job is to read the working tree, and a reader is still an
 * authorization surface: one that can be talked out of its confinement hands
 * over source, credentials, and the trail itself.
 *
 * So the confinement is tested the dangerous way round -- every test here
 * asserts that something is REFUSED, and the two that assert success exist so
 * the refusals cannot pass vacuously against an action that never works at all.
 *
 * And it is tested from every caller, not only from the function: in-process,
 * over the CLI, and over the daemon's HTTP route. A guard that lives in one of
 * three entry points is not a guard.
 */

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "project-files",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
      await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
      await initProject(repo);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-project-files-test-"
  );
}

test("the file reader serves project source and says what a listing contains", async () => {
  await withRepo(async (repo) => {
    const listed = await listProjectFiles(repo, ".");
    assert.equal(listed.ok, true);
    if (listed.ok) {
      const names = listed.value.entries.map((entry) => entry.name);
      assert.ok(names.includes("README.md"), `root listing was ${names.join(", ")}`);
      assert.ok(names.includes("src"));
      /* Directories first, then files, each alphabetical -- a tree that
         reorders itself between reads is a tree nobody can click. */
      assert.equal(listed.value.entries[0]?.kind, "directory");
      const source = listed.value.entries.find((entry) => entry.name === "src");
      assert.equal(source?.kind, "directory");
      assert.equal(source?.path, "src");
    }

    const read = await readProjectFile(repo, "src/app.ts");
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.text, "export const value = 1;\n");
      assert.equal(read.value.truncated, false);
      assert.equal(read.value.path, "src/app.ts");
    }
  });
});

test("nothing reaches outside the project root, however it is spelled", async () => {
  await withRepo(async (repo) => {
    for (const attempt of [
      "../etc/passwd",
      "../../secret.txt",
      "src/../../escape.txt",
      "/etc/passwd",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "..\\..\\escape.txt"
    ]) {
      const listed = await listProjectFiles(repo, attempt);
      assert.equal(listed.ok, false, `list accepted ${attempt}`);
      const read = await readProjectFile(repo, attempt);
      assert.equal(read.ok, false, `read accepted ${attempt}`);
    }
  });
});

/* A DIRECTORY JUNCTION, deliberately, rather than a file symlink.
 *
 * The first draft of these two used `symlink(..., "file")` and fell back to a
 * bare `return` when the OS refused. On Windows that refusal is EPERM unless
 * developer mode is on -- so on the machine this was written on, both tests
 * built no hazard at all and reported `ok`. A guard proven against a hazard
 * that was never created is exactly the instrument that can only return one
 * answer, and it looked like a pass.
 *
 * A junction needs no privilege, and `realpath` resolves through it, so the
 * hazard is real on both platforms. Where even that fails, the test SKIPS
 * loudly through the test context: skipped is visible in the output, `return`
 * is not.
 */
async function linkDirectory(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, "junction");
    return true;
  } catch {
    try {
      await symlink(target, link, "dir");
      return true;
    } catch {
      return false;
    }
  }
}

test("a link out of the repository is refused on where it lands, not how it is named", async (t) => {
  await withRepo(async (repo) => {
    /* The dangerous direction: an innocuous name INSIDE the repo pointing at
       something outside it. A lexical check passes this; only resolving it
       catches it. */
    const outside = path.join(repo, "..", "outside-secrets");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "not yours\n");

    if (!(await linkDirectory(outside, path.join(repo, "innocuous")))) {
      t.skip("this platform will not create a directory link, so the hazard was not built");
      return;
    }

    const read = await readProjectFile(repo, "innocuous/secret.txt");
    assert.equal(read.ok, false, "a link out of the repo was followed");
    if (!read.ok) assert.match(read.reason, /outside repo root/u);

    const listed = await listProjectFiles(repo, "innocuous");
    assert.equal(listed.ok, false, "a link out of the repo was listed");

    /* And it is not offered by the root listing either, so nothing shows a
       person an entry that then refuses to open. */
    const root = await listProjectFiles(repo, ".");
    assert.equal(root.ok, true);
    if (root.ok) {
      assert.ok(
        !root.value.entries.some((entry) => entry.name === "innocuous"),
        "the escaping link was listed"
      );
    }
  });
});

test("a link to .hivemind is refused even though its name is not", async (t) => {
  await withRepo(async (repo) => {
    if (!(await linkDirectory(path.join(repo, ".hivemind"), path.join(repo, "notes")))) {
      t.skip("this platform will not create a directory link, so the hazard was not built");
      return;
    }
    /* The refused-root check runs on the RESOLVED path for exactly this case:
       checking the spelling would let any name at all reach the record. */
    const listed = await listProjectFiles(repo, "notes");
    assert.equal(listed.ok, false, "a link into .hivemind was listed");
    const read = await readProjectFile(repo, "notes/config.json");
    assert.equal(read.ok, false, "a link into .hivemind was read");
  });
});

test("Hivemind's own record is not served as project files", async () => {
  await withRepo(async (repo) => {
    for (const attempt of [
      ".hivemind",
      ".hivemind/config.json",
      ".hivemind/canon",
      /* Case-folded unconditionally: on a case-insensitive volume this reaches
         the real directory while a byte comparison says it did not. */
      ".Hivemind/config.json",
      ".HIVEMIND",
      /* Backslashes are a separator here too. */
      ".hivemind\\config.json"
    ]) {
      const listed = await listProjectFiles(repo, attempt);
      assert.equal(listed.ok, false, `list served ${attempt}`);
      const read = await readProjectFile(repo, attempt);
      assert.equal(read.ok, false, `read served ${attempt}`);
    }

    /* The refusal names the action that DOES serve it, so a caller is pointed
       at the audited path rather than left guessing. */
    const refused = await readProjectFile(repo, ".hivemind/config.json");
    if (!refused.ok) assert.match(refused.reason, /config\.inspect/u);
  });
});

test("the git directory is refused, and neither it nor .hivemind is listed", async () => {
  await withRepo(async (repo) => {
    for (const attempt of [".git", ".git/config", ".GIT/config"]) {
      const read = await readProjectFile(repo, attempt);
      assert.equal(read.ok, false, `read served ${attempt}`);
      const listed = await listProjectFiles(repo, attempt);
      assert.equal(listed.ok, false, `list served ${attempt}`);
    }
    const listed = await listProjectFiles(repo, ".");
    assert.equal(listed.ok, true);
    if (listed.ok) {
      const names = listed.value.entries.map((entry) => entry.name.toLowerCase());
      assert.ok(!names.includes(".git"), "the git directory was listed");
      assert.ok(!names.includes(".hivemind"), "the Hivemind directory was listed");
    }
  });
});

test("a listing is not a read, and a read is not a listing", async () => {
  await withRepo(async (repo) => {
    const fileAsDirectory = await listProjectFiles(repo, "README.md");
    assert.equal(fileAsDirectory.ok, false);
    if (!fileAsDirectory.ok) assert.match(fileAsDirectory.reason, /not a directory/u);

    const directoryAsFile = await readProjectFile(repo, "src");
    assert.equal(directoryAsFile.ok, false);
    if (!directoryAsFile.ok) assert.match(directoryAsFile.reason, /is a directory/u);
  });
});

test("what is not text is said to be, rather than returned as damage", async () => {
  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const read = await readProjectFile(repo, "logo.png");
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.reason, /not text/u);
  });
});

test("a file larger than the read limit is truncated and says so", async () => {
  await withRepo(async (repo) => {
    const line = "x".repeat(999) + "\n";
    const big = line.repeat(Math.ceil((PROJECT_FILE_READ_LIMIT_BYTES + 5000) / line.length));
    await writeFile(path.join(repo, "big.txt"), big);
    const read = await readProjectFile(repo, "big.txt");
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.truncated, true);
      assert.equal(read.value.text.length, PROJECT_FILE_READ_LIMIT_BYTES);
      assert.ok(read.value.bytes > PROJECT_FILE_READ_LIMIT_BYTES);
    }
  });
});

test("the project reader uses a bounded handle read even for a 64 MiB file", async () => {
  await withRepo(async (repo) => {
    const file = path.join(repo, "large-text.txt");
    const handle = await open(file, "w");
    try {
      await handle.write(Buffer.alloc(PROJECT_FILE_READ_LIMIT_BYTES, "x"));
      await handle.truncate(64 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const measured = await instrumentProjectRead(repo, "large-text.txt", "normal");
    assert.equal(measured.result.ok, true, JSON.stringify(measured));
    assert.deepEqual(measured.result.value, {
      path: "large-text.txt", textLength: PROJECT_FILE_READ_LIMIT_BYTES,
      prefix: "x".repeat(16), bytes: 64 * 1024 * 1024, truncated: true
    });
    assert.equal(measured.wholeFileReads, 0, "reader attempted to load the whole file");
    assert.equal(measured.opened, 1);
    assert.equal(measured.closed, 1);
    assert.equal(measured.requestedBytes, PROJECT_FILE_READ_LIMIT_BYTES);
    assert.equal(measured.returnedBytes, PROJECT_FILE_READ_LIMIT_BYTES);
  });
});

test("the bounded file reader fills short reads and closes its handle", async () => {
  await withRepo(async (repo) => {
    const content = "x".repeat(1024);
    await writeFile(path.join(repo, "short-reads.txt"), content);
    const measured = await instrumentProjectRead(repo, "short-reads.txt", "short");
    assert.equal(measured.result.ok, true, JSON.stringify(measured));
    assert.equal(measured.result.value?.textLength, content.length);
    assert.equal(measured.result.value?.truncated, false);
    assert.equal(measured.result.value?.bytes, content.length);
    assert.ok(measured.readCalls > 1, "the read instrument did not force partial reads");
    assert.equal(measured.returnedBytes, content.length);
    assert.equal(measured.closed, 1);
  });
});

test("a changing or failed file read refuses and releases its handle", async () => {
  await withRepo(async (repo) => {
    for (const mode of ["change", "error"] as const) {
      await writeFile(path.join(repo, "changing.txt"), "x".repeat(1024));
      const measured = await instrumentProjectRead(repo, "changing.txt", mode);
      assert.equal(measured.result.ok, false, JSON.stringify(measured));
      assert.match(measured.result.reason ?? "", mode === "change" ? /changed.*retry/u : /cannot be read/u);
      assert.equal(measured.opened, 1);
      assert.equal(measured.closed, 1);
    }
  });
});

test("bounded text preserves empty and exact-limit files and never splits UTF-8", async () => {
  await withRepo(async (repo) => {
    for (const content of ["", "x".repeat(PROJECT_FILE_READ_LIMIT_BYTES)]) {
      await writeFile(path.join(repo, "boundary.txt"), content);
      const result = await readProjectFile(repo, "boundary.txt");
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.value, {
        path: "boundary.txt", text: content, bytes: Buffer.byteLength(content), truncated: false
      });
    }
    for (const character of ["é", "€", "🛰"]) {
      for (let received = 1; received < Buffer.byteLength(character); received += 1) {
        const prefix = "x".repeat(PROJECT_FILE_READ_LIMIT_BYTES - received);
        const content = prefix + character + "tail";
        await writeFile(path.join(repo, "boundary.txt"), content);
        const result = await readProjectFile(repo, "boundary.txt");
        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.value, {
          path: "boundary.txt", text: prefix, bytes: Buffer.byteLength(content), truncated: true
        });
      }
    }
  });
});

interface ProjectReadMeasurement {
  result: { ok: boolean; value?: { path: string; textLength: number; prefix: string; bytes: number; truncated: boolean }; reason?: string };
  wholeFileReads: number;
  opened: number;
  closed: number;
  readCalls: number;
  requestedBytes: number;
  returnedBytes: number;
}

/** Instrument actual filesystem calls in an isolated process, not the reader's
 * claimed metadata. A whole-file read is refused before allocating its payload. */
async function instrumentProjectRead(
  repo: string, requested: string, mode: "normal" | "short" | "change" | "error"
): Promise<ProjectReadMeasurement> {
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const target = ${JSON.stringify(path.join(repo, requested))};
    const mode = ${JSON.stringify(mode)};
    const trace = { wholeFileReads: 0, opened: 0, closed: 0, readCalls: 0, requestedBytes: 0, returnedBytes: 0 };
    const originalReadFile = fs.readFile.bind(fs), originalOpen = fs.open.bind(fs);
    fs.readFile = async (file, ...args) => {
      if (String(file) === target) {
        trace.wholeFileReads += 1;
        throw new Error("whole-file loading is forbidden by this test");
      }
      return originalReadFile(file, ...args);
    };
    fs.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (String(file) !== target) return handle;
      trace.opened += 1;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        trace.readCalls += 1;
        trace.requestedBytes += length;
        if (mode === "error") throw new Error("injected read error");
        const result = await read(buffer, offset, mode === "short" ? Math.min(97, length) : length, position);
        trace.returnedBytes += result.bytesRead;
        if (mode === "change" && trace.readCalls === 1) await fs.appendFile(target, "changed");
        return result;
      };
      handle.close = async () => { trace.closed += 1; return close(); };
      return handle;
    };
    syncBuiltinESMExports();
    const { readProjectFile } = await import(${JSON.stringify(pathToFileURL(path.resolve("dist/src/project-files.js")).href)});
    const result = await readProjectFile(${JSON.stringify(repo)}, ${JSON.stringify(requested)});
    if (result.ok) {
      const { text, ...metadata } = result.value;
      result.value = { ...metadata, textLength: text.length, prefix: text.slice(0, 16) };
    }
    console.log(JSON.stringify({ ...trace, result }));
  `;
  const measured = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { windowsHide: true });
  return JSON.parse(measured.stdout) as ProjectReadMeasurement;
}

test("the file actions add no write path", async () => {
  await withRepo(async (repo) => {
    const before = await snapshot(repo);
    await listProjectFiles(repo, ".");
    await readProjectFile(repo, "README.md");
    await executeWorkspaceAction(repo, { type: "files.list", payload: {} });
    await executeWorkspaceAction(repo, { type: "files.read", payload: { path: "README.md" } });
    assert.deepEqual(await snapshot(repo), before);

    /* And there is no writing verb in the module at all. Checked against the
       source because a behavioural test can only prove that THESE calls wrote
       nothing, not that no call could. */
    const source = await readFile(path.resolve("src/project-files.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    for (const verb of ["writeFile", "appendFile", "mkdir", "rm(", "rename", "unlink", "createWriteStream", "chmod"]) {
      assert.ok(!code.includes(verb), `project-files.ts reaches for ${verb}`);
    }
  });
});

test("the payload is shaped, and no authority field rides along", async () => {
  await withRepo(async (repo) => {
    const extra = await executeWorkspaceAction(repo, {
      type: "files.read",
      payload: { path: "README.md", encoding: "utf8" }
    });
    assert.equal(extra.ok, false);

    const missing = await executeWorkspaceAction(repo, { type: "files.read", payload: {} });
    assert.equal(missing.ok, false);

    for (const field of ["approved", "human", "force", "authorized", "gate_passed"]) {
      const crafted = await executeWorkspaceAction(repo, {
        type: "files.list",
        [field]: true,
        payload: { path: "." }
      });
      assert.equal(crafted.ok, false, `files.list accepted ${field}`);
      if (!crafted.ok) assert.match(crafted.reason, /cannot supply authority field/u);
    }

    /* A listing with no path means the root, so a tree can open knowing
       nothing. Asserted so the optionality is deliberate rather than a gap. */
    const root = await executeWorkspaceAction(repo, { type: "files.list", payload: {} });
    assert.equal(root.ok, true);
  });
});

test("the confinement holds over the CLI, not only in process", async () => {
  await withRepo(async (repo) => {
    const actionFile = path.join(repo, "action.json");

    await writeFile(actionFile, JSON.stringify({ type: "files.read", payload: { path: "../outside.txt" } }));
    await writeFile(path.join(repo, "..", "outside.txt"), "not yours\n");
    const escaped = await runCli(repo, actionFile);
    assert.notEqual(escaped.code, 0, "the CLI served a path outside the repo");
    assert.ok(!escaped.stdout.includes("not yours"));

    await writeFile(actionFile, JSON.stringify({ type: "files.read", payload: { path: ".hivemind/config.json" } }));
    const record = await runCli(repo, actionFile);
    assert.notEqual(record.code, 0, "the CLI served Hivemind's own record");

    /* Not vacuous: the same caller serves real source. */
    await writeFile(actionFile, JSON.stringify({ type: "files.read", payload: { path: "src/app.ts" } }));
    const allowed = await runCli(repo, actionFile);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stdout, /export const value/u);
  });
});

test("the confinement holds over the daemon route, not only in process", async () => {
  await withRepo(async (repo) => {
    await writeFile(path.join(repo, "..", "outside.txt"), "not yours\n");
    const daemon = await startDaemon(repo);
    try {
      const escaped = await postAction(daemon.url, daemon.authToken, {
        type: "files.read",
        payload: { path: "../outside.txt" }
      });
      assert.equal(escaped.response.status, 400);
      assert.equal(escaped.body.ok, false);

      const record = await postAction(daemon.url, daemon.authToken, {
        type: "files.list",
        payload: { path: ".hivemind" }
      });
      assert.equal(record.response.status, 400);
      assert.equal(record.body.ok, false);

      const crafted = await postAction(daemon.url, daemon.authToken, {
        type: "files.read",
        approved: true,
        payload: { path: "README.md" }
      });
      assert.equal(crafted.response.status, 400);
      assert.match(String(crafted.body.reason), /cannot supply authority field/u);

      /* Not vacuous. */
      const allowed = await postAction(daemon.url, daemon.authToken, {
        type: "files.read",
        payload: { path: "src/app.ts" }
      });
      assert.equal(allowed.response.status, 200);
      assert.equal(allowed.body.ok, true);
    } finally {
      daemon.child.kill("SIGTERM");
      await once(daemon.child, "exit");
    }
  });
});

/* Not about the file actions specifically -- about the rule they were added
 * under. "It goes in the audit table with the others" is only a rule if
 * something checks; otherwise the table is accurate until the next action, and
 * then quietly is not. This is the check.
 */
test("every workspace action appears in the routing audit", async () => {
  const audit = await readFile(path.resolve("docs/m8-action-routing-audit.md"), "utf8");
  const missing = workspaceActionTypes.filter((type) => !audit.includes(`\`${type}\``));
  assert.deepEqual(
    missing,
    [],
    `these actions exist but are not documented in docs/m8-action-routing-audit.md: ${missing.join(", ")}`
  );
});

/** Every path under the repo and its bytes, so a write anywhere is visible. */
async function snapshot(repo: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(repo, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (next === ".git") continue;
        await walk(next);
      } else if (entry.isFile()) {
        out[next] = (await readFile(path.join(repo, next))).length;
      }
    }
  };
  await walk("");
  return out;
}

async function runCli(
  repo: string,
  actionFile: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("dist/src/cli.js"), "workspace", actionFile],
      { cwd: repo, windowsHide: true }
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const shaped = error as { code?: number; stdout?: string; stderr?: string };
    return { code: shaped.code ?? 1, stdout: shaped.stdout ?? "", stderr: shaped.stderr ?? "" };
  }
}

async function startDaemon(repo: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string; authToken: string }> {
  const child = spawn(process.execPath, [path.resolve("dist/src/cli.js"), "daemon", "--port", "0"], {
    cwd: repo,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon startup timed out: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().startsWith("{"));
      if (line === undefined) return;
      const parsed = JSON.parse(line) as { url?: string };
      if (typeof parsed.url === "string") {
        clearTimeout(timer);
        resolve(parsed.url);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited during startup (${String(code)}): ${stderr}`));
    });
  });
  const state = JSON.parse(
    await readFile(path.join(repo, ".hivemind", "daemon.json"), "utf8")
  ) as { auth_token?: unknown };
  assert.match(String(state.auth_token ?? ""), /^[A-Za-z0-9_-]{43}$/u);
  return { child, url, authToken: String(state.auth_token) };
}

async function postAction(
  url: string,
  authToken: string,
  body: unknown
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/workspace/action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

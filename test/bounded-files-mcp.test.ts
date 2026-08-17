import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureBoundedFilesAccountConfig } from "../src/adapter.js";
import { boundedFileToolNames } from "../src/bounded-files-mcp.js";
import { resolveProviderEndpoint } from "../src/provider-endpoint.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("bounded file MCP supports normal project edits and deterministic discovery", async () => {
  await withFixture(async (root) => {
    await withClient(root, async (client) => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((entry) => entry.name), [...boundedFileToolNames]);

      await callOk(client, "write_file", { path: "src/example.ts", content: "const answer = 41;\n" });
      await callOk(client, "replace_in_file", { path: "src/example.ts", old_text: "41", new_text: "42" });
      const read = await callOk(client, "read_file", { path: "src/example.ts" });
      assert.equal(read.content, "const answer = 42;\n");
      const listed = await callOk(client, "list_files", { path: "." });
      assert.deepEqual(listed.files, ["README.md", "src/example.ts"]);
      const searched = await callOk(client, "search_files", { path: ".", query: "answer" });
      assert.deepEqual(searched.matches, [{ path: "src/example.ts", line: 1, text: "const answer = 42;" }]);
    });
  });
});

test("bounded file MCP refuses absolute paths, traversal, protected state, and ambiguous replacements", async () => {
  await withFixture(async (root) => {
    await mkdir(path.join(root, ".hivemind"), { recursive: true });
    await writeFile(path.join(root, ".hivemind", "config.json"), "secret\n");
    await writeFile(path.join(root, "repeat.txt"), "same same\n");
    await withClient(root, async (client) => {
      await callRefused(client, "read_file", { path: path.join(root, "README.md") }, /absolute paths/u);
      await callRefused(client, "write_file", { path: "../escape.txt", content: "no" }, /traversal/u);
      await callRefused(client, "read_file", { path: ".hivemind/config.json" }, /protected/u);
      await callRefused(client, "replace_in_file", { path: "repeat.txt", old_text: "same", new_text: "x" }, /not unique/u);
    });
  });
});

test("Kimi account MCP config is created only when absent and refuses ambient servers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hivemind-kimi-home-"));
  try {
    assert.deepEqual(await ensureBoundedFilesAccountConfig({ KIMI_CODE_HOME: home }), { ok: true });
    const first = await readFile(path.join(home, "mcp.json"), "utf8");
    assert.match(first, /hivemind_files/u);
    assert.match(first, /files-mcp/u);
    assert.deepEqual(await ensureBoundedFilesAccountConfig({ KIMI_CODE_HOME: home }), { ok: true });

    const same = JSON.parse(first) as { mcpServers: { hivemind_files: { command: string; args: string[] } } };
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({
      mcpServers: { hivemind_files: { args: same.mcpServers.hivemind_files.args, command: same.mcpServers.hivemind_files.command } }
    }));
    assert.deepEqual(await ensureBoundedFilesAccountConfig({ KIMI_CODE_HOME: home }), { ok: true });

    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { ambient: { command: "danger" } } }));
    const refused = await ensureBoundedFilesAccountConfig({ KIMI_CODE_HOME: home });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /different or additional MCP server/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the selected Kimi home determines the reported alternate-provider endpoint", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hivemind-kimi-endpoint-"));
  try {
    await writeFile(path.join(home, "config.toml"), '[providers.fixture]\nbase_url = "http://127.0.0.1:9877/v1"\n');
    const endpoint = await resolveProviderEndpoint({
      tool: "kimi",
      invoke: ["kimi"],
      environment: { USERPROFILE: tmpdir(), KIMI_CODE_HOME: home }
    });
    assert.equal(endpoint.standing, "configured");
    assert.equal(endpoint.host, "127.0.0.1:9877");
    assert.equal(endpoint.source, "harness_config");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-files-mcp-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "fixture\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withClient(root: string, run: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ name: "bounded-files-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, "files-mcp"], cwd: root, stderr: "pipe" });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

async function callOk(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
}

async function callRefused(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), pattern);
}

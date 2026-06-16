#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(repoRoot, "dist", "src", "cli.js");

const [taskId, mergeRef, ...extraArgs] = process.argv.slice(2);

if (!taskId || !mergeRef || extraArgs.length > 0 || taskId.startsWith("-") || mergeRef.startsWith("-")) {
  console.error("error: usage: node scripts/hivemind-protected-merge.mjs <task_id> <merge_ref>");
  process.exit(1);
}

if (!existsSync(cliPath)) {
  console.error("error: built Hivemind CLI not found; run npm run build before protected merge");
  process.exit(1);
}

const analyzeResult = spawnSync(process.execPath, [cliPath, "analyze", taskId], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});

writeResultOutput(analyzeResult);

if (analyzeResult.error || analyzeResult.status !== 0) {
  console.error(`error: protected merge blocked by hivemind analyze for ${taskId}`);
  process.exit(analyzeResult.status ?? 1);
}

const mergeResult = spawnSync("git", ["merge", "--ff-only", mergeRef], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});

writeResultOutput(mergeResult);

if (mergeResult.error || mergeResult.status !== 0) {
  process.exit(mergeResult.status ?? 1);
}

function writeResultOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    console.error(`error: ${result.error.message}`);
  }
}

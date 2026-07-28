#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const [targetArg, ...extraArgs] = process.argv.slice(2);

if (!targetArg || extraArgs.length > 0 || !path.isAbsolute(targetArg)) {
  fail("usage: node scripts/create-isolated-fixture-repo.mjs <absolute-new-directory>");
}

const requestedTarget = path.resolve(targetArg);
try {
  mkdirSync(requestedTarget, { recursive: false });
} catch (error) {
  fail(`fixture target must be a new directory: ${errorMessage(error)}`);
}

const target = realpathSync(requestedTarget);
if (!samePath(target, requestedTarget)) {
  fail(`fixture target resolved somewhere unexpected: requested ${requestedTarget}, resolved ${target}`);
}

runGit(target, ["init", "--initial-branch=main"]);
const topLevel = runGit(target, ["rev-parse", "--show-toplevel"]).stdout.trim();
const resolvedTopLevel = realpathSync(topLevel);
if (!samePath(resolvedTopLevel, target)) {
  fail(`fixture git top-level mismatch: expected ${target}, got ${resolvedTopLevel}`);
}

process.stdout.write(`${JSON.stringify({ repo: target, branch: "main" })}\n`);

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) {
    fail(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed with exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

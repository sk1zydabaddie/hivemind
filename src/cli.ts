#!/usr/bin/env node

import { analyzeCommand } from "./analyze.js";
import { intentCommand } from "./intent.js";
import { initProject } from "./init.js";
import { leaseCommand } from "./lease.js";
import { validateContractCommand } from "./contract.js";
import { runCommand } from "./run.js";
import { worktreeCommand } from "./worktree.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "init" && rest.length === 0) {
    return initProject(process.cwd());
  }

  if (command === "contract") {
    return validateContractCommand(process.cwd(), rest);
  }

  if (command === "worktree") {
    return worktreeCommand(process.cwd(), rest);
  }

  if (command === "run") {
    return runCommand(process.cwd(), rest);
  }

  if (command === "analyze") {
    return analyzeCommand(process.cwd(), rest);
  }

  if (command === "lease") {
    return leaseCommand(process.cwd(), rest);
  }

  if (command === "intent") {
    return intentCommand(process.cwd(), rest);
  }

  console.error(command ? `error: unknown command ${command}` : "error: missing command");
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : "error: unexpected failure");
    process.exitCode = 1;
  });

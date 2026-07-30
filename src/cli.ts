#!/usr/bin/env node

import { analyzeCommand } from "./analyze.js";
import { checkpointCommand } from "./checkpoint.js";
import { daemonCommand } from "./daemon.js";
import { integrateCommand } from "./integrate.js";
import { intentCommand } from "./intent.js";
import { ideationCommand } from "./ideation.js";
import { initProject } from "./init.js";
import { leaseCommand } from "./lease.js";
import { routingCommand } from "./learned-routing.js";
import { managerCommand } from "./manager.js";
import { memoryCommand } from "./memory.js";
import { quotaCommand } from "./resource-ledger.js";
import { validateContractCommand } from "./contract.js";
import { planCommand } from "./plan.js";
import { specCommand } from "./spec.js";
import { runCommand } from "./run.js";
import { scoutCommand } from "./scout.js";
import { statusCommand } from "./status.js";
import { submitCommand } from "./submit.js";
import { verifyCommand } from "./verify.js";
import { valueQualityCommand } from "./value-quality.js";
import { worktreeCommand } from "./worktree.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "init" && rest.length === 0) {
    return initProject(process.cwd());
  }

  if (command === "contract") {
    return validateContractCommand(process.cwd(), rest);
  }

  if (command === "spec") {
    return specCommand(process.cwd(), rest);
  }

  if (command === "plan") {
    if (rest.length === 2 && rest[1] === "--ground") {
      try {
        const { evaluateClosureCoverage } = await import("./closure-coverage.js");
        return planCommand(process.cwd(), rest, { closureCoverageAdvisory: evaluateClosureCoverage });
      } catch {
        return planCommand(process.cwd(), rest);
      }
    }
    return planCommand(process.cwd(), rest);
  }

  if (command === "ideate") {
    return ideationCommand(process.cwd(), rest);
  }

  if (command === "manager") {
    return managerCommand(process.cwd(), rest);
  }

  if (command === "memory") {
    return memoryCommand(process.cwd(), rest);
  }

  if (command === "routing") {
    return routingCommand(process.cwd(), rest);
  }

  if (command === "quality") {
    if (rest[0] === "best-of-n") {
      const { bestOfNCommand } = await import("./best-of-n.js");
      return bestOfNCommand(process.cwd(), rest);
    }
    if (rest[0] === "select") {
      const { qualitySelectionCommand } = await import("./quality-selection.js");
      return qualitySelectionCommand(process.cwd(), rest);
    }
    return valueQualityCommand(process.cwd(), rest);
  }

  if (command === "worktree") {
    return worktreeCommand(process.cwd(), rest);
  }

  if (command === "run") {
    return runCommand(process.cwd(), rest);
  }

  if (command === "scout") {
    return scoutCommand(process.cwd(), rest);
  }

  if (command === "analyze") {
    return analyzeCommand(process.cwd(), rest);
  }

  if (command === "daemon") {
    return daemonCommand(process.cwd(), rest);
  }

  if (command === "cache") {
    const { cacheCommand } = await import("./cache.js");
    return cacheCommand(process.cwd(), rest);
  }

  if (command === "checkpoint") {
    return checkpointCommand(process.cwd(), rest);
  }

  if (command === "quota") {
    return quotaCommand(process.cwd(), rest);
  }

  if (command === "graph") {
    try {
      const { repoGraphCommand } = await import("./repo-graph.js");
      return repoGraphCommand(process.cwd(), rest);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "unexpected module-load failure";
      console.error(`error: repo graph unavailable: ${reason}`);
      return 1;
    }
  }

  if (command === "mcp") {
    const { mcpCommand } = await import("./mcp.js");
    return mcpCommand(process.cwd(), rest);
  }

  if (command === "lease") {
    return leaseCommand(process.cwd(), rest);
  }

  if (command === "intent") {
    return intentCommand(process.cwd(), rest);
  }

  if (command === "integrate") {
    return integrateCommand(process.cwd(), rest);
  }

  if (command === "status") {
    return statusCommand(process.cwd(), rest);
  }

  if (command === "verify") {
    return verifyCommand(process.cwd(), rest);
  }

  if (command === "submit") {
    return submitCommand(process.cwd(), rest);
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

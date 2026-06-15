import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { runGate, type GateResult } from "./gate.js";
import { findGitRoot } from "./repo.js";

export async function analyzeCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, ...rest] = args;
  if (!taskId || rest.length > 0) {
    console.error("error: usage: hivemind analyze <id>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await analyzeTask(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return result.value.verdict === "accept" ? 0 : 1;
}

export async function analyzeTask(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: GateResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const patchPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  if (!(await exists(patchPath))) {
    return { ok: false, reason: `patch not found: .hivemind/patches/${taskId}/diff.patch` };
  }

  return {
    ok: true,
    value: await runGate(contractResult.contract.base_commit, patchPath, contractResult.contract, configResult.config)
  };
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

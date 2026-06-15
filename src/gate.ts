import type { ChangesetOp } from "./changeset.js";
import { withResolvedChangesetCheckouts } from "./changeset.js";
import type { TaskContract } from "./contract.js";
import { decideOp, type DecisionConfig } from "./decision.js";

export type GateVerdict = "accept" | "reject" | "escalate";

export interface GateResult {
  verdict: GateVerdict;
  reason: string;
}

export async function runGate(
  baseCommit: string,
  patchPath: string,
  contract: TaskContract,
  config: DecisionConfig
): Promise<GateResult> {
  try {
    const result = await withResolvedChangesetCheckouts<GateResult>(config.repo_root, baseCommit, patchPath, async (context) => {
      let escalateReason: string | null = null;

      for (const op of context.ops) {
        const verdict = await decideOp(op, contract, {
          ...config,
          repo_root: rootForOp(op, context.baseCheckoutPath, context.appliedCheckoutPath)
        });

        if (verdict === "reject") {
          return rejectResult(`rejected ${op.op} ${op.path}`);
        }

        if (verdict === "escalate" && escalateReason === null) {
          escalateReason = `escalated ${op.op} ${op.path}`;
        }
      }

      if (escalateReason !== null) {
        return { verdict: "escalate", reason: escalateReason };
      }

      if (context.ops.length === 0) {
        return { verdict: "accept", reason: "no changes" };
      }

      return { verdict: "accept", reason: "all changes are within scope" };
    });

    if (!result.ok) {
      return rejectResult(result.reason);
    }

    return result.value;
  } catch (error: unknown) {
    return rejectResult(`internal gate error: ${errorMessage(error)}`);
  }
}

function rootForOp(op: ChangesetOp, baseCheckoutPath: string, appliedCheckoutPath: string): string {
  return op.op === "delete" ? baseCheckoutPath : appliedCheckoutPath;
}

function rejectResult(reason: string): GateResult {
  return { verdict: "reject", reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "unknown error";
}

import type { ChangesetOp } from "./changeset.js";
import { withResolvedChangesetCheckouts } from "./changeset.js";
import type { TaskContract } from "./contract.js";
import { decideOpOutcome, plainDecisionReason, type DecisionConfig } from "./decision.js";

export type GateVerdict = "accept" | "reject" | "escalate";

export interface GateResult {
  verdict: GateVerdict;
  /* Evidence. Terse, stable, and never reworded: things downstream match on it
     and it is what the durable trail records. */
  reason: string;
  /* The same fact in one sentence a person can read. Written here because the
     cause is known here; reconstructing it later means guessing at a string
     nobody downstream owns, which the desktop client tried three times. */
  plain_reason: string;
}

export async function runGate(
  baseCommit: string,
  patchPath: string,
  contract: TaskContract,
  config: DecisionConfig
): Promise<GateResult> {
  try {
    const result = await withResolvedChangesetCheckouts<GateResult>(config.repo_root, baseCommit, patchPath, async (context) => {
      let escalation: { reason: string; plain_reason: string } | null = null;

      for (const op of context.ops) {
        const outcome = await decideOpOutcome(op, contract, {
          ...config,
          repo_root: rootForOp(op, context.baseCheckoutPath, context.appliedCheckoutPath)
        });

        if (outcome.verdict === "reject") {
          return {
            verdict: "reject",
            reason: `rejected ${op.op} ${op.path}`,
            plain_reason: plainDecisionReason(outcome.cause, op)
          };
        }

        if (outcome.verdict === "escalate" && escalation === null) {
          escalation = {
            reason: `escalated ${op.op} ${op.path}`,
            plain_reason: plainDecisionReason(outcome.cause, op)
          };
        }
      }

      if (escalation !== null) {
        return { verdict: "escalate", ...escalation };
      }

      if (context.ops.length === 0) {
        return {
          verdict: "accept",
          reason: "no changes",
          plain_reason: "It finished without changing anything."
        };
      }

      return {
        verdict: "accept",
        reason: "all changes are within scope",
        plain_reason: "Every file it changed was one this task was given."
      };
    });

    if (!result.ok) {
      /* A checkout failure is machinery breaking, not a worker misbehaving. Say
         that, rather than implying the change was refused on its merits. */
      return {
        verdict: "reject",
        reason: result.reason,
        plain_reason: "The change could not be read back to be checked."
      };
    }

    return result.value;
  } catch (error: unknown) {
    return {
      verdict: "reject",
      reason: `internal gate error: ${errorMessage(error)}`,
      plain_reason: "Something went wrong while checking this change."
    };
  }
}

function rootForOp(op: ChangesetOp, baseCheckoutPath: string, appliedCheckoutPath: string): string {
  return op.op === "delete" ? baseCheckoutPath : appliedCheckoutPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "unknown error";
}

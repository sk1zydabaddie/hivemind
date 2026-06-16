import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified, type SpecResult } from "./spec.js";
import { loadSpecDocument } from "./spec-format.js";
import { getStatus } from "./status.js";

interface ManagerSession {
  version: 1;
  session_id: string;
  created_at: string;
  spec_id: string;
  working_set: ManagerWorkingSet;
  turns: ManagerTurn[];
  proposed_action: ManagerProposedAction;
}

interface ManagerWorkingSet {
  spec: {
    spec_id: string;
    title: string;
    status: "ratified";
    path: string;
  };
  status: {
    task_count: number;
    active_lease_count: number;
    integration_queue_count: number;
    integrated_task_count: number;
  };
}

interface ManagerTurn {
  role: "user" | "manager";
  content: string;
}

interface ManagerProposedAction {
  type: "await_planning_loop";
  reason: string;
  requires: "M5.4";
}

export interface ManagerSessionResult {
  session_id: string;
  session_path: string;
  spec_id: string;
  proposed_action: ManagerProposedAction;
}

export async function managerCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseManagerArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await startManagerSession(repoRoot, parsed.value.message);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function startManagerSession(repoRoot: string, message: string): Promise<SpecResult<ManagerSessionResult>> {
  if (message.trim() === "") {
    return { ok: false, reason: "manager message must not be empty" };
  }

  const spec = await requireActiveSpecRatified(repoRoot);
  if (!spec.ok) {
    return spec;
  }

  const loadedSpec = await loadSpecDocument(repoRoot, spec.value.spec_id);
  if (!loadedSpec.ok) {
    return loadedSpec;
  }
  if (loadedSpec.value.status !== "ratified") {
    return { ok: false, reason: `active spec ${spec.value.spec_id} is ${loadedSpec.value.status}; ratify it before starting manager chat` };
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }

  const proposedAction: ManagerProposedAction = {
    type: "await_planning_loop",
    reason: "M5.4 planning loop must produce tentative tasks before manager action execution can continue",
    requires: "M5.4"
  };
  const sessionId = randomUUID();
  const session: ManagerSession = {
    version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    spec_id: spec.value.spec_id,
    working_set: {
      spec: {
        spec_id: spec.value.spec_id,
        title: loadedSpec.value.title,
        status: "ratified",
        path: `.hivemind/spec/${spec.value.spec_id}.md`
      },
      status: {
        task_count: status.value.tasks.length,
        active_lease_count: Object.keys(status.value.leases).length,
        integration_queue_count: status.value.integration.queue.length,
        integrated_task_count: status.value.tasks.filter((task) => task.integrated).length
      }
    },
    turns: [
      { role: "user", content: message.trim() },
      { role: "manager", content: proposedAction.reason }
    ],
    proposed_action: proposedAction
  };

  const relativePath = `.hivemind/orchestrator/sessions/${sessionId}.json`;
  await writeJsonAtomic(path.join(repoRoot, relativePath), session);
  return {
    ok: true,
    value: {
      session_id: sessionId,
      session_path: relativePath,
      spec_id: spec.value.spec_id,
      proposed_action: proposedAction
    }
  };
}

function parseManagerArgs(args: string[]): SpecResult<{ message: string }> {
  if (args[0] !== "--message" || typeof args[1] !== "string" || args.length !== 2) {
    return { ok: false, reason: "usage: hivemind manager --message <message>" };
  }
  return { ok: true, value: { message: args[1] } };
}

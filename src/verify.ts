import { generateCharacterizationCandidate } from "./characterization-generator.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { findGitRoot } from "./repo.js";

interface CharacterizeCommandInput {
  taskId: string;
  tool: string;
  checkId?: string;
}

export async function verifyCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseVerifyArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  const daemonProbe = await callDaemonIfConfigured<unknown>(repoRoot, "/status", {});
  if (daemonProbe.routed) {
    console.error(
      `error: ${
        daemonProbe.ok
          ? "on-demand characterization generation is local-only; stop the Hivemind daemon before generating"
          : `characterization generation refused because daemon ownership could not be ruled out: ${daemonProbe.reason}`
      }`
    );
    return 1;
  }

  const result = await generateCharacterizationCandidate(
    repoRoot,
    parsed.value.taskId,
    parsed.value.tool,
    parsed.value.checkId
  );
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function parseVerifyArgs(
  args: string[]
): { ok: true; value: CharacterizeCommandInput } | { ok: false; reason: string } {
  if (args.length !== 4 && args.length !== 6) {
    return { ok: false, reason: verifyUsage() };
  }
  if (
    args[0] !== "characterize" ||
    args[1].trim() === "" ||
    args[2] !== "--tool" ||
    args[3].trim() === ""
  ) {
    return { ok: false, reason: verifyUsage() };
  }
  if (args.length === 6 && (args[4] !== "--check" || args[5].trim() === "")) {
    return { ok: false, reason: verifyUsage() };
  }
  return {
    ok: true,
    value: {
      taskId: args[1],
      tool: args[3],
      ...(args.length === 6 ? { checkId: args[5] } : {})
    }
  };
}

function verifyUsage(): string {
  return "usage: hivemind verify characterize <task-id> --tool <tool> [--check <check-id>]";
}

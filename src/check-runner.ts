import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface NamedCheckResult {
  id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export async function runNamedCheck(cwd: string, id: string, command: string): Promise<NamedCheckResult> {
  try {
    const result = await execAsync(command, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { id, command, exit_code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    return {
      id,
      command,
      exit_code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "",
      stderr: typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
    };
  }
}

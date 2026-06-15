const safeTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateTaskId(taskId: string): string | null {
  if (taskId.trim() === "") {
    return "task id must not be empty";
  }
  if (!safeTaskIdPattern.test(taskId)) {
    return "task id may contain only letters, numbers, dots, underscores, and hyphens, and must start with a letter or number";
  }
  return null;
}

export function validateRequestedTaskId(taskId: string): { ok: true } | { ok: false; reason: string } {
  const problem = validateTaskId(taskId);
  return problem === null ? { ok: true } : { ok: false, reason: `invalid task id "${taskId}": ${problem}` };
}

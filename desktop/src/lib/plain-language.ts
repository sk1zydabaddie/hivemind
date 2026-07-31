export function plainActionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw === "") return "";
  if (/has started and its contract is immutable/iu.test(raw)) {
    return "This task is already working and cannot be edited. Guide the worker, or stop and re-plan.";
  }
  if (/no unhandled rejected write-intent/iu.test(raw)) {
    return "The worker is not waiting at a safe correction point yet.";
  }
  if (/current lint-passed tentative plan|plan hash|re-ratification/iu.test(raw)) {
    return "The plan changed. Review the latest version before approving it.";
  }
  if (/change not found/iu.test(raw)) {
    return "No submitted change is available for this task yet.";
  }
  if (/already terminal/iu.test(raw)) {
    return "This task has already finished and cannot be stopped again.";
  }
  if (/quality run is already cancelled/iu.test(raw)) {
    return "This draft run has already stopped.";
  }
  if (/no unique admitted run/iu.test(raw)) {
    return "This draft run is not active or cannot be identified safely.";
  }
  if (/cleanup|worker death|liveness|termination/iu.test(raw)) {
    return "The stop was recorded, but cleanup could not be proven complete. Ownership remains held so other work cannot collide with it.";
  }
  return raw.replace(/^error:\s*/iu, "");
}

/* The role names the desktop sends to Core. Provider and model knowledge lives
 * only in Core's catalogue and arrives through config.inspect; keeping a second
 * client catalogue here previously left an unrendered, stale Claude story in
 * the bundle after the real provider had passed its live probe. */

export interface ProviderRole {
  tool: string;
  purpose: string;
  /**
   * True when the client sends this tool name to Core and Core resolves the
   * profile by it. False when Core's routing has to *find* the profile,
   * because the action never names a tool -- which is a different failure if
   * the file is missing, and a different thing for setup to explain.
   */
  requestedByName: boolean;
}

/* Core resolves each to `.hivemind/adapters/<tool>.profile.json`, so all three
   files must exist -- and setting the project up does NOT write them. Core
   deliberately writes no adapter profile, because one written by setup would be
   a declaration that no probe has checked, which is the exact thing connecting
   an agent exists to replace. Connecting each role is what creates its file.
   The claim that setup wrote them is what sent a new person looking for a step
   that had never happened. */
export const REQUIRED_ROLES: ProviderRole[] = [
  { tool: "planner", purpose: "Turns what you type into a plan", requestedByName: true },
  {
    tool: "manager",
    purpose: "Decides the next step when something is unexpected",
    requestedByName: true
  },
  { tool: "worker", purpose: "Writes the code for each task", requestedByName: false }
];

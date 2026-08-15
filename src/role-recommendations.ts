import type { InspectedAdapter } from "./config-actions.js";
import {
  ROLE_RECOMMENDATIONS,
  type AdapterRoleName,
  type RoleRecommendation
} from "./agent-catalogue.js";

export { ROLE_RECOMMENDATIONS, type RoleRecommendation };

/**
 * Which model to suggest for each role, and why.
 *
 * ## A suggestion, never a default that spends
 *
 * Same posture as the visual-task routing preference: this produces text next
 * to a control, and the person still presses the button. Nothing here selects
 * a provider on somebody's behalf, and nothing here can widen a gate --
 * `routeTaskProvider` never reads this file. The tier floor decides what MAY
 * run a task; this only decides what to write on screen beforehand.
 *
 * The distinction matters because a recommendation that auto-applied would be
 * a default that spends money: connecting runs the agent once, for real, on
 * the person's own subscription.
 *
 * ## Curated, and dated for the same reason prices are
 *
 * Model rankings move faster than releases. These carry a `reviewed` date so
 * the surface can say how old the advice is rather than presenting last
 * quarter's ordering as current. What they are NOT is a benchmark result --
 * they are a considered default, and the reason is stated so a person can
 * disagree with the reasoning rather than just the conclusion.
 */

export function recommendationFor(role: AdapterRoleName): RoleRecommendation | null {
  return ROLE_RECOMMENDATIONS.find((entry) => entry.role === role) ?? null;
}

/**
 * Whether a person may deliberately aim this connection at a model.
 *
 * **Read from the RECORDED probe, never from the catalogue.** The catalogue
 * says what a profile asks for; only the connection record says what the
 * provider reported back. Deciding this from the catalogue would make
 * `pins_one_model` a declaration again -- which is the exact thing the
 * capability contract exists to refuse, and the thing every "verified" claim
 * in this product is defined against.
 *
 * The contract admits an unverified pin rather than refusing it, degrading
 * `tier_routing` and `routing_provenance` and saying so. This is the surface
 * half of that same decision: a connection whose pin was not confirmed still
 * runs, and still cannot be pointed at a chosen model.
 *
 * A connection that has never been probed returns false. Absence of evidence
 * is not evidence, and the safe direction here is to offer no choice rather
 * than a choice that silently does nothing.
 */
export function modelChoiceAllowed(adapter: Pick<InspectedAdapter, "capabilities">): boolean {
  const pin = adapter.capabilities.find((capability) => capability.id === "pins_one_model");
  return pin?.status === "verified";
}

/** Why the choice is not offered, for a person, or null when it is. */
export function modelChoiceRefusal(
  adapter: Pick<InspectedAdapter, "capabilities" | "connected_at">
): string | null {
  if (modelChoiceAllowed(adapter)) return null;
  if (adapter.connected_at === null) {
    return "Connect this first — until it has run once, nothing has reported which model it loads.";
  }
  return "This agent did not report which model it loaded, so Hivemind cannot aim it at one. It still runs; it just runs on whatever it chooses, and cheaper work will not be sent to a cheaper model.";
}

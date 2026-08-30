import { readFile } from "node:fs/promises";
import path from "node:path";

export function releaseTrustPolicyPath(desktopRoot, environment = process.env) {
  const configured = environment.HIVEMIND_RELEASE_TRUST_POLICY;
  return typeof configured === "string" && configured.trim() !== ""
    ? path.resolve(configured)
    : path.join(desktopRoot, "release", "trust-policy.json");
}

export async function loadReleaseTrustPolicy(desktopRoot, environment = process.env) {
  return JSON.parse(await readFile(releaseTrustPolicyPath(desktopRoot, environment), "utf8"));
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(__dirname, "..");
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, "");

/* AGENTS.md is read verbatim by every harness as untrusted context. The door
 * that writes it must not accept content from a client, or the client becomes a
 * way to put arbitrary text in front of every worker. Core re-derives the file
 * and takes only the hashes it handed out.
 *
 * Proven to bite: add a `content` or `proposed` field to the apply payload and
 * the first assertion fails. */
describe("the AGENTS.md card", () => {
  test("sends back only the hashes it was shown, never file content", async () => {
    const card = strip(
      await readFile(path.join(root, "src", "components", "workspace", "agents-file-card.tsx"), "utf8")
    );
    const payload = /type: "agents\.apply",\s*payload: \{([^}]*)\}/u.exec(card);
    expect(payload, "the apply call was not found").not.toBeNull();
    const fields = (payload?.[1] ?? "")
      .split(",")
      .map((entry) => entry.split(":")[0].trim())
      .filter((entry) => entry !== "");
    expect(fields.sort()).toEqual(["existing_sha", "proposed_sha"]);
  });

  test("nothing is written until the person presses accept", async () => {
    const card = strip(
      await readFile(path.join(root, "src", "components", "workspace", "agents-file-card.tsx"), "utf8")
    );
    /* The only apply lives inside the accept handler, and the effect that runs
       on mount proposes rather than applies. */
    expect(card.match(/agents\.apply/gu)?.length ?? 0).toBe(1);
    const effect = card.slice(card.indexOf("useEffect"), card.indexOf("if (proposal === null"));
    expect(effect).toContain("agents.propose");
    expect(effect).not.toContain("agents.apply");
  });

  test("a refusal shows no card rather than an error where a suggestion would be", async () => {
    const card = strip(
      await readFile(path.join(root, "src", "components", "workspace", "agents-file-card.tsx"), "utf8")
    );
    expect(card).toMatch(/if \(proposal === null \|\| dismissed\) return null;/u);
  });

  /* The card must not be counted in "Waiting for you to look at": it decides
     for itself whether it has anything to say, and a count that includes an
     invisible card does not match the screen. */
  test("it is rendered outside the waiting list it cannot be counted in", async () => {
    const tab = strip(
      await readFile(path.join(root, "src", "components", "workspace", "project-tab.tsx"), "utf8")
    );
    const waitingBlock = tab.slice(tab.indexOf("{waiting.length > 0 ?"), tab.indexOf("<AgentsFileCard"));
    expect(waitingBlock).not.toContain("AgentsFileCard");
    expect(tab).toContain("<AgentsFileCard onAction={onAction} />");
  });
});

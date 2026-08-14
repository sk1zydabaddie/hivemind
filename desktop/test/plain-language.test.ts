import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { plainActionError } from "../src/lib/plain-language";

/* The mapping moved to Core on 2026-08-14, so what this file guards changed
 * with it. It no longer asserts the WORDS of any Core refusal — that is Core's
 * to own and Core's to test. It asserts the boundary: that the client stopped
 * interpreting Core's failure vocabulary, and still handles the one class of
 * error Core never sees.
 */
describe("plain action errors", () => {
  test("a Core sentence passes through untouched", () => {
    /* By the time an error reaches here the shell has already preferred Core's
       `plain` field, so the client's job is to not damage it. */
    const sentence =
      "The proposed plan was stopped because its contract check duplicated a test the worker would write itself.";
    expect(plainActionError(sentence)).toBe(sentence);
    expect(plainActionError(`error: ${sentence}`)).toBe(sentence);
  });

  test("transport failures are phrased here, because Core never sees them", () => {
    expect(plainActionError("daemon action connection failed: ECONNREFUSED")).toMatch(
      /lost contact with the project/u
    );
    expect(plainActionError("request timed out after 30s")).toMatch(/longer than Hivemind waits/u);
  });

  test("an unmapped reason is shown as it is, rather than paraphrased", () => {
    /* Inventing a friendly sentence for a failure nobody has mapped would hide
       WHICH failure it was, which is worse than the raw text. */
    expect(plainActionError("some refusal nobody has phrased yet")).toBe(
      "some refusal nobody has phrased yet"
    );
  });

  test("the client no longer carries Core's failure vocabulary", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "..", "src", "lib", "plain-language.ts"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    /* Each of these is a Core failure string the client used to match on. If
       one comes back, the mapping has drifted back across the boundary. */
    for (const vocabulary of [
      "SKELETON_TRAP",
      "deterministic_validity_check",
      "write-intent",
      "lint-passed",
      "already terminal",
      "admitted run"
    ]) {
      expect(code).not.toContain(vocabulary);
    }
  });

  test("Core owns the mapping, and the daemon actually attaches it", async () => {
    const core = await readFile(
      path.resolve(import.meta.dirname, "..", "..", "src", "plain-reason.ts"),
      "utf8"
    );
    expect(core).toMatch(/SKELETON_TRAP_ACCEPTANCE/u);
    expect(core).toMatch(/export function plainReason/u);
    /* Returning null is a real answer -- "no better sentence than the raw one"
       -- and the caller renders the reason in that case. */
    expect(core).toMatch(/\?\?\s*null/u);

    const daemon = await readFile(
      path.resolve(import.meta.dirname, "..", "..", "src", "daemon.ts"),
      "utf8"
    );
    expect(daemon).toMatch(/withPlainReason\(result\)/u);

    /* And the shell prefers it over the machine reason. */
    const shell = await readFile(
      path.resolve(import.meta.dirname, "..", "src-tauri", "src", "project.rs"),
      "utf8"
    );
    expect(shell).toMatch(/\.get\("plain"\)/u);
  });
});

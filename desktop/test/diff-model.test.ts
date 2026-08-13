import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  diffLineKey,
  diffLineNumber,
  filesWithoutChanges,
  parseUnifiedDiff
} from "../src/lib/diff-model";

/**
 * Parsed against a REAL captured patch, not a fixture.
 *
 * `docs/evidence/e2e-2026-08-11-walk4/.../T-001/diff.patch` is the actual diff a
 * worker produced on the 2026-08-11 walk: two new files and one modified, with
 * a regex full of the characters a careless parser trips on -- `+`, `-`, `@`
 * and a `/` at the start of a line inside a character class.
 */

const PATCH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "evidence",
  "e2e-2026-08-11-walk4",
  "project-state-after",
  "patches",
  "T-001",
  "diff.patch"
);

describe("a real captured patch", () => {
  test("splits into its files, with the right kind of change on each", async () => {
    const parsed = parseUnifiedDiff(await readFile(PATCH, "utf8"));

    expect(parsed.files.map((file) => file.path)).toEqual([
      "src/email.js",
      "src/index.js",
      "test/email.test.js"
    ]);
    expect(parsed.files.map((file) => file.change)).toEqual(["added", "modified", "added"]);
    expect(parsed.unparsed).toEqual([]);
  });

  test("counts only lines that changed, never the headers that describe them", async () => {
    const parsed = parseUnifiedDiff(await readFile(PATCH, "utf8"));
    const index = parsed.files.find((file) => file.path === "src/index.js")!;

    /* One export added, nothing removed. A parser that counted `+++ b/…` as an
       addition would say two, and a diff view that overstates what changed is
       worse than one that shows nothing. */
    expect(index.added).toBe(1);
    expect(index.removed).toBe(0);
    expect(parsed.removed).toBe(0);
    expect(parsed.added).toBeGreaterThan(20);
  });

  test("a line beginning with + inside the content is content, not an addition marker", async () => {
    const parsed = parseUnifiedDiff(await readFile(PATCH, "utf8"));
    const email = parsed.files.find((file) => file.path === "src/email.js")!;
    const regex = email.hunks[0]!.lines.find((line) => line.text.includes("EMAIL_PATTERN"))!;

    expect(regex.kind).toBe("added");
    /* The leading `+` is stripped once and only once: the regex it introduces
       contains `+` and `-` of its own, and they have to survive. */
    expect(regex.text.startsWith("const EMAIL_PATTERN")).toBe(true);
    expect(regex.text).toContain("A-Z0-9!#$%&'*+/=?^_`{|}~-");
  });

  test("numbers each line the way the person's editor would", async () => {
    const parsed = parseUnifiedDiff(await readFile(PATCH, "utf8"));
    const index = parsed.files.find((file) => file.path === "src/index.js")!;
    const lines = index.hunks[0]!.lines;

    /* `@@ -1,2 +1,3 @@`: context, then the added export, then context. */
    expect(lines.map((line) => [line.kind, line.before, line.after])).toEqual([
      ["context", 1, 1],
      ["added", null, 2],
      ["context", 2, 3]
    ]);
    expect(diffLineNumber(lines[1]!)).toBe("2");
  });
});

describe("the shape of the parse", () => {
  test("an added file is all additions and a removed file is all removals", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 1234567..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-first",
        "-second"
      ].join("\n")
    );
    expect(parsed.files[0]!.change).toBe("removed");
    expect(parsed.files[0]!.removed).toBe(2);
    expect(parsed.files[0]!.added).toBe(0);
  });

  test("a rename says where the file came from", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/old/name.js b/new/name.js",
        "similarity index 96%",
        "rename from old/name.js",
        "rename to new/name.js"
      ].join("\n")
    );
    expect(parsed.files[0]!.change).toBe("renamed");
    expect(parsed.files[0]!.previousPath).toBe("old/name.js");
    /* Named in the patch and carrying no lines: a real state, and one that must
       read as "nothing to show" rather than as an empty file. */
    expect(parsed.files[0]!.textless).toBe(true);
  });

  test("anything it does not recognise is reported, never dropped", () => {
    /* The same rule the vocabulary guard follows: decline to render, and say so.
       Silently swallowing an unfamiliar header is how a diff view comes to show
       fewer changes than the patch contains. */
    const parsed = parseUnifiedDiff("GIT binary patch\nliteral 4096\nzcmZ\n");
    expect(parsed.files).toEqual([]);
    expect(parsed.unparsed.length).toBeGreaterThan(0);
  });

  test("the change viewer's own task heading does not become a file", () => {
    /* Hivemind heads each task's section with `# <title>` when it concatenates
       a whole verified set. Read as content, that would make the first file
       swallow every task after it. */
    const parsed = parseUnifiedDiff(
      [
        "# Add a greet helper",
        "diff --git a/a.js b/a.js",
        "index 1..2 100644",
        "--- a/a.js",
        "+++ b/a.js",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\n")
    );
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.path).toBe("a.js");
    expect(parsed.unparsed).toEqual(["# Add a greet helper"]);
  });

  test("an empty patch is empty, not an error", () => {
    const parsed = parseUnifiedDiff("");
    expect(parsed.files).toEqual([]);
    expect(parsed.added).toBe(0);
    expect(parsed.unparsed).toEqual([]);
  });
});

describe("naming a line, and naming what did not change", () => {
  test("a line key survives being read twice and points at the visible number", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/a.js b/a.js",
        "@@ -4,2 +4,3 @@",
        " kept",
        "-dropped",
        "+added"
      ].join("\n")
    );
    const file = parsed.files[0]!;
    const [kept, dropped, added] = file.hunks[0]!.lines;

    expect(diffLineKey(file, kept!)).toBe("a.js:+4");
    expect(diffLineKey(file, added!)).toBe("a.js:+5");
    /* A removed line has no after-number, so it is keyed on the one it had. */
    expect(diffLineKey(file, dropped!)).toBe("a.js:-5");
  });

  test("a file a task holds but never touched is named as untouched", () => {
    /* "editing 2 files" against a patch that changed one is a real and common
       state -- the lease is what the task may write, not what it did. */
    const parsed = parseUnifiedDiff(
      ["diff --git a/src/a.js b/src/a.js", "@@ -1 +1 @@", "-x", "+y"].join("\n")
    );
    expect(filesWithoutChanges(["src/a.js", "test/a.test.js"], parsed)).toEqual([
      "test/a.test.js"
    ]);
  });
});

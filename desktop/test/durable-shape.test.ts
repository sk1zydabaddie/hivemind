import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { list, present, table } from "../src/lib/durable";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function everyFile(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...everyFile(full));
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * The hole in the rule that was supposed to make this class impossible.
 *
 * `src/lib/durable.ts` states it: every collection-valued field on a daemon
 * response is optional to the client, and `tsc --noEmit` turns that into a
 * build error the moment somebody writes `.length` on one. It worked. It also
 * only covers the types that live in `workspace-actions.ts`.
 *
 * `SharingBar` did not use one. It declared its own shape at the call site --
 * `onAction<{ tracked: string[] }>(...)` -- which is a promise to the compiler
 * that the field is always there, made by the same person writing the code
 * that trusts it. The compiler had nothing to object to, and the setup surface
 * crashed on the first caller that answered differently: the replay harness,
 * which has no git and returns nothing at all.
 *
 * Two things that made it worse than the three before it:
 *
 * - The `catch` looked like it covered this and could not, because the promise
 *   RESOLVED. An absent field is a successful answer.
 * - `SharingBar` mounts above every surface in `App.tsx`, so one unread field
 *   took down four surfaces, and `verify:reachable` -- the instrument built to
 *   catch exactly "you cannot finish this screen" -- was the thing that found
 *   it, three commits after the bar landed.
 *
 * So the rule is mechanised where it was bypassed rather than restated.
 */
describe("collections off a daemon answer", () => {
  /* The first version of this check matched a SPELLING: an inline literal with
     a required array in it. That is the word-ban failure in type clothing, and
     it had already missed two of the five instances by the time it was written
     -- a nested literal, because its pattern stopped at the first `}`, and a
     named `interface` declared beside the call, because that is not a literal
     at all. Five instances, three spellings.

     So the rule is structural instead. It does not care what the shape looks
     like or where the braces are: the type argument to `onAction` must be a
     NAME, resolved from the module that owns these types. Whether its
     collections are optional is then the compiler's problem, in the one file
     where that is already enforced. */
  test("no component declares the shape of a daemon answer", () => {
    const offenders: string[] = [];
    for (const file of everyFile(path.join(desktopRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/onAction<([^(]*?)>\s*\(/gu)) {
        const argument = match[1].trim();
        /* A name, or a union of names, or `Name[]`. Anything with a brace in
           it is a shape written at the call site. */
        if (argument.includes("{")) {
          offenders.push(`${path.relative(desktopRoot, file)}: onAction<${argument}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /* And the names have to come from the module that owns them, or a component
     could satisfy the rule above by declaring `interface Foo` one line up --
     which is exactly what checks-output.tsx and provenance-note.tsx both did
     for the same action, arriving at two contradictory answers. */
  test("the daemon response types live in one module", () => {
    const owner = readFileSync(
      path.join(desktopRoot, "src", "lib", "workspace-actions.ts"),
      "utf8"
    );
    const offenders: string[] = [];
    for (const file of everyFile(path.join(desktopRoot, "src", "components"))) {
      const source = readFileSync(file, "utf8");
      const declared = new Set(
        [...source.matchAll(/^(?:export )?(?:interface|type) ([A-Za-z0-9_]+)/gmu)].map((m) => m[1])
      );
      for (const match of source.matchAll(/onAction<([A-Za-z0-9_]+)/gu)) {
        const name = match[1];
        if (declared.has(name)) {
          offenders.push(`${path.relative(desktopRoot, file)} declares ${name}`);
        } else if (!new RegExp(`^export interface ${name}\\b`, "mu").test(owner)) {
          offenders.push(`${path.relative(desktopRoot, file)}: ${name} is not in workspace-actions.ts`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /* The instrument, checked against the shape that actually broke it. An
     assertion that only ever sees a well-formed record cannot fail on the case
     this whole family is about. */
  test("the helpers answer for a record that predates the field", () => {
    expect(list(undefined)).toEqual([]);
    expect(list(null)).toEqual([]);
    expect(list(["a"])).toEqual(["a"]);
    expect(table(undefined)).toEqual({});
    expect(present(undefined)).toBe(false);
    expect(present(null)).toBe(false);
    expect(present(0)).toBe(true);
  });

  /* And the bar itself, which is the one that shipped broken. */
  test("the sharing bar reads its answer through the helper", () => {
    const source = readFileSync(
      path.join(desktopRoot, "src", "components", "workspace", "sharing-bar.tsx"),
      "utf8"
    );
    expect(source).toMatch(/list\(result\?\.tracked\)/u);
    expect(source).toMatch(/list\(result\?\.removed\)/u);
    expect(source).not.toMatch(/setTracked\(result\.tracked\)/u);
  });
});

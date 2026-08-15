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
  test("no call site promises the compiler an array that is always there", () => {
    const offenders: string[] = [];
    for (const file of everyFile(path.join(desktopRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      /* Only inline object literals. A named type (`onAction<AccountsView>`)
         is declared in workspace-actions.ts, where the optionality rule is
         already enforced by the compiler. */
      for (const match of source.matchAll(/onAction<\{([^}]*)\}>/gu)) {
        for (const field of match[1].split(/[;,\n]/u)) {
          /* `name: T[]` or `name: readonly T[]` with no `?`. */
          if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*(?:readonly\s+)?[^:]*\[\]\s*$/u.test(field)) {
            offenders.push(`${path.relative(desktopRoot, file)}: ${field.trim()}`);
          }
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

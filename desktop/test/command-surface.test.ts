import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every command the client calls must exist.
 *
 * ## The failure, found by walking rather than by reading
 *
 * `inspect_daemon_work` and `restart_daemon` were written, correct, and **never
 * registered in `generate_handler!`**. Two consequences, and both were silent:
 *
 * - The build bar calls `inspect_daemon_work` inside a `try` and hides itself on
 *   failure — which is right for "outside the shell" and catastrophic here. The
 *   bar had therefore *never appeared*, and its idleness gate had never run.
 * - "Restart it", the recovery offered after a build mismatch, answered
 *   `Command restart_daemon not found`. It only appears after an update leaves a
 *   stale daemon, which is why nobody had reached it.
 *
 * The tell was in the build output the whole time: `warning: function
 * restart_daemon is never used`. A dead-code warning on a `#[tauri::command]`
 * means the command is not registered, because registration is the only thing
 * that uses it.
 *
 * This is the unreached-mechanism family — built, correct, nothing calls it —
 * in the one place `npm run audit:unreached` cannot see, because that tool reads
 * Core's TypeScript exports and this seam is React-to-Rust.
 *
 * ## Why a string scan is the right instrument here
 *
 * The names cross a language boundary as string literals, so no compiler on
 * either side can check them. The client says `invoke("restart_daemon")` and
 * Rust says `generate_handler![restart_daemon]`, and nothing but this connects
 * the two.
 */

async function clientSources(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
    }
  };
  await walk(path.join(desktopRoot, "src"));
  return found;
}

/** Command names the client asks for, wherever `invoke` is called. */
async function invoked(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await clientSources()) {
    const source = await readFile(file, "utf8");
    /* `invoke("x")` and `invoke<T>("x")`. `[^(]*` rather than `[^>]*` for the
       generic: `invoke<Record<string, boolean>>("dismissed_hints")` nests angle
       brackets, and a scan that stopped at the first `>` reported that command
       as uncalled — the instrument mismeasuring before it was trusted. */
    for (const match of source.matchAll(/\binvoke\s*(?:<[^(]*>)?\s*\(\s*"([a-z_]+)"/gu)) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Command names Rust actually registers. */
async function registered(): Promise<Set<string>> {
  const main = await readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8");
  const block = /generate_handler!\[([\s\S]*?)\]/u.exec(main);
  if (block === null) return new Set();
  return new Set(
    block[1]
      .split(",")
      .map((entry) => entry.replace(/\/\*[\s\S]*?\*\//gu, "").trim())
      .filter((entry) => /^[a-z_]+$/u.test(entry))
  );
}

describe("the React-to-Rust command surface", () => {
  test("every command the client invokes is registered", async () => {
    const asked = await invoked();
    const have = await registered();
    const missing = [...asked].filter((name) => !have.has(name)).sort();
    expect(
      missing,
      "the client calls these and Rust does not register them; they fail at runtime only"
    ).toEqual([]);
  });

  /* The other direction is a weaker finding and still worth seeing: a command
     nobody calls is either dead or reached some way this scan cannot see. Not
     asserted empty -- `inspect_git_readiness` is legitimately reached through a
     path this does not model -- but the count is pinned so a new one is a
     decision rather than an accident. */
  test("registered commands with no caller are counted, not ignored", async () => {
    const asked = await invoked();
    const have = await registered();
    const uncalled = [...have].filter((name) => !asked.has(name)).sort();
    expect(uncalled.length, `uncalled commands: ${uncalled.join(", ")}`).toBeLessThanOrEqual(1);
  });

  /* The two that were missing, named so a regression is unambiguous rather than
     a count changing by one. */
  test("the two that were never wired stay wired", async () => {
    const have = await registered();
    expect(have.has("inspect_daemon_work"), "the build bar's idleness gate").toBe(true);
    expect(have.has("restart_daemon"), "the recovery offered after a build mismatch").toBe(true);
  });
});

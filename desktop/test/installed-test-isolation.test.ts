import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("installed test isolation", () => {
  test("every installed-app driver preserves the user's recent-project registry", () => {
    const directory = path.resolve(import.meta.dirname, "../e2e");
    const offenders = readdirSync(directory)
      .filter((name) => name.endsWith(".mjs") && name !== "protect-recent-projects.mjs")
      .filter((name) => {
        const source = readFileSync(path.join(directory, name), "utf8");
        const drivesInstalledApp = /selenium-webdriver|Hivemind AI[\\/]hivemind_desktop\.exe|HIVEMIND_E2E_BINARY/u.test(source);
        const isolatesRegistry = /protect-recent-projects\.mjs|recent-projects\.json/u.test(source);
        return drivesInstalledApp && !isolatesRegistry;
      });
    expect(offenders).toEqual([]);
  });
});

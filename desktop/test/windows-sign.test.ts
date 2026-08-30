import path from "node:path";
import { describe, expect, test } from "vitest";
import { isInside } from "../scripts/windows-sign.mjs";

describe("Windows custom signer confinement", () => {
  test("accepts only descendants of the Tauri target directory", () => {
    const root = path.resolve("D:/repo/desktop/src-tauri/target");
    expect(isInside(root, path.join(root, "release", "app.exe"))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.resolve(root, "..", "outside.exe"))).toBe(false);
  });
});

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(repoRoot, "dist");

if (path.dirname(output) !== repoRoot || path.basename(output) !== "dist") {
  throw new Error(`refusing to clean unexpected build output: ${output}`);
}

await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

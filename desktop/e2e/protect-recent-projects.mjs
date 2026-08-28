import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/* Installed tests open real projects, so the production shell remembers them.
   This side-effect import snapshots the user's registry before any driver or
   app starts and restores the exact bytes when the script exits. A missing
   registry is restored as missing. Tests that need to inspect the registry can
   still do so during the run; only the user's durable state is isolated. */
const registry = path.join(process.env.APPDATA ?? "", "ai.hivemind.desktop", "recent-projects.json");
const existed = existsSync(registry);
const before = existed ? readFileSync(registry) : null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (before === null) {
    rmSync(registry, { force: true });
    return;
  }
  mkdirSync(path.dirname(registry), { recursive: true });
  writeFileSync(registry, before);
}

process.once("exit", restore);

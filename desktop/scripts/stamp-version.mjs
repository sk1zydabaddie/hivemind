/** Stamp one clean source commit with a monotonic Windows-safe build version. */
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson, writeFileAtomically } from "./artifact-integrity.mjs";
import { nextMonotonicVersion } from "./versioning.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
const releaseStateDir = path.join(desktopRoot, "src-tauri", "target", "hivemind-release");
const stateFile = path.join(releaseStateDir, "last-version.json");
const lockFile = path.join(releaseStateDir, "version.lock");

assertCleanHead();
const sourceCommit = git(["rev-parse", "HEAD"]).trim();
if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit)) throw new Error("git returned an invalid source commit");

await mkdir(generatedDir, { recursive: true });
await mkdir(releaseStateDir, { recursive: true });
let lock;
try {
  lock = await open(lockFile, "wx");
} catch {
  throw new Error("another Hivemind build is already allocating a release version");
}

try {
  let previousVersion;
  try {
    const previous = JSON.parse(await readFile(stateFile, "utf8"));
    previousVersion = previous.version;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`release version state is unreadable: ${error.message}`);
  }
  const generatedAtMs = Date.now();
  const version = nextMonotonicVersion(generatedAtMs, previousVersion);
  const context = {
    schema_version: 1,
    version,
    generated_at_ms: generatedAtMs,
    source_commit: sourceCommit,
    platform: "windows-x86_64"
  };
  await writeFileAtomically(stateFile, stableJson({ version, generated_at_ms: generatedAtMs }));
  /* Generated resources cannot live in the base Tauri config: cargo test reads
     that config in a clean checkout before bundle preparation has run. The
     packaging-only overlay is parsed first, then beforeBuildCommand creates
     these paths before Rust's resource bundler consumes them. */
  await writeFileAtomically(path.join(generatedDir, "version.conf.json"), stableJson({
    version,
    bundle: {
      resources: {
        "gen/bundle/core": "core",
        "gen/bundle/runtime": "runtime",
        "gen/payload-manifest.json": "artifact/payload-manifest.json"
      }
    }
  }));
  await writeFileAtomically(path.join(generatedDir, "app-version.txt"), `${version}\n`);
  await writeFileAtomically(path.join(generatedDir, "build-context.json"), stableJson(context));
  console.log(`bundle version ${version} from clean commit ${sourceCommit.slice(0, 12)}`);
} finally {
  await lock.close();
  await rm(lockFile, { force: true });
}

function assertCleanHead() {
  git(["diff", "--quiet"]);
  git(["diff", "--cached", "--quiet"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked !== "") throw new Error("release builds require a clean HEAD; untracked files are present");
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  } catch {
    throw new Error(`release builds require a clean HEAD; git ${args.join(" ")} failed`);
  }
}

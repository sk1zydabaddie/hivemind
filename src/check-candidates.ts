/**
 * What counts as a check, in one file.
 *
 * Two jobs that must not drift apart: the command `project.init` records
 * without asking, and the candidates the setup screen SUGGESTS when it found
 * nothing to record. They share the detection rules below because a suggestion
 * a person accepts becomes the command every integration runs.
 *
 * The rule that shapes all of it: a guessed command becomes the command
 * verification actually runs, and a command that always fails is worse than a
 * declared absence -- it fails every integration after the money is spent. So
 * detection never guesses, suggestions are named with their kind so nobody
 * accepts one thinking it is something else, and anything a person types is
 * RUN once before it can be stored (see `src/check-trial.ts`).
 *
 * Tests are not the only legitimate check. A typecheck or a build catches real
 * breakage, and for most projects that arrive here it is what actually exists.
 * They are offered as suggestions rather than recorded silently, because the
 * difference between "your tests pass" and "it compiles" is one a person
 * should choose knowingly.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * What a check actually proves, which is not the same for all three.
 *
 * `tests` asserts behaviour. `typecheck` proves the code is consistent with
 * itself. `build` proves it compiles and bundles. All three catch real
 * breakage; only the first can catch a wrong answer.
 */
export type CheckKind = "tests" | "typecheck" | "build";

export interface CheckCandidate {
  command: string;
  kind: CheckKind;
  /** Where it came from, in the words of the thing that has it. */
  source: string;
}

export async function detectTestCommand(repoRoot: string): Promise<string> {
  const fromPackageJson = await detectNodeTestCommand(repoRoot);
  if (fromPackageJson !== "") return fromPackageJson;

  /* The obvious equivalents in other ecosystems, each keyed on the manifest
     that guarantees its standard runner exists. A manifest is evidence the
     TOOLCHAIN is present, not that tests are -- a Rust crate with zero tests
     still runs `cargo test` green, which is the honest vacuous answer. What
     this must never do is guess: a detection here becomes the command
     verification actually runs, so every entry names a file that ships with
     the runner it implies. Where nothing matches, setup asks the person
     rather than proceeding (A-03) -- an empty answer here no longer reads as
     setup-complete. */
  const manifests: Array<{ files: string[]; command: string }> = [
    /* Both runners exit 0 on a project with zero tests, so a manifest alone
       is a safe detection. */
    { files: ["Cargo.toml"], command: "cargo test" },
    { files: ["go.mod"], command: "go test ./..." }
  ];
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      if (await exists(path.join(repoRoot, file))) {
        return manifest.command;
      }
    }
  }
  /* pytest exits 5 when it collects nothing, so its detection needs evidence
     pytest is actually configured, not merely that the project is Python. */
  if (await exists(path.join(repoRoot, "pytest.ini")) || await exists(path.join(repoRoot, "tox.ini"))) {
    return "pytest";
  }
  try {
    const pyproject = await readFile(path.join(repoRoot, "pyproject.toml"), "utf8");
    if (pyproject.includes("[tool.pytest")) return "pytest";
  } catch (error: unknown) {
    if (!isFileMissing(error)) throw error;
  }

  /* EVIDENCE-GATED detections: a manifest here proves the toolchain, not that
     there is anything to run, and these runners do NOT all exit 0 on an empty
     project. So each pairs its manifest with something that only exists when
     tests do -- a directory, a target, a declared script. The gate is the
     point: a guessed command becomes the command verification runs, and a
     guaranteed-red check is worse than asking.

     Ordered from most to least specific so a polyglot repository answers with
     the runner that owns its root. */
  const gated: Array<{ manifest: string; evidence: string[]; command: string }> = [
    /* Gradle and Maven both fail a build with no test sources configured, so
       the source directory is the evidence. */
    { manifest: "build.gradle", evidence: ["src/test"], command: "gradle test" },
    { manifest: "build.gradle.kts", evidence: ["src/test"], command: "gradle test" },
    { manifest: "pom.xml", evidence: ["src/test"], command: "mvn -q test" },
    /* `mix test` needs the test directory to exist. */
    { manifest: "mix.exs", evidence: ["test"], command: "mix test" },
    /* `deno test` with no files exits non-zero. */
    { manifest: "deno.json", evidence: ["test", "tests"], command: "deno test -A" },
    { manifest: "deno.jsonc", evidence: ["test", "tests"], command: "deno test -A" },
    /* rspec is the near-universal Ruby answer, and `spec/` is its evidence. */
    { manifest: "Gemfile", evidence: ["spec"], command: "bundle exec rspec" }
  ];
  for (const entry of gated) {
    if (!(await exists(path.join(repoRoot, entry.manifest)))) continue;
    for (const evidence of entry.evidence) {
      if (await exists(path.join(repoRoot, evidence))) return entry.command;
    }
  }

  /* A wrapper script is stronger evidence than the manifest it wraps, because
     somebody committed it deliberately. Checked after the manifests so the
     wrapper form wins only when it is actually present. */
  for (const [wrapper, command] of [
    ["gradlew.bat", "gradlew test"],
    ["gradlew", "./gradlew test"],
    ["mvnw.cmd", "mvnw -q test"],
    ["mvnw", "./mvnw -q test"]
  ] as const) {
    if ((await exists(path.join(repoRoot, wrapper))) && (await exists(path.join(repoRoot, "src/test")))) {
      return command;
    }
  }

  /* A Makefile with a `test:` target is an explicit statement by the author
     that this is how the project is checked. Parsed rather than guessed: the
     target must start a line, which is what make itself requires. */
  try {
    const makefile = await readFile(path.join(repoRoot, "Makefile"), "utf8");
    if (/^test\s*:/mu.test(makefile)) return "make test";
  } catch (error: unknown) {
    if (!isFileMissing(error)) throw error;
  }

  /* .NET: `dotnet test` needs a test project, and a solution with none exits
     non-zero. A `*Tests*` project file is the evidence. */
  if (await exists(path.join(repoRoot, "global.json"))) {
    if (await hasTestProject(repoRoot)) return "dotnet test";
  }
  for (const solutionish of await listShallow(repoRoot)) {
    if (!/\.(sln|slnx)$/iu.test(solutionish)) continue;
    if (await hasTestProject(repoRoot)) return "dotnet test";
    break;
  }

  return "";
}

/** A `*Tests.csproj` / `*.Tests/` anywhere shallow, which is what `dotnet test` needs. */
async function hasTestProject(repoRoot: string): Promise<boolean> {
  for (const entry of await listShallow(repoRoot)) {
    if (/tests?$/iu.test(entry) || /tests?\.(cs|fs|vb)proj$/iu.test(entry)) return true;
  }
  return false;
}

/** Entry names one level down, or an empty list when the folder cannot be read. */
async function listShallow(repoRoot: string): Promise<string[]> {
  try {
    return await readdir(repoRoot);
  } catch (error: unknown) {
    if (isFileMissing(error)) return [];
    throw error;
  }
}

async function detectNodeTestCommand(repoRoot: string): Promise<string> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  let contents: string;
  try {
    contents = await readFile(packageJsonPath, "utf8");
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return "";
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(contents.replace(/^﻿/u, "")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = parsed.scripts ?? {};
    /* `test` first because it is the convention, then the two names projects
       use when "test" would be misleading -- a `check` script that runs types
       and tests together is a better answer than nothing, and it is the
       author's own word for how the project is checked. Anything else is not
       guessed at. */
    const script = ["test", "check", "verify"].find((name) => typeof scripts[name] === "string");
    if (script === undefined) return "";
    /* The project's own package manager, from its lockfile. `npm test` in a
       pnpm workspace works often enough to look fine and fails in exactly the
       repositories where workspace resolution matters. */
    const runner = (await exists(path.join(repoRoot, "pnpm-lock.yaml")))
      ? "pnpm"
      : (await exists(path.join(repoRoot, "yarn.lock")))
        ? "yarn"
        : (await exists(path.join(repoRoot, "bun.lockb"))) || (await exists(path.join(repoRoot, "bun.lock")))
          ? "bun"
          : "npm";
    /* `yarn test` and `pnpm test` take the bare script name; npm and bun are
       happiest with `run` for anything that is not literally `test`. */
    if (script === "test") return `${runner} test`;
    return runner === "yarn" || runner === "pnpm" ? `${runner} ${script}` : `${runner} run ${script}`;
  } catch {
    console.error(
      "warning: package.json could not be read, so no test command was recorded. " +
        "Set test_command in .hivemind/config.json once package.json parses."
    );
    return "";
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Everything this project could plausibly be checked with, best first.
 *
 * Suggestions, not decisions: nothing here is written to config without a
 * person choosing it and the command surviving a real run. The order is by
 * strength of the guarantee -- a test command that was detectable is a better
 * answer than a typecheck, and a typecheck is a better answer than a build,
 * because a build can pass on code that does not typecheck under the project's
 * own settings.
 *
 * Empty is a real answer, and it is the case where setup asks.
 */
export async function detectCheckCandidates(repoRoot: string): Promise<CheckCandidate[]> {
  const candidates: CheckCandidate[] = [];
  const detected = await detectTestCommand(repoRoot);
  if (detected !== "") {
    candidates.push({ command: detected, kind: "tests", source: "found in this project" });
  }

  const scripts = await packageScripts(repoRoot);
  if (scripts !== null) {
    const runner = await packageScriptRunner(repoRoot);
    /* The author's own names for these, in the order they mean what they say.
       `typecheck` and `type-check` are the two spellings in the wild; `tsc` is
       what people call the script when it is nothing but the compiler. */
    for (const [names, kind] of [
      [["typecheck", "type-check", "tsc"], "typecheck"],
      [["build", "compile"], "build"]
    ] as const) {
      const name = names.find((candidate) => typeof scripts[candidate] === "string");
      if (name === undefined) continue;
      candidates.push({
        command: runScript(runner, name),
        kind,
        source: `the ${name} script in package.json`
      });
    }
  }

  /* No script, but the compiler is configured: `tsc --noEmit` is exactly what
     a typecheck script would contain, so offering it is not a guess. Through
     `npx` because a project with a tsconfig has typescript as a dependency far
     more often than it has a global compiler. */
  if (!candidates.some((entry) => entry.kind === "typecheck")) {
    if (await exists(path.join(repoRoot, "tsconfig.json"))) {
      candidates.push({
        command: "npx tsc --noEmit",
        kind: "typecheck",
        source: "this project has a tsconfig.json"
      });
    }
  }

  /* The same offer for the two toolchains whose build command is unambiguous
     and whose manifest proves the toolchain is installed. */
  if (!candidates.some((entry) => entry.kind === "build")) {
    for (const [manifest, command] of [
      ["Cargo.toml", "cargo build"],
      ["go.mod", "go build ./..."]
    ] as const) {
      if (await exists(path.join(repoRoot, manifest))) {
        candidates.push({ command, kind: "build", source: `this project has a ${manifest}` });
        break;
      }
    }
  }

  return candidates;
}

/** The `scripts` block, or null when there is no readable package.json. */
async function packageScripts(repoRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const contents = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(contents.replace(/^﻿/u, "")) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? {};
  } catch {
    /* Unreadable or unparseable is the same as absent for a SUGGESTION -- the
       recording path warns about it, and warning twice about one broken file
       teaches nobody anything new. */
    return null;
  }
}

/**
 * The project's own package manager, from its lockfile.
 *
 * `npm test` in a pnpm workspace works often enough to look fine and fails in
 * exactly the repositories where workspace resolution matters.
 */
export async function packageScriptRunner(repoRoot: string): Promise<string> {
  if (await exists(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (await exists(path.join(repoRoot, "bun.lockb"))) return "bun";
  if (await exists(path.join(repoRoot, "bun.lock"))) return "bun";
  return "npm";
}

/**
 * `yarn build` and `pnpm build` take the bare script name; npm and bun are
 * happiest with `run` for anything that is not literally `test`.
 */
export function runScript(runner: string, script: string): string {
  if (script === "test") return `${runner} test`;
  return runner === "yarn" || runner === "pnpm" ? `${runner} ${script}` : `${runner} run ${script}`;
}

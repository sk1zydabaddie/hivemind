import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TaskContract } from "../../src/contract.js";
import type { DecisionConfig } from "../../src/decision.js";
import type { GateVerdict } from "../../src/gate.js";

const execFileAsync = promisify(execFile);

export interface GateCorpusFixture {
  name: string;
  repo: string;
  baseCommit: string;
  patchPath: string;
  contract: TaskContract;
  config: DecisionConfig;
  expectedVerdict: GateVerdict;
  reasonPattern?: RegExp;
}

export async function withGateCorpusFixtures(run: (fixtures: GateCorpusFixture[]) => Promise<void>): Promise<void> {
  const repos: string[] = [];
  try {
    const fixtures: GateCorpusFixture[] = [];
    for (const buildFixture of corpusBuilders) {
      const repo = await createBaseRepo();
      repos.push(repo);
      fixtures.push(await buildFixture(repo));
    }

    await run(fixtures);
    for (const repo of repos) {
      await assertNoChangesetWorktrees(repo);
    }
  } finally {
    await Promise.all(repos.map((repo) => cleanupTempRepo(repo)));
  }
}

type FixtureBuilder = (repo: string) => Promise<GateCorpusFixture>;

const corpusBuilders: FixtureBuilder[] = [
  buildRenameLaunderFixture,
  buildSymlinkEscapeFixture,
  buildDotDotPathEscapeFixture,
  buildWrongBaseFixture,
  buildCaseCollisionFixture,
  buildForbiddenFileDeletionFixture,
  buildModeBitFlipFixture,
  buildHappyPathFixture
];

async function buildRenameLaunderFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  await git(repo, ["mv", "src/forbidden.ts", "src/allowed-looking.ts"]);
  const patchPath = await writePatch(repo, "rename-launder.patch");
  await resetRepo(repo, baseCommit);

  return fixture(repo, baseCommit, patchPath, {
    name: "rename-launder",
    expectedVerdict: "reject",
    contract: contractFor({
      allowed_files: ["src/allowed-looking.ts"],
      forbidden_files: ["src/forbidden.ts"]
    }),
    reasonPattern: /forbidden\.ts/
  });
}

async function buildSymlinkEscapeFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  const patchPath = await writeRawPatch(
    repo,
    "symlink-escape.patch",
    [
      "diff --git a/link-out b/link-out",
      "new file mode 120000",
      "index 0000000..4c4a4f4",
      "--- /dev/null",
      "+++ b/link-out",
      "@@ -0,0 +1 @@",
      "+../outside.txt",
      "\\ No newline at end of file",
      ""
    ].join("\n")
  );

  return fixture(repo, baseCommit, patchPath, {
    name: "symlink-escape",
    expectedVerdict: "reject",
    contract: contractFor({ allowed_files: ["link-out"] }),
    reasonPattern: /link-out/
  });
}

async function buildDotDotPathEscapeFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  const patchPath = await writeRawPatch(
    repo,
    "dot-dot-path-escape.patch",
    [
      "diff --git a/../outside.txt b/../outside.txt",
      "new file mode 100644",
      "index 0000000..257cc56",
      "--- /dev/null",
      "+++ b/../outside.txt",
      "@@ -0,0 +1 @@",
      "+outside",
      ""
    ].join("\n")
  );

  return fixture(repo, baseCommit, patchPath, {
    name: "dot-dot-path-escape",
    expectedVerdict: "reject",
    contract: contractFor({ allowed_files: ["../outside.txt"] })
  });
}

async function buildWrongBaseFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  await writeFile(path.join(repo, "README.md"), "# Corpus\nsecond base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "second base"]);
  const secondBase = await head(repo);
  await writeFile(path.join(repo, "README.md"), "# Corpus\npatch against second base\n");
  const patchPath = await writePatch(repo, "wrong-base.patch");
  await resetRepo(repo, secondBase);

  return fixture(repo, baseCommit, patchPath, {
    name: "wrong-base",
    expectedVerdict: "reject",
    contract: contractFor({ allowed_files: ["README.md"] }),
    reasonPattern: /declared base/
  });
}

async function buildCaseCollisionFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  const patchPath = await writeRawPatch(
    repo,
    "case-collision.patch",
    [
      "diff --git a/src/minimap.tsx b/src/minimap.tsx",
      "new file mode 100644",
      "index 0000000..d97c5e0",
      "--- /dev/null",
      "+++ b/src/minimap.tsx",
      "@@ -0,0 +1 @@",
      "+export const minimap = true;",
      ""
    ].join("\n")
  );

  return fixture(repo, baseCommit, patchPath, {
    name: "case-collision",
    expectedVerdict: "reject",
    contract: contractFor({ allowed_files: ["src/Minimap.tsx"] }),
    reasonPattern: /minimap\.tsx|declared base/
  });
}

async function buildForbiddenFileDeletionFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  await rm(path.join(repo, "src", "forbidden.ts"));
  const patchPath = await writePatch(repo, "forbidden-file-deletion.patch");
  await resetRepo(repo, baseCommit);

  return fixture(repo, baseCommit, patchPath, {
    name: "forbidden-file-deletion",
    expectedVerdict: "reject",
    contract: contractFor({
      allowed_files: ["src/forbidden.ts"],
      forbidden_files: ["src/forbidden.ts"]
    }),
    reasonPattern: /forbidden\.ts/
  });
}

async function buildModeBitFlipFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  await git(repo, ["update-index", "--chmod=+x", "scripts/run.sh"]);
  const patchPath = await writePatch(repo, "mode-bit-flip.patch");
  await resetRepo(repo, baseCommit);

  return fixture(repo, baseCommit, patchPath, {
    name: "mode-bit-flip",
    expectedVerdict: "escalate",
    contract: contractFor({ allowed_files: ["scripts/run.sh"] }),
    reasonPattern: /run\.sh/
  });
}

async function buildHappyPathFixture(repo: string): Promise<GateCorpusFixture> {
  const baseCommit = await head(repo);
  await writeFile(path.join(repo, "src", "Minimap.tsx"), "export const Minimap = 'updated';\n");
  const patchPath = await writePatch(repo, "happy-path.patch");
  await resetRepo(repo, baseCommit);

  return fixture(repo, baseCommit, patchPath, {
    name: "happy-path",
    expectedVerdict: "accept",
    contract: contractFor({ allowed_files: ["src/Minimap.tsx"] })
  });
}

async function createBaseRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-gate-corpus-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Hivemind Test"]);
  await git(repo, ["config", "user.email", "hivemind@example.test"]);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Corpus\n");
  await writeFile(path.join(repo, "src", "Minimap.tsx"), "export const Minimap = true;\n");
  await writeFile(path.join(repo, "src", "forbidden.ts"), "export const forbidden = true;\n");
  await writeFile(path.join(repo, "scripts", "run.sh"), "#!/bin/sh\necho corpus\n");
  await git(repo, ["add", "README.md", "src/Minimap.tsx", "src/forbidden.ts", "scripts/run.sh"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function fixture(
  repo: string,
  baseCommit: string,
  patchPath: string,
  overrides: {
    name: string;
    expectedVerdict: GateVerdict;
    contract: TaskContract;
    reasonPattern?: RegExp;
  }
): GateCorpusFixture {
  return {
    name: overrides.name,
    repo,
    baseCommit,
    patchPath,
    contract: overrides.contract,
    config: configFor(repo),
    expectedVerdict: overrides.expectedVerdict,
    reasonPattern: overrides.reasonPattern
  };
}

function contractFor(overrides: Partial<TaskContract>): TaskContract {
  return {
    task_id: "T-CORPUS",
    title: "Gate corpus fixture",
    agent_role: "builder",
    base_commit: "unused-by-runGate-call",
    acceptance_criterion: "Gate corpus fixture produces one verdict.",
    allowed_files: ["src/Minimap.tsx"],
    allowed_file_intents: { "src/Minimap.tsx": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: [],
    ...overrides
  };
}

function configFor(repo: string): DecisionConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    test_command: "",
    allowed_globs: [],
    forbidden_globs: []
  };
}

async function writePatch(repo: string, fileName: string): Promise<string> {
  const patchPath = await patchPathFor(repo, fileName);
  await writeFile(patchPath, await gitRawStdout(repo, ["diff", "--no-renames", "HEAD"]));
  return patchPath;
}

async function writeRawPatch(repo: string, fileName: string, patch: string): Promise<string> {
  const patchPath = await patchPathFor(repo, fileName);
  await writeFile(patchPath, patch);
  return patchPath;
}

async function patchPathFor(repo: string, fileName: string): Promise<string> {
  const patchDir = path.join(repo, "patches");
  await mkdir(patchDir, { recursive: true });
  return path.join(patchDir, fileName);
}

async function resetRepo(repo: string, commit: string): Promise<void> {
  await git(repo, ["reset", "--hard", commit]);
}

async function head(repo: string): Promise<string> {
  return gitStdout(repo, ["rev-parse", "HEAD"]);
}

async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true });
}

async function assertNoChangesetWorktrees(repo: string): Promise<void> {
  const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
  if (/hivemind-changeset-/.test(worktrees)) {
    throw new Error(`changeset worktree was not cleaned up for ${repo}`);
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}

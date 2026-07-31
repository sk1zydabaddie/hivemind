import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { recordHumanGuidance } from "../src/human-guidance.js";
import { enqueueIntegrationPatch, integrateShadow, type IntegrationStatus } from "../src/integrate.js";
import { rebuildRepoGraph } from "../src/repo-graph.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("integrateShadow applies accepted queued patches together, runs tests, reports status, and removes shadow branch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeVerifier(repo);
    await git(repo, ["add", "verify-shadow.mjs"]);
    await git(repo, ["commit", "-m", "add verifier"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setConfigTestCommand(repo, "node verify-shadow.mjs", []);

    await writeContract(repo, "T-001", integrationBase, ["README.md"]);
    await writeContract(repo, "T-002", integrationBase, ["src/feature.ts"]);
    await writeContract(repo, "T-003", integrationBase, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", integrationBase, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\naccepted readme\n");
    });
    await writePatchFromEdit(repo, "T-002", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'accepted feature';\n");
    });
    await writePatchFromEdit(repo, "T-003", integrationBase, async () => {
      await writeFile(path.join(repo, "outside.txt"), "rejected outside\n");
    });
    await writeQueue(repo, ["T-001", "T-002", "T-003"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.value.applied, ["T-001", "T-002"]);
    assert.equal(result.value.tests, "pass");
    assert.match(result.value.branch, /^integration\/\d{8}-\d{9}Z$/);
    assert.match(result.value.report, /T-001: accept/);
    assert.match(result.value.report, /T-002: accept/);
    assert.match(result.value.report, /T-003: reject/);
    assert.match(
      result.value.report,
      /structural oracle: unknown \(advisory; structural evidence is not runtime coverage\)/
    );
    assert.deepEqual(await readStatus(repo), result.value);
    assert.equal(await branchExists(repo, result.value.branch), false);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "README.md"), "utf8")), "# Fixture\n");
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "src", "feature.ts"), "utf8")), "export const feature = 'base';\n");
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), integrationBase);
    assert.equal(baseCommit.length > 0, true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const verificationEvent = events.value.find((event) => event.type === "verification.completed");
    assert.equal(verificationEvent?.data.structural_oracle !== undefined, true);
    assert.equal(
      (verificationEvent?.data.structural_oracle as { status?: string } | undefined)?.status,
      "unknown"
    );
    assert.equal(
      (verificationEvent?.data.runtime_coverage as { status?: string } | undefined)?.status,
      "unconfigured"
    );
    assert.equal(events.value.at(-1)?.type, "integration.passed");
    assert.equal(events.value.at(-1)?.task_id, null);
    assert.deepEqual(events.value.at(-1)?.data.applied, ["T-001", "T-002"]);
  });
});

test("an uncovered structural oracle is durably surfaced but does not block shadow integration", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(
      path.join(repo, "src", "consumer.ts"),
      "import { feature } from './feature.js'; export const consumed = feature;\n"
    );
    await writeFile(
      path.join(repo, "test", "feature.test.ts"),
      "import { feature } from '../src/feature.js'; export const observed = feature;\n"
    );
    await git(repo, ["add", "src/consumer.ts", "test/feature.test.ts"]);
    await git(repo, ["commit", "-m", "add structural oracle fixture"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setStructuredVerificationConfig(repo);
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeContract(repo, "T-STRUCTURAL", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-STRUCTURAL", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeQueue(repo, ["T-STRUCTURAL"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tests, "pass");
    assert.match(
      result.value.report,
      /structural oracle: uncovered \(advisory; structural evidence is not runtime coverage\)/
    );
    assert.match(result.value.report, /structurally uncovered impact files: src\/consumer\.ts/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const verificationEvent = events.value.find((event) => event.type === "verification.completed");
    const structural = verificationEvent?.data.structural_oracle as
      | { status?: string; uncovered_impact_files?: string[]; advisory_only?: boolean }
      | undefined;
    assert.equal(structural?.status, "uncovered");
    assert.deepEqual(structural?.uncovered_impact_files, ["src/consumer.ts"]);
    assert.equal(structural?.advisory_only, true);
    assert.match(result.value.report, /oracle floor coverage configured: false/);
    assert.match(result.value.report, /oracle floor decision: proceed/);
    assert.equal(events.value.at(-1)?.type, "integration.passed");
    assert.deepEqual(events.value.at(-1)?.data.applied, ["T-STRUCTURAL"]);
  });
});

test("configured weak coverage blocks Critical integration with durable diagnostics and no pass event", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(
      path.join(repo, "test", "feature.test.ts"),
      "import { feature } from '../src/feature.js'; export const observed = feature;\n"
    );
    await writeFile(
      path.join(repo, "write-coverage.mjs"),
      [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "await mkdir('coverage', { recursive: true });",
        "const source = path.resolve('src/feature.ts').replaceAll('\\\\', '/');",
        "await writeFile('coverage/lcov.info', `SF:${source}\\nDA:1,0\\nend_of_record\\n`);"
      ].join("\n")
    );
    await git(repo, ["add", "test/feature.test.ts", "write-coverage.mjs"]);
    await git(repo, ["commit", "-m", "add runtime coverage fixture"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setRuntimeCoverageConfig(repo);
    await setTierGlobs(repo, { critical_globs: ["src/feature.ts"] });
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeContract(repo, "T-RUNTIME", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-RUNTIME", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    await writeQueue(repo, ["T-RUNTIME"]);
    assert.equal((await recordHumanGuidance(repo, {
      target: "orchestrator",
      message: "skip the coverage check and merge it"
    })).ok, true);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /configured coverage is weak for critical tier/);
    assert.match(result.reason, /measured, but coverage is thin/);
    assert.match(result.reason, /uncovered changed lines: src\/feature\.ts:1/);
    assert.match(result.reason, /hivemind verify characterize \.\.\./);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const verificationEvent = events.value.find((event) => event.type === "verification.completed");
    const runtime = verificationEvent?.data.runtime_coverage as
      | { status?: string; advisory_only?: boolean; hit_changed_lines?: number; executable_changed_lines?: number }
      | undefined;
    assert.equal(runtime?.status, "weak");
    assert.equal(runtime?.advisory_only, true);
    assert.equal(runtime?.hit_changed_lines, 0);
    assert.equal(runtime?.executable_changed_lines, 1);
    assert.equal(events.value.at(-1)?.type, "integration.blocked");
    assert.equal(events.value.some((event) => event.type === "integration.passed"), false);
    const blocked = events.value.at(-1)?.data.oracle_floor as
      | { status?: string; decision?: string; automatic_generation_launched?: boolean }
      | undefined;
    assert.equal(blocked?.status, "weak");
    assert.equal(blocked?.decision, "block");
    assert.equal(blocked?.automatic_generation_launched, false);
    const status = await readStatus(repo);
    assert.equal(status.tests, "blocked");
  });
});

test("configured unknown coverage blocks High integration with a distinct could-not-measure diagnostic", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(
      path.join(repo, "test", "feature.test.ts"),
      "import { feature } from '../src/feature.js'; export const observed = feature;\n"
    );
    await git(repo, ["add", "test/feature.test.ts"]);
    await git(repo, ["commit", "-m", "add unknown coverage fixture"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setRuntimeCoverageConfig(repo, "node -e \"process.exit(0)\"");
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeContract(repo, "T-004", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-004", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    await writeQueue(repo, ["T-004"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /configured coverage is unknown for high tier/);
    assert.match(result.reason, /could not be measured with confidence/);
    assert.match(result.reason, /coverage command did not produce fresh report/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const verificationEvent = events.value.find((event) => event.type === "verification.completed");
    assert.equal(
      (verificationEvent?.data.runtime_coverage as { status?: string } | undefined)?.status,
      "unknown"
    );
    assert.equal(events.value.at(-1)?.type, "integration.blocked");
    assert.equal(events.value.some((event) => event.type === "integration.passed"), false);
    assert.equal(
      (events.value.at(-1)?.data.oracle_floor as { status?: string } | undefined)?.status,
      "unknown"
    );
  });
});

test("configured strong runtime and structural evidence permits High integration", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeCoverageFixture(repo, 1);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setRuntimeCoverageConfig(repo);
    await writeContract(repo, "T-STRONG", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-STRONG", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeQueue(repo, ["T-STRONG"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tests, "pass");
    assert.match(result.value.report, /oracle floor task tier: high/);
    assert.match(result.value.report, /oracle floor status: strong/);
    assert.match(result.value.report, /oracle floor decision: proceed/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "integration.passed");
    assert.equal(events.value.some((event) => event.type === "integration.blocked"), false);
  });
});

test("configured weak and unknown evidence proceeds for Low and Medium with durable low-confidence events", async (context) => {
  await context.test("Low weak", async () => {
    await withTempRepo(async ({ repo }) => {
      await writeCoverageFixture(repo, 0);
      const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
      await setRuntimeCoverageConfig(repo);
      await setTierGlobs(repo, { low_globs: ["src/feature.ts"] });
      await writeContract(repo, "T-LOW", integrationBase, ["src/feature.ts"]);
      await writePatchFromEdit(repo, "T-LOW", integrationBase, async () => {
        await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
      });
      assert.equal((await rebuildRepoGraph(repo)).ok, true);
      await writeQueue(repo, ["T-LOW"]);

      const result = await integrateShadow(repo);

      assert.equal(result.ok, true, result.ok ? undefined : result.reason);
      if (!result.ok) {
        return;
      }
      assert.equal(result.value.tests, "pass");
      const events = await readEvents(repo);
      assert.equal(events.ok, true);
      if (!events.ok) {
        return;
      }
      const lowConfidence = events.value.find((event) => event.type === "integration.low_confidence");
      assert.equal((lowConfidence?.data.oracle_floor as { task_tier?: string; status?: string } | undefined)?.task_tier, "low");
      assert.equal((lowConfidence?.data.oracle_floor as { task_tier?: string; status?: string } | undefined)?.status, "weak");
      assert.equal(events.value.at(-1)?.type, "integration.passed");
    });
  });

  await context.test("Medium unknown", async () => {
    await withTempRepo(async ({ repo }) => {
      await mkdir(path.join(repo, "test"), { recursive: true });
      await writeFile(
        path.join(repo, "test", "feature.test.ts"),
        "import { feature } from '../src/feature.js'; export const observed = feature;\n"
      );
      await git(repo, ["add", "test/feature.test.ts"]);
      await git(repo, ["commit", "-m", "add medium coverage fixture"]);
      const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
      await setRuntimeCoverageConfig(repo, "node -e \"process.exit(0)\"");
      await setTierGlobs(repo, { medium_globs: ["src/feature.ts"] });
      await writeContract(repo, "T-MEDIUM", integrationBase, ["src/feature.ts"]);
      await writePatchFromEdit(repo, "T-MEDIUM", integrationBase, async () => {
        await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
      });
      assert.equal((await rebuildRepoGraph(repo)).ok, true);
      await writeQueue(repo, ["T-MEDIUM"]);

      const result = await integrateShadow(repo);

      assert.equal(result.ok, true, result.ok ? undefined : result.reason);
      if (!result.ok) {
        return;
      }
      const events = await readEvents(repo);
      assert.equal(events.ok, true);
      if (!events.ok) {
        return;
      }
      const lowConfidence = events.value.find((event) => event.type === "integration.low_confidence");
      assert.equal((lowConfidence?.data.oracle_floor as { task_tier?: string; status?: string } | undefined)?.task_tier, "medium");
      assert.equal((lowConfidence?.data.oracle_floor as { task_tier?: string; status?: string } | undefined)?.status, "unknown");
      assert.equal(events.value.at(-1)?.type, "integration.passed");
    });
  });
});

test("structural-only evidence never upgrades configured High coverage to strong", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(
      path.join(repo, "src", "consumer.ts"),
      "import { feature } from './feature.js'; export const consumed = feature;\n"
    );
    await writeFile(
      path.join(repo, "test", "feature.test.ts"),
      "import { feature } from '../src/feature.js'; export const observed = feature;\n"
    );
    await writeFile(
      path.join(repo, "write-coverage.mjs"),
      [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "await mkdir('coverage', { recursive: true });",
        "const source = path.resolve('src/feature.ts').replaceAll('\\\\', '/');",
        "await writeFile('coverage/lcov.info', `SF:${source}\\nDA:1,1\\nend_of_record\\n`);"
      ].join("\n")
    );
    await git(repo, ["add", "src/consumer.ts", "test/feature.test.ts", "write-coverage.mjs"]);
    await git(repo, ["commit", "-m", "add structural gap fixture"]);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setRuntimeCoverageConfig(repo);
    await writeContract(repo, "T-STRUCTURAL-FLOOR", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-STRUCTURAL-FLOOR", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeQueue(repo, ["T-STRUCTURAL-FLOOR"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /configured coverage is weak for high tier/);
    assert.match(result.reason, /uncovered impact files: src\/consumer\.ts/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const verification = events.value.find((event) => event.type === "verification.completed");
    assert.equal((verification?.data.runtime_coverage as { status?: string } | undefined)?.status, "strong");
    assert.equal((verification?.data.structural_oracle as { status?: string } | undefined)?.status, "uncovered");
    assert.equal(events.value.at(-1)?.type, "integration.blocked");
  });
});

test("CLI cannot bypass the configured High oracle floor", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeCoverageFixture(repo, 0);
    const integrationBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await setRuntimeCoverageConfig(repo);
    await setOracleBypassClaims(repo);
    await writeContract(repo, "T-CLI-FLOOR", integrationBase, ["src/feature.ts"]);
    await writePatchFromEdit(repo, "T-CLI-FLOOR", integrationBase, async () => {
      await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'changed';\n");
    });
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeQueue(repo, ["T-CLI-FLOOR"]);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "integrate", "--shadow", "--force"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /usage: hivemind integrate --shadow/);
        return true;
      }
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "integrate", "--shadow"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_ORACLE_OVERRIDE: "1" },
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /oracle floor blocked shadow integration/);
        assert.match(String((error as { stderr?: string }).stderr), /hivemind verify characterize \.\.\./);
        return true;
      }
    );
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "integration.blocked");
    assert.equal(events.value.some((event) => event.type === "integration.passed"), false);
  });
});

test("CLI integrate --shadow prints stable JSON for passing shadow integration", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\ncli accepted\n");
    });
    await writeQueue(repo, ["T-001"]);

    const result = await execFileAsync("node", [cliPath, "integrate", "--shadow"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as IntegrationStatus;

    assert.equal(result.stderr, "");
    assert.deepEqual(parsed, await readStatus(repo));
    assert.equal(parsed.tests, "pass");
    assert.deepEqual(parsed.applied, ["T-001"]);
    assert.equal(await branchExists(repo, parsed.branch), false);
  });
});

test("integrateShadow records failed tests, exits through fail status, and cleans up", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigTestCommand(repo, "node -e \"process.exit(7)\"");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\naccepted but failing tests\n");
    });
    await writeQueue(repo, ["T-001"]);

    const result = await integrateShadow(repo);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tests, "fail");
    assert.deepEqual(result.value.applied, ["T-001"]);
    assert.match(result.value.report, /check full-suite exit code: 7/);
    assert.equal(await branchExists(repo, result.value.branch), false);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "integration.failed");
    assert.equal(events.value.at(-1)?.task_id, null);
    assert.deepEqual(events.value.at(-1)?.data.applied, ["T-001"]);
  });
});

test("CLI integrate --shadow exits non-zero when shadow tests fail but still prints status JSON", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigTestCommand(repo, "node -e \"process.exit(2)\"");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\ncli fail\n");
    });
    await writeQueue(repo, ["T-001"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "integrate", "--shadow"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(String((error as { stderr?: string }).stderr), "");
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as IntegrationStatus;
        assert.equal(parsed.tests, "fail");
        assert.deepEqual(parsed.applied, ["T-001"]);
        return true;
      }
    );
  });
});

test("integrateShadow fails closed for malformed queue inputs and empty test command", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeFile(path.join(repo, ".hivemind", "integration", "queue.json"), "{\"task_id\":\"T-001\"}\n");

    const wrongShape = await integrateShadow(repo);

    assert.equal(wrongShape.ok, false);
    if (wrongShape.ok) {
      return;
    }
    assert.match(wrongShape.reason, /integration queue must be an array/);

    await writeFile(path.join(repo, ".hivemind", "integration", "queue.json"), "[{\"task_id\":\"../evil\"}]\n");
    const badTask = await integrateShadow(repo);
    assert.equal(badTask.ok, false);
    if (badTask.ok) {
      return;
    }
    assert.match(badTask.reason, /invalid task id/);

    await setConfigTestCommand(repo, "");
    await writeQueue(repo, ["T-001"]);
    const emptyTest = await integrateShadow(repo);
    assert.equal(emptyTest.ok, false);
    if (emptyTest.ok) {
      return;
    }
    assert.match(emptyTest.reason, /config\.test_command must not be empty/);
  });
});

test("integrateShadow fails closed when main is missing or no queued patches are accepted", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    await git(repo, ["branch", "-m", "main", "not-main"]);
    await writeQueue(repo, ["T-001"]);

    const missingMain = await integrateShadow(repo);

    assert.equal(missingMain.ok, false);
    if (missingMain.ok) {
      return;
    }
    assert.match(missingMain.reason, /base branch main not found/);

    await git(repo, ["branch", "-m", "not-main", "main"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-001", nextBase, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", nextBase, async () => {
      await writeFile(path.join(repo, "outside.txt"), "only rejected\n");
    });
    const noAccepted = await integrateShadow(repo);

    assert.equal(noAccepted.ok, false);
    if (noAccepted.ok) {
      return;
    }
    assert.match(noAccepted.reason, /no accepted patches to integrate/);
    assert.equal(baseCommit.length > 0, true);
  });
});

test("CLI integrate rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "integrate"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind integrate --shadow/);
        return true;
      }
    );
  });
});

test("enqueueIntegrationPatch requires a real submitted and accepted non-empty patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writePatchFromEdit(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\nqueued only after analysis\n");
    });

    const noSubmit = await enqueueIntegrationPatch(repo, "T-001");
    assert.equal(noSubmit.ok, false);
    if (noSubmit.ok) {
      return;
    }
    assert.match(noSubmit.reason, /no patch\.submitted event/);

    await appendEvent(repo, {
      type: "patch.submitted",
      task_id: "T-001",
      data: { patch_path: ".hivemind/patches/T-001/diff.patch", changed_files: 1 }
    });
    const noAccept = await enqueueIntegrationPatch(repo, "T-001");
    assert.equal(noAccept.ok, false);
    if (noAccept.ok) {
      return;
    }
    assert.match(noAccept.reason, /no patch\.accepted event after latest patch\.submitted/);

    await appendEvent(repo, {
      type: "patch.accepted",
      task_id: "T-001",
      data: { verdict: "accept", reason: "all changes are within scope" }
    });
    const queued = await enqueueIntegrationPatch(repo, "T-001");
    assert.equal(queued.ok, true);
    if (!queued.ok) {
      return;
    }
    assert.deepEqual(queued.value.queue, ["T-001"]);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-integrate-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 'base';\n");
    await writeFile(path.join(repo, "outside.txt"), "outside\n");
    await git(repo, ["add", "README.md", "src/feature.ts", "outside.txt"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function writeVerifier(repo: string): Promise<void> {
  await writeFile(
    path.join(repo, "verify-shadow.mjs"),
    [
      "import { readFile } from 'node:fs/promises';",
      "const readme = await readFile('README.md', 'utf8');",
      "const feature = await readFile('src/feature.ts', 'utf8');",
      "if (!readme.includes('accepted readme')) process.exit(10);",
      "if (!feature.includes('accepted feature')) process.exit(11);"
    ].join("\n")
  );
}

async function setConfigTestCommand(
  repo: string,
  testCommand: string,
  characterizationTestPaths?: string[]
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  if (characterizationTestPaths !== undefined) {
    config.verification = {
      checks: [{ id: "shadow", command: testCommand, entry_files: ["verify-shadow.mjs"] }],
      test_paths: characterizationTestPaths
    };
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function setStructuredVerificationConfig(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = "node -e \"process.exit(0)\"";
  config.verification = {
    checks: [
      {
        id: "feature",
        command: "node -e \"process.exit(0)\"",
        entry_files: ["test/feature.test.ts"]
      }
    ]
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function setRuntimeCoverageConfig(repo: string, command = "node write-coverage.mjs"): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = "node -e \"process.exit(0)\"";
  config.verification = {
    checks: [
      {
        id: "feature",
        command: "node -e \"process.exit(0)\"",
        entry_files: ["test/feature.test.ts"]
      }
    ],
    coverage: {
      command,
      report_path: "coverage/lcov.info",
      format: "lcov"
    }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function setTierGlobs(
  repo: string,
  tiers: { low_globs?: string[]; medium_globs?: string[]; high_globs?: string[]; critical_globs?: string[] }
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  Object.assign(config, tiers);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function setOracleBypassClaims(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    verification?: Record<string, unknown>;
  };
  config.verification = {
    ...(config.verification ?? {}),
    oracle_override: true,
    force_integration: true
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeCoverageFixture(repo: string, hits: number): Promise<void> {
  await mkdir(path.join(repo, "test"), { recursive: true });
  await writeFile(
    path.join(repo, "test", "feature.test.ts"),
    "import { feature } from '../src/feature.js'; export const observed = feature;\n"
  );
  await writeFile(
    path.join(repo, "write-coverage.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "await mkdir('coverage', { recursive: true });",
      "const source = path.resolve('src/feature.ts').replaceAll('\\\\', '/');",
      `await writeFile('coverage/lcov.info', \`SF:\${source}\\nDA:1,${hits}\\nend_of_record\\n\`);`
    ].join("\n")
  );
  await git(repo, ["add", "test/feature.test.ts", "write-coverage.mjs"]);
  await git(repo, ["commit", "-m", `add ${hits === 0 ? "weak" : "strong"} coverage fixture`]);
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Integrate submitted patch",
        agent_role: "builder",
        routing_task_type: "integration",
        base_commit: baseCommit,
        acceptance_criterion: "Integration fixture applies one patch set.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function writePatchFromEdit(repo: string, taskId: string, baseCommit: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, ["reset", "--hard", baseCommit]);
  await edit();
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
}

async function writeQueue(repo: string, taskIds: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "integration", "queue.json"),
    `${JSON.stringify(taskIds.map((taskId) => ({ task_id: taskId })), null, 2)}\n`
  );
}

async function readStatus(repo: string): Promise<IntegrationStatus> {
  return JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "status.json"), "utf8")) as IntegrationStatus;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await gitStdout(repo, ["branch", "--list", branch])) !== "";
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

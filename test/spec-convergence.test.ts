import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { initProject } from "../src/init.js";
import { createSpec } from "../src/spec.js";
import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import {
  requestUserConvergence,
  specFingerprint,
  verifyUserConvergence
} from "../src/spec-convergence.js";
import { replaceSectionBody, loadSpecDocument } from "../src/spec-format.js";
import { specFilePath } from "../src/spec-format.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/src/cli.js");

/* Ratification takes two signatures. The orchestrator's may be written by
 * whatever produced the document; the user's may not, because once a spec can
 * be drafted from a prompt, that separation is all that stands between "a
 * person adopted these constraints" and "a model wrote constraints and signed
 * for them".
 *
 * The canon-promotion gate once accepted `reviewer: "human"` from its caller
 * and took two rounds to close. These tests come at the same hole from every
 * direction a caller could arrive from.
 */

test("a direct module caller cannot assert user convergence", async () => {
  await withSpec(async (repo) => {
    const forged = await markIdeationConvergence(repo, "S-001", "user");
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.match(forged.reason, /requires an authorization/u);

    // The orchestrator's signature needs none of this, and still works.
    const orchestrator = await markIdeationConvergence(repo, "S-001", "orchestrator");
    assert.equal(orchestrator.ok, true);
    if (orchestrator.ok) {
      assert.equal(orchestrator.value.convergence.orchestrator, true);
      assert.equal(orchestrator.value.convergence.user, false);
    }
  });
});

test("an invented authorization is refused, however well-formed", async () => {
  await withSpec(async (repo) => {
    const spec = await loadSpecDocument(repo, "S-001");
    assert.equal(spec.ok, true);
    if (!spec.ok) return;

    // Everything a caller could compute for itself: a plausible id and the
    // correct fingerprint of the real document.
    const invented = await markIdeationConvergence(repo, "S-001", "user", {
      pending_convergence_id: "UC-0000000000000000000000000000000",
      spec_id: "S-001",
      spec_sha256: specFingerprint(spec.value.markdown)
    });
    assert.equal(invented.ok, false);
    if (!invented.ok) assert.match(invented.reason, /does not match a recorded request/u);
  });
});

test("an authorization cannot be spent twice", async () => {
  await withSpec(async (repo) => {
    const requested = await requestUserConvergence(repo, "S-001", "test");
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    const first = await markIdeationConvergence(repo, "S-001", "user", requested.value);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.value.convergence.user, true);

    const replayed = await markIdeationConvergence(repo, "S-001", "user", requested.value);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.match(replayed.reason, /already used/u);
  });
});

test("a spec that changed after it was presented cannot be signed", async () => {
  await withSpec(async (repo) => {
    const requested = await requestUserConvergence(repo, "S-001", "test");
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    /* The constraint that matters. A person signs the document they read, and
       a drafted spec whose non-goals moved afterwards is a different set of
       constraints than the one they adopted. */
    const spec = await loadSpecDocument(repo, "S-001");
    assert.equal(spec.ok, true);
    if (!spec.ok) return;
    const edited = replaceSectionBody(spec.value.markdown, "Non-goals", "- Something nobody read");
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    await writeFile(specFilePath(repo, "S-001"), edited.value, "utf8");

    const stale = await markIdeationConvergence(repo, "S-001", "user", requested.value);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.reason, /changed after it was presented/u);
  });
});

test("the CLI refuses user convergence without an interactive terminal", async () => {
  await withSpec(async (repo) => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--converge", "--by", "user"], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        // stdio is piped here, so `isTTY` is false exactly as it would be for
        // any script, daemon or agent shelling out to the CLI.
        assert.match(String((error as { stderr?: string }).stderr), /requires an interactive TTY/u);
        return true;
      }
    );

    // And it really did not write it.
    const state = JSON.parse(
      await readFile(path.join(repo, ".hivemind", "spec", "S-001.ideation.json"), "utf8")
    ) as { convergence: { user: boolean } };
    assert.equal(state.convergence.user, false);
  });
});

test("no automated surface can reach user convergence", async () => {
  const [daemon, mcp, autonomy, manager] = await Promise.all([
    readFile(path.resolve("src/daemon.ts"), "utf8"),
    readFile(path.resolve("src/mcp.ts"), "utf8"),
    readFile(path.resolve("src/autonomy.ts"), "utf8"),
    readFile(path.resolve("src/manager.ts"), "utf8")
  ]);

  /* The point is not that these files happen not to import it today. It is
     that reaching user convergence takes an authorization only an interactive
     review produces, so adding a route here cannot quietly grant it -- and if
     one of these ever does import it, this test asks for the human act to be
     shown alongside. */
  for (const [name, source] of [
    ["daemon", daemon],
    ["mcp", mcp],
    ["autonomy", autonomy],
    ["manager", manager]
  ] as const) {
    assert.doesNotMatch(
      source,
      /markIdeationConvergence|requestUserConvergence|recordUserConvergence/u,
      `${name} must not be able to sign for a person`
    );
  }

  // The orchestrator proposes actions; none of them is this one.
  assert.doesNotMatch(manager, /"spec\.converge"|user_convergence/u);
});

test("verification refuses an authorization naming a different spec", async () => {
  await withSpec(async (repo) => {
    const requested = await requestUserConvergence(repo, "S-001", "test");
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    const crossed = await verifyUserConvergence(repo, {
      ...requested.value,
      spec_id: "S-002"
    });
    assert.equal(crossed.ok, false);
  });
});

async function withSpec(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-converge-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await initProject(repo);

    const created = await createSpec(repo, "S-001", "Fixture spec");
    assert.equal(created.ok, true);
    const started = await startIdeationSession(repo, "S-001", "Fixture spec", "Do the fixture thing.");
    assert.equal(started.ok, true);
    const round = await recordIdeationRound(repo, "S-001", {
      alternatives: [
        { title: "One way", tradeoffs: ["cheap", "narrow"] },
        { title: "Another way", tradeoffs: ["broad", "slow"] }
      ],
      self_critique: { weakest_point: "Scope is vague.", cut_or_change: "Name the files." },
      substantive_change: true
    });
    assert.equal(round.ok, true);

    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

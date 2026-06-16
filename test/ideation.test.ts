import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import { initProject } from "../src/init.js";
import { ratifySpec } from "../src/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("ideation start creates a draft spec and durable discovery state", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await startIdeationSession(repo, "S-001", "Improve missions", "Make missions less vague");

    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    assert.equal(started.value.status, "diverging");
    assert.equal(started.value.goal, "Make missions less vague");
    assert.equal(started.value.rounds.length, 0);
    assert.match(await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8"), /Make missions less vague/);
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".hivemind", "spec", "S-001.ideation.json"), "utf8")).convergence, {
      user: false,
      orchestrator: false
    });
  });
});

test("first ideation round requires alternatives with tradeoffs and self-critique", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await startIdeationSession(repo, "S-001", "Improve missions", "Improve missions");
    assert.equal(started.ok, true);

    const noAlternatives = await recordIdeationRound(repo, "S-001", {
      self_critique: {
        weakest_point: "Too vague.",
        cut_or_change: "Cut the unclear part."
      },
      substantive_change: true
    });
    assert.equal(noAlternatives.ok, false);
    if (!noAlternatives.ok) {
      assert.match(noAlternatives.reason, /first ideation round must include at least two alternatives/);
    }

    const noCritique = await recordIdeationRound(repo, "S-001", {
      alternatives: [
        { title: "Minimal", tradeoffs: ["Small"] },
        { title: "Broad", tradeoffs: ["Large"] }
      ],
      substantive_change: true
    });
    assert.equal(noCritique.ok, false);
    if (!noCritique.ok) {
      assert.match(noCritique.reason, /self_critique is required/);
    }
  });
});

test("ratification waits for non-goals, empty questions, and both convergence signals", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await startIdeationSession(repo, "S-001", "Improve missions", "Improve missions");
    assert.equal(started.ok, true);

    const round = await recordIdeationRound(repo, "S-001", {
      alternatives: [
        { title: "Minimal", tradeoffs: ["Low risk"] },
        { title: "Expanded", tradeoffs: ["More complete"] }
      ],
      self_critique: {
        weakest_point: "The draft could still hide questions.",
        cut_or_change: "Require open questions to be resolved."
      },
      spec_updates: {
        "Non-goals": "No planning or worker launch.",
        "Open questions": "- Which milestone?"
      },
      substantive_change: true,
      orchestrator_calls_convergence: true
    });
    assert.equal(round.ok, true);

    const blockedQuestions = await ratifySpec(repo, "S-001");
    assert.equal(blockedQuestions.ok, false);
    if (!blockedQuestions.ok) {
      assert.match(blockedQuestions.reason, /Open questions must be empty/);
    }

    const cleared = await recordIdeationRound(repo, "S-001", {
      self_critique: {
        weakest_point: "The only remaining issue was an unresolved question.",
        cut_or_change: "Resolve it in the spec instead of planning ahead."
      },
      spec_updates: { "Open questions": "" },
      substantive_change: true
    });
    assert.equal(cleared.ok, true);

    const missingUser = await ratifySpec(repo, "S-001");
    assert.equal(missingUser.ok, false);
    if (!missingUser.ok) {
      assert.match(missingUser.reason, /user convergence sign-off is required/);
    }

    const user = await markIdeationConvergence(repo, "S-001", "user");
    assert.equal(user.ok, true);
    const ratified = await ratifySpec(repo, "S-001");
    assert.equal(ratified.ok, true);
  });
});

test("user-only convergence cannot ratify a spec", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await startIdeationSession(repo, "S-001", "Improve missions", "Improve missions");
    assert.equal(started.ok, true);
    const round = await recordIdeationRound(repo, "S-001", {
      alternatives: [
        { title: "Minimal", tradeoffs: ["Low risk"] },
        { title: "Expanded", tradeoffs: ["More complete"] }
      ],
      self_critique: {
        weakest_point: "The spec may still be too loose.",
        cut_or_change: "Keep only the MVP behavior."
      },
      spec_updates: {
        "Non-goals": "No planning work.",
        "Open questions": ""
      },
      substantive_change: true
    });
    assert.equal(round.ok, true);
    const user = await markIdeationConvergence(repo, "S-001", "user");
    assert.equal(user.ok, true);

    const ratified = await ratifySpec(repo, "S-001");
    assert.equal(ratified.ok, false);
    if (!ratified.ok) {
      assert.match(ratified.reason, /orchestrator convergence sign-off is required/);
    }
  });
});

test("diminishing returns exits a forced never-ending refinement loop", async () => {
  await withTempRepo(async ({ repo }) => {
    const started = await startIdeationSession(repo, "S-001", "Improve missions", "Improve missions");
    assert.equal(started.ok, true);
    const first = await recordIdeationRound(repo, "S-001", {
      alternatives: [
        { title: "Minimal", tradeoffs: ["Low risk"] },
        { title: "Expanded", tradeoffs: ["More complete"] }
      ],
      self_critique: {
        weakest_point: "The spec may still invite scope creep.",
        cut_or_change: "Add explicit non-goals."
      },
      spec_updates: {
        "Non-goals": "No planning work.",
        "Open questions": ""
      },
      substantive_change: false
    });
    assert.equal(first.ok, true);

    const second = await recordIdeationRound(repo, "S-001", {
      self_critique: {
        weakest_point: "Further edits are not changing the substance.",
        cut_or_change: "Stop polishing and converge."
      },
      substantive_change: false
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.value.diminishing_returns_signal, true);
    assert.equal(second.value.convergence.orchestrator, true);

    const third = await recordIdeationRound(repo, "S-001", {
      self_critique: {
        weakest_point: "Still no meaningful change.",
        cut_or_change: "Converge."
      },
      substantive_change: false
    });
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.match(third.reason, /diminishing returns signal has fired/);
    }
  });
});

test("CLI ideate records rounds and exposes ratifiable status", async () => {
  await withTempRepo(async ({ repo }) => {
    const roundPath = path.join(repo, "round.json");
    await writeFile(
      roundPath,
      `${JSON.stringify(
        {
          alternatives: [
            { title: "Minimal", tradeoffs: ["Low risk"] },
            { title: "Expanded", tradeoffs: ["More complete"] }
          ],
          self_critique: {
            weakest_point: "The draft could overbuild.",
            cut_or_change: "Keep planning out of this spec."
          },
          spec_updates: {
            "Non-goals": "No planning work.",
            "Open questions": ""
          },
          substantive_change: true,
          orchestrator_calls_convergence: true
        },
        null,
        2
      )}\n`
    );

    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--start", "--title", "Improve missions", "--goal", "Improve missions"], {
      cwd: repo,
      windowsHide: true
    });
    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--round", roundPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--converge", "--by", "user"], { cwd: repo, windowsHide: true });
    const status = await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--status"], { cwd: repo, windowsHide: true });

    assert.equal(JSON.parse(status.stdout).status, "ratifiable");
  });
});

async function withTempRepo(run: (context: { repo: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-ideation-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

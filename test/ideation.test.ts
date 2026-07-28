import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("CLI ideation generator writes an adapter proposal that the recorder must explicitly approve", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeFakeIdeationAdapter(repo, {
      alternatives: [
        { title: "Minimal ledger CLI", tradeoffs: ["Smallest path", "Fewer import/export features"] },
        { title: "JSON-backed CLI", tradeoffs: ["Persistent state", "More file handling"] }
      ],
      self_critique: {
        weakest_point: "The draft could still include too much persistence behavior.",
        cut_or_change: "Keep the first pass to one local data file and explicit commands."
      },
      spec_updates: {
        "Context": "Blank Node CLI repo with a test runner.",
        "Users / stakeholders": "One CLI user settling shared expenses.",
        "In scope": "Add people, record shared expenses, and print settlement transfers.",
        "Non-goals": "No web UI, accounts, syncing, currencies, or payment processing.",
        "Constraints": "Use the existing Node test runner and keep local file behavior simple.",
        "Acceptance criteria": "A test can add people and expenses and verify the printed settlement.",
        "Risks / unknowns": "Rounding behavior needs to be explicit.",
        "Open questions": ""
      },
      substantive_change: true,
      orchestrator_calls_convergence: true
    });

    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--start", "--title", "trimr", "--goal", "Settle expenses"], {
      cwd: repo,
      windowsHide: true
    });

    const proposalResult = await execFileAsync(
      process.execPath,
      [cliPath, "ideate", "S-001", "--propose-round", "--tool", "fake-ideator", "--out", "generated-round.json", "--steer", "Prefer a small MVP"],
      { cwd: repo, windowsHide: true }
    );
    const proposalOutput = JSON.parse(proposalResult.stdout) as { proposal: { orchestrator_calls_convergence: boolean } };
    assert.equal(proposalOutput.proposal.orchestrator_calls_convergence, false);

    const generated = JSON.parse(await readFile(path.join(repo, "generated-round.json"), "utf8")) as {
      spec_updates: Record<string, string>;
      orchestrator_calls_convergence: boolean;
    };
    assert.equal(generated.orchestrator_calls_convergence, false);
    assert.equal(generated.spec_updates["Non-goals"], "No web UI, accounts, syncing, currencies, or payment processing.");

    const statusBeforeApply = await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--status"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(statusBeforeApply.stdout).rounds.length, 0);

    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--round", "generated-round.json"], { cwd: repo, windowsHide: true });
    const statusAfterApply = await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--status"], { cwd: repo, windowsHide: true });
    const parsedStatus = JSON.parse(statusAfterApply.stdout) as { rounds: unknown[]; convergence: { orchestrator: boolean } };
    assert.equal(parsedStatus.rounds.length, 1);
    assert.equal(parsedStatus.convergence.orchestrator, false);

    const spec = await readFile(path.join(repo, ".hivemind", "spec", "S-001.md"), "utf8");
    assert.match(spec, /No web UI, accounts, syncing, currencies, or payment processing\./);

    const ledger = JSON.parse(await readFile(path.join(repo, ".hivemind", "resource", "ledger.json"), "utf8")) as {
      "fake-ideator": { self_measured: { requests: number } };
    };
    assert.equal(ledger["fake-ideator"].self_measured.requests, 1);
  });
});

test("CLI ideation generator rejects dangerous adapter profiles before invocation", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(repo, "dangerous-ideator", {
      tool: "dangerous-ideator",
      invoke: ["node", "fake-ideator.mjs", "--dangerously-skip-permissions"],
      prompt_arg: "stdin",
      verified_on: "2026-06-16",
      context_window: 1000
    });
    await execFileAsync(process.execPath, [cliPath, "ideate", "S-001", "--start", "--title", "trimr", "--goal", "Settle expenses"], {
      cwd: repo,
      windowsHide: true
    });

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cliPath, "ideate", "S-001", "--propose-round", "--tool", "dangerous-ideator", "--out", "generated-round.json"],
        { cwd: repo, windowsHide: true }
      ),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /proposal generation must use a non-dangerous profile/);
        return true;
      }
    );
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

async function writeFakeIdeationAdapter(repo: string, proposal: unknown): Promise<void> {
  const agentPath = path.join(repo, "fake-ideator.mjs");
  await writeFile(
    agentPath,
    [
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (!prompt.includes('Current spec markdown:')) process.exit(12);",
      `  console.log(${JSON.stringify(JSON.stringify(proposal, null, 2))});`,
      "});",
      ""
    ].join("\n")
  );
  await writeProfile(repo, "fake-ideator", {
    tool: "fake-ideator",
    invoke: ["node", "fake-ideator.mjs"],
    prompt_arg: "stdin",
    verified_on: "2026-06-16",
    context_window: 1000,
    routing_tier: "strong",
    cost_rank: 1
  });
}

async function writeProfile(repo: string, tool: string, profile: unknown): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(path.join(adaptersDir, `${tool}.profile.json`), `${JSON.stringify(profile, null, 2)}\n`);
}

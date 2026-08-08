import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadAndValidateContract } from "../src/contract.js";
import { CONTRACT_FORMAT_VERSION, upcastContract } from "../src/contract-version.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/**
 * Contract format versioning.
 *
 * INVARIANT: upgrading Hivemind must not lose in-flight work, and a durable
 * format gaining a required field must not make existing records unreadable --
 * without loosening closed-world validation, which is a real floor against a
 * worker smuggling data through a contract.
 */

const unversionedContract = {
  task_id: "T-OLD",
  title: "Authored before learned routing",
  agent_role: "builder",
  base_commit: "abc123",
  acceptance_criterion: "The old contract fixture still validates.",
  allowed_files: ["src/old.ts"],
  allowed_file_intents: { "src/old.ts": "modify" },
  read_only_files: [],
  forbidden_files: [],
  allowed_symbols: [],
  forbidden_symbols: [],
  must_not_change: [],
  required_tests: ["npm test"],
  patch_requirements: []
};

test("a contract written before routing_task_type existed still loads and runs", async () => {
  await withTempRepo(async (repo) => {
    // Exactly the shape that is permanently unusable today: no contract_version
    // because the field did not exist, and no routing_task_type because it was
    // added later. loadAndValidateContract gates lease, run, worktree, submit,
    // analyze, verification and adoption, so this contract's task is dead.
    await writeContract(repo, "T-OLD", unversionedContract);

    const loaded = await loadAndValidateContract(repo, "T-OLD");

    assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.reason);
    if (!loaded.ok) return;
    assert.equal(loaded.contract.task_id, "T-OLD");
    // "other" is the routing enum's own unclassified member, not an invented
    // value. It cannot spend more or reach a stronger provider: a
    // learned-routing scorecard miss falls back to the deterministic
    // comparison, and a value-quality policy that does not name it DENIES.
    assert.equal(loaded.contract.routing_task_type, "other");
    assert.equal(loaded.contract.contract_version, CONTRACT_FORMAT_VERSION);
  });
});

test("reading an old contract never rewrites it, because adoption re-hashes the file", async () => {
  await withTempRepo(async (repo) => {
    const contractPath = path.join(repo, ".hivemind", "tasks", "T-OLD.contract.json");
    await writeContract(repo, "T-OLD", unversionedContract);
    const before = await readFile(contractPath, "utf8");

    assert.equal((await loadAndValidateContract(repo, "T-OLD")).ok, true);
    assert.equal((await loadAndValidateContract(repo, "T-OLD")).ok, true);

    // verificationInputsStillMatch re-hashes every contract file and adoption
    // gates on it, so a migration that touched these bytes would report
    // "verified-then-stale: contract hash changed" on already-verified work.
    // That is why migration is read-time only.
    assert.equal(await readFile(contractPath, "utf8"), before, "the upcast rewrote the contract");
  });
});

test("a contract from a newer build refuses legibly instead of looking corrupt", async () => {
  await withTempRepo(async (repo) => {
    await writeContract(repo, "T-NEW", {
      ...unversionedContract,
      task_id: "T-NEW",
      routing_task_type: "cli",
      contract_version: CONTRACT_FORMAT_VERSION + 1,
      some_field_this_build_has_never_heard_of: true
    });

    const loaded = await loadAndValidateContract(repo, "T-NEW");

    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.match(loaded.reason, /written by a newer Hivemind \(contract format 2\)/u);
    assert.match(loaded.reason, /reads up to format 1/u);
    assert.match(loaded.reason, /Upgrade Hivemind/u);
    // The whole reason the version is parsed before the schema: the old message
    // named a field and read as corruption, sending a person to look for damage
    // that was not there.
    assert.doesNotMatch(loaded.reason, /unsupported contract field/u);
  });
});

test("closed-world validation still refuses an unknown field at the current version", async () => {
  await withTempRepo(async (repo) => {
    // Versioning must not become a way to smuggle data through a contract.
    await writeContract(repo, "T-SMUGGLE", {
      ...unversionedContract,
      task_id: "T-SMUGGLE",
      routing_task_type: "cli",
      contract_version: CONTRACT_FORMAT_VERSION,
      exfiltrate: "everything"
    });

    const loaded = await loadAndValidateContract(repo, "T-SMUGGLE");

    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.match(loaded.reason, /unsupported contract field: exfiltrate/u);
    }
  });
});

test("the upcast supplies only what is absent, is pure, and refuses what is wrong", () => {
  const supplied = upcastContract(unversionedContract, "fixture");
  assert.equal(supplied.ok, true);
  if (supplied.ok) {
    assert.equal(supplied.value.from_version, 0);
    assert.deepEqual(supplied.value.applied, ["routing_task_type=other"]);
    // Pure and total: the same bytes must always produce the same contract, or
    // a hash-bound artifact could disagree with itself between two reads.
    const again = upcastContract(unversionedContract, "fixture");
    assert.equal(again.ok, true);
    if (again.ok) assert.deepEqual(again.value.contract, supplied.value.contract);
    // The input is not mutated.
    assert.equal("routing_task_type" in unversionedContract, false);
  }

  // Present but not a member is malformed, not old. Overwriting it would
  // discard something somebody actually wrote.
  const wrong = upcastContract({ ...unversionedContract, routing_task_type: "teleportation" }, "fixture");
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.match(wrong.reason, /not a known routing task type/u);
    assert.match(wrong.reason, /not upcast/u);
  }

  const current = upcastContract(
    { ...unversionedContract, contract_version: CONTRACT_FORMAT_VERSION, routing_task_type: "cli" },
    "fixture"
  );
  assert.equal(current.ok, true);
  if (current.ok) {
    assert.deepEqual(current.value.applied, []);
    assert.equal(current.value.from_version, CONTRACT_FORMAT_VERSION);
  }

  for (const bad of [-1, 1.5, "1", null, true]) {
    const invalid = upcastContract({ ...unversionedContract, contract_version: bad }, "fixture");
    assert.equal(invalid.ok, false, `contract_version ${JSON.stringify(bad)} was accepted`);
    if (!invalid.ok) assert.match(invalid.reason, /invalid contract_version/u);
  }
});

test("a newly created contract records the format it was written in", async () => {
  await withTempRepo(async (repo) => {
    await writeContract(repo, "T-STAMP", { ...unversionedContract, task_id: "T-STAMP", routing_task_type: "cli" });
    const loaded = await loadAndValidateContract(repo, "T-STAMP");
    assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.reason);
    if (loaded.ok) {
      // normalizeContract stamps it, so anything this build writes back out
      // says what format it is rather than leaving the next reader to guess.
      assert.equal(loaded.contract.contract_version, CONTRACT_FORMAT_VERSION);
    }
  });
});

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "contract-version",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-contract-version-test-"
  );
}

async function writeContract(repo: string, taskId: string, contract: unknown): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, `${taskId}.contract.json`), `${JSON.stringify(contract, null, 2)}\n`);
}

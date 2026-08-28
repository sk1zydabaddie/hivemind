import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkFormatVersion, formatVersions } from "../src/format-version.js";
import { loadVerificationSet } from "../src/verification-set.js";

/**
 * The version gate, and the one rule immutable evidence depends on.
 *
 * INVARIANT: upgrading must not lose in-flight work, a format gaining a field
 * must not make existing records unreadable, and migration must not change the
 * bytes of any record another record's hash is bound to.
 */

test("the gate refuses a newer record with the format, the limit, and the fix", () => {
  const refused = checkFormatVersion({ version: 3 }, formatVersions.config, ".hivemind/config.json");

  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.reason, /\.hivemind\/config\.json/u);
  assert.match(refused.reason, /newer Hivemind \(config format 3\)/u);
  assert.match(refused.reason, /reads up to format 1/u);
  assert.match(refused.reason, /Upgrade Hivemind/u);
  // Nothing was rewritten, so downgrading is still possible. Saying so stops a
  // person hunting for a backup that was never needed.
  assert.match(refused.reason, /has not been changed/u);
});

test("absence is refused for a format that has always stamped its version", () => {
  // Only task contracts have a real pre-versioning era. For everything else an
  // absent version is damage, not age, and reading it as version 0 would invent
  // an era that never existed.
  for (const [name, gate] of Object.entries(formatVersions)) {
    assert.equal(gate.whenAbsent, "refuse", `${name} claims a pre-versioning era`);
    const refused = checkFormatVersion({}, gate, "fixture");
    assert.equal(refused.ok, false, `${name} accepted a record with no version`);
    if (!refused.ok) {
      assert.match(refused.reason, /declares no .* version/u);
    }
  }
});

test("the gate refuses a malformed version rather than coercing it", () => {
  for (const bad of [-1, 1.5, "1", null, true, {}]) {
    const refused = checkFormatVersion({ version: bad }, formatVersions.spec, "fixture");
    assert.equal(refused.ok, false, `version ${JSON.stringify(bad)} was accepted`);
    if (!refused.ok) assert.match(refused.reason, /invalid spec version/u);
  }
  assert.equal(checkFormatVersion(null, formatVersions.spec, "fixture").ok, false);
  assert.equal(checkFormatVersion([], formatVersions.spec, "fixture").ok, false);
});

test("a current record passes the gate untouched", () => {
  const passed = checkFormatVersion({ version: 1, anything: "else" }, formatVersions.spec, "fixture");
  assert.equal(passed.ok, true);
  if (passed.ok) assert.equal(passed.version, 1);
});

test("every durable format is gated, and the ephemeral ones are deliberately absent", () => {
  // The finding was twenty-one inert copies of `version !== 1`. This is the
  // list that stops a new format quietly skipping the gate.
  for (const [name, gate] of Object.entries(formatVersions)) {
    assert.equal(typeof gate.format, "string", `${name} has no human-readable format name`);
    assert.notEqual(gate.format.trim(), "", `${name} has an empty format name`);
    assert.equal(gate.current, name === "daemonState" ? 2 : 1);
  }
  assert.deepEqual(
    Object.entries(formatVersions)
      .filter(([, gate]) => gate.current > 1)
      .map(([name, gate]) => [name, gate.current]),
    [["daemonState", 2]],
    "every durable-format migration must be named and reviewed here"
  );
  // An unparseable lease lock is already reaped as stale, and an owner record
  // that does not match already means "not mine". Both fail closed in the
  // right direction without a version, so gating them is ceremony.
  assert.equal("leaseLock" in formatVersions, false);
  assert.equal("projectTempOwner" in formatVersions, false);
});

/**
 * Immutable evidence.
 *
 * A verification manifest is written once, hashed, and referenced by adoption.
 * It can never be rewritten, so migration for it is read-time upcasting only --
 * and that only stays sound while the hash is taken over the bytes on disk.
 */
test("a manifest hash is a property of the FILE, never of the parsed object", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-manifest-hash-"));
  try {
    const verificationId = "V-00000000-0000-4000-8000-000000000000";
    const manifest = {
      version: 1,
      verification_id: verificationId,
      created_at: "2026-08-08T00:00:00.000Z",
      base_branch: "main",
      base_commit: "a".repeat(40),
      task_ids: ["T-001"],
      inputs: [
        {
          task_id: "T-001",
          contract_path: ".hivemind/tasks/T-001.contract.json",
          contract_sha256: "b".repeat(64),
          patch_path: ".hivemind/patches/T-001/diff.patch",
          patch_sha256: "c".repeat(64)
        }
      ],
      changed_files: ["src/a.ts"],
      result_tree: "d".repeat(40),
      config_path: ".hivemind/config.json",
      config_sha256: "e".repeat(64),
      verification: { audit: {}, checks: {}, runtime_coverage: {}, tests: "pass" },
      oracle: {
        coverage_configured: true,
        binding: false,
        task_tier: "medium",
        status: "strong",
        decision: "proceed",
        diagnostic: "fixture",
        uncovered_changed_lines: [],
        uncovered_impact_files: [],
        unknown_files: [],
        unknown_reasons: [],
        recommendation: null,
        automatic_generation_launched: false
      }
    };

    // Written with formatting that a re-serialization would NOT reproduce:
    // four-space indent and a trailing newline. Semantically identical, byte
    // for byte different.
    const onDisk = `${JSON.stringify(manifest, null, 4)}\n`;
    const dir = path.join(repo, ".hivemind", "resource", "verification-sets", verificationId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), onDisk, "utf8");

    const loaded = await loadVerificationSet(repo, verificationId);

    assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.reason);
    if (!loaded.ok) return;

    const fileHash = createHash("sha256").update(Buffer.from(onDisk, "utf8")).digest("hex");
    const reserializedHash = createHash("sha256")
      .update(Buffer.from(JSON.stringify(loaded.value.manifest), "utf8"))
      .digest("hex");

    assert.equal(loaded.value.manifest_sha256, fileHash, "the hash was not taken over the file bytes");
    assert.notEqual(fileHash, reserializedHash, "the fixture failed to make the two differ");
    assert.notEqual(
      loaded.value.manifest_sha256,
      reserializedHash,
      "the hash was re-derived from the parsed object; adoption binds to this value and an upcast shape would not round-trip"
    );
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a verification manifest from a newer build refuses legibly, not as malformed", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-manifest-version-"));
  try {
    const verificationId = "V-00000000-0000-4000-8000-000000000001";
    const dir = path.join(repo, ".hivemind", "resource", "verification-sets", verificationId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ version: 2, verification_id: verificationId }, null, 2)}\n`,
      "utf8"
    );

    const loaded = await loadVerificationSet(repo, verificationId);

    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.match(loaded.reason, /newer Hivemind \(verification-set manifest format 2\)/u);
    // "malformed" would send someone looking for corruption in an immutable
    // artifact that is perfectly intact.
    assert.doesNotMatch(loaded.reason, /malformed/u);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
});

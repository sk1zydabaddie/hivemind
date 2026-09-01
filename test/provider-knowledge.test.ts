import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  compareAdapterVersion,
  normalizeVersionOutput,
  versionInvocation
} from "../src/adapter-version.js";
import { readModelAttribution } from "../src/adapter-probe.js";
import { agentCatalogue } from "../src/agent-catalogue.js";
import { capabilityDefinition } from "../src/capability-contract.js";
import { compareRepoMarks, type RepoMark } from "../src/repo-observation.js";

/**
 * A harness over five harnesses, none of which are the same and all of which
 * ship weekly. The thing that keeps that survivable is that provider-specific
 * knowledge lives in a countable number of places -- and the only way that
 * stays true is if a fourth place fails a test rather than passing review.
 */

/* Resolved from the working directory, like every other source-reading test
   here -- the suite runs the compiled output, so a path relative to the test
   file would find `dist/src` and scan the build instead of the source. */
const SRC = path.resolve("src");

/** The three files allowed to know a provider by name, and what each holds. */
const PROVIDER_KNOWLEDGE = new Map([
  ["agent-catalogue.ts", "how to start it"],
  ["adapter.ts", "how to read what it spent"],
  ["adapter-probe.ts", "how to read what it resolved"]
]);

/* Files that legitimately mention a provider without branching on one:
   defaults copied from the catalogue, the local-profile writer, and the
   corpus, which names the harness it certifies against. Listed explicitly so
   adding a fourth is a decision somebody makes on purpose. */
const NAMED_BUT_NOT_BRANCHING = new Set([
  "project-defaults.ts",
  "local-adapters.ts",
  "capability-corpus.ts",
  "capability-corpus-evidence.ts"
]);

const PROVIDER_NAMES = [/\bcodex\b/iu, /\bclaude[-_ ]?code\b/iu, /\bopencode\b/iu, /\bgrok\b/iu];

test("only three files may know a provider by name", async () => {
  const entries = await readdir(SRC);
  const offenders: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    if (PROVIDER_KNOWLEDGE.has(entry) || NAMED_BUT_NOT_BRANCHING.has(entry)) continue;
    const source = await readFile(path.join(SRC, entry), "utf8");
    /* Comments are allowed to explain a provider; code may not branch on one.
       Stripping them is what makes this a rule about behaviour rather than a
       ban on writing down why something is the way it is. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    if (PROVIDER_NAMES.some((pattern) => pattern.test(code))) offenders.push(entry);
  }

  assert.deepEqual(
    offenders,
    [],
    "a fourth place now knows a provider by name; put it in one of the three or say why here"
  );
});

test("every catalogue entry says how its shell is denied and how that is confirmed", () => {
  for (const agent of agentCatalogue) {
    assert.ok(agent.shell_denial, `${agent.id} has no shell posture`);
    assert.ok(
      agent.shell_denial.detail.length > 60,
      `${agent.id} does not say what its shell posture actually is`
    );
    /* The whole point of the field: a denial nobody has confirmed is not a
       denial. Recording HOW it is confirmed is what stops "we passed the flag"
       being mistaken for "the flag took effect". */
    assert.ok(
      ["runtime-readback", "resolved-config", "behavioural-canary", "unconfirmed"].includes(
        agent.shell_denial.confirmed_by
      ),
      `${agent.id} has an unknown confirmation class`
    );
    if (agent.shell_denial.confirmed_by === "unconfirmed") {
      assert.notEqual(
        agent.status,
        "supported",
        `${agent.id} is supported with an unconfirmed shell denial`
      );
    }
  }
});

test("an agent that is not supported says specifically what is missing", () => {
  for (const agent of agentCatalogue) {
    if (agent.status === "supported") {
      assert.equal(agent.caveat, null);
      continue;
    }
    assert.ok(agent.caveat !== null && agent.caveat.length > 80, `${agent.id} has no real reason`);
    /* Refused reads as the contract working only if the reason is specific
       enough to re-check when the provider changes. */
    assert.ok(
      /because|its own|cannot|not a boundary|unknown|never/iu.test(agent.caveat),
      `${agent.id}'s caveat does not say why`
    );
  }
});

test("an agent with no invocation cannot be connected", () => {
  for (const agent of agentCatalogue) {
    if (agent.invoke !== null) continue;
    assert.notEqual(agent.status, "supported", `${agent.id} is supported with no way to start it`);
  }
});

/* ── Version staleness ───────────────────────────────────────────────────── */

test("the version invocation is derived from the argv that actually runs", () => {
  assert.deepEqual(versionInvocation(["codex", "exec", "--json", "-"]), ["codex", "--version"]);
  /* Windows runs through cmd.exe, and asking cmd.exe its version would answer
     the wrong question. */
  assert.deepEqual(
    versionInvocation(["cmd.exe", "/d", "/s", "/c", "claude.cmd", "-p", "--verbose"]),
    ["cmd.exe", "/d", "/s", "/c", "claude.cmd", "--version"]
  );
  assert.equal(versionInvocation([]), null);
  assert.equal(versionInvocation(["cmd.exe", "/d", "/s"]), null);
});

test("a version is the line the harness prints, not a parsed number", () => {
  /* These five print five different things. Any parser would be a fourth place
     provider knowledge lives, and a harness that changes how it prints reads
     as an update -- which is the safe way to be wrong. */
  assert.equal(normalizeVersionOutput("codex-cli 0.147.0\n"), "codex-cli 0.147.0");
  assert.equal(normalizeVersionOutput("2.1.229 (Claude Code)"), "2.1.229 (Claude Code)");
  assert.equal(normalizeVersionOutput("\n\n1.18.15\n"), "1.18.15");
  assert.equal(normalizeVersionOutput("   \n  "), null);
});

test("an updated harness is stale, not invalid, and says how to fix it", () => {
  const stale = compareAdapterVersion("2.1.229 (Claude Code)", "2.1.240 (Claude Code)");
  assert.equal(stale.standing, "stale");
  assert.match(stale.detail, /updated since Hivemind checked it/u);
  assert.match(stale.detail, /Reconnect/u);

  assert.equal(compareAdapterVersion("codex-cli 0.147.0", "codex-cli 0.147.0").standing, "current");
  /* Silence is not reassurance, in either direction. */
  assert.equal(compareAdapterVersion("codex-cli 0.147.0", null).standing, "unknown");
  assert.equal(compareAdapterVersion(null, "codex-cli 0.147.0").standing, "unknown");
});

/* ── The measured commit check ───────────────────────────────────────────── */

function mark(head: string | null, ref: string | null): RepoMark {
  return { head, ref, unreadable: head === null && ref === null };
}

test("an unchanged branch settles the claim, and a moved one refuses it", () => {
  const same = mark("abc123", "refs/heads/master");
  assert.equal(compareRepoMarks(same, same).standing, "unchanged");

  const committed = compareRepoMarks(same, mark("def456", "refs/heads/master"));
  assert.equal(committed.standing, "moved");
  assert.match(committed.detail, /committed its work/u);

  /* A checkout and a commit are different accidents and a person can act on
     them differently, so they do not share a sentence. */
  const switched = compareRepoMarks(same, mark("abc123", "refs/heads/other"));
  assert.equal(switched.standing, "moved");
  assert.match(switched.detail, /different branch/u);
});

test("a repository that could not be read claims nothing", () => {
  const unreadable = mark(null, null);
  const observation = compareRepoMarks(mark("abc123", "refs/heads/master"), unreadable);
  assert.equal(observation.standing, "unknown");
  assert.match(observation.detail, /could not read/u);
});

/* ── The capability split, and the question it stops nobody asking ───────── */

test("a provider that reports one total is flagged, not silently passed", () => {
  /* Split out from "reports what it spent" after a Claude Code probe pinned to
     one model reported a SECOND model in its own breakdown. Codex reports one
     total and no breakdown, so before this capability existed the question was
     never asked of it -- and the answer is not "fine", it is "unknown". */
  assert.equal(readModelAttribution("codex-jsonl", CODEX_STDOUT), null);
  assert.equal(readModelAttribution("codex-text", "tokens used\n1,234\n"), null);
  assert.equal(readModelAttribution("opencode-json", OPENCODE_STDOUT), null);
});

test("a per-model breakdown names every model that actually ran", () => {
  const models = readModelAttribution("claude-json", CLAUDE_STDOUT);
  assert.notEqual(models, null);
  assert.deepEqual(
    models!.map((entry) => entry.model).sort(),
    ["claude-haiku-4-5-20251001", "claude-sonnet-5"]
  );
  /* The measurement this exists for: the pin took AND a second model ran. */
  assert.equal(models!.length > 1, true);
});

test("an unreadable breakdown costs prediction and provenance, never the ceiling", () => {
  /* A total counts every model whether or not it names them, so the spending
     limit is unaffected. Saying otherwise would be inventing a risk. */
  const attribution = capabilityDefinition("reports_model_attribution");
  for (const state of ["unverified", "unsupported"] as const) {
    const admission = attribution.admission[state];
    assert.equal(admission.decision, "admit", `${state} must not refuse`);
    assert.deepEqual(admission.degrades.sort(), ["cost_prediction", "routing_provenance"]);
    assert.equal(admission.degrades.includes("spend_ceilings" as never), false);
  }
  /* And it says so in words a person can act on, without a number that would
     imply a precision nobody has. */
  assert.match(attribution.admission.unverified.consequence, /limits are unaffected/u);
  assert.match(attribution.admission.unsupported.consequence, /wrong by an amount nobody can measure/u);
});

const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"abc"}',
  '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":80}}'
].join("\n");

const OPENCODE_STDOUT = JSON.stringify({
  type: "step_finish",
  part: { type: "step-finish", tokens: { total: 6075, input: 5754, output: 117 } }
});

const CLAUDE_STDOUT = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["Read"] }),
  JSON.stringify({
    type: "result",
    usage: { input_tokens: 4, output_tokens: 167 },
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 4, outputTokens: 167 },
      "claude-haiku-4-5-20251001": { inputTokens: 541, outputTokens: 14 }
    }
  })
].join("\n");

# M7.6e Real-Provider Characterization Demonstration

Date: 2026-07-29 (America/Los_Angeles)

## Scope

One real Codex provider call generated a characterization-test candidate for an isolated task with a measured uncovered changed line. The candidate was then passed to the same M7.6c `validateCharacterizationCandidate()` disposer used by the product path. No alternate validator was used.

Fixture repository:

`C:\Users\ethan\AppData\Local\Temp\hivemind-m7-6e-demo-20260729`

Base commit:

`d53294b31b172ced099f01ce10e2c5959e1e2672`

Task:

`T-001 - Refactor negative quantity normalization without changing behavior`

## Adapter Startup

The repository's root Codex profile was not used because it contains dangerous bypass and ignore flags. The demonstration used this isolated profile invocation:

```json
[
  "cmd.exe",
  "/d",
  "/s",
  "/c",
  "codex.cmd",
  "exec",
  "--model",
  "gpt-5.5",
  "--sandbox",
  "workspace-write",
  "-c",
  "approval_policy=\"never\"",
  "--ephemeral",
  "-"
]
```

It contains no `--dangerously-bypass-approvals-and-sandbox`, `--ignore-user-config`, or `--ignore-rules` flag.

An initial free startup attempt placed `--ask-for-approval never` after `exec`. Codex rejected that unsupported placement in 1.3 seconds with exit code 2 before reaching the model:

```text
error: unexpected argument '--ask-for-approval' found
```

The corrected invocation above was syntax-checked with `--help` before the paid call. During the real call, Codex reported:

```text
OpenAI Codex v0.145.0
workdir: C:\Users\ethan\AppData\Local\Temp\hivemind-checkout-KES5bL\checkout
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: high
```

## Real Uncovered Gap

The task patch under evaluation was:

```diff
diff --git a/src/quantity.js b/src/quantity.js
index 1d9e3e9..3a36beb 100644
--- a/src/quantity.js
+++ b/src/quantity.js
@@ -3,7 +3,7 @@ export function normalizeQuantity(value) {
     throw new TypeError("quantity must be an integer");
   }
   if (value < 0) {
-    return 0;
+    return Math.max(0, value);
   }
   return value;
 }
```

The configured coverage command ran the existing positive-only Node test under V8 coverage, emitted LCOV, and M7.6b bound the report to applied tree `f0ba5b66f4a6cd63e078c0cd94c79140d67006ca`. The task-bound durable measurement was:

```json
{
  "kind": "runtime_changed_line",
  "status": "weak",
  "advisory_only": true,
  "coordinate_space": "post_patch_applied_tree",
  "configured": true,
  "command": "node scripts/coverage.mjs",
  "report_path": ".coverage/lcov.info",
  "report_hash": "ab65741b8282e52bb877b159773eaa99b3ff16a435381a823540cefa5397d706",
  "applied_tree": "f0ba5b66f4a6cd63e078c0cd94c79140d67006ca",
  "executable_changed_lines": 1,
  "hit_changed_lines": 0,
  "ratio": 0,
  "covered_lines": [],
  "uncovered_lines": [
    {
      "file": "src/quantity.js",
      "line": 6,
      "hits": 0
    }
  ],
  "unknown_files": [],
  "unknown_reasons": [],
  "command_result": {
    "id": "coverage",
    "command": "node scripts/coverage.mjs",
    "exit_code": 0
  }
}
```

## Generated Candidate Patch

Verbatim immutable artifact:

`.hivemind/resource/oracle-candidates/C-T-001-78eb9f6d-f873-436d-8cce-93a48c635c48/candidate.patch`

```diff
diff --git a/test/quantity.test.js b/test/quantity.test.js
index d603f07..600d0b1 100644
--- a/test/quantity.test.js
+++ b/test/quantity.test.js
@@ -5,3 +5,9 @@ import { normalizeQuantity } from "../src/quantity.js";
 test("preserves a positive integer", () => {
   assert.equal(normalizeQuantity(4), 4);
 });
+
+test("normalizes negative integers to zero", () => {
+  for (const value of [-1, -42, Number.MIN_SAFE_INTEGER]) {
+    assert.equal(normalizeQuantity(value), 0);
+  }
+});
```

## M7.6c Disposition

Verbatim `validation.json`:

```json
{
  "version": 1,
  "candidate_id": "C-T-001-78eb9f6d-f873-436d-8cce-93a48c635c48",
  "task_id": "T-001",
  "classification": "valid_characterization",
  "reason": "candidate passes on both the pre-change base and post-change tree",
  "advisory_only": true,
  "semantic_interpretation": "A post-change failure is a behavior-flip signal. It may be a regression or an intended behavior change; only a human decides.",
  "base_commit": "d53294b31b172ced099f01ce10e2c5959e1e2672",
  "task_patch_sha256": "a135e2f94c3e036a059c155931b1a9fdfd5055103c18e5304b7b2543f8aae357",
  "candidate_patch_sha256": "bbc1c403d0f491fef17d733f398b5a1f5ccbf81f438d1380c536c3d029d634df",
  "test_scope_source": "verification.test_paths",
  "configured_test_paths": [
    "test/**/*.test.js"
  ],
  "gate": {
    "verdict": "accept",
    "reason": "all changes are within scope"
  },
  "check_id": "quantity-tests",
  "check_command": "node --test",
  "same_check_both_trees": true,
  "attempts": [
    {
      "tree": "base_with_candidate",
      "check_id": "quantity-tests",
      "command": "node --test",
      "runs": [
        {
          "id": "quantity-tests",
          "command": "node --test",
          "exit_code": 0,
          "stdout": "TAP version 13\n# Subtest: preserves a positive integer\nok 1 - preserves a positive integer\n  ---\n  duration_ms: 0.7528\n  type: 'test'\n  ...\n# Subtest: normalizes negative integers to zero\nok 2 - normalizes negative integers to zero\n  ---\n  duration_ms: 0.1312\n  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 80.6426\n",
          "stderr": ""
        },
        {
          "id": "quantity-tests",
          "command": "node --test",
          "exit_code": 0,
          "stdout": "TAP version 13\n# Subtest: preserves a positive integer\nok 1 - preserves a positive integer\n  ---\n  duration_ms: 0.7325\n  type: 'test'\n  ...\n# Subtest: normalizes negative integers to zero\nok 2 - normalizes negative integers to zero\n  ---\n  duration_ms: 0.1241\n  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 79.9805\n",
          "stderr": ""
        }
      ],
      "identity_before": {
        "head_commit": "d53294b31b172ced099f01ce10e2c5959e1e2672",
        "index_tree": "5261ee4ae0d75ffe10f5f52e58e8d6e32003ce43",
        "status_hash": "bfb5317f11ceab3433f62a8dc881b9089023607f1dcd48b304066032f75667e0",
        "worktree_content_hash": "bbc1c403d0f491fef17d733f398b5a1f5ccbf81f438d1380c536c3d029d634df"
      },
      "identity_after": {
        "head_commit": "d53294b31b172ced099f01ce10e2c5959e1e2672",
        "index_tree": "5261ee4ae0d75ffe10f5f52e58e8d6e32003ce43",
        "status_hash": "bfb5317f11ceab3433f62a8dc881b9089023607f1dcd48b304066032f75667e0",
        "worktree_content_hash": "bbc1c403d0f491fef17d733f398b5a1f5ccbf81f438d1380c536c3d029d634df"
      }
    },
    {
      "tree": "post_change_with_candidate",
      "check_id": "quantity-tests",
      "command": "node --test",
      "runs": [
        {
          "id": "quantity-tests",
          "command": "node --test",
          "exit_code": 0,
          "stdout": "TAP version 13\n# Subtest: preserves a positive integer\nok 1 - preserves a positive integer\n  ---\n  duration_ms: 0.9037\n  type: 'test'\n  ...\n# Subtest: normalizes negative integers to zero\nok 2 - normalizes negative integers to zero\n  ---\n  duration_ms: 0.1241\n  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 81.3096\n",
          "stderr": ""
        },
        {
          "id": "quantity-tests",
          "command": "node --test",
          "exit_code": 0,
          "stdout": "TAP version 13\n# Subtest: preserves a positive integer\nok 1 - preserves a positive integer\n  ---\n  duration_ms: 0.7403\n  type: 'test'\n  ...\n# Subtest: normalizes negative integers to zero\nok 2 - normalizes negative integers to zero\n  ---\n  duration_ms: 0.1251\n  type: 'test'\n  ...\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 82.6475\n",
          "stderr": ""
        }
      ],
      "identity_before": {
        "head_commit": "d53294b31b172ced099f01ce10e2c5959e1e2672",
        "index_tree": "405f9799402c240928cbc1c96ea08e0ac6e8a7b6",
        "status_hash": "4d3067f6f10bd12ce8f93bd289c06e2e45f99317e5e0d257a9904ea40c0d5b69",
        "worktree_content_hash": "ab51230dc9079dae2485cdff42d4552f684b58dfd1b83be2d3e2f8b038bb51f9"
      },
      "identity_after": {
        "head_commit": "d53294b31b172ced099f01ce10e2c5959e1e2672",
        "index_tree": "405f9799402c240928cbc1c96ea08e0ac6e8a7b6",
        "status_hash": "4d3067f6f10bd12ce8f93bd289c06e2e45f99317e5e0d257a9904ea40c0d5b69",
        "worktree_content_hash": "ab51230dc9079dae2485cdff42d4552f684b58dfd1b83be2d3e2f8b038bb51f9"
      }
    }
  ]
}
```

The same named check, `quantity-tests -> node --test`, ran twice on each identity-verified disposable tree. Every run exited 0 with two passing tests.

## Protected-State Check

The generator and validator left the fixture repository, source, existing test, task worktree sentinel, and canon sentinel unchanged:

| Path | Before SHA-256 | After SHA-256 |
| --- | --- | --- |
| `src/quantity.js` | `DC20B4E21A0A935E91B174C0CA51FF939962FC21FD173A09A0D5C26B07572F73` | `DC20B4E21A0A935E91B174C0CA51FF939962FC21FD173A09A0D5C26B07572F73` |
| `test/quantity.test.js` | `77FB7DD9E4B9E07C22A554FD8C36BA32CB290C44CF4D6EBDE3CA59D82084B59E` | `77FB7DD9E4B9E07C22A554FD8C36BA32CB290C44CF4D6EBDE3CA59D82084B59E` |
| `.hivemind/worktrees/T-001/sentinel.txt` | `A8B8728A835CA01026E94586F3715A2F888DD4A201C3195B639A5B0C13828E18` | `A8B8728A835CA01026E94586F3715A2F888DD4A201C3195B639A5B0C13828E18` |
| `.hivemind/canon/sentinel.json` | `A1CDA99AB712D39DD3EC7DD9673CE5FA5D5E96C52735952EFAE890CB58CD04E3` | `A1CDA99AB712D39DD3EC7DD9673CE5FA5D5E96C52735952EFAE890CB58CD04E3` |

The fixture's tracked Git status was clean after validation. It had only branch `main` and only the main checkout. The generated content existed only in the immutable candidate directory:

```text
candidate.patch  485 bytes
manifest.json    587 bytes
validation.json  4978 bytes
```

## Metered Spend

The paid adapter call wall time was `147,687 ms`.

Provider-reported usage for the one model call:

```json
{
  "reports": 1,
  "total_tokens": 38645,
  "accounting_source": "provider_reported"
}
```

The provider's text output exposed only aggregate tokens, so input, cached input, output, and reasoning fields are `null`.

The startup parse failure did not reach the provider and has no provider usage report, but the ledger conservatively records it as a separate self-measured adapter attempt. Consequently, the characterization session contains:

```json
{
  "session_id": "characterization-T-001",
  "adapter_attempts": 2,
  "provider_reported_calls": 1,
  "provider_reported_tokens": 38645,
  "self_measured_tokens": 2579,
  "effective_tokens": 39880,
  "session_ceiling_tokens": 500000,
  "run_ceiling_tokens": 150000
}
```

For the paid request itself, Hivemind estimated `1,344` tokens while Codex reported `38,645`, an absolute divergence of `37,301` tokens and a provider/self ratio of `28.753720238095237`. The ledger used the provider-reported total for accounting.

## Repository Validation

After the human removed the temporary demo setup script, the Hivemind TypeScript build passed:

```text
npm run build
> tsc -p tsconfig.json
exit 0
```

The complete repository suite also passed:

```text
npm test
tests 373
pass 373
fail 0
```

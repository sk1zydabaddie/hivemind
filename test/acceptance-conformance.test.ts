import assert from "node:assert/strict";
import test from "node:test";

import { observableInterfaceKind, observableValidityCheckProblem } from "../src/acceptance-conformance.js";

test("observable-interface detection stays narrow and mechanically checkable", () => {
  assert.equal(observableInterfaceKind("The CLI accepts --input <path>."), "named CLI flag");
  assert.equal(observableInterfaceKind("The command supports a positional path argument and emits sorted stdout."), "CLI argument or output contract");
  assert.equal(observableInterfaceKind("Exported function signature is parse(input: string): Record."), "exported signature");
  assert.equal(observableInterfaceKind("The response output shape matches the documented schema."), "output shape");
  assert.equal(observableInterfaceKind("The JSON file format preserves every record."), "file format");
  assert.equal(observableInterfaceKind("The documentation explains the workflow clearly to a new maintainer."), null);
});

test("observable validity checks cannot reuse worker tests or unconditionally pass", () => {
  assert.equal(observableValidityCheckProblem("npm test", ["npm test"]), "deterministic_validity_check must be independent of required_tests");
  assert.equal(observableValidityCheckProblem("exit 0", ["npm test"]), "deterministic_validity_check is an unconditional pass");
  assert.equal(observableValidityCheckProblem("node verify-interface.mjs", ["npm test"]), null);
});

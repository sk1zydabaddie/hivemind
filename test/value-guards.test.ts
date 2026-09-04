import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../src/json.js";
import { isNodeError } from "../src/error-detail.js";

test("shared record guard retains structural rather than plain-object semantics", () => {
  for (const value of [null, undefined, true, 1, NaN, 1n, "text", Symbol("x"), [], () => 0]) {
    assert.equal(isRecord(value), false);
  }
  for (const value of [{}, Object.create(null), new Date(0), new Error("x"), new Map(), new Uint8Array(1)]) {
    assert.equal(isRecord(value), true);
  }
});

test("shared error guard keeps strict code comparison and inherited properties", () => {
  for (const value of [null, undefined, "ENOENT", 0, {}, { code: 0 }, { code: "EACCES" }, () => "ENOENT"]) {
    assert.equal(isNodeError(value, "ENOENT"), false);
  }
  for (const value of [{ code: "ENOENT" }, Object.create({ code: "ENOENT" }), Object.assign(new Error("x"), { code: "ENOENT" })]) {
    assert.equal(isNodeError(value, "ENOENT"), true);
  }
  assert.equal(isNodeError({ code: "" }, ""), true);
});

test("shared guards preserve property access and exceptions rather than swallowing them", () => {
  let reads = 0;
  const value = { get code() { reads += 1; return "ENOENT"; } };
  assert.equal(isRecord(value), true);
  assert.equal(reads, 0);
  assert.equal(isNodeError(value, "ENOENT"), true);
  assert.equal(reads, 1);
  const failure = new Error("property unavailable");
  assert.throws(() => isNodeError({ get code() { throw failure; } }, "ENOENT"), (error) => error === failure);
});

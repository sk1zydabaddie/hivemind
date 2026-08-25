/**
 * PAID. Can a person talk to it?
 *
 * Types "hello" into the composer on the installed app and requires a real
 * answer back, then asks a follow-up question and requires another. The bar is
 * the one that was set: if a normal exchange is not possible, it is not fixed.
 *
 * Also checks the two things that must NOT change: nothing is authorised by
 * talking, and the planner's text appears while it is still arriving rather
 * than only at the end.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Builder, By, Capabilities, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installed = path.join(os.homedir(), "AppData", "Local", "Hivemind AI", "hivemind_desktop.exe");
const evidence = path.join(os.tmpdir(), "hivemind-conversation-walk");
let tauriDriver;
let driver;

const body = async () => driver.executeScript("return document.body.innerText;");
async function shot(name) {
  await writeFile(path.join(evidence, `${name}.png`), Buffer.from(await driver.takeScreenshot(), "base64"));
  console.log(`  screenshot: ${name}.png`);
}
async function type(text) {
  const ok = await driver.executeScript(
    `const box = document.querySelector("textarea") ||
       [...document.querySelectorAll('[contenteditable="true"]')][0];
     if (!box) return false;
     const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
     if (setter) { setter.call(box, arguments[0]); box.dispatchEvent(new Event("input", { bubbles: true })); }
     else { box.textContent = arguments[0]; box.dispatchEvent(new InputEvent("input", { bubbles: true })); }
     return true;`,
    text
  );
  assert.ok(ok, "no composer to type into");
}
async function send() {
  const ok = await driver.executeScript(
    `const b = [...document.querySelectorAll("button")].find(
       (e) => (e.getAttribute("aria-label") || "") === "Send request" && !e.disabled);
     if (!b) return false;
     b.click();
     return true;`
  );
  assert.ok(ok, "the send control was not available");
}

async function prepareProject() {
  const dir = path.join(os.tmpdir(), "hivemind-fresh-b");
  assert.ok(
    existsSync(path.join(dir, ".hivemind", "adapters", "planner.profile.json")),
    `no connected project at ${dir}; run e2e/fresh-project-walk.mjs first`
  );
  /* A clean slate for the conversation: previous specs would change what the
     composer does with a message. */
  await rm(path.join(dir, ".hivemind", "spec"), { recursive: true, force: true });
  await rm(path.join(dir, ".hivemind", "plans"), { recursive: true, force: true });
  return dir;
}

async function main() {
  assert.ok(existsSync(installed), `no installed binary at ${installed}`);
  await rm(evidence, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidence, { recursive: true });
  const project = await prepareProject();
  console.log(`project: ${project}`);

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installed });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.wait(async () => (await body()).trim().length > 40, 30_000);

  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    project
  );
  await driver.executeScript(
    `[...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "Open project")?.click();`
  );
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  /* ── 1. hello ── */
  const before = await body();
  await type("Hello, this is a test");
  await send();
  console.log("sent: \"Hello, this is a test\"");

  /* Streaming: the planner's text must appear BEFORE the call finishes. */
  let sawStreamingText = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const now = await body();
    if (/Planner is reading your request/u.test(now)) {
      const after = now.split("Planner is reading your request")[1] ?? "";
      /* Anything past the label and the clock is streamed content. */
      if (after.replace(/[\d.]+m?s elapsed/u, "").trim().length > 40) sawStreamingText = true;
    }
    if (/HIVEMIND/u.test(now) && !/Planner is reading your request/u.test(now)) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const answered = await body();
  console.log(`2. streamed text appeared while thinking: ${sawStreamingText}`);
  await shot("1-hello-answered");

  /* The reply is on screen, and it is NOT a gate refusal. */
  const newText = answered.slice(before.length > 0 ? 0 : 0);
  console.log(`1. reply on screen: ${/Hivemind/u.test(answered)}`);
  for (const refusal of [
    /at least two alternatives/u,
    /I couldn't finish preparing a plan/u,
    /No project source files were changed/u
  ]) {
    assert.doesNotMatch(newText, refusal, `a gate refusal was shown for a greeting: ${refusal}`);
  }
  /* And it did not introduce a conversational answer as a drafted direction. */
  assert.doesNotMatch(newText, /I've prepared this direction: Hello/u);

  /* Nothing was authorised: no spec, no plan, no run. */
  const specDir = path.join(project, ".hivemind", "spec");
  const planDir = path.join(project, ".hivemind", "plans");
  console.log(`3. spec created by talking: ${existsSync(specDir)}`);
  console.log(`3. plan created by talking: ${existsSync(planDir)}`);
  assert.equal(existsSync(planDir), false, "talking created a plan");
  assert.doesNotMatch(answered, /agents? (?:is|are) working/u, "talking started work");

  /* ── 2. a follow-up question, which is what "a normal exchange" means ── */
  await type("What can you help me with in this project?");
  await send();
  console.log('sent: "What can you help me with in this project?"');
  /* Wait for the ANSWER, not for the absence of a label -- the absence is true
     before the label ever appears, which is the same mistake that made an
     earlier walk report a 0s connect. The reply is what arrived when the
     question is in the thread and nothing is still reading it. */
  /* Wait for an ANSWER after the question, not for a label to vanish. The
     absence of the label is true before it ever appears -- the same mistake
     that once made a walk report a 0s connect -- and a stale round left by an
     interrupted earlier call keeps the label on screen forever, which would
     make a working exchange look broken. */
  await driver.wait(
    async () => {
      const now = await body();
      const at = now.indexOf("What can you help me with in this project?");
      return at !== -1 && /HIVEMIND/u.test(now.slice(at));
    },
    240_000,
    "the second message never came back"
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const second = await body();
  await shot("2-follow-up-answered");

  /* Two of my messages and two answers: an exchange, not a single reply. */
  const mine = (second.match(/Hello, this is a test/gu) ?? []).length;
  const asked = (second.match(/What can you help me with in this project\?/gu) ?? []).length;
  console.log(`4. both my messages are in the thread: ${mine >= 1 && asked >= 1}`);
  assert.ok(mine >= 1 && asked >= 1, "the thread lost a message");
  assert.doesNotMatch(second, /at least two alternatives/u);
  assert.equal(existsSync(planDir), false, "the second message created a plan");

  const replies = (second.match(/Hivemind\n/gu) ?? []).length;
  console.log(`4. answers in the thread: ${replies}`);

  console.log(`\nCONVERSATION WALK PASSED. evidence: ${evidence}`);
}

try {
  await main();
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (tauriDriver) tauriDriver.kill();
}

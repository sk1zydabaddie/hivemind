import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { announcement, attentionItems, newAttention } from "../src/lib/attention";
import type { WorkspaceQueueItem } from "../src/lib/workspace-actions";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const item = (kind: string, id: string, detail = "something happened"): WorkspaceQueueItem =>
  ({
    id,
    kind,
    title: `title for ${kind}`,
    detail,
    created_at: "2026-08-15T00:00:00.000Z",
    task_id: null,
    action: null
  }) as WorkspaceQueueItem;

describe("breaking silence", () => {
  /* The rule the feature lives or dies by. A notification that did not need a
     decision teaches the person to dismiss the next one without reading, and
     then the real one is missed -- which is worse than never having built it. */
  test("silence means fine: progress never interrupts", () => {
    const queue = [
      item("task_attention", "t:1"),
      item("memory_review", "m:1"),
      item("quality_review", "q:1")
    ];
    expect(attentionItems(queue)).toEqual([]);
  });

  test("a stop that needs a decision does interrupt", () => {
    const queue = [
      item("plan_review", "plan:abc", "6 tasks are waiting for your approval."),
      item("run_stalled", "stall:1"),
      item("adoption_ready", "adopt:1")
    ];
    const found = attentionItems(queue);
    expect(found.map((entry) => entry.id)).toEqual(["plan:abc", "stall:1", "adopt:1"]);
    /* Core's own sentence, not a second voice for the same fact. */
    expect(found[0]?.body).toBe("6 tasks are waiting for your approval.");
  });

  /* An allowlist, for the same reason the shell denial is one: a kind added to
     Core later must be SILENT until somebody decides it is worth interrupting
     for. Loud-by-default is how the feature gets switched off. */
  test("an unknown kind is silent rather than loud", () => {
    expect(attentionItems([item("some_future_kind", "x:1")])).toEqual([]);
  });

  /* Opening the app on four pending decisions must not fire four toasts -- the
     person is looking at them. The first sight is a baseline. */
  test("the first look is silent, and records what was already waiting", () => {
    const current = attentionItems([item("plan_review", "plan:1")]);
    const first = newAttention(null, current);
    expect(first.announce).toEqual([]);
    expect([...first.seen]).toEqual(["plan:1"]);

    /* And the same item on the next poll is still not news. */
    expect(newAttention(first.seen, current).announce).toEqual([]);
  });

  test("something that arrives after the baseline is announced once", () => {
    const before = newAttention(null, attentionItems([item("plan_review", "plan:1")]));
    const after = newAttention(
      before.seen,
      attentionItems([item("plan_review", "plan:1"), item("run_stalled", "stall:9")])
    );
    expect(after.announce.map((entry) => entry.id)).toEqual(["stall:9"]);
    /* Announced once, not on every poll thereafter. */
    expect(newAttention(after.seen, attentionItems([item("run_stalled", "stall:9")])).announce)
      .toEqual([]);
  });

  /* Leaving and returning is two separate stops, so it is two notifications.
     Remembering it forever would silence the second one. */
  test("an item that leaves and comes back is new again", () => {
    const seen = newAttention(null, attentionItems([item("run_stalled", "s:1")])).seen;
    const cleared = newAttention(seen, []);
    expect(cleared.announce).toEqual([]);
    expect(newAttention(cleared.seen, attentionItems([item("run_stalled", "s:1")])).announce)
      .toHaveLength(1);
  });

  /* Four decisions at once is one interruption. A stack of toasts is the same
     mistake as a chatty one. */
  test("several at once become one summary", () => {
    const many = attentionItems([
      item("plan_review", "p:1", "a plan is waiting"),
      item("run_stalled", "s:1"),
      item("adoption_ready", "a:1")
    ]);
    const one = announcement(many);
    expect(one?.title).toBe("3 things need you");
    expect(one?.body).toContain("a plan is waiting");
    expect(announcement([])).toBeNull();
    expect(announcement(many.slice(0, 1))?.title).toBe("A plan is waiting for you");
  });

  /* The durable-record rule: an absent queue is a real value the client sees. */
  test("an absent queue is quiet rather than a crash", () => {
    expect(attentionItems(undefined)).toEqual([]);
  });
});

describe("the notification reaches the artifact", () => {
  /* The `bundle.icon` shape, pre-empted. A plugin permission that exists in the
     repository and never reaches the build is configured-and-inert, and the
     symptom is silence -- which is indistinguishable from "nothing needed you".
     So the wiring is asserted rather than trusted. */
  test("the plugin is a dependency, is registered, and its permission is granted", async () => {
    const cargo = await readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8");
    expect(cargo).toMatch(/tauri-plugin-notification/u);

    const main = await readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8");
    expect(main).toMatch(/tauri_plugin_notification::init\(\)/u);

    /* Tauri v2 compiles `capabilities/*.json` in via `generate_context!`. A
       custom command needs no ACL entry, which is why this project had no
       capability file at all until the first plugin arrived. */
    const capability = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "capabilities", "default.json"), "utf8")
    ) as { permissions: string[]; windows: string[] };
    expect(capability.permissions).toContain("notification:default");
    expect(capability.windows).toContain("main");
  });

  test("the client half is installed and the click is handled", async () => {
    const pkg = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@tauri-apps/plugin-notification"]).toBeDefined();

    const hook = await readFile(path.join(desktopRoot, "src", "hooks", "use-attention.ts"), "utf8");
    /* Sending without handling the click is half a feature: it interrupts and
       then leaves the person to find the thing themselves. */
    expect(hook).toMatch(/onAction/u);
    expect(hook).toMatch(/setFocus/u);
  });

  /* Autonomy is mirrored by reading Core's queue, never by a second filter
     here. Core builds a `plan_review` item only when a plan review exists, so
     Auto produces nothing to announce -- structural, not polite. A filter in
     the client would be a second opinion about autonomy, and the two would
     drift. */
  test("autonomy is not re-implemented on the client", async () => {
    const source = await readFile(path.join(desktopRoot, "src", "lib", "attention.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).not.toMatch(/autonomy/iu);
    expect(code).not.toMatch(/review_plan|review_everything/u);
  });
});

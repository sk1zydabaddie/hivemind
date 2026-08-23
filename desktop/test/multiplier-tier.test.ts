import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { adapterModelText } from "../src/lib/workspace-actions";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* The multiplier tier, as a person meets it: two support claims that must not
 * blur, a model label that must not assert what the probe recorded as
 * unverified, and a disclosure that makes "your provider isn't listed" an
 * answered question instead of a discovered workaround. */
describe("multiplier tier surfaces", () => {
  /* Requested vs confirmed is the whole of item one: "OpenCode · gpt-5.x"
     asserted a model identity while the same record said the pin was
     unverified. The label a person reads has to carry the difference. */
  test("a model label asserts only what the probe confirmed", () => {
    expect(adapterModelText({ model: "gpt-5.6-terra", model_standing: "confirmed" })).toBe(
      "gpt-5.6-terra"
    );
    expect(adapterModelText({ model: "openai/gpt-5.6", model_standing: "requested" })).toBe(
      "asked for openai/gpt-5.6"
    );
    /* An older daemon sends no standing at all. That must render as the plain
       text it always was — adding "asked for" there would invent a claim about
       a record this client cannot see. */
    expect(adapterModelText({ model: "sonnet" })).toBe("sonnet");
    expect(adapterModelText({ model: null, model_standing: null })).toBe(null);
  });

  test("connected-model chips and pickers render through the standing, not the raw field", async () => {
    const settings = await readFile(
      path.join(desktopRoot, "src", "components", "settings-dialog.tsx"),
      "utf8"
    );
    /* The chip that shows what each role runs must go through the helper. */
    expect(settings).toMatch(/\{adapterModelText\(adapter\)\}/u);
    const workTab = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    expect(workTab).toMatch(/adapterModelText\(adapter\)/u);
  });

  test("the disclosure exists on both surfaces and says the honest halves", async () => {
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    /* The question a person actually has, as the heading. */
    expect(providerList).toMatch(/Don&apos;t see your provider\?/u);
    /* Both halves of the claim, not just the pitch: what holds and what is off. */
    expect(providerList).toMatch(/spending limits\s+in tokens/u);
    expect(providerList).toMatch(/does not report which model answered/u);
    /* The provider's own installer, never ours. */
    expect(providerList).toMatch(/its own instructions/u);
    expect(providerList).toMatch(/opencode auth login/u);
    /* The refusal, by name, pointing at the door that is open. */
    expect(providerList).toMatch(/Claude subscriptions cannot be connected through/u);
    expect(providerList).toMatch(/integrated directly/u);

    for (const file of [
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      path.join(desktopRoot, "src", "components", "settings-dialog.tsx")
    ]) {
      const source = await readFile(file, "utf8");
      expect(source, `${path.basename(file)} does not render the disclosure`).toMatch(
        /<MultiplierDisclosure \/>/u
      );
    }
  });

  test("pickers refuse a prohibited slug and tag an unchecked one before the pick", async () => {
    const settings = await readFile(
      path.join(desktopRoot, "src", "components", "settings-dialog.tsx"),
      "utf8"
    );
    /* The option is disabled from the model's own selectable flag, and the
       sanction is written into the option text a person reads while choosing. */
    expect(settings).toMatch(/disabled=\{!option\.selectable\}/u);
    expect(settings).toMatch(/not allowed here/u);
    expect(settings).toMatch(/unchecked/u);

    const workTab = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    expect(workTab).toMatch(/!option\.selectable/u);
    expect(workTab).toMatch(/sanction === "prohibited"/u);
  });

  test("the two support claims are rendered apart, from Core's own sentences", async () => {
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    /* The multiplier tag renders only for the multiplier tier, and the claim
       sentence comes from Core (`tier_claim`), never re-written client-side. */
    expect(providerList).toMatch(/support_tier === "multiplier"/u);
    expect(providerList).toMatch(/\{provider\.tier_claim\}/u);
    /* The reaches line carries the sanction word per vendor, with the counted
       remainder — never a raw name the registry did not recognise. */
    expect(providerList).toMatch(/Its sign-ins reach:/u);
    expect(providerList).toMatch(/does not recognise/u);
  });
});

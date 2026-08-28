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
        /<MultiplierDisclosure/u
      );
      /* The multiplier row is selected by its TIER. Selecting it by name would
         put provider knowledge in the client, which is Core's to own. */
      expect(source).toMatch(/support_tier === "multiplier"/u);
    }
  });

  test("the automated flow stops exactly at the two lines the rules draw", async () => {
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    /* The vendor's install command goes to the CLIPBOARD and nowhere else:
       no action dispatch, no shell, nothing executed. The only computed use
       of `install.command` in the component is the writeText call. */
    expect(providerList).toMatch(/navigator\.clipboard\.writeText\(provider\.install!\.command\)/u);
    const dispatches = providerList.match(/onAction[<(][^)]*\{[\s\S]{0,200}?type: "([a-z_.]+)"/gu) ?? [];
    for (const dispatch of dispatches) {
      expect(dispatch).not.toMatch(/install/u);
    }
    /* Sign-in preselection sends exactly a provider id through the fixed
       command; the API-key instruction names where the key goes and where it
       never does. */
    expect(providerList).toMatch(/type: "provider\.auth\.start",\s*payload: \{ provider_id: provider\.id, inner_provider_id: inner\.id \}/u);
    expect(providerList).toMatch(/paste it there, never into Hivemind/u);
    /* The picker connects through the same audited door as every connect. */
    expect(providerList).toMatch(/type: "adapter\.connect_model",\s*payload: \{ role: "worker", provider_id: provider\.id, model_slug: slug \}/u);
    /* Prohibited chips and models are disabled from typed sanction, never text. */
    expect(providerList).toMatch(/inner\.sanction === "prohibited" \|\| signInBusy/u);
    expect(providerList).toMatch(/disabled=\{model\.selectable === false/u);
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

  /* A-10, the one open register item that bites a multi-hour run: the output
     stream had no error handler, so a failed task stream froze the live pane
     silently while the app still reported "live". */
  test("the live output stream reports its own interruption", async () => {
    const hook = await readFile(path.join(desktopRoot, "src", "hooks", "use-workspace.ts"), "utf8");
    const outputStream = hook.slice(
      hook.indexOf("/output/stream"),
      hook.indexOf("const connectEventStream")
    );
    expect(outputStream).toMatch(/source\.onerror =/u);
    /* Reported through the same primitive the next message clears, so a
       recovered stream stops complaining on its own. */
    expect(outputStream).toMatch(/recordActionError\(/u);
    expect(outputStream).toMatch(/the run is unaffected/u);
  });

  /* Reported: complete a sign-in, and the row keeps its old state for minutes.
     Measured on the installed app rather than guessed -- a real terminal window
     was brought to the front and closed while the webview recorded every event
     it received, and it saw none: no focus, no blur, no visibilitychange, with
     document.hasFocus() staying true throughout. The only refresh trigger was
     an event this webview does not deliver. */
  test("sign-in state refreshes on a signal the webview actually delivers", async () => {
    const watcher = await readFile(
      path.join(desktopRoot, "src", "lib", "provider-authentication.ts"),
      "utf8"
    );
    /* Interaction, because it means the person came back. */
    expect(watcher).toMatch(/addEventListener\("pointerdown", refreshIfWatching, true\)/u);
    expect(watcher).toMatch(/addEventListener\("keydown", refreshIfWatching, true\)/u);
    /* Removed on cleanup, or a remount leaves a listener re-reading forever. */
    expect(watcher).toMatch(/removeEventListener\("pointerdown", refreshIfWatching, true\)/u);
    /* And NOT a timer: a poll would re-read a provider CLI on a schedule to
       catch a change that happens at most once per sign-in. */
    expect(watcher).not.toMatch(/setInterval|setTimeout/u);
    /* A provider with no readable status gets one return interaction, not a
       CLI subprocess on every later click that can never produce a verdict. */
    expect(watcher).toMatch(/watchedStanding\?\.status === "unverifiable"/u);
    expect(watcher).toMatch(/watchedProvider\.current = null/u);
    /* The measurement is recorded where the decision is. */
    expect(watcher).toMatch(/hasFocus\(\)` stayed `true`/u);
  });

  test("every sign-in path arms the watcher, including the multiplier one", async () => {
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    /* The disclosure dispatches provider.auth.start; before this it refreshed
       nothing, so that path could only ever go stale. */
    expect(providerList).toMatch(/onSignInStarted\?\.\(provider\.id\)/u);
    for (const file of ["setup-screen.tsx", "settings-dialog.tsx"]) {
      const source = await readFile(
        path.join(desktopRoot, "src", "components", file.startsWith("setup") ? "workspace" : ".", file),
        "utf8"
      );
      expect(source, `${file} does not arm the watcher for the disclosure`).toMatch(
        /onSignInStarted=\{watchForCompletion\}/u
      );
    }
  });

  /* Reported: the row read "Connected · Signed in" while the banner below said
     a model could not be connected. Signed in is a fact about the account;
     checked is a fact about this project. A single "Connected" claimed the
     stronger one for both. */
  test("the row says which fact it has, never a bare Connected", async () => {
    const providerList = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "provider-list.tsx"),
      "utf8"
    );
    /* Was the chip's own wording, which said the same fact as the standing
       beside it in different words ("Ready here"/"Signed in only" against
       "Checked here"/"Signed in"). One vocabulary now, and the guarantee is
       unchanged: the row states which fact it has and never a bare
       "Connected". */
    expect(providerList).toMatch(/providerStanding\(provider, authenticationStatus\)/u);
    expect(providerList).toMatch(/"Checked here", "Signed in", "Not signed in", "Sign-in not readable", "Not installed", "Unreadable response", "Not checked yet", "Status check failed"/u);
    /* The weaker state says out loud that a model here may still refuse. */
    expect(providerList).toMatch(/a model here may still refuse/u);
    /* And the old unqualified claim is gone. */
    expect(providerList).not.toMatch(/^\s*Connected\s*$/mu);
    /* Product support cannot paint a missing or failed local executable as a
       healthy blue standing, and install help stays reachable on that row. */
    expect(providerList).toMatch(/const standingRank = providerStandingRank/u);
    expect(providerList).toMatch(/const install = provider\.install \?\? null/u);
    expect(providerList).toMatch(/install !== null/u);
    expect(providerList).not.toMatch(/provider\.checked_here \|\| provider\.status === "supported"/u);
  });
});

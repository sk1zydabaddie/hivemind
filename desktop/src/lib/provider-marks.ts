import claudeMark from "@/assets/providers/claude-ai-icon.svg";
import kimiMark from "@/assets/providers/kimi-icon.svg";
import grokDark from "@/assets/providers/grok-dark.svg";
import grokLight from "@/assets/providers/grok-light.svg";
import openaiDark from "@/assets/providers/openai_dark.svg";
import openaiLight from "@/assets/providers/openai.svg";
import opencodeDark from "@/assets/providers/opencode-dark.svg";
import opencodeLight from "@/assets/providers/opencode.svg";

/**
 * A real mark per provider, where a real one exists.
 *
 * From svgl.app, the same open library the component search draws on. Bundled
 * rather than linked: the app runs offline against a local daemon, and a
 * provider row that shows a broken image when the network is down would be
 * worse than one that shows a letter.
 *
 * A provider with no published mark gets a monogram instead of a generic glyph.
 * Substituting a stand-in icon would imply a brand that does not exist, and
 * drawing one would be inventing it.
 *
 * Keyed by HARNESS id, which is what `catalogueProviders()` returns -- the
 * Codex harness is `codex-cli`, not `codex`, which is the same distinction that
 * made `profile.tool` look like a harness when it was a role.
 */
export const PROVIDER_MARKS: Record<string, { light: string; dark?: string }> = {
  "codex-cli": { light: openaiLight, dark: openaiDark },
  claude: { light: claudeMark },
  grok: { light: grokLight, dark: grokDark },
  /* Added 2026-08-17. These two were the monogram case -- OpenCode and Kimi
     showed a letter in a box, which is what the fallback is for and not what
     either brand has. Both publish a mark and svgl carries both, so the
     monogram now has no consumer at all among the five providers Core
     surfaces. It stays for the sixth. */
  opencode: { light: opencodeLight, dark: opencodeDark },
  kimi: { light: kimiMark }
};

/**
 * Brand colour is the brand's, not a choice made here.
 *
 * Worth stating because "in colour" is easy to over-deliver on: Kimi is
 * `#027aff` and Claude is `#D97757`, so those render in colour. OpenAI, Grok and
 * OpenCode are **monochrome by brand** -- there is no colour version to use, and
 * tinting a monochrome mark to make the row look livelier would be inventing
 * brand identity, which is the same refusal that produced the monogram in the
 * first place. Five marks, three of them black-or-white because that is what
 * they are.
 */
export const PROVIDER_MARK_COUNT = 5;

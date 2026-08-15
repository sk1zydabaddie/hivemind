import claudeMark from "@/assets/providers/claude-ai-icon.svg";
import grokDark from "@/assets/providers/grok-dark.svg";
import grokLight from "@/assets/providers/grok-light.svg";
import openaiDark from "@/assets/providers/openai_dark.svg";
import openaiLight from "@/assets/providers/openai.svg";

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
  grok: { light: grokLight, dark: grokDark }
};

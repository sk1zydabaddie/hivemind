/**
 * What each model costs, where that number came from, and when it was checked.
 *
 * ## Why this is a curated list and not a live lookup
 *
 * Artificial Analysis publishes exactly the fields this needs -- `slug`,
 * `price_1m_input_tokens`, `price_1m_output_tokens` -- on a free tier. It was
 * still the wrong dependency, for reasons that are worth keeping written down
 * because they will be re-proposed:
 *
 * 1. **The number that matters most cannot come from a token-price API.** The
 *    primary user pays for ChatGPT Plus or Claude Pro, not per token. No
 *    per-million rate describes their bill. What a price feed gives is the
 *    relative ordering, which is the part a curated list already has.
 * 2. **100 requests per 24 hours, shared across an organisation key.** One key
 *    shipped inside a desktop client is a certain 429, not a risk. Per-user
 *    keys would mean sending a new person to register with a third party in
 *    the middle of onboarding.
 * 3. **The slug mapping is manual either way.** `--model gpt-5.6-sol` is what
 *    the Codex CLI accepts; a price table lists API model ids. Something has
 *    to map one to the other by hand, and once that table exists the price is
 *    one more column in it.
 * 4. **Redistribution needs a bespoke contract**, and shipping cached prices
 *    inside a client is plausibly that.
 * 5. **It would be a live third-party call inside the one flow that must not
 *    break.** Setting up is where a failure has nowhere to go.
 *
 * ## Why provenance is a field and not a comment
 *
 * On **30 July 2026** OpenAI cut Luna's input price by 80% ($1.00 -> $0.20) and
 * Terra's by 20%. A list written in July was wrong within a fortnight. A
 * curated list is not defensible because it is stable -- it is not -- but
 * because it can SAY how old it is. So every entry carries where the number
 * came from and the day it was checked, the surface renders both, and an entry
 * past `STALE_AFTER_DAYS` reports itself as stale rather than continuing to
 * look authoritative. Silently rotting is the failure mode being designed out.
 *
 * ## Why the basis is on the record
 *
 * These are API list prices. Somebody running Codex inside a ChatGPT Plus
 * subscription is not billed them at all. Showing `$5.00 / $30.00` to that
 * person without saying what it is would be an authoritative-looking number
 * they will never be charged, so `basis` travels with the price and every
 * surface that renders one renders it.
 */

export type PriceBasis =
  /** Per-token API list price. NOT what a subscription user pays. */
  | "api_list"
  /** Included in a subscription: no per-token charge to show. */
  | "subscription";

export interface ModelPrice {
  /** US dollars per million input tokens. */
  input_per_m: number;
  /** US dollars per million output tokens. */
  output_per_m: number;
  basis: PriceBasis;
  /** Where the number came from, so a reader can check it themselves. */
  source: string;
  /** ISO date the number was last verified against that source. */
  checked: string;
}

/**
 * How long a checked price stays credible.
 *
 * Sixty days is not a claim that prices hold for sixty days -- the July cut
 * proves they do not. It is the point past which presenting one without a
 * warning stops being honest.
 */
export const STALE_AFTER_DAYS = 60;

/**
 * The curated list, keyed by the slug actually passed to the harness.
 *
 * A model absent from here has no price rather than a guessed one. Absence is
 * a real answer: several harnesses do not let Hivemind pin a model at all, so
 * there is no model to price.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-sol": {
    input_per_m: 5.0,
    output_per_m: 30.0,
    basis: "api_list",
    source: "openai.com — Advancing the price-performance frontier with GPT-5.6",
    checked: "2026-08-14"
  },
  "gpt-5.6-terra": {
    input_per_m: 2.0,
    output_per_m: 12.0,
    basis: "api_list",
    source: "openai.com — Advancing the price-performance frontier with GPT-5.6",
    checked: "2026-08-14"
  },
  "gpt-5.6-luna": {
    input_per_m: 0.2,
    output_per_m: 1.2,
    basis: "api_list",
    /* The 80% cut of 30 July 2026 is already in this number. It is the reason
       `checked` exists: the previous figure ($1.00 / $6.00) was correct when it
       was written and wrong a fortnight later. */
    source: "openai.com — Advancing the price-performance frontier with GPT-5.6",
    checked: "2026-08-14"
  }
};

/** The price for a model slug, or null when none is known. */
export function priceForModel(slug: string | null): ModelPrice | null {
  if (slug === null) return null;
  return MODEL_PRICES[slug] ?? null;
}

/**
 * How old a price is, in days, against a caller-supplied "now".
 *
 * The clock is passed in rather than read here so this stays a pure function --
 * a surface that renders a staleness warning has to be testable without
 * waiting sixty days for it.
 */
export function priceAgeDays(price: ModelPrice, now: Date): number | null {
  const checked = Date.parse(`${price.checked}T00:00:00Z`);
  if (Number.isNaN(checked)) return null;
  return Math.floor((now.getTime() - checked) / 86_400_000);
}

export function priceIsStale(price: ModelPrice, now: Date): boolean {
  const age = priceAgeDays(price, now);
  /* An unparseable date is treated as stale. A price whose provenance cannot
     be read is exactly the case this exists to catch. */
  return age === null || age > STALE_AFTER_DAYS;
}

/** One line for a person, basis included, never the bare number. */
export function describePrice(price: ModelPrice): string {
  if (price.basis === "subscription") {
    return "Included in your subscription — no per-token charge.";
  }
  return `$${price.input_per_m.toFixed(2)} in / $${price.output_per_m.toFixed(2)} out per million tokens — API list price, not what you pay on a subscription.`;
}

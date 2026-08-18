import { AlertTriangle, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { SpecReview } from "@/lib/workspace-actions";

/* The half of the review that is about what will NOT be built.
 *
 * Drafted non-goals are suggestions, never the answer. The drafting experiment
 * showed the drafter leaves the tempting adjacent scope undeclared on exactly
 * the prompts where it matters -- asked for a config reader it declined nothing,
 * not writing, not validation, not caching. So this asks the person, and what
 * they leave here is what gets written.
 *
 * Every constraint carries who wrote it, because agreeing to a limit somebody
 * else invented without being told is the failure this whole screen guards.
 */

export interface NonGoalEntry {
  text: string;
  drafted: boolean;
}

/* "There is nothing to decline" is an answer to the question, not an empty
   field -- the person considered scope and judged there is nothing. It is never
   the default and never prefilled; it has to be chosen. */
export const NOTHING_TO_DECLINE = "__nothing__";

export function initialNonGoals(review: SpecReview | null): NonGoalEntry[] {
  return (review?.drafted_non_goals ?? []).map((text) => ({ text, drafted: true }));
}

export function SpecReviewPanel({
  review,
  nonGoals,
  busy,
  onNonGoalsChange
}: {
  review: SpecReview;
  nonGoals: NonGoalEntry[];
  busy: boolean;
  onNonGoalsChange: (entries: NonGoalEntry[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(""), [review.spec_id]);

  const add = (): void => {
    const text = draft.trim();
    if (text === "") return;
    onNonGoalsChange([...nonGoals, { text, drafted: false }]);
    setDraft("");
  };

  return (
    <section className="grid gap-5">
      {review.open_questions.length > 0 ? (
        <BlockingQuestions questions={review.open_questions} />
      ) : null}

      {review.asked_for === null ? null : (
        <div className="grid gap-1.5">
          <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">You asked for</h3>
          {/* Verbatim, so the drafted spec can be read back against the request
              it came from. */}
          <p className="m-0 border-l-2 border-navy bg-canvas px-3.5 py-2.5 text-[13px] leading-relaxed break-words text-ink">
            {review.asked_for}
          </p>
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-baseline gap-2">
          <h3 className="m-0 text-[11px] font-medium tracking-label text-muted-foreground uppercase">What this will do</h3>
          {review.authorship === "drafted" ? <DraftedMark /> : null}
        </div>
        <p className="m-0 text-[14px] leading-relaxed break-words text-ink">{review.goal}</p>
        {review.acceptance.length > 0 ? (
          <ul className="mt-1 mb-0 grid list-none gap-1 p-0">
            {review.acceptance.map((item) => (
              <li className="text-[12px] leading-relaxed break-words text-muted-foreground" key={item}>
                {item}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {review.assumptions.length > 0 ? (
        /* A choice the person did not make, shown as prominently as a
           constraint they did not write. Same principle: accepting somebody
           else's decision without being told is the failure. */
        <div className="grid gap-2 rounded-md border border-navy/25 border-l-2 border-l-navy bg-navy-wash px-4 py-3">
          <div>
            <h3 className="m-0 text-[14px] leading-snug font-semibold tracking-tight text-ink">
              Decisions made for you
            </h3>
            <p className="mt-1 mb-0 max-w-[620px] text-[12px] leading-relaxed text-muted-foreground">
              You did not say, so these were chosen. If any is wrong, say so below
              and Hivemind will plan again.
            </p>
          </div>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {review.assumptions.map((assumption) => (
              <li
                className="flex items-start gap-2.5 rounded-sm border border-navy/20 bg-panel px-2.5 py-1.5"
                key={assumption}
              >
                <span className="min-w-0 flex-1 pt-0.5 text-[13px] leading-snug break-words text-ink">
                  {assumption}
                </span>
                <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-sm bg-canvas px-1.5 py-px text-[11px] leading-[15px] font-medium text-muted-foreground">
                  <Sparkles aria-hidden="true" className="size-3" />
                  Assumed
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The half people skip, given the weight of the half they do not. */}
      <div className="grid gap-2.5 rounded-md border border-amber/30 border-l-2 border-l-amber bg-amber-wash px-4 py-3">
        <div>
          <h3 className="m-0 text-[14px] leading-snug font-semibold tracking-tight text-ink">
            Anything this should NOT do?
          </h3>
          <p className="mt-1 mb-0 max-w-[620px] text-[12px] leading-relaxed text-muted-foreground">
            {nonGoals.some((entry) => entry.drafted)
              ? "These were suggested for you. Keep the ones you agree with, remove the rest, and add anything missing."
              : "Nothing was suggested. If there is something nearby this should leave alone, say so now."}
          </p>
        </div>

        {nonGoals.length > 0 ? (
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {nonGoals.map((entry, index) => (
              <li
                className="flex items-start gap-2.5 rounded-sm border border-amber/25 bg-panel px-2.5 py-1.5"
                key={`${entry.text}-${index}`}
              >
                <span className="min-w-0 flex-1 pt-0.5 text-[13px] leading-snug break-words text-ink">
                  {entry.text === NOTHING_TO_DECLINE
                    ? "Nothing — you said this has no limits to set."
                    : entry.text}
                </span>
                {entry.drafted ? <DraftedMark /> : <YoursMark />}
                <Button
                  aria-label={`Remove "${entry.text}"`}
                  className="shrink-0"
                  disabled={busy}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => onNonGoalsChange(nonGoals.filter((_, at) => at !== index))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            aria-label="Something this should not do"
            className="h-8 min-w-0 flex-1 rounded-md border border-rule bg-panel px-2.5 text-[13px] text-ink transition-colors placeholder:text-muted-foreground focus-visible:border-navy/45"
            disabled={busy}
            id="spec-non-goal"
            placeholder="e.g. don't change the sign-up form"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button
            disabled={busy || draft.trim() === ""}
            type="button"
            variant="outline"
            onClick={add}
          >
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
        {nonGoals.length === 0 ? (
          <Button
            className="justify-self-start"
            disabled={busy}
            size="inline"
            type="button"
            variant="link"
            onClick={() => onNonGoalsChange([{ text: NOTHING_TO_DECLINE, drafted: false }])}
          >
            There is nothing this should leave alone
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/* A constraint nobody wrote has to say so on its face. */
function DraftedMark(): React.JSX.Element {
  return (
    <span
      className="mt-px inline-flex shrink-0 items-center gap-1 rounded-sm bg-canvas px-1.5 py-px text-[11px] leading-[15px] font-medium text-muted-foreground"
      title="Suggested for you, not written by you"
    >
      <Sparkles aria-hidden="true" className="size-3" />
      Suggested
    </span>
  );
}

function YoursMark(): React.JSX.Element {
  return (
    <span className="mt-px inline-flex shrink-0 items-center rounded-sm bg-navy-wash px-1.5 py-px text-[11px] leading-[15px] font-medium text-navy">
      Yours
    </span>
  );
}

/* The earlier audit's worst defect was a person who could not act and could not
   see why. If ratification is refused, the reason and the remedy are the most
   prominent thing on the screen. */
function BlockingQuestions({ questions }: { questions: string[] }): React.JSX.Element {
  return (
    <section className="grid gap-2 rounded-md border border-clay/30 border-l-2 border-l-clay bg-clay-wash px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-clay" />
        <div className="min-w-0">
          <h3 className="m-0 text-[14px] leading-snug font-semibold tracking-tight text-ink">
            This cannot start until you answer{" "}
            {questions.length === 1 ? "this" : `these ${questions.length}`}
          </h3>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted-foreground">
            The answer changes what gets built, so nothing runs until it is settled.
            Say more in the box below and Hivemind will plan again.
          </p>
        </div>
      </div>
      <ul className="m-0 grid list-none gap-1 p-0 pl-6">
        {questions.map((question) => (
          <li className="text-[13px] leading-snug break-words text-ink" key={question}>
            {question}
          </li>
        ))}
      </ul>
    </section>
  );
}

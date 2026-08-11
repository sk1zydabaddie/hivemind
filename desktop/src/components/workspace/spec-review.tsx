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
    <section className="grid gap-6">
      {review.open_questions.length > 0 ? (
        <BlockingQuestions questions={review.open_questions} />
      ) : null}

      {review.asked_for === null ? null : (
        <div className="grid gap-1.5">
          <h3 className="m-0 text-[12px] font-semibold text-muted-foreground">You asked for</h3>
          {/* Verbatim, so the drafted spec can be read back against the request
              it came from. */}
          <p className="m-0 rounded-md border border-rule bg-canvas px-4 py-3 text-[14px] leading-relaxed break-words text-ink">
            {review.asked_for}
          </p>
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-baseline gap-2">
          <h3 className="m-0 text-[12px] font-semibold text-muted-foreground">What this will do</h3>
          {review.authorship === "drafted" ? <DraftedMark /> : null}
        </div>
        <p className="m-0 text-[15px] leading-relaxed break-words text-ink">{review.goal}</p>
        {review.acceptance.length > 0 ? (
          <ul className="mt-1 mb-0 grid list-none gap-1 p-0">
            {review.acceptance.map((item) => (
              <li className="text-[13px] leading-relaxed break-words text-muted-foreground" key={item}>
                {item}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* The half people skip, given the weight of the half they do not. */}
      <div className="grid gap-2.5 rounded-lg border border-amber/30 bg-amber-wash px-5 py-4">
        <div>
          <h3 className="m-0 text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
            Anything this should NOT do?
          </h3>
          <p className="mt-1 mb-0 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">
            {nonGoals.some((entry) => entry.drafted)
              ? "These were suggested for you. Keep the ones you agree with, remove the rest, and add anything missing."
              : "Nothing was suggested. If there is something nearby this should leave alone, say so now."}
          </p>
        </div>

        {nonGoals.length > 0 ? (
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {nonGoals.map((entry, index) => (
              <li
                className="flex items-start gap-2.5 rounded-md border border-amber/25 bg-panel px-3 py-2"
                key={`${entry.text}-${index}`}
              >
                <span className="min-w-0 flex-1 text-[13px] leading-snug break-words text-ink">
                  {entry.text}
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
            className="h-10 min-w-0 flex-1 rounded-md border border-rule bg-panel px-3 text-[14px] text-ink placeholder:text-muted-foreground"
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
            className="bg-panel"
            disabled={busy || draft.trim() === ""}
            type="button"
            variant="outline"
            onClick={add}
          >
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>
    </section>
  );
}

/* A constraint nobody wrote has to say so on its face. */
function DraftedMark(): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
      title="Suggested for you, not written by you"
    >
      <Sparkles aria-hidden="true" className="size-3" />
      Suggested
    </span>
  );
}

function YoursMark(): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded-sm bg-navy-wash px-1.5 py-0.5 text-[11px] font-medium text-navy">
      Yours
    </span>
  );
}

/* The earlier audit's worst defect was a person who could not act and could not
   see why. If ratification is refused, the reason and the remedy are the most
   prominent thing on the screen. */
function BlockingQuestions({ questions }: { questions: string[] }): React.JSX.Element {
  return (
    <section className="grid gap-2 rounded-lg border border-clay/30 bg-clay-wash px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-clay" />
        <div className="min-w-0">
          <h3 className="m-0 text-[15px] leading-snug font-semibold tracking-[-0.01em] text-ink">
            This cannot start until you answer{" "}
            {questions.length === 1 ? "this" : `these ${questions.length}`}
          </h3>
          <p className="mt-1 mb-0 text-[13px] leading-relaxed text-muted-foreground">
            The answer changes what gets built, so nothing runs until it is settled.
            Say more in the box below and Hivemind will plan again.
          </p>
        </div>
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0 pl-[30px]">
        {questions.map((question) => (
          <li className="text-[14px] leading-snug break-words text-ink" key={question}>
            {question}
          </li>
        ))}
      </ul>
    </section>
  );
}

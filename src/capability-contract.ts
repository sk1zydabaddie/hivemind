/**
 * The contract every coding agent must answer before it is allowed to work.
 *
 * Verifying Codex took a probe, three real invocations, and one empirical
 * discovery that appears in no documentation: `--ephemeral` suppresses the very
 * session record that carries the capability readback. Nothing about that was
 * inferable. Assume the same per provider, and assume some providers cannot be
 * verified at all.
 *
 * So this file is deliberately NOT a list of adapters. It is the question set,
 * the evidence rules, and the admission decision — written down once, so that
 * an agent nobody has integrated yet is REFUSABLE WITH A REASON rather than
 * broken or silently trusted. Four proven and honestly labelled beats five
 * claimed.
 *
 * The one rule underneath all of it: **capabilities are measured, never
 * declared.** Both regressions this project has shipped were a flag being
 * accepted without being applied — `--ignore-user-config` silently forcing a
 * read-only sandbox, and a model pin silently ignored for months. A profile
 * that says `"sandbox": "workspace-write"` is a claim about a flag, not
 * evidence about a run.
 */

/* ── The four states, and why "three" was one short ─────────────────────── */

/**
 * A capability's standing after a probe.
 *
 * The brief asked for three — verified, unverified, unsupported — and the
 * fourth is the one the probe exists to produce. "Asked for gpt-5.6-terra and
 * it reported running gpt-5.5" is not *unsupported*: the provider has model
 * pinning, it advertises it, and it did not do it. Folding that into
 * `unsupported` would file the single most dangerous observation this system
 * can make under the same word as "this tool has no such feature", and the two
 * need different messages and different blast radii.
 *
 * `mismatched` refuses unconditionally, for every capability, whatever the
 * admission policy says. It is the only state with no policy attached, because
 * a provider that reports doing something other than what it was told is not a
 * provider whose other answers can be trusted either.
 */
export type CapabilityState =
  /** Asked for, read back, and the readback matched. */
  | "verified"
  /** Asked for, read back, and the readback DISAGREED. Always refuses. */
  | "mismatched"
  /** Asked for, and there was nothing to read back. */
  | "unverified"
  /** The provider structurally has no such feature. */
  | "unsupported";

/**
 * What kind of thing the state was derived from. Recorded because the classes
 * are not equally strong, and a surface that treats them alike is lying.
 */
export type CapabilityEvidence =
  /** The provider reported what it resolved. The only class that can VERIFY. */
  | "readback"
  /** We looked at the machine afterwards — the repo, the filesystem, HEAD. */
  | "observation"
  /** A property of the argv we are about to run. True before anything spawns. */
  | "static"
  /** Nothing was available. */
  | "absent";

/**
 * Can this evidence class establish a capability, or only refute it?
 *
 * An observation that the agent did NOT do something is weak: a single prompt
 * not provoking a behaviour is not proof the behaviour is off. That is exactly
 * why the sub-agent behavioural probe was considered and rejected — a green
 * result there would be worse than no result.
 *
 * The exception, and it is a real one, is an observation whose subject IS the
 * whole claim. "This run did not create a commit" is completely established by
 * comparing HEAD before and after: there is no hidden way to have committed.
 * So the rule is not "observations cannot verify" but "observations can verify
 * only a claim about THIS RUN, never a claim about the agent's disposition".
 */
export function canEstablish(evidence: CapabilityEvidence, scope: "this-run" | "disposition"): boolean {
  if (evidence === "readback" || evidence === "static") return true;
  if (evidence === "observation") return scope === "this-run";
  return false;
}

/* ── Admission ──────────────────────────────────────────────────────────── */

/** What Hivemind does with a capability in a given state. */
export interface Admission {
  decision: "admit" | "refuse";
  /**
   * What stops working when this capability is admitted unverified. Empty for
   * a clean admission. Every entry is shown to the person before they connect,
   * and recorded on the connection so a later surface can explain itself.
   */
  degrades: DegradedFunction[];
  /** One sentence, in the product's voice, saying what this means for them. */
  consequence: string;
}

/**
 * The things that stop being true when a capability is admitted unverified.
 *
 * Named rather than free text, because a degraded function has to be
 * enforceable somewhere else in the system — a ceiling that cannot hold must
 * actually stop being applied, not merely be described as unreliable.
 */
export type DegradedFunction =
  /** Token ceilings cannot be enforced; spend is unbounded and unreported. */
  | "spend_ceilings"
  /** Tier routing cannot be trusted; every task runs on whatever answers. */
  | "tier_routing"
  /** `routing.observed` may attribute work to the wrong model. */
  | "routing_provenance"
  /** A per-task cost worked out from model prices is wrong by an unknown amount. */
  | "cost_prediction"
  /** `max_concurrent_workers` governs our workers, not calls made under one. */
  | "concurrency_accounting";

export interface CapabilityDefinition {
  id: CapabilityId;
  /** Plain language, for the connect screen. Never internal vocabulary. */
  label: string;
  /** What goes wrong if this is not true. Written for a person, not a log. */
  whyItMatters: string;
  /**
   * Whether the claim is about this one run or about how the agent is set up.
   * Decides whether an observation is allowed to establish it.
   */
  scope: "this-run" | "disposition";
  /** The admission decision for each state. `mismatched` is never listed. */
  admission: Record<Exclude<CapabilityState, "mismatched">, Admission>;
}

export type CapabilityId =
  | "no_bypass_flags"
  | "non_interactive"
  | "pins_one_model"
  | "confined_to_project"
  | "leaves_change_uncommitted"
  | "reports_usage"
  | "reports_model_attribution"
  | "no_nested_agents";

const admit = (consequence: string, degrades: DegradedFunction[] = []): Admission => ({
  decision: "admit",
  degrades,
  consequence
});

const refuse = (consequence: string): Admission => ({
  decision: "refuse",
  degrades: [],
  consequence
});

/**
 * The contract.
 *
 * The asymmetry across these rows is the whole design, and it is the same one
 * the case-folding fix turned on: **when unsure, fail in the direction that
 * costs least if you are wrong.** For confinement, being wrong means an
 * unbounded agent on somebody's machine, so unverified refuses. For usage
 * reporting, being wrong means a ceiling that does not hold — bad, bounded,
 * and describable — so unverified admits with the ceiling switched OFF and the
 * person told, rather than left running against a limit that silently is not
 * one.
 *
 * A degraded admission is only honest if the degradation is REAL. Admitting an
 * agent whose usage cannot be read while still drawing a spend meter would be
 * worse than refusing it.
 */
export const CAPABILITY_CONTRACT: CapabilityDefinition[] = [
  {
    id: "no_bypass_flags",
    label: "Carries no permission-bypass flags",
    whyItMatters:
      "A bypass flag turns off the checks that keep an agent inside your project. Hivemind refuses to start one at all.",
    scope: "this-run",
    admission: {
      /* Static: this is a property of argv we are holding, so there is no
         version of it we cannot determine. Both other states are unreachable
         and are written as refusals so that a future change that makes them
         reachable fails closed rather than opening a hole. */
      verified: admit("Checked before the agent starts, and again every run."),
      unverified: refuse("Hivemind could not check this agent's start-up flags, so it will not run it."),
      unsupported: refuse("This agent cannot be started without a permission-bypass flag.")
    }
  },
  {
    id: "non_interactive",
    label: "Runs without asking you anything",
    whyItMatters:
      "Work happens while you are not watching. An agent that stops to ask a question just stops, and nothing tells you why.",
    scope: "this-run",
    admission: {
      verified: admit("It finished on its own with nothing attached to its input."),
      /* A hang and a question are the same thing from outside, so there is no
         safe reading of "we could not tell". */
      unverified: refuse(
        "Hivemind could not confirm this agent finishes on its own. An agent that waits for an answer looks exactly like one that has hung."
      ),
      unsupported: refuse("This agent only runs interactively, so it cannot be left to work.")
    }
  },
  {
    id: "confined_to_project",
    label: "Can write in this project, and only here",
    whyItMatters:
      "This is the one that cannot be got wrong. An agent that is not confined can change anything on your computer.",
    scope: "disposition",
    admission: {
      verified: admit("It reported the boundary it applied, and the file it was told to write is on disk."),
      /* The brief is explicit and it is right: unverified refuses. Being wrong
         here is unbounded, and no other capability's failure is. */
      unverified: refuse(
        "Hivemind could not confirm where this agent is allowed to write. It will not be given a project until it can say."
      ),
      unsupported: refuse(
        "This agent has no way to be confined to one folder, so Hivemind will not run it against your code."
      )
    }
  },
  {
    id: "leaves_change_uncommitted",
    label: "Leaves the change for you to approve",
    whyItMatters:
      "Hivemind shows you every change before it lands. An agent that commits on its own has already skipped that.",
    scope: "this-run",
    admission: {
      verified: admit("Your branch was exactly where it started when the agent finished."),
      /* Reachable only if the repository could not be read, which means the
         rest of the run cannot be trusted either. */
      unverified: refuse(
        "Hivemind could not tell whether this agent changed your branch, so it will not run it."
      ),
      unsupported: refuse(
        "This agent commits its work directly, which would skip the review Hivemind exists to give you."
      )
    }
  },
  {
    id: "pins_one_model",
    label: "Runs the one model you chose",
    whyItMatters:
      "Hivemind sends cheap work to a cheap model and risky work to a strong one. If the pin does not take, everything runs on whatever the agent felt like.",
    scope: "disposition",
    admission: {
      verified: admit("It reported running the model it was asked for."),
      /* Degraded rather than refused: the cost of being wrong is money and
         attribution, both bounded and both describable. Routing is switched
         OFF rather than left running on an unverifiable pin, because a routing
         decision nobody can confirm is worse than no routing decision. */
      unverified: admit(
        "The model was requested but this agent does not report which one it loaded. Every task will run on one setting, and cheaper work will not be sent to a cheaper model.",
        ["tier_routing", "routing_provenance"]
      ),
      unsupported: admit(
        "This agent cannot be pinned to one model. Every task will run on whatever it chooses.",
        ["tier_routing", "routing_provenance"]
      )
    }
  },
  {
    id: "reports_usage",
    label: "Reports what it spent",
    whyItMatters:
      "Spending limits are the only thing standing between a long run and a surprise bill.",
    scope: "this-run",
    admission: {
      verified: admit("Real token counts were found in this run's own output."),
      /* The brief's own example, and the reasoning holds: a limit built on
         numbers nobody can read is not a limit. Switching it off and saying so
         is honest; leaving it drawn on screen is not. */
      unverified: admit(
        "This agent does not report what it spends, so Hivemind cannot hold a spending limit for it. You will need to watch your usage on the provider's own page.",
        ["spend_ceilings"]
      ),
      unsupported: admit(
        "This agent reports no usage at all. Spending limits are switched off and the cost readout will stay empty rather than show a number that is not true.",
        ["spend_ceilings"]
      )
    }
  },
  {
    /**
     * Split out from "reports what it spent" after a measurement, not a
     * theory. A Claude Code probe pinned to one model reported a SECOND model
     * in its own per-model breakdown: the pin took, and the harness still ran
     * something of its own choosing. A provider that reports one total cannot
     * show that, so the question was never being asked of it -- Codex passed
     * `reports_usage` while the same thing could have been happening
     * invisibly. Kimi documents a secondary model for helper agents by design,
     * so this is not one harness's quirk.
     *
     * The distinction is: "reports what it spent" is about whether a CEILING
     * can hold, and "reports what each model cost" is about whether a PRICE
     * can be predicted. The first still holds when the second does not,
     * because a total includes every model whether or not it names them.
     */
    id: "reports_model_attribution",
    label: "Says which model spent what",
    whyItMatters:
      "Sending cheap work to a cheap model only saves money if the cheap model is what actually ran. A total that does not break down by model cannot tell you.",
    scope: "this-run",
    admission: {
      verified: admit("Its own report breaks the run down by model."),
      /* Never refuses. The ceiling is unaffected -- a total counts every model
         whether or not it names them -- so the honest cost is a limitation,
         not a refusal. And refusing here would refuse Codex, which is the one
         harness that is actually proven. */
      unverified: admit(
        "This agent reports one total rather than a figure per model, so Hivemind cannot tell whether the model you chose is the only one that ran. Spending limits are unaffected, because the total counts everything. What is not reliable is working out what a task cost from the price of the model you picked.",
        ["routing_provenance", "cost_prediction"]
      ),
      unsupported: admit(
        "This agent cannot break its usage down by model. Spending limits still hold, but a per-task cost worked out from model prices will be wrong by an amount nobody can measure.",
        ["routing_provenance", "cost_prediction"]
      )
    }
  },
  {
    id: "no_nested_agents",
    label: "Does not start agents of its own",
    whyItMatters:
      "Hivemind decides how many agents run at once. One that starts its own does work nobody counted, on models nobody chose.",
    scope: "disposition",
    admission: {
      verified: admit("It reported that it starts no agents of its own."),
      /* This is Codex's standing today and it is a measured fact, not a
         guess: the provider reports that the capability EXISTS and reports
         nothing about whether it is off. No probe can close that from our
         side. Refusing here would refuse the one harness that is proven. */
      unverified: admit(
        "This agent may be able to start helpers of its own, and does not say whether that is switched off. Work it does that way is still checked, but may not be counted.",
        ["concurrency_accounting", "routing_provenance"]
      ),
      unsupported: admit(
        "This agent starts helpers of its own and they cannot be turned off. Their work is still checked before anything lands, but is not separately counted.",
        ["concurrency_accounting", "routing_provenance"]
      )
    }
  }
];

/* ── Deciding ───────────────────────────────────────────────────────────── */

export interface CapabilityFinding {
  id: CapabilityId;
  state: CapabilityState;
  evidence: CapabilityEvidence;
  /** What the profile asked for, where there is something to ask for. */
  requested: string | null;
  /** What the provider or the machine said. Null when neither said anything. */
  reported: string | null;
  detail: string;
}

export interface ContractVerdict {
  admitted: boolean;
  /** Every reason the connection was refused, in contract order. */
  refusals: Array<{ id: CapabilityId; label: string; consequence: string }>;
  /** What will not work if this connection is accepted. */
  degraded: DegradedFunction[];
  /** The sentence each degraded capability contributes, for the screen. */
  limitations: Array<{ id: CapabilityId; label: string; consequence: string }>;
  /** A finding for a capability the contract does not define is a bug. */
  unknownCapabilities: string[];
  /** Capabilities the contract requires an answer for and did not get one. */
  missingCapabilities: CapabilityId[];
}

/**
 * The whole admission decision, in one pure function over findings.
 *
 * Pure on purpose. Whether a provider is admitted is arithmetic over what was
 * observed, so it can be exercised for every combination of states on a
 * machine that has none of these agents installed — which is the same reason
 * the lease-index decision was split out from the filesystem probe.
 */
export function decideAdmission(findings: CapabilityFinding[]): ContractVerdict {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const known = new Set(CAPABILITY_CONTRACT.map((entry) => entry.id));
  const refusals: ContractVerdict["refusals"] = [];
  const limitations: ContractVerdict["limitations"] = [];
  const degraded = new Set<DegradedFunction>();
  const missing: CapabilityId[] = [];

  for (const definition of CAPABILITY_CONTRACT) {
    const finding = byId.get(definition.id);
    if (finding === undefined) {
      /* A capability with no finding is not an absent capability — it is a
         probe that did not run. Silence is never admission. */
      missing.push(definition.id);
      refusals.push({
        id: definition.id,
        label: definition.label,
        consequence: `Hivemind did not get an answer about "${definition.label.toLowerCase()}" from this agent.`
      });
      continue;
    }

    if (finding.state === "mismatched") {
      refusals.push({
        id: definition.id,
        label: definition.label,
        consequence: `It was asked for ${finding.requested ?? "one thing"} and reported ${finding.reported ?? "another"}.`
      });
      continue;
    }

    /* An observation cannot establish a claim about how the agent is set up,
       however cleanly the run went. Reported as verified, it would be the
       false confidence the sub-agent behavioural probe was rejected for. */
    if (
      finding.state === "verified" &&
      !canEstablish(finding.evidence, definition.scope)
    ) {
      const downgraded = definition.admission.unverified;
      if (downgraded.decision === "refuse") {
        refusals.push({
          id: definition.id,
          label: definition.label,
          consequence: downgraded.consequence
        });
      } else {
        limitations.push({
          id: definition.id,
          label: definition.label,
          consequence: downgraded.consequence
        });
        for (const entry of downgraded.degrades) degraded.add(entry);
      }
      continue;
    }

    const admission = definition.admission[finding.state];
    if (admission.decision === "refuse") {
      refusals.push({
        id: definition.id,
        label: definition.label,
        consequence: admission.consequence
      });
      continue;
    }
    if (admission.degrades.length > 0) {
      limitations.push({
        id: definition.id,
        label: definition.label,
        consequence: admission.consequence
      });
      for (const entry of admission.degrades) degraded.add(entry);
    }
  }

  return {
    admitted: refusals.length === 0,
    refusals,
    degraded: [...degraded].sort(),
    limitations,
    unknownCapabilities: findings
      .map((finding) => finding.id as string)
      .filter((id) => !known.has(id as CapabilityId))
      .sort(),
    missingCapabilities: missing
  };
}

/** The contract entry for an id, for surfaces that render one finding. */
export function capabilityDefinition(id: CapabilityId): CapabilityDefinition {
  const found = CAPABILITY_CONTRACT.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no contract entry for capability ${id}`);
  return found;
}

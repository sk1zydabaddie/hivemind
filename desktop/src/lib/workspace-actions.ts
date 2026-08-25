import { invoke } from "@tauri-apps/api/core";
import type { TaskProjection } from "./projection";

export type AutonomyLevel = "auto" | "review_plan" | "review_everything";

export interface WorkspaceQueueItem {
  id: string;
  kind:
    | "plan_review"
    | "manager_approval"
    | "verification_blocked"
    | "reverification_required"
    | "run_stalled"
    | "task_attention"
    | "quality_cancel_failed"
    | "memory_review"
    | "quality_review"
    | "plan_amendment"
    | "guidance_pending"
    | "guidance_expired"
    | "adoption_ready"
    /* A ship that failed, and a ship nobody can confirm either way. Core has
       emitted both since adoption was built; the client's union omitted them,
       so neither could be notified about -- and "we cannot tell whether this
       landed" is the single most important thing this product can say. Found by
       the seam test, not by review. */
    | "adoption_failed"
    | "adoption_indeterminate";
  title: string;
  detail: string;
  created_at: string;
  task_id: string | null;
  action: WorkspaceAction | null;
  change_set?: {
    verification_id: string;
    base_branch: string;
    task_ids: string[];
    changed_files: string[];
  };
}

export interface WorkspacePlanTask {
  task_id: string;
  title: string;
  tier: "low" | "medium" | "high" | "critical";
  task_type: "generative" | "deterministic";
  routing_task_type: string;
  mode: "read_only" | "write" | "integration";
  agent_role: string;
  scope: string[];
  allowed_file_intents: Record<string, string>;
  read_only_scope: string[];
  forbidden_scope: string[];
  must_not_change: string[];
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  deterministic_validity_check: string | null;
  required_tests: string[];
  patch_requirements: string[];
  critical_path_approved: boolean;
}

export interface WorkspacePlanReview {
  spec_id: string;
  plan_hash: string;
  plan_path: string;
  base_commit: string;
  created_at: string;
  tasks: WorkspacePlanTask[];
  execution_groups: Array<{
    group_id: string;
    mode: "parallel" | "sequence";
    task_ids: string[];
  }>;
}

export interface WorkspaceInspection {
  tasks: TaskProjection[];
  execution_groups: Array<{
    group_id: string;
    mode: "parallel" | "sequence";
    task_ids: string[];
    label: string;
    counts: { working: number; waiting: number; needs_you: number; done: number };
    configured_cap: number | null;
    effective_concurrency: number | null;
    binding_limit: "configured_cap" | "budget" | "ready_count" | null;
    capacity_note: string | null;
  }>;
  task_titles: Record<string, string>;
  active_spec_id: string | null;
  active_spec_title: string | null;
  manager_session: null | {
    session_id: string;
    spec_id: string;
    created_at: string;
    last_activity_at: string;
    status: "active" | "paused" | "stopped" | "complete";
    tool: string;
    call_count: number;
    blocked_reason: string | null;
    blocked_action_type: string | null;
    continuation_available: boolean;
    autonomy_level: AutonomyLevel;
    autonomy_levels: AutonomyLevel[];
  };
  autonomy: {
    configured_level: AutonomyLevel;
    run_levels: AutonomyLevel[];
  };
  plan_review: WorkspacePlanReview | null;
  current_plan: WorkspacePlanReview | null;
  integration_failure: {
    reason: string;
    task_ids: string[];
  } | null;
  needs_you: WorkspaceQueueItem[];
  later: WorkspaceQueueItem[];
  spend: {
    session_id: string | null;
    calls: number;
    effective_tokens: number;
    reserved_tokens: number;
    committed_tokens: number;
    run_ceiling_tokens: number;
    session_ceiling_tokens: number;
    near_session_ceiling: boolean;
    /* Setup (capability-probe) spend, its own figures rather than a share of
       the ceiling-bound ones. Optional: a daemon older than these fields is a
       permanent input, and their absence means "not reported", never zero
       spend proven. */
    setup_calls?: number;
    setup_tokens?: number;
    setup_reserved_tokens?: number;
  };
  swarm: {
    characterizations: Array<{
      candidate_id: string;
      task_id: string;
      classification: "rejected" | "regression_signal" | "valid_characterization" | "indeterminate";
      reason: string;
      check_id: string;
      artifact_path: string;
      patch: string;
      base_outcome: "pass" | "fail" | "unknown";
      post_change_outcome: "pass" | "fail" | "unknown";
    }>;
    warnings: string[];
  };
  memory: {
    pending_lessons: WorkspaceMemoryProposal[];
    routing_changes: WorkspaceRoutingChange[];
    draft_tests: WorkspaceCharacterization[];
    canon: Array<{
      canon_id: string;
      approved_at: string;
      title: string;
      lesson: string;
      evidence: string[];
    }>;
    active_routing: {
      status: "active" | "absent" | "stale" | "invalid";
      canon_id: string | null;
      reason: string | null;
      task_types: WorkspaceRoutingTaskType[];
    };
    warnings: string[];
  };
  history: {
    runs: WorkspaceHistoryRun[];
    run_ceiling_tokens: number;
    session_ceiling_tokens: number;
    warnings: string[];
  };
}

export type WorkspaceCharacterization = WorkspaceInspection["swarm"]["characterizations"][number];

export interface WorkspaceMemoryProposal {
  proposal_id: string;
  proposed_at: string;
  title: string;
  lesson: string;
  evidence: string[];
  task_id: string | null;
  review_command: string;
}

export interface WorkspaceRoutingProvider {
  provider: string;
  weight: number;
  sample_count: number;
  request_count: number;
  accepted_count: number;
  integrated_count: number;
  failed_count: number;
  timeout_count: number;
  revision_count: number;
  merged_diff_bytes: number;
  effective_tokens: number;
  merged_diff_bytes_per_1k_tokens: number;
  handoff_safety_rate: number | null;
  cost_source: string;
  evidence: string[];
}

export interface WorkspaceRoutingTaskType {
  routing_task_type: string;
  providers: WorkspaceRoutingProvider[];
}

export interface WorkspaceRoutingChange extends WorkspaceMemoryProposal {
  change_kind: "routing_weights" | "quality_eligibility";
  task_types: WorkspaceRoutingTaskType[];
  error_prone_task_types: string[];
}

export interface WorkspaceHistoryRun {
  session_id: string;
  spec_id: string;
  started_at: string;
  last_activity_at: string;
  duration_ms: number;
  outcome: "active" | "completed" | "needs_attention" | "paused";
  outcome_detail: string;
  verified_tasks: string[];
  merged_tasks: string[];
  stopped_tasks: Array<{
    task_id: string;
    state: "failed" | "blocked" | "cancelled" | "paused";
    reason: string;
  }>;
  calls: number;
  effective_tokens: number;
  provider_reported_tokens: number;
  self_measured_tokens: number;
  evidence_paths: string[];
  autonomy_levels: AutonomyLevel[];
}

/** What the one review shows. Read-only; `spec.adopt` is the signature. */
export interface SpecReview {
  spec_id: string;
  title: string;
  authorship: "human" | "drafted";
  status: "draft" | "ratified";
  goal: string;
  drafted_non_goals: string[];
  acceptance: string[];
  open_questions: string[];
  assumptions: string[];
  asked_for: string | null;
}

/* The settings surface. Everything here is read or narrowly-whitelisted write;
   nothing in this group can reach a gate, and  records only
   what a probe confirmed. */
/* Four states, mirroring Core's contract. This declared three until 2026-08-13
   and the drift was not cosmetic: the settings dialog branched on `"failed"`,
   which Core stopped emitting when it split that state into `mismatched` (it
   reported something other than what was asked) and `unsupported` (it has no
   such feature). A `mismatched` capability -- the single most dangerous thing a
   probe can report -- therefore rendered with the neutral unverified mark.
   Two true things, one drawn as the other, which is a shape this project has
   now recorded three times. */
export type CapabilityStatus = "verified" | "mismatched" | "unverified" | "unsupported";

/** How the state was reached. Not all evidence is equally strong. */
export type CapabilityEvidence = "readback" | "observation" | "static" | "absent";

/** One of a harness's own homes, registered under a name a person chose. */
export interface ProviderAccountView {
  id: string;
  label: string;
  harness: string;
  home_dir: string;
  added_at: string;
}

export interface AccountsView {
  accounts: ProviderAccountView[];
  /** Harness -> the one variable it is switched with. Empty means no switch. */
  switchable: Record<string, string>;
  roles: {
    role: string;
    tool: string | null;
    account: { id: string; label: string; harness: string } | null;
    /** Why the recorded capabilities no longer describe what would run. */
    capabilities_stale: string | null;
    connected_at: string | null;
  }[];
}

export interface ProbedCapability {
  id: string;
  label: string;
  status: CapabilityStatus;
  evidence: CapabilityEvidence;
  requested: string | null;
  reported: string | null;
  detail: string;
  required: boolean;
}

/** What stops working when a capability is admitted without being verified. */
export type DegradedFunction =
  | "spend_ceilings"
  | "tier_routing"
  | "routing_provenance"
  | "cost_prediction"
  | "concurrency_accounting";

export interface AdapterProbeResult {
  agent_id: string;
  tool: string;
  ok: boolean;
  refusal: string | null;
  capabilities: ProbedCapability[];
  effective_tokens: number;
  wall_time_ms: number;
  readback_source: string | null;
}

/**
 * The two support claims a harness can make, kept apart on screen: an
 * integrated harness's economics work; a multiplier harness is a verified
 * cage around providers Hivemind never integrated. Sentences come from Core.
 */
export type SupportTier = "integrated" | "multiplier";

/**
 * For a multiplier harness: whose service requests go to and whether that
 * vendor sanctions the path. `unchecked` means "documented by the harness,
 * never verified by us" — and the surface says so before anything is picked.
 */
export interface InnerProviderStanding {
  id: string;
  label: string;
  sanction: "blessed" | "prohibited" | "unchecked";
  why: string;
  checked: string;
  /** How the vendor's sign-in works: browser OAuth, or an API key pasted into
      the HARNESS's own terminal — never into Hivemind. Absent on older daemons. */
  access?: "oauth" | "api_key" | "unknown";
}

/** A harness and the subscription that pays for it. Not a harness-and-model. */
export interface CatalogueProvider {
  id: string;
  label: string;
  subscription: string;
  status: 'supported' | 'unverified' | 'unsupported';
  caveat: string | null;
  pins_model: boolean;
  connectable: boolean;
  /** Absent only when talking to an older daemon. */
  support_tier?: SupportTier;
  tier_claim?: string;
  /** The vendor's documented install command — offered with its source URL,
      never run by Hivemind. Absent on older daemons and unrecorded vendors. */
  install?: { url: string; command: string; detail: string; checked: string } | null;
  /** For a multiplier: every inner provider it is known to reach, prohibited
      entries included, each with its recorded sanction. */
  reachable_providers?: InnerProviderStanding[];
  authentication: {
    experience: "browser" | "interactive" | "device_code";
    detail: string;
  };
  /** A current capability record exists for this project and machine. */
  checked_here: boolean;
}

export interface ProviderAuthenticationStanding {
  provider_id: string;
  status: "signed_in" | "signed_out" | "unknown";
  detail: string;
  /** Which vendors this harness's own sign-ins reach; unrecognised entries are
      counted, never carried. Absent on older daemons and on integrated harnesses. */
  reaches?: { providers: InnerProviderStanding[]; unrecognised: number } | null;
  /** Whether the provider CLI exists on this machine. Typed so surfaces branch
      on a code, never on the detail sentence. Absent when nothing could tell. */
  installed?: boolean;
}

export interface ProviderAuthenticationStatusView {
  providers: ProviderAuthenticationStanding[];
}

export interface ModelPrice {
  input_per_m: number;
  output_per_m: number;
  basis: 'api_list' | 'subscription';
  /** Where the number came from, rendered beside it. */
  source: string;
  /** ISO date it was last checked against that source. */
  checked: string;
}

export interface CatalogueModelView {
  agent_id: string;
  provider_id: string;
  slug: string | null;
  label: string;
  routing_tier: string;
  context_window: number;
  price: ModelPrice | null;
  price_stale: boolean | null;
  price_age_days: number | null;
  /** Whose service this slug reaches, on a multiplier harness. Absent on older daemons. */
  inner_provider?: InnerProviderStanding | null;
}

export interface RoleRecommendation {
  role: string;
  agent_id: string;
  why: string;
  reviewed: string;
}

export interface InspectedAdapter {
  role: string;
  installed: boolean;
  tool: string | null;
  agent_id: string | null;
  /** Provider derived by Core; absent only when talking to an older daemon. */
  provider_id?: string | null;
  model: string | null;
  routing_tier: string | null;
  problems: string[];
  connected_at: string | null;
  capabilities: ProbedCapability[];
  /* Why the recorded capabilities no longer describe what would run, or null.
     Set when the account behind the harness changed. */
  capabilities_stale: string | null;
  /* The account this role runs as, where one has been chosen. */
  account: { id: string; label: string; harness: string } | null;
  /* Why this role cannot be aimed at a chosen model, or null when it can.
     Computed by Core: the client cannot import it, and a second copy of a
     capability-contract rule is how two surfaces come to disagree. */
  model_choice_refusal?: string | null;
  /** Whether `model` is a confirmed fact or only what was asked for.
      Absent on older daemons, which must render the same as "requested"
      NOT being asserted — see `adapterModelText`. */
  model_standing?: "confirmed" | "requested" | null;
  /** Which support claim this connection's harness may make. */
  support_tier?: SupportTier | null;
  /** Recorded at connect time for multiplier connections. */
  inner_provider?: InnerProviderStanding | null;
}

/**
 * The model text a connection label may honestly carry. A verified pin reads
 * as the model; anything else reads as a request — "asked for X" — because
 * the probe recorded the pin as unverified and the label must not assert
 * what the record declines to. An older daemon that sends no standing gets
 * the plain text it always had, which asserts nothing new.
 */
export function adapterModelText(
  adapter: Pick<InspectedAdapter, "model" | "model_standing">
): string | null {
  if (adapter.model === null) return null;
  return adapter.model_standing === "requested" ? `asked for ${adapter.model}` : adapter.model;
}

export interface DiscoveredModel {
  slug: string;
  label: string;
  /** Whose service this slug reaches, on a multiplier harness. Absent on older daemons. */
  inner_provider?: InnerProviderStanding | null;
  /** False when the inner provider is prohibited; the picker must not offer it. */
  selectable?: boolean;
}

export interface ProviderModelDiscovery {
  provider_id: string;
  status: "detected" | "empty" | "unavailable";
  models: DiscoveredModel[];
  source: string;
  detail: string;
}

export interface ModelDiscoveryView {
  providers: ProviderModelDiscovery[];
}

/**
 * Whether the question "how is this project checked" has an answer (A-03).
 *
 * True when a verification command exists, or when the person has recorded
 * that this project has no tests. Setup must not read complete while this is
 * false: integration requires the answer, and the old behavior was to enable
 * Work and let integration reject the project after planning and worker
 * calls were already paid for.
 */
export function verificationResolved(
  config: ProjectConfigView["config"] | null | undefined
): boolean {
  if (!config) return false;
  return config.test_command.trim() !== "" || config.no_tests_declared === true;
}

/** What a check proves. Not interchangeable, so the surface names which it is. */
export type CheckKind = "tests" | "typecheck" | "build";

export interface CheckCandidate {
  command: string;
  kind: CheckKind;
  source: string;
}

/**
 * What one real run of a candidate command did.
 *
 * `not_runnable` and `timed_out` are outcomes the surface REPORTS and Core
 * refuses to store; `stored` says which way it went, because a red command that
 * was not adopted and a red command somebody accepted look identical otherwise.
 */
export interface CheckTrialView {
  command: string;
  outcome: "passed" | "failed" | "not_runnable" | "timed_out";
  exit_code: number;
  duration_ms: number;
  output_tail: string;
  detail: string;
  stored: boolean;
}

/**
 * What `checks.try` answers with: the refreshed project view, plus what the run
 * did. Declared here rather than at the call site because a component that
 * writes out the shape of a daemon answer is how two surfaces end up believing
 * different things about the same response.
 */
export interface CheckTryResult extends ProjectConfigView {
  trial?: CheckTrialView;
}

/**
 * What a person can do next about a trial, as a typed code.
 *
 * The one that must never be reachable is an accept path for a command that
 * never ran. A red suite is a state a project can really be in, so accepting it
 * is a real choice; a string that does not run is not a check under any
 * confirmation, and Core refuses to store it either way. This exists so that
 * refusal is also visible on screen rather than only enforced underneath.
 */
export type TrialAffordance = "settled" | "accept_or_replace" | "replace_only";

export function trialAffordance(trial: CheckTrialView): TrialAffordance {
  if (trial.stored) return "settled";
  if (trial.outcome === "failed") return "accept_or_replace";
  return "replace_only";
}

/**
 * A proposed AGENTS.md and the diff it would make.
 *
 * `diff` is what the person reviews; the two hashes are what the accept sends
 * back so Core can prove nothing moved in between. There is deliberately no
 * content field: a client that could supply the file body would be a way to
 * write arbitrary text into something every harness reads.
 */
export interface AgentsFileProposalView {
  summary: string;
  diff: string;
  bytes: number;
  over_target: boolean;
  size_target_bytes: number;
  has_existing_file: boolean;
  existing_sha: string | null;
  proposed_sha: string;
  facts: {
    project_name: string | null;
    stack: string | null;
    source_dirs: string[];
    test_dirs: string[];
    checks: Array<{ command: string; kind: CheckKind; source: string }>;
  };
}

export interface ProjectConfigView {
  initialized: boolean;
  config_problem: string | null;
  config: {
    test_command: string;
    /* The recorded decision that this project has no tests (A-03). Optional:
       a daemon older than the field is a permanent input, and absence means
       "not declared", never a declaration. */
    no_tests_declared?: boolean;
    /* What happened the one time Hivemind ran the check command, and for WHICH
       command. Optional: a daemon older than the field is a permanent input,
       and absence means nobody has run it -- never that it passed. Compare
       `command` against `test_command` before showing it, because an edit
       through Settings leaves this pointing at the older string. */
    test_command_trial?: {
      command: string;
      outcome: "passed" | "failed";
      exit_code: number;
      at: string;
      duration_ms: number;
    } | null;
    base_branch: string | null;
    allowed_globs: string[];
    forbidden_globs: string[];
    low_globs: string[];
    medium_globs: string[];
    high_globs: string[];
    critical_globs: string[];
    run_ceiling_tokens: number | null;
    session_ceiling_tokens: number | null;
    max_concurrent_workers: number | null;
    verification_checks?: Array<{ id: string; command: string }>;
    /* Which agent handles which KIND of work. Empty when nobody has chosen --
       absent means absent, never "the default". */
    task_type_routing?: Record<string, { tool: string | null; preference: "cheapest" | "strongest" | null }>;
  } | null;
  roles?: string[];
  adapters?: InspectedAdapter[];
  providers?: CatalogueProvider[];
  models?: CatalogueModelView[];
  recommendations?: RoleRecommendation[];
  /* What this project could be checked with, computed by Core only while the
     question is open. A build or a typecheck is a legitimate check, so `kind`
     travels with each one -- accepting a build thinking it ran tests would be
     the same class of mistake as typing a command that never runs. */
  check_candidates?: CheckCandidate[];
  limits: {
    max_concurrent_workers_hard_max: number;
    max_concurrent_workers_default: number;
    observed_worker_call_tokens: { low: number; high: number };
  };
  writable_keys?: string[];
}

export type WorkspaceAction = {
  type:
    | "autonomy.set"
    | "manager.start"
    | "manager.continue"
    | "manager.retry_blocked"
    | "guidance.record"
    | "plan.prepare"
    | "plan.review"
    | "plan.ratify"
    | "spec.draft"
    | "spec.review"
    | "spec.adopt"
    | "manual_task.review"
    | "manual_task.authorize"
    | "plan.amend"
    | "manager.approve_pending"
    | "task.redirect"
    | "task.stop"
    | "task.resume"
    | "run.stop"
    | "status.inspect"
    | "trail.inspect"
    | "change.inspect"
    | "verify.characterize"
    | "quality.best_of_n"
    | "quality.draft_refine"
    | "quality.cancel"
    | "memory.review_handoff"
    | "verification.rerun"
    | "adoption.review"
    | "adoption.execute"
    | "config.inspect"
    | "config.set"
    /* Run one candidate check command and let Core decide, from what it did,
       whether it may be stored. The client renders the typed outcome; it does
       not get to store a command the run refused. */
    | "checks.try"
    /* AGENTS.md. `agents.propose` reads and returns a diff; `agents.apply`
       writes what CORE re-derived, taking only the hashes this client was
       shown -- the client never supplies file content. */
    | "agents.propose"
    | "agents.apply"
    | "project.init"
    | "provider.auth.inspect"
    | "provider.auth.start"
    | "models.discover"
    | "adapter.connect"
    | "adapter.connect_model"
    /* The file tree and the file viewer. Read-only and confined in Core -- see
       src/project-files.ts. The client cannot widen either: it names a path and
       Core decides, exactly as with every other action. */
    | "files.list"
    | "files.read"
    /* What the checks printed. Reading a record, never running one. */
    | "checks.inspect"
    /* Which account each harness runs as. No credential ever crosses this
       boundary: an account is a directory the harness itself owns. */
    | "accounts.inspect"
    | "accounts.add"
    | "accounts.select"
  | "sharing.inspect"
  | "sharing.untrack";
  payload: Record<string, unknown>;
};

/** One directory's immediate children, as `files.list` returns them. */
export interface ProjectFileListing {
  path: string;
  entries: { name: string; path: string; kind: "file" | "directory" }[];
}

/** One file's text, as `files.read` returns it. */
export interface ProjectFileContent {
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

/*
 * ── Everything below is a daemon answer, and lives here for one reason ───────
 *
 * A response type declared inside the component that reads it is a promise to
 * the compiler written by the same hand as the code that trusts it. `strict`
 * cannot object, because nothing disagrees. That is how `SharingBar` shipped
 * `onAction<{ tracked: string[] }>` and took four surfaces down.
 *
 * The proof that local declarations drift, rather than an argument that they
 * might: `checks.inspect` had TWO local types, in two components, that
 * contradicted each other. `ChecksOutput` in checks-output.tsx declared
 * `checks` and `task_ids` required and read `output.checks.filter(...)`
 * directly; `ChecksView` in provenance-note.tsx declared a single optional
 * field and guarded it. Same action, same daemon, two different claims about
 * what comes back, and only one of them survived an older record.
 */

/** What `checks.inspect` returns. */
export interface ChecksOutput {
  checks_run_id?: string;
  checks?: {
    id: string;
    command: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }[];
  ran_at?: string;
  task_ids?: string[];
  tests?: string | null;
  /** Absent on a run recorded before provenance existed, which is not `null`. */
  provenance?: VerificationProvenance | null;
}

/**
 * What a verification was actually made of.
 *
 * Collections are required here on purpose, and it is the one exception. Both
 * facts this renders — how many tasks ran on a verified provider, and who
 * authored the checks — read arrays off it, and neither can be produced from a
 * partial record. Rendering half a provenance would make a weaker claim look
 * like a stronger one, which is the failure the feature exists to prevent. So
 * it is not degraded to an empty case; it is checked whole by `isProvenance`
 * and otherwise said to be absent.
 */
export interface VerificationProvenance {
  version: 1;
  code: { task_id: string; tool: string | null; probe_verified: boolean }[];
  checks: { id: string; author: "contract" | "project_config" | "fail_safe" }[];
  scope: "integrated_set" | "single_worktree";
  artifact_identity: string;
  adversarial_coverage: "unknown";
}

/** One event off the durable trail, as `trail.inspect` returns it. */
export interface DurableTrailEvent {
  ts?: string;
  type?: string;
  task_id?: string | null;
  data?: Record<string, unknown>;
}

/** What `adapter.connect` returns: the probe it ran, and the config after. */
export interface AdapterConnectResult {
  probe?: { capabilities?: ProbedCapability[]; ok?: boolean };
  config?: ProjectConfigView;
}

/** What `sharing.inspect` returns. */
export interface SharingInspection {
  tracked?: readonly string[];
}

/** What `sharing.untrack` returns: what it staged, not what it committed. */
export interface SharingUntrackResult {
  removed?: readonly string[];
}

/** What `manager.start` returns. */
export interface StartedSession {
  session_id?: string;
}

/** What `plan.prepare` returns. */
export interface PreparedPlan {
  status?: "awaiting_ratification" | "ratified_by_policy";
  autonomy_level?: AutonomyLevel;
  task_count?: number;
}

/** What a queue item's action returns, whichever action it is. */
export interface QueuedWorkResult {
  task_ids?: string[];
  session_id?: string;
}

/** What `change.inspect` returns for one task. */
export interface TaskDiff {
  task_id?: string;
  diff?: string;
}

export function invokeWorkspaceAction<T>(projectPath: string, action: WorkspaceAction): Promise<T> {
  return invoke<T>("workspace_action", { projectPath, action });
}

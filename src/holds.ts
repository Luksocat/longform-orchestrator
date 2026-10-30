/**
 * What each hold means and what clears it, for people and models reading the
 * orchestrator's state (Astra and the driving chat should not have to read code or the database to understand routine holds).
 *
 * An explanation is guidance only. A command shown here grants nothing: it
 * needs the evidence or authority named, and the controller re-checks
 * everything when it is run.
 */
export type HoldExplanation = {
  /** What the hold means, in plain words. */
  means: string;
  /** What has to be true for it to clear. */
  clearedBy: string;
  /** The command that records that, if one does (it grants nothing itself). */
  command: string | null;
  /** Who may supply what clears it. */
  authority: string;
};

const OWNER = "the owner";
const OPERATOR_ASSESSMENT =
  "the local operator's own checks of the process, workspace and external effects; never a model's statement";

const TABLE: Record<string, HoldExplanation> = {
  UNKNOWN_RUN: {
    means:
      "A run's outcome is unknown: it may still be running or may have changed files or Drive. Its task and resources stay held until it is reconciled.",
    clearedBy:
      "Reconciliation: a run-bound evidence envelope recorded after the unknown outcome, stating processStopped true, externalEffects NONE or RECONCILED, an assessment of actual checks, and the run's usage when it was never observed.",
    command:
      "longform-orchestrator reconcile-helper --run-id <run> (a draft from the records), then evidence <task> --envelope --file <envelope.json> --execute, then reconcile --run-id <run> --file <reconciliation.json> --execute",
    authority: OPERATOR_ASSESSMENT,
  },
  ACTIVE_OR_UNKNOWN_ATTEMPT: {
    means:
      "A worker run on this task is reserved, running or awaiting reconciliation, so no other worker run can start.",
    clearedBy:
      "The run finishing, or, for an unknown outcome, its reconciliation (see UNKNOWN_RUN).",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  EXECUTION_BUDGET_EXHAUSTED: {
    means:
      "The task has used the cost or token budget its specification allows, so no further run (a reply, rework, moderator or Astra checkpoint included) can start for it.",
    clearedBy: "The owner raising the task's cost or token cap.",
    command:
      "longform-orchestrator budget-extend <task> --file <{maxCostUsd?,maxTokens?,reason,sourceRef}> --execute",
    authority: OWNER,
  },
  MISSING_ACCEPTANCE_EVIDENCE: {
    means:
      "Verification needs evidence bound to each acceptance criterion, and the named criterion has none that is current and valid for the sealed work.",
    clearedBy:
      "Evidence for that criterion (for example the worker's Drive record or a local evidence file) imported and bound to it after checking it against the sealed work.",
    command:
      "longform-orchestrator evidence <task> --file <file> --execute (or --envelope), then longform-orchestrator bind <task> --criterion <id> --evidence-id <id> --execute",
    authority:
      "the owner or the local operator binding real evidence they inspected; a review or a model's statement is not evidence",
  },
  ATTEMPT_BUDGET_EXHAUSTED: {
    means: "The task has used every worker attempt its budget allows.",
    clearedBy: "The owner extending the task's attempt budget.",
    command:
      "longform-orchestrator budget-extend <task> --file <extension.json> --execute",
    authority: OWNER,
  },
  UNCHANGED_FAILED_ATTEMPT_REQUIRES_RECONCILIATION: {
    means:
      "The last worker run failed and nothing it depended on has changed since, so the same run would fail the same way.",
    clearedBy:
      "A change to the task's specification, its dependencies' status, its evidence or its owner decisions.",
    command: null,
    authority:
      "whoever may record that change (a revision or decision is the owner's)",
  },
  OWNER_DECISION_REQUIRED: {
    means: "The task needs a recorded owner decision covering its operations.",
    clearedBy: "An owner decision record for the task's current specification.",
    command:
      "longform-orchestrator decision <task> --file <decision.json> --execute",
    authority: OWNER,
  },
  OPERATION_NOT_AUTHORIZED: {
    means: "An operation the task needs has no current grant.",
    clearedBy:
      "An owner grant for that operation on the task's current specification.",
    command: "longform-orchestrator grant <task> --file <grant.json> --execute",
    authority: OWNER,
  },
  DEPENDENCY_NOT_CURRENT_ACCEPTED: {
    means: "A task this one depends on is not accepted and current.",
    clearedBy:
      "The dependency being verified and accepted, and staying current.",
    command: "longform-orchestrator accept <dependency> --execute",
    authority: OWNER,
  },
  SPECIFICATION_UNAUTHENTICATED: {
    means: "The task's specification has no authenticated source.",
    clearedBy: "A revision bound to an authenticated specification source.",
    command: "longform-orchestrator revise <task> --file <task.json> --execute",
    authority: OWNER,
  },
  NO_AUTHENTICATED_SPECIFICATION_SOURCE: {
    means: "The task names no source for its specification.",
    clearedBy:
      "A revision of the task that binds it to an authenticated source, such as the owner's recorded request.",
    command: "longform-orchestrator revise <task> --file <task.json> --execute",
    authority: OWNER,
  },
  MISSING_SOURCE: {
    means:
      "A source the task is bound to has no evidence recorded under the ID the task names.",
    clearedBy:
      "That source's evidence recorded under exactly that ID, revision and digest from an authenticated connector or the owner's recorded request (the evidence command imports only unverified local files, which cannot clear this), or a revision of the task's sources.",
    command: null,
    authority:
      "the operator records retrieved sources; changing which sources bind the task is the owner's revision",
  },
  STALE_SOURCE: {
    means:
      "A source's recorded evidence no longer matches the revision or digest the task is bound to, or is not current.",
    clearedBy:
      "A revision of the task binding it to the source's current evidence.",
    command: "longform-orchestrator revise <task> --file <task.json> --execute",
    authority: OWNER,
  },
  SUPERSEDED_SOURCE: {
    means: "A source the task is bound to has been superseded.",
    clearedBy: "A revision binding the task to the current source.",
    command: "longform-orchestrator revise <task> --file <task.json> --execute",
    authority: OWNER,
  },
  UNAUTHENTICATED_SOURCE: {
    means:
      "A source's evidence is not authenticated (unverified, or not from an authenticated connector or the owner's request).",
    clearedBy:
      "A revision binding the task to authenticated evidence for that source.",
    command: "longform-orchestrator revise <task> --file <task.json> --execute",
    authority: OWNER,
  },
  REAL_TASK_EXECUTION_DISABLED: {
    means: "This orchestrator is configured not to run real tasks.",
    clearedBy: "The operator's configuration allowing real tasks.",
    command: null,
    authority: OWNER,
  },
  RESERVED_LANE_EXCLUDED_FROM_EXECUTION: {
    means:
      "The reserved HOLD workstream is excluded from execution. It is permanent for this task.",
    clearedBy: "Nothing short of an owner change of scope.",
    command: null,
    authority: OWNER,
  },
  PROVIDER_PAUSED: {
    means:
      "The provider hit its usage or rate limit, so nothing new runs on it until the time shown (its stated reset, or a recheck interval), or, when held, until the operator says the limit is lifted. It is not failed work; work on the other provider continues.",
    clearedBy:
      "The time passing, then one test run or probe getting through; when held, the operator's record that the limit is lifted, or one operator probe.",
    command:
      "longform-orchestrator provider-pause [--provider <p>]; when held: provider-pause --provider <p> --clear --file <evidence.json> --execute, or provider-pause --provider <p> --recheck --execute",
    authority:
      "the operator, with evidence of the provider's state (its usage page, a manual check); never a model",
  },
  PROVIDER_RECHECK_IN_PROGRESS: {
    means:
      "The provider's pause has run out and one run or probe is testing it; nothing else starts on it until that one ends.",
    clearedBy: "The test run or probe ending (success clears the pause).",
    command: null,
    authority: "the controller",
  },
  PROVIDER_RETRIES_EXHAUSTED: {
    means:
      "The provider's limit, or a shared database that stayed busy, has cut this step off three times (or as often as extended), so it is not started again on its own.",
    clearedBy: "The owner's word that it may run three more times.",
    command:
      "longform-orchestrator retry-extend <task> --file <{step,reason,sourceRef}> --execute",
    authority: OWNER,
  },
  ADVICE_WAITING_PROVIDER: {
    means:
      "The task's requested advice comes from a provider paused for its usage limit, or its run was stopped because the shared database stayed busy, so the worker waits for it rather than going ahead without it.",
    clearedBy:
      "The advisor's provider pause ending, or the next advance asking for the advice again, and the advice being obtained.",
    command: null,
    authority: "the controller",
  },
  CLAIM_CONFLICT: {
    means:
      "Another run, filing or unsettled Drive write holds a file, folder or resource this operation would write, so it waits; only this orchestrator's own writers are ordered this way.",
    clearedBy:
      "The other operation ending (its claims are released), or, when the refusal names a run whose attempt is UNKNOWN, an uncertain write intent or a lease that ran out, that run, write or filing being reconciled.",
    command: "longform-orchestrator claims",
    authority:
      "the controller; an uncertain write needs the operator's reconciliation",
  },
  DRIVE_WRITE_UNCERTAIN: {
    means:
      "A Drive write may or may not have reached Drive (a server error, a timeout, a lost response, or a stop mid-write). Its file or folder stays held until someone checks Drive.",
    clearedBy:
      "The operator's evidence, bound to the write, that the operation stopped and what Drive shows, checked at least ten minutes after the write and the stop.",
    command:
      "longform-orchestrator evidence <task> --envelope --file <envelope.json> --execute, then longform-orchestrator claims-reconcile --intent <id> --file <{evidenceId}> --execute",
    authority:
      "the local operator's own check of Drive and of the process; never a model's statement",
  },
  FILING_CLAIMS_UNCERTAIN: {
    means:
      "A filing stopped without releasing its claims (its process ended or its lease ran out), so what it wrote is not known for certain.",
    clearedBy:
      "The operator's evidence, bound to the filing, that it stopped and what Drive shows, checked at least ten minutes after its last write and its stop. Its stop counts from when claims-reconcile first sees it gone, so the first call may answer CHECKED_TOO_EARLY with the time to check after.",
    command:
      "longform-orchestrator evidence <task> --envelope --file <envelope.json> --execute, then longform-orchestrator claims-reconcile --filing <id> --file <{evidenceId}> --execute",
    authority:
      "the local operator's own check of Drive and of the process; never a model's statement",
  },
  PROJECT_OVERSIGHT_HELD: {
    means:
      "Astra's last checkpoint for the project was held; the detail says why.",
    clearedBy: "The condition named in the detail, then a new advance.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --advance --execute",
    authority: "as the detail requires",
  },
  WORKER_QUESTION_NOT_RECORDED: {
    means:
      "A worker left questions that are not yet recorded, so review waits.",
    clearedBy: "The next advance recording them.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --advance --execute",
    authority: "the controller",
  },
  WORKER_QUESTION_OPEN_IN_OTHER_REQUEST: {
    means:
      "A worker's question on this task is open in another request, so review waits.",
    clearedBy:
      "An answer to that question in that request (the owner's for an owner question).",
    command:
      "longform-orchestrator orchestrate --request-id <other request> --answer-file <answer.json> --execute",
    authority:
      "the owner for an owner question; the operator, with evidence, for an operator question",
  },
  PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST: {
    means:
      "An open question another of the project's requests recorded (Astra's, or a worker's) holds this task.",
    clearedBy:
      "An answer to that question in the request that holds it (the owner's for an owner question).",
    command:
      "longform-orchestrator orchestrate --request-id <other request> --answer-file <answer.json> --execute",
    authority:
      "the owner for an owner question; the operator, with evidence, for an operator question",
  },
  PROJECT_QUESTION_OPEN: {
    means:
      "An open question covers this task, so it is neither worked on nor reviewed until it is answered.",
    clearedBy: "An answer to the question.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --answer-file <answer.json> --execute",
    authority:
      "the owner for an owner question; the operator, with evidence, for an operator question",
  },
  PROPOSAL_QUESTION_OPEN_IN_OTHER_REQUEST: {
    means:
      "A reviewer's proposal on this task waits on an owner question in another request.",
    clearedBy: "The owner's answer in that request.",
    command:
      "longform-orchestrator orchestrate --request-id <other request> --answer-file <answer.json> --execute",
    authority: OWNER,
  },
  PRE_DESIGN_SCREEN_REQUIRED: {
    means:
      "The task is opted in to pre-design decision discovery and its current specification has no screening by Astra yet, so no worker run starts on it. Outside a two-tier project (NO_PROJECT_OVERSIGHT) nothing can screen it.",
    clearedBy:
      "Astra's next checkpoint screening the task (the next advance runs it); outside a project, a revision that removes the opt-in or the task joining a two-tier project.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --advance --execute",
    authority: "the controller; Astra screens, it decides nothing",
  },
  PRE_DESIGN_SCREEN_STALE: {
    means:
      "The task's screening rested on inputs that have since changed (the detail names them: its own specification, a related task's specification, or the owner's decisions on it), so no fresh worker run starts until Astra screens it again.",
    clearedBy: "Astra's next checkpoint screening the task again.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --advance --execute",
    authority: "the controller; Astra screens, it decides nothing",
  },
  PRE_DESIGN_OWNER_CHOICE_OPEN: {
    means:
      "The screening found a choice only the owner can make, recorded as an owner question (the detail names it); the tasks it affects wait for the owner's answer. The answer is context for the work, not a grant, decision record or change of scope.",
    clearedBy:
      "The owner's answer to that question; if the answer changes the specification, a revision, its grant and a rebind, after which the task is screened again.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --answer-file <answer.json> --execute",
    authority: OWNER,
  },
  PRE_DESIGN_QUESTION_NOT_RECORDED: {
    means:
      "A screening's owner question is not yet recorded (the advance stopped between the checkpoint and its questions), so the task waits.",
    clearedBy: "The next advance recording it.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --advance --execute",
    authority: "the controller",
  },
  PRE_DESIGN_EVIDENCE_REQUIRED: {
    means:
      "Astra could not screen the task without a source that is missing, and said what is missing in a question; no worker run starts until the evidence is supplied and Astra screens the task again.",
    clearedBy:
      "The answer to that question with the source (the operator records a retrieved source; the owner supplies what only the owner has), then Astra's next checkpoint.",
    command:
      "longform-orchestrator orchestrate --request-id <request> --answer-file <answer.json> --execute",
    authority:
      "the operator for a record they can retrieve, with evidence; the owner for what only the owner has",
  },
  // The adaptive workflow (issue #12): plain words for each of its holds.
  ADAPTIVE_ADVICE_CONTEXT_UNAVAILABLE: {
    means: "This pair qualified with advisor notes that cannot fit in the worker's brief, so the worker has not started.",
    clearedBy: "Shorten the task context, or supply qualifying evidence for the arrangement the worker will actually receive.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_LINEAGE_NOT_PREWARMED: {
    means: "Historical input files have not been checked for this admission, so the controller stopped before reading them under its database write lock.",
    clearedBy: "Retry admission so the controller can prepare and check the historical files before its write transaction; if it persists, inspect the named file or run.",
    command: null,
    authority: "the controller, or the operator if the historical record needs inspection",
  },
  ADAPTIVE_LINEAGE_FILES_CHANGED: {
    means: "Historical files changed while their contribution lineage was being prepared, so the controller cannot establish independent review from that snapshot.",
    clearedBy: "Stabilize and inspect the named historical record, then retry admission to prepare a fresh checked snapshot.",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  ADAPTIVE_INTAKE_DISABLED: {
    means:
      "The adaptive workflow's intake is switched off, so this task gets no new worker and reviewer selection. Work already pinned continues.",
    clearedBy:
      "The owner switching adaptive intake back on in the routing policy.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_EVIDENCE_MISSING: {
    means:
      "No worker and reviewer pair has current, qualifying evaluation evidence for this kind of task, so no pair can be chosen. The adaptive workflow never falls back to the fixed pairing.",
    clearedBy:
      "A frozen evaluation plan covering this task class, with imported evidence that qualifies a pair; or the owner moving the task to another workflow before it is pinned.",
    command: "longform-orchestrator adaptive evidence (read-only), then adaptive freeze-plan or import-evidence --execute",
    authority: OWNER,
  },
  ADAPTIVE_EVIDENCE_CONTRADICTORY: {
    means:
      "Two listed evaluation plans disagree about this task class: one qualifies the pair and another failed it, so neither is trusted.",
    clearedBy:
      "The owner settling the conflict, for example by listing only one of the plans, or by a new frozen plan whose evidence decides.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_AUTHORSHIP_UNKNOWN: {
    means:
      "Who shaped this task's work cannot be established from the records (for example an unreadable Drive record, or a listing recorded without the files it returned), so no review can be called independent.",
    clearedBy:
      "The unknown contribution resolved: an unresolved Drive write reconciled, or the task revised or split so that the unknown work is not part of it.",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED: {
    means:
      "Both providers have already contributed to this task's work, so neither can review it independently.",
    clearedBy:
      "The owner splitting the work into tasks each shaped by one provider, or changing the review plan for this task.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_NO_ELIGIBLE_WORKER: {
    means:
      "No worker route in the policy can serve this task: each is excluded by its role, provider, tier, effort floor, availability or failure history, as the reasons list.",
    clearedBy:
      "A route the reasons show as excluded becoming eligible, such as an attestation renewed or a provider pause ending; or a policy change by the owner.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_NO_INDEPENDENT_REVIEWER: {
    means:
      "No eligible reviewer from the other provider exists for this task, so no work is started that could not be reviewed.",
    clearedBy:
      "An eligible reviewer route of the other provider, or the owner changing which providers the task may use.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_PINNED_PREFERENCE_REFUSED: {
    means:
      "The owner pinned routes for this task that are not an eligible, qualified, independent pair here. A preference never waives an effort floor, attestation, evidence or independence.",
    clearedBy:
      "The owner recording another preference, or the pinned pair becoming eligible and qualified.",
    command: "longform-orchestrator adaptive prefer --task <task> --file <{mode,workerRouteId?,reviewerRouteId?,reason}> --execute",
    authority: OWNER,
  },
  ADAPTIVE_PINNED_ROUTE_UNAVAILABLE: {
    means:
      "The route this task or checkpoint was pinned to is no longer usable: it changed, was disabled, lost its attestation, or its evidence no longer qualifies. Nothing is re-selected or swapped.",
    clearedBy:
      "The pinned route becoming usable again (an attestation renewed, the route restored, evidence current), or the owner cancelling or superseding the task.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW: {
    means:
      "This task was pinned under the adaptive workflow, which is not the workflow in force now; it never continues under fixed pairing.",
    clearedBy:
      "The adaptive workflow returning, or the owner cancelling or superseding the task and registering a new one.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_PIN_MISSING: {
    means:
      "A run refers to an adaptive pin that is not in the records, so its route cannot be checked.",
    clearedBy:
      "Reconciliation of the run by the operator; the controller never invents a pin.",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE: {
    means:
      "Two failed reviews require a stronger worker effort or a higher tier on the same provider and model, and no eligible route for it exists. No weaker reviewer, lower effort or other provider is substituted.",
    clearedBy:
      "An eligible route for the escalated effort, or the owner deciding how to go on.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_ESCALATION_UNQUALIFIED: {
    means:
      "The escalation the failed reviews require has no qualifying evaluation evidence for the escalated pair.",
    clearedBy:
      "Evidence that qualifies the escalated pair, or the owner deciding how to go on.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_CEILING_EXHAUSTED: {
    means:
      "The worker is already at its Max ceiling, and the bounded continuations at Max (owner decision 1) are used up.",
    clearedBy:
      "The owner deciding how to go on: for example cancelling the task and registering smaller ones, which start without its failed reviews (a revision keeps them), or raising the ceiling allowance in the policy.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_CEILING_NO_CORRECTION: {
    means:
      "This work at the Max ceiling does not show a real correction for every must-fix item of the failed review (its CORRECTIONS list misses an item, names a target outside the task, or a target did not change), so it is not reviewed.",
    clearedBy:
      "The owner deciding how to go on; the worker's response and changes are kept for inspection.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_LINEAGE_CONFLICT: {
    means:
      "The pinned reviewer's provider contributed to this work, so the review would not be independent. No other reviewer is substituted.",
    clearedBy:
      "The owner splitting or revising the work so that the reviewer's provider did not shape it.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_NO_WORK_TO_REVIEW: {
    means:
      "There is no sealed work for the pinned reviewer to review.",
    clearedBy:
      "A successful worker run on the current specification.",
    command: null,
    authority: "the controller",
  },
  ADAPTIVE_CHECKPOINT_NO_QUALIFIED_OVERSEER: {
    means:
      "No overseer route has qualifying checkpoint evidence for this project's demand, so the checkpoint holds and no worker is admitted.",
    clearedBy:
      "Overseer evidence for that demand, or the owner changing the project or the policy.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_CHECKPOINT_PIN_MISSING: {
    means:
      "An overseer run refers to a checkpoint pin that is not in the records.",
    clearedBy:
      "Reconciliation of that run by the operator.",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  ADAPTIVE_SUBSTANTIVE_OVERSIGHT_UNAVAILABLE: {
    means:
      "The checkpoint would have to guide workers (a task needs a pre-design screening, or the policy asks for substantive oversight), and substantive adaptive oversight is not in this build: it is deferred.",
    clearedBy:
      "The owner exempting the task from screening, changing the policy's oversight mode, or moving the task to another workflow before it is pinned.",
    command: null,
    authority: OWNER,
  },
  ADAPTIVE_ROUTING_FAILED: {
    means:
      "The adaptive routing records could not be read, so no route is chosen.",
    clearedBy:
      "The operator checking the routing policy and the database; the controller checks again at the next admission.",
    command: null,
    authority: OPERATOR_ASSESSMENT,
  },
  ADAPTIVE_POLICY_UNAVAILABLE: {
    means:
      "The routing policy's adaptive section could not be read.",
    clearedBy:
      "A valid routing policy installed by the owner.",
    command: null,
    authority: OWNER,
  },
};

const FALLBACK: HoldExplanation = {
  means: "A hold the controller records; its code says what it is.",
  clearedBy:
    "The condition its code names; the controller re-checks it at admission.",
  command: null,
  authority: "as the code requires",
};

/**
 * What a hold means and what clears it; a code's suffix (after ":") names its
 * subject. A wrapping hold that carries another's reason (for example
 * `WORKFLOW_VERIFY_HELD:Error: MISSING_ACCEPTANCE_EVIDENCE:a`) is explained by
 * the first known code inside it.
 */
export function explainHold(code: string): HoldExplanation & { hold: string } {
  const known = code
    .split(/[^A-Z0-9_]+/)
    .find((token) => token in TABLE);
  return { hold: code, ...(known ? TABLE[known]! : FALLBACK) };
}

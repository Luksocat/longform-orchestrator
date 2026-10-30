import { z } from "zod";
import { canonical, digest, overlaps, type Task } from "./domain.js";
import { DRIVE_CHANGES_DIR } from "./drive.js";

/**
 * Pre-design decision discovery (proposal #17): before a substantial design
 * task's first worker run, Astra screens it for the choices only the owner
 * can make, and the controller admits the worker only on a current screening
 * whose owner choices are settled. Opt-in per task (`preDesignDiscovery`);
 * tasks without the field are untouched.
 *
 * Everything here is deterministic and pure: the eligibility classifier, the
 * screening payload Astra returns, the stable key and plain-language text of
 * the owner question each required choice becomes, and the task-scoped
 * currency inputs that decide when a screening is stale. The records
 * themselves live in the controller's event journal (project.ts).
 */
export const SCREENING_VERSION = 1;
/** Question keys the controller derives from screening candidates. */
export const PRE_DESIGN_QUESTION_PREFIX = "pre-design-question:";

export type PreDesignPolicy = "REQUIRED" | "AUTO" | "EXEMPT";
export type Eligibility = {
  /** Whether a screening is needed before the first worker run. */
  required: boolean;
  /** The task's policy; null when the task is not opted in. */
  policy: PreDesignPolicy | null;
  /** Why, as fixed codes (the table is in docs/astra-project-oversight.md). */
  reasons: string[];
};
const DESIGN_KINDS = ["mechanics", "engineering-design", "narrative"];
const ROUTINE_KINDS = ["records", "owner-brief"];
/**
 * Whether the task needs a screening, from its record alone, so that the
 * same specification always gets the same answer (no keyword matching on titles, no model's say). Under AUTO, work that continues
 * reviewed work or files exact content is exempt; otherwise any signal that
 * the work can change requirements, accepted behaviour, a cross-task
 * contract or an owner-level outcome requires the screen, and an unknown
 * work type is screened rather than skipped.
 */
export function screeningEligibility(task: Task): Eligibility {
  const policy = task.preDesignDiscovery?.policy ?? null;
  if (!policy) return { required: false, policy, reasons: ["NOT_CONFIGURED"] };
  if (policy === "EXEMPT")
    return { required: false, policy, reasons: ["POLICY_EXEMPT"] };
  if (policy === "REQUIRED")
    return { required: true, policy, reasons: ["POLICY_REQUIRED"] };
  const exempt: string[] = [];
  if (task.fixes) exempt.push("FIXES_REVIEWED_WORK");
  if (task.kind && ROUTINE_KINDS.includes(task.kind))
    exempt.push("ROUTINE_FILING_OR_OWNER_PRESENTATION");
  if (exempt.length) return { required: false, policy, reasons: exempt };
  const signals: string[] = [];
  if (!task.kind) signals.push("WORK_TYPE_UNKNOWN");
  else if (DESIGN_KINDS.includes(task.kind)) signals.push("DESIGN_WORK_TYPE");
  if (task.risk === "HIGH") signals.push("HIGH_RISK");
  if (task.decisionRequired) signals.push("OWNER_DECISION_REQUIRED");
  if (task.drive && task.drive.update.length)
    signals.push("CHANGES_EXISTING_DOCUMENTS");
  if (task.dependencies.length) signals.push("CROSS_TASK_DEPENDENCY");
  if (task.resources.length) signals.push("SHARED_RESOURCE");
  if (task.complexity?.level === "EXPERT") signals.push("EXPERT_COMPLEXITY");
  return signals.length
    ? { required: true, policy, reasons: signals }
    : { required: false, policy, reasons: ["NO_DESIGN_SIGNAL"] };
}

const text = z.string().trim().min(1).max(4000);
const ref = z.string().trim().min(1).max(500);
const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
export const CandidateTypeSchema = z.enum([
  /** A choice only the owner can make, still open: becomes an owner question. */
  "OWNER_REQUIRED",
  /** A routine engineering trade-off: Astra settles it in technicalDecisions. */
  "ENGINEERING",
  /** Already settled by a recorded decision or an answered question (decidedBy). */
  "ALREADY_DECIDED",
  /** A choice that arises only if something later turns out one way. */
  "CONDITIONAL",
  /** Cannot be judged or recommended without a source that is missing. */
  "EVIDENCE_BLOCKED",
]);
export type CandidateType = z.infer<typeof CandidateTypeSchema>;
/**
 * One choice Astra found. Every field is present (null where it does not
 * apply) so the provider's strict output schema has no optional member.
 */
export const CandidateSchema = z
  .object({
    /** Stable across retries and requests: the same choice gets the same key. */
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    type: CandidateTypeSchema,
    /** What is to be decided and why it matters now, in everyday language. */
    choice: text,
    /** Whether the fork rests on cited evidence or on inference. */
    basis: z.enum(["EVIDENCE", "INFERENCE"]),
    sourceRefs: z.array(ref).max(20),
    /** The tasks that wait for the choice (the screened task among them). */
    affectedTaskIds: z.array(taskId).min(1).max(100),
    /** 2 to 4 genuinely viable outcomes for an owner choice; fewer otherwise. */
    options: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            consequences: text,
          })
          .strict(),
      )
      .max(4),
    /** The preferred option and why; required for an owner choice. */
    recommendation: text.nullable(),
    /** Confidence and what is uncertain. */
    uncertainty: text,
    /** What happens to the work if the choice is postponed. */
    ifPostponed: text,
    /** What would reopen a settled or conditional choice. */
    reopenWhen: text,
    /** ALREADY_DECIDED: the recorded decision or answered question that settled it. */
    decidedBy: ref.nullable(),
    /** An owner choice that would change a recorded decision: that decision's id. */
    revisesDecision: ref.nullable(),
  })
  .strict();
export type Candidate = z.infer<typeof CandidateSchema>;
export const OverseerDispositionSchema = z.enum([
  /** The required scan found no open owner choice. */
  "SCREENED_CLEAR",
  /** One or more owner choices are still open. */
  "REQUIRES_OWNER",
  /** Cannot be assessed or recommended without a missing source. */
  "BLOCKED_ON_EVIDENCE",
]);
/** A screening as Astra returns it in its checkpoint. */
export const ScreeningSchema = z
  .object({
    taskId,
    /** The specification Astra screened; must be the pinned one. */
    specDigest: z.string(),
    disposition: OverseerDispositionSchema,
    /** Source-based explanation of the disposition. */
    reason: text,
    sourceRefs: z.array(ref).max(20),
    candidates: z.array(CandidateSchema).max(20),
  })
  .strict();
export type Screening = z.infer<typeof ScreeningSchema>;
export type Disposition = z.infer<typeof OverseerDispositionSchema> | "EXEMPT";

/**
 * The stable key of the owner question a required choice becomes: the
 * candidate's key, scoped by the tasks it holds (at their specifications
 * when screened), the sources it rests on and the decision it would change,
 * so two different choices that happen to share a key never collapse, and
 * the same choice asked again (another checkpoint, another request) does not
 * ask twice. A revision of an affected task makes it a new question: an
 * answer binds the specifications it was given on (as every question in the
 * journal does), and an answer the owner closed as historical for a revised
 * task is never taken as settling that task's choice (review round 3); the
 * earlier answer can still settle the choice when Astra cites it as
 * decidedBy and it applies.
 */
export function candidateQuestionKey(
  c: Pick<
    Candidate,
    "key" | "affectedTaskIds" | "sourceRefs" | "revisesDecision"
  >,
  /** The affected tasks' specification digests when screened. */
  affectedSpecs: Record<string, string>,
) {
  const affectedTaskIds = [...new Set(c.affectedTaskIds)].sort();
  const scope = digest({
    affectedTaskIds,
    affectedSpecs: affectedTaskIds.map((id) => [id, affectedSpecs[id] ?? null]),
    sourceRefs: [...new Set(c.sourceRefs)].sort(),
    // Which recorded decision the choice would change is part of what the
    // owner is asked: another target is another question, never the old
    // answer reused (review round 2).
    revisesDecision: c.revisesDecision ?? null,
  }).slice(0, 16);
  return PRE_DESIGN_QUESTION_PREFIX + c.key + ":" + scope;
}
/** The owner question for a required choice: recommendation first, 2 to 4 answers, scope. */
export function candidateQuestionText(taskId: string, c: Candidate): string {
  const affected = [...new Set(c.affectedTaskIds)].sort();
  const lines = [
    `Pre-design choice for task ${taskId} (${c.key}): ${c.choice}`,
    c.recommendation
      ? `Recommended: ${c.recommendation}`
      : "No recommendation was given.",
    `Uncertainty: ${c.uncertainty}`,
    "Options: " +
      c.options
        .map((o, i) => `${i + 1}) ${o.label}: ${o.consequences}`)
        .join(" "),
    `If postponed: ${c.ifPostponed}`,
    `Affects: ${affected.join(", ")} (these tasks wait for your answer; other tasks continue).`,
    `Basis: ${c.basis === "EVIDENCE" ? "cited evidence" : "inference"}; sources: ${
      c.sourceRefs.length ? c.sourceRefs.join("; ") : "none cited"
    }.`,
    ...(c.revisesDecision
      ? [
          `This would change recorded decision ${c.revisesDecision}. Your answer alone changes nothing: a new decision record is needed, and a revision and rebind if the specification changes.`,
        ]
      : []),
    "Your answer is recorded as context for the work. It is not a grant, an acceptance or a change of scope.",
  ];
  return lines.join("\n");
}

/** What Astra's brief says about screening, when the project has opted-in tasks. */
export const OVERSEER_SCREENING_GUIDANCE = [
  "PRE-DESIGN DECISION DISCOVERY. preDesign lists the tasks opted in to it: each task's eligibility (required or not, with the reasons), its latest screening of its current specification and that screening's state (current, or stale with the reasons, and the hold the controller applies). A task with eligibility.required true cannot be assigned until its current specification has a current screening; give one in screenings (one per task) for every such task whose state is not current (hold PRE_DESIGN_SCREEN_REQUIRED or PRE_DESIGN_SCREEN_STALE) that is ready for design.",
  "To screen a task: read the owner's request, the task's sources and evidence, its dependencies' specifications and deliverables, the owner's recorded decisions and answered questions, the other tasks' contracts and the previous plan. Before detailed design begins, find the choices that materially affect the user's experience, domain rules, creative direction, cross-task contracts, reversibility, privacy or significant cost. Report each as a candidate with a stable key (the same choice always gets the same key), its type (OWNER_REQUIRED: only the owner can choose and it is open; ENGINEERING: a routine trade-off you settle in technicalDecisions; ALREADY_DECIDED: settled on the record, decidedBy naming the recorded decision id or the answered question id; CONDITIONAL: arises only if something later turns out one way; EVIDENCE_BLOCKED: cannot be judged without a source that is missing), whether it rests on cited evidence or inference, its sources, the tasks it affects (the screened task among them), and for an owner choice 2 to 4 genuinely viable options with their consequences in everyday language, your recommendation first and its uncertainty. Never invent an approved choice, present a settled choice as open, or turn an engineering preference into an owner question; a question already answered in snapshot.questions is cited as decidedBy, not asked again.",
  "disposition: SCREENED_CLEAR when no candidate is OWNER_REQUIRED or EVIDENCE_BLOCKED; REQUIRES_OWNER when an owner choice is open; BLOCKED_ON_EVIDENCE when a source is missing, and then also ask, in questionsForOwner or questionsForOperator scoped to the task, for exactly what is missing. The controller records each screening with this checkpoint and turns each OWNER_REQUIRED candidate into an owner question that holds its affected tasks (do not list it in questionsForOwner as well). A choice that affects several tasks is listed once, under one task, with every task it affects in affectedTaskIds; a copy under another task must be identical in key, affected tasks, sources, choice, options and recommendation, or the checkpoint is rejected, and a key already used in this project for another choice cannot be reused. A task with an open owner choice or an evidence hold, or affected by another task's open owner choice, cannot be in nextTaskIds, and a task whose required screening is missing or stale cannot be assigned; a task whose screening went stale before its questions were recorded must be screened again in this checkpoint. Tasks with eligibility.required false need no screening, and a screening for them is rejected. A screening attests that the screen was done; it never claims every real-world fork was found, and later evidence may raise a new candidate.",
].join("\n");

/** What can change a task's design forks: the inputs of its screening's currency. */
export type CurrencyInputs = {
  version: 1;
  taskId: string;
  spec: string;
  /** Related tasks (dependencies, the task it fixes, shared resources, shared repository paths) and their specifications. */
  peers: Array<{ id: string; why: string[]; spec: string }>;
  /** The owner's decisions recorded on the task, and whether each is revoked. */
  decisions: Array<{ id: string; revoked: boolean }>;
};
export type Currency = { digest: string; inputs: CurrencyInputs };
/**
 * Why one task is related to another, as the scoped macro audit (#20)
 * defines it: an explicit or transitive dependency or the task it fixes, a
 * shared named resource, or overlapping target paths in the same repository.
 * Local `writePaths` are private to each worker and relate nothing; the
 * drive-changes staging folder is not a repository path.
 */
export function peerRelations(
  t: Task,
  all: Task[],
): Array<{ id: string; why: string[] }> {
  const byId = new Map(all.map((x) => [x.id, x]));
  const dependencies = new Set<string>();
  const visit = (id: string) => {
    if (dependencies.has(id) || id === t.id) return;
    dependencies.add(id);
    const node = byId.get(id);
    for (const d of node?.dependencies ?? []) visit(d);
    if (node?.fixes) visit(node.fixes);
  };
  for (const d of t.dependencies) visit(d);
  if (t.fixes) visit(t.fixes);
  const targets = (x: Task) =>
    x.writePaths.filter(
      (p) => p !== DRIVE_CHANGES_DIR && !p.startsWith(DRIVE_CHANGES_DIR + "/"),
    );
  return (
    all
      .filter((x) => x.id !== t.id)
      .flatMap((x) => {
        const why: string[] = [];
        if (dependencies.has(x.id)) why.push("DEPENDENCY_OR_FIX");
        if (t.resources.some((r) => x.resources.includes(r)))
          why.push("SHARED_RESOURCE");
        if (
          t.repo &&
          x.repo &&
          t.repo.name === x.repo.name &&
          targets(t).some((p) => targets(x).some((q) => overlaps(p, q)))
        )
          why.push("SHARED_REPO_TARGET_PATH");
        return why.length ? [{ id: x.id, why: why.sort() }] : [];
      })
      // Plain order, the same under every locale.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );
}
/** What changed between a screening's currency inputs and the current ones, as codes. */
export function staleReasons(
  recorded: CurrencyInputs,
  now: CurrencyInputs,
): string[] {
  const reasons: string[] = [];
  if (recorded.spec !== now.spec) reasons.push("OWN_SPEC_CHANGED");
  const before = new Map(recorded.peers.map((p) => [p.id, p])),
    after = new Map(now.peers.map((p) => [p.id, p]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(id),
      a = after.get(id);
    if (!b) reasons.push("PEER_ADDED:" + id);
    else if (!a) reasons.push("PEER_REMOVED:" + id);
    else if (canonical(b) !== canonical(a))
      reasons.push("PEER_SPEC_CHANGED:" + id);
  }
  if (canonical(recorded.decisions) !== canonical(now.decisions))
    reasons.push("OWN_DECISIONS_CHANGED");
  return reasons;
}

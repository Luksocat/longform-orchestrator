import { canonical, digest } from "./domain.js";
import {
  checkpointCurrent,
  covers,
  questionScope,
  questionResolved,
  type ProjectContext,
  COORDINATION_INSTRUCTION,
} from "./project.js";
import { OWNER_TEXT_IN_SANDBOX } from "./providers.js";
/**
 * What an adaptive task's view may carry of overseer text (issue #12,
 * contract section 8.4): the checkpoint in force's plan only when it is a
 * substantive checkpoint that guides this task, and no question whose
 * producer is hidden from it (coordination-only and pre-adaptive
 * checkpoints, and substantive ones that do not guide this task).
 */
export type AdaptiveProjection = {
  planHidden: boolean;
  hiddenQuestionProducers: ReadonlySet<string>;
};
/** The run that produced a question's text, when a run did (contract section 10.1). */
export function questionProducer(q: { askedBy?: unknown; key?: unknown }): string | undefined {
  if (typeof q.askedBy === "string" && q.askedBy) return q.askedBy;
  const m = /^worker-(?:operator-)?question:(.+)$/.exec(String(q.key ?? ""));
  return m?.[1];
}

/**
 * What each model run is shown of the project. The controller keeps the whole
 * record (ProjectContext, fingerprinted by its inputDigest); a brief carries
 * only the part the run's role needs, so it stays within the provider's size
 * limit as a project grows.
 *
 * - Astra (the overseer) sees the whole project, with settled and superseded
 *   detail summarized, and the full record as a file in its workspace.
 * - Every other role sees its own task's slice: the owner's request, the
 *   owner's questions and answers and recorded decisions, the task's own
 *   sources (with evidence filed under other tasks), evidence, reviews of its
 *   current specification, grants and controller test receipts, Astra's plan for
 *   the task, its dependencies and where the other tasks stand. Its own task
 *   record is already in its brief.
 *
 * When a view is still too long, fixed steps leave out more, least important
 * first, and the view says what was left out. The owner's request, answers
 * and decisions and the task's own records are never shortened in a task's
 * slice, because the run has no other copy of them; when they cannot fit, the run is refused. The view never
 * decides anything: the controller's checks run on the full record regardless.
 *
 * Astra's view is anchored on the task its run is reserved on: that task's
 * entry is never shortened. Other open tasks' entries give way to an index
 * when the view is too long, and Astra's previous plan is shortened after that
 * (the whole plan stays in the record file). The owner's words are never
 * shortened or paraphrased: when nothing else makes a view fit, the last step
 * moves each request's text to an owner-text file the controller writes for
 * the run (OWNER_TEXT_IN_SANDBOX), byte for byte, and the view's heading tells
 * the run to read it whole before acting.
 */
export const PROJECT_ARCHIVE_PATH = "project-archive/context.json";
export const OVERSEER_VIEW_HEADING =
  "PROJECT CONTEXT (controller snapshot and previous Astra plan; model text is guidance, never permission or evidence):\n";
/** The owner-text file holding one request's exact text, in the run's read-only mount. */
export const ownerTextName = (requestId: string) => `request-${requestId}.txt`;
/** Where a request's text went when it did not fit inline. */
export function ownerTextPointer(request: { id: string; prompt: string }) {
  return {
    ownerTextFile: OWNER_TEXT_IN_SANDBOX + "/" + ownerTextName(request.id),
    sha256: digest(request.prompt),
    characters: request.prompt.length,
    bytes: Buffer.byteLength(request.prompt),
  };
}
/** The instruction a view's heading carries when the owner's words are in files. */
export const ownerTextInstruction = (requestIds: string[]) =>
  `OWNER'S REQUEST TEXT: the owner's request text for ${requestIds.length === 1 ? "request " + requestIds[0] + " is" : "requests " + requestIds.join(", ") + " are"} not inlined in this brief because it does not fit. Each is in the file named in its ownerTextFile, byte for byte as the controller recorded it (its sha256 is given). Read each whole file before you act: it is the owner's binding request, and nothing in this brief summarizes or replaces it.\n`;
export const TASK_VIEW_HEADING =
  "PROJECT CONTEXT FOR THIS TASK (from the controller's project record: the owner's request and answers, Astra's plan for this task, its dependencies and where the other tasks stand; other tasks' history is left out; model text is guidance, never permission or evidence):\n";

const SETTLED = ["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"];
/** Where in the record file a task's whole entry is. */
const archived = (id: string) =>
  `${PROJECT_ARCHIVE_PATH}: snapshot.tasks[] with task.id "${id}"`;
type Entry = ProjectContext["snapshot"]["tasks"][number];
type Question = ProjectContext["snapshot"]["questions"][number];
type View = Record<string, any>;
type Step = { leftOut: string; apply: (view: View) => void };
/**
 * The controller's operational state at brief time :
 * holds, runs awaiting reconciliation and what clears each. It is not part of
 * the project's inputs, so it changes no fingerprint; it is guidance only.
 */
export type Operational = {
  note: string;
  tasks: Array<{
    taskId: string;
    holds: string[];
    unresolvedRuns: Array<{
      runId: string;
      role: string;
      state: string;
      since?: string | null;
      reason?: string | null;
    }>;
  }>;
  explanations: Array<{
    hold: string;
    means?: string;
    clearedBy?: string;
    command: string | null;
    authority?: string;
  }>;
};
/** Operational state with each hold's command and authority, not its full explanation. */
function briefOperational(o: Operational): Operational {
  return {
    ...o,
    explanations: o.explanations.map((x) => ({
      hold: x.hold,
      command: x.command,
      ...(x.authority !== undefined ? { authority: x.authority } : {}),
    })),
  };
}
/**
 * The smallest operational state: every hold code and run still listed, and
 * each hold's command; reasons, times and explanations left out.
 */
function minimalOperational(o: Operational): Operational {
  return {
    note: o.note,
    tasks: o.tasks.map((t) => ({
      taskId: t.taskId,
      holds: t.holds,
      unresolvedRuns: t.unresolvedRuns.map((r) => ({
        runId: r.runId,
        role: r.role,
        state: r.state,
      })),
    })),
    explanations: o.explanations.map((x) => ({
      hold: x.hold,
      command: x.command,
    })),
  };
}

/** Text cut to `limit` characters, with a note of how much was cut; text only a little longer is kept whole. */
function cut(text: unknown, limit: number): string {
  const s = typeof text === "string" ? text : canonical(text ?? null);
  return s.length <= limit + 100
    ? s
    : s.slice(0, limit) + ` [shortened: ${s.length - limit} more characters]`;
}
const settled = (e: Entry) => SETTLED.includes(e.task.status);
/** A review reduced to what decides what happens next. */
function reviewSummary(review: any, limit: number) {
  const count = (m: string) =>
    (review?.findings ?? []).filter((f: any) => f?.materiality === m).length;
  return {
    runId: review?.runId ?? null,
    verdict: review?.verdict ?? null,
    findings: {
      CRITICAL: count("CRITICAL"),
      MAJOR: count("MAJOR"),
      MINOR: count("MINOR"),
      INFO: count("INFO"),
    },
    remediation: (review?.remediation ?? []).map((r: unknown) => cut(r, limit)),
    residualHolds: (review?.residualHolds ?? []).map((r: unknown) =>
      cut(r, limit),
    ),
  };
}
/**
 * A question with its answers, whole: the owner's can bind the work. It says
 * whom it is for (the owner, or the operator for facts about the
 * orchestrator's records) and which tasks wait for it, or the whole project.
 */
function questionView(q: Question, taskId?: string, currentSpec?: string) {
  const scope = questionScope(q);
  return {
    id: q.id,
    audience: scope.audience,
    ...(scope.projectWide
      ? { projectWide: true }
      : { taskIds: scope.taskIds }),
    kind: q.kind,
    text: q.text,
    status: q.answers.length ? "ANSWERED" : q.deferred ? "DEFERRED" : "OPEN",
    ...(q.deferred ? { deferred: q.deferred } : {}),
    answers: q.answers.map((a: any) => ({
      text: a?.text,
      sourceRef: a?.sourceRef ?? null,
      // A reply recorded before audiences was the owner's.
      answeredAs: a?.answeredAs === "OPERATOR" ? "OPERATOR" : "OWNER",
      ...(a?.historicalOnly
        ? {
            historicalOnly: true,
            // Per task: an ordinary answer only for a task the answer did not
            // leave out whose specification is still the one asked about
            // (not revised later either).
            appliesToCurrentSpecification:
              !!taskId &&
              !Object.hasOwn(a.historicalForSpec ?? {}, taskId) &&
              !!currentSpec &&
              (q.specDigests?.[taskId] ??
                (q.taskId === taskId ? q.specDigest : undefined)) ===
                currentSpec,
            historicalForTasks: Object.keys(a.historicalForSpec ?? {}).sort(),
          }
        : {}),
      ...(a?.evidence ? { evidence: a.evidence } : {}),
    })),
  };
}
/** Why a task is BLOCKED when the controller records no hold on it. */
export function statusNote(e: Entry): string | undefined {
  if (e.task.status !== "BLOCKED" || !e.gate || e.gate.holds.length)
    return undefined;
  return "The controller records no hold on this task. BLOCKED is also the status a task is given when its specification is revised; such a task is dispatchable, and once assigned its next worker run starts the revised specification afresh. Runs in progress or awaiting reconciliation are not shown in this view.";
}

/**
 * Astra's view. Always: a settled task (verified, accepted, cancelled or
 * superseded) is summarized; a request whose tasks are all settled keeps no
 * prompt; only the latest review and assessment of an open task are shown
 * whole; the decision history leaves out the latest plan, which `previous`
 * already holds. The full record is at PROJECT_ARCHIVE_PATH. The entry of the
 * task the run is anchored on is never shortened.
 */
function overseerView(
  context: ProjectContext,
  anchor: string,
  operational?: Operational,
): { view: View; steps: Step[] } {
  const snap = context.snapshot;
  const byId = new Map(snap.tasks.map((e) => [e.task.id, e]));
  // A request is settled when, for every task it binds, its own latest
  // binding is the task's current specification and that task is settled. A
  // task revised and rebound by a later request leaves the earlier request
  // unsettled: finishing the new specification does not finish the old goals.
  const requestSettled = (requestId: string) => {
    if (requestId === context.requestId) return false;
    const latest = new Map<string, string>();
    for (const b of snap.taskBindings)
      if (b.requestId === requestId) latest.set(b.taskId, b.specDigest);
    return (
      latest.size > 0 &&
      [...latest].every(([id, spec]) => {
        const e = byId.get(id);
        return !!e && e.specDigest === spec && settled(e);
      })
    );
  };
  const open = (e: Entry) => {
    const note = statusNote(e);
    return {
      ...e,
      ...(note ? { statusNote: note } : {}),
      assessments: e.assessments.slice(-1),
      reviews: e.reviews.map((r: any, i: number) =>
        i === e.reviews.length - 1 ? r : reviewSummary(r, 300),
      ),
    };
  };
  const closed = (e: Entry) => ({
    task: {
      id: e.task.id,
      title: e.task.title,
      status: e.task.status,
      deliverable: e.task.deliverable,
      dependencies: e.task.dependencies,
      specVersion: e.task.specVersion,
      artifactRevision: e.task.artifactRevision,
    },
    specDigest: e.specDigest,
    gate: e.gate,
    artifact: e.artifact
      ? {
          runId: e.artifact.runId,
          digest: e.artifact.digest,
          path: e.artifact.path,
        }
      : null,
    reviews: e.reviews.length
      ? [reviewSummary(e.reviews[e.reviews.length - 1], 500)]
      : [],
    archived:
      "Settled. Its scope, artifact summary, evidence, review details, audits and grants are in " +
      PROJECT_ARCHIVE_PATH +
      ".",
  });
  const view: View = {
    requestId: context.requestId,
    ...(byId.has(anchor) ? { anchoredTask: anchor } : {}),
    snapshot: {
      projectId: snap.projectId,
      inputDigest: snap.inputDigest,
      requests: snap.requests.map((r) =>
        requestSettled(r.id)
          ? {
              id: r.id,
              sourceRef: r.sourceRef,
              context: r.context,
              archived: `Every task of this request is settled; its prompt (${r.prompt.length} characters) is in ${PROJECT_ARCHIVE_PATH}.`,
            }
          : r,
      ),
      // The anchored task's entry stays whole even when it is settled (the
      // closing checkpoint can anchor on a verified task).
      tasks: snap.tasks.map((e) =>
        settled(e) && e.task.id !== anchor ? closed(e) : open(e),
      ),
      taskBindings: snap.taskBindings,
      questions: snap.questions,
    },
    ...(context.previous ? { previous: context.previous } : {}),
    decisionHistory: context.decisionHistory.filter(
      (d) => d.runId !== context.previous?.runId,
    ),
    // Pre-design discovery (proposal #17): the opted-in tasks' state, whole.
    ...(context.preDesign
      ? { preDesign: context.preDesign.map(preDesignView) }
      : {}),
    ...(operational ? { operational } : {}),
    view: {
      fullRecord: PROJECT_ARCHIVE_PATH,
      note: "Settled tasks, settled requests' prompts, superseded reviews and assessments, and the latest plan's copy in decisionHistory are summarized here; the full record is in fullRecord. Read it when you need a detail left out. The anchored task's entry (anchoredTask) is always whole; when the project is large, other open tasks appear as index entries (indexed) whose whole entries are in fullRecord.",
      leftOut: [] as string[],
    },
  };
  // Steps that shorten open tasks never touch the anchored task's entry.
  const openTasks = (v: View, f: (t: View) => void) =>
    v.snapshot.tasks
      .filter((t: View) => !t.archived && !t.indexed && t.task?.id !== anchor)
      .forEach(f);
  const shorterPlan = (v: View, change: (plan: View) => void) => {
    if (!v.previous?.plan) return;
    change(v.previous.plan);
    v.previous.planShortened = `Astra's previous plan is shortened here; the whole plan is "previous" in ${PROJECT_ARCHIVE_PATH}. No item was dropped.`;
  };
  const steps: Step[] = [
    {
      leftOut: "technical decisions from Astra's earlier plans",
      apply: (v) => (v.decisionHistory = []),
    },
    {
      leftOut: "evidence details other than id, kind, uri and authority",
      apply: (v) =>
        openTasks(v, (t) => {
          t.evidence = t.evidence.map((x: any) => ({
            id: x?.id,
            kind: x?.kind,
            uri: x?.uri,
            authorityTier: x?.authorityTier,
          }));
        }),
    },
    {
      leftOut: "grant details other than id and operations",
      apply: (v) =>
        openTasks(v, (t) => {
          t.grants = t.grants.map((g: any) => ({
            id: g?.id,
            operations: g?.operations,
          }));
        }),
    },
    {
      leftOut: "difficulty assessments",
      apply: (v) => openTasks(v, (t) => (t.assessments = [])),
    },
    {
      leftOut: "audit details",
      apply: (v) =>
        openTasks(v, (t) => {
          t.audits = t.audits.map((a: any) => ({
            id: a?.id,
            kind: a?.kind,
            artifactRevision: a?.artifactRevision,
            result: a?.result,
            checks: a?.checks,
            limitations: a?.limitations,
          }));
        }),
    },
    {
      leftOut:
        "operational explanations beyond each hold's command and authority (codes are listed)",
      apply: (v) => {
        if (v.operational) v.operational = briefOperational(v.operational);
      },
    },
    {
      leftOut: "artifact summaries beyond 1,500 characters",
      apply: (v) =>
        openTasks(v, (t) => {
          if (t.artifact)
            t.artifact = {
              ...t.artifact,
              summary: cut(t.artifact.summary, 1_500),
            };
        }),
    },
    {
      leftOut:
        "review details beyond verdict, must-fix items and residual holds",
      apply: (v) =>
        openTasks(v, (t) => {
          t.reviews = t.reviews.map((r: any) =>
            "auditAssessments" in r || "authorshipDisclosure" in r
              ? reviewSummary(r, 500)
              : r,
          );
        }),
    },
    {
      leftOut:
        "pre-design candidates beyond key, type, choice, recommendation and what settled them (the whole screening is in the record file)",
      apply: (v) => {
        if (v.preDesign) v.preDesign = v.preDesign.map(briefPreDesign);
      },
    },
    {
      leftOut: "artifact summaries beyond 300 characters",
      apply: (v) =>
        openTasks(v, (t) => {
          if (t.artifact)
            t.artifact = {
              ...t.artifact,
              summary: cut(t.artifact.summary, 300),
            };
        }),
    },
    {
      leftOut:
        "other open tasks' records: an index entry stands in for each, with its whole entry in the record file",
      apply: (v) =>
        (v.snapshot.tasks = v.snapshot.tasks.map((t: View) =>
          t.archived || t.indexed || t.task?.id === anchor
            ? t
            : indexEntry(byId.get(t.task.id)!, snap.questions),
        )),
    },
    {
      leftOut:
        "the text of Astra's previous plan beyond fixed lengths (every item kept)",
      apply: (v) =>
        shorterPlan(v, (plan) => {
          plan.summary = cut(plan.summary, 1_500);
          plan.assignments = (plan.assignments ?? []).map((a: View) => ({
            ...a,
            instruction: cut(a?.instruction, 600),
          }));
          plan.milestones = (plan.milestones ?? []).map((m: unknown) =>
            cut(m, 300),
          );
          plan.risks = (plan.risks ?? []).map((r: unknown) => cut(r, 300));
          plan.technicalDecisions = (plan.technicalDecisions ?? []).map(
            (d: View) => ({
              ...d,
              decision: cut(d?.decision, 600),
              reason: cut(d?.reason, 200),
            }),
          );
          if (plan.screenings?.length)
            plan.screenings = plan.screenings.map((s: View) => ({
              taskId: s?.taskId,
              disposition: s?.disposition,
              candidates: (s?.candidates ?? []).map((c: View) => ({
                key: c?.key,
                type: c?.type,
              })),
            }));
        }),
    },
    {
      leftOut:
        "the reasons and sources of Astra's previous technical decisions (each decision kept, shortened)",
      apply: (v) =>
        shorterPlan(v, (plan) => {
          plan.technicalDecisions = (plan.technicalDecisions ?? []).map(
            (d: View) => ({ decision: cut(d?.decision, 300) }),
          );
        }),
    },
    {
      // The owner's answers are never shortened: only the question asked.
      leftOut: "answered questions' own text beyond 1,500 characters",
      apply: (v) =>
        (v.snapshot.questions = v.snapshot.questions.map((q: any) =>
          q.answers?.length ? { ...q, text: cut(q.text, 1_500) } : q,
        )),
    },
    {
      leftOut:
        "operational detail beyond each hold's code and command and each unsettled run (the request view has the rest)",
      apply: (v) => {
        if (v.operational) v.operational = minimalOperational(v.operational);
      },
    },
    {
      leftOut:
        "the owner's request text, moved whole to the owner-text files named in ownerTextFile",
      apply: (v) =>
        (v.snapshot.requests = v.snapshot.requests.map((r: View) =>
          typeof r.prompt === "string"
            ? {
                id: r.id,
                sourceRef: r.sourceRef,
                context: r.context,
                ...ownerTextPointer({ id: r.id, prompt: r.prompt }),
              }
            : r,
        )),
    },
  ];
  return { view, steps };
}
type PreDesign = NonNullable<ProjectContext["preDesign"]>[number];
/**
 * A task's pre-design state for a brief (proposal #17): its eligibility, the
 * latest screening of its specification with every candidate (so a worker
 * or reviewer sees which choices are settled and how), the owner questions
 * it raised and their status, and the hold, if any. The currency inputs are
 * summarized as the stale reasons.
 */
function preDesignView(s: PreDesign) {
  return {
    taskId: s.taskId,
    eligibility: s.eligibility,
    current: s.current,
    stale: s.stale,
    hold: s.hold,
    questions: s.questions,
    latest: s.latest
      ? {
          disposition: s.latest.disposition,
          reason: s.latest.reason,
          sourceRefs: s.latest.sourceRefs,
          candidates: s.latest.candidates,
          checkpointRunId: s.latest.checkpointRunId,
          checkpointRevision: s.latest.checkpointRevision,
          recordedAt: s.latest.recordedAt,
        }
      : null,
  };
}
/** The same with each candidate reduced to what settles the work. */
function briefPreDesign(v: View) {
  return {
    ...v,
    latest: v.latest
      ? {
          ...v.latest,
          candidates: (v.latest.candidates ?? []).map((c: View) => ({
            key: c?.key,
            type: c?.type,
            choice: cut(c?.choice, 300),
            recommendation:
              typeof c?.recommendation === "string"
                ? cut(c.recommendation, 300)
                : null,
            decidedBy: c?.decidedBy ?? null,
            revisesDecision: c?.revisesDecision ?? null,
          })),
        }
      : null,
  };
}
/** What an open task in Astra's index is waiting for, in plain words; guidance only. */
function waitingFor(e: Entry, questions: Question[]): string {
  const open = questions.find(
    (q) => !questionResolved(q) && covers(q, e.task.id),
  );
  if (open)
    return `an answer to ${questionScope(open).audience === "OPERATOR" ? "operator" : "owner"} question ${open.id}`;
  const holds = e.gate?.holds ?? [];
  if (holds.length) return "its holds to clear: " + holds.slice(0, 3).join("; ");
  const verdict = (e.reviews.at(-1) as any)?.verdict;
  switch (e.task.status) {
    case "WAITING_REVIEW":
      return e.artifact ? "review of its sealed work" : "review";
    case "REMEDIATION_REQUIRED":
      return verdict === "FAIL"
        ? "rework after a failed review"
        : "a further worker run";
    case "RUNNING":
      return "its current run to finish";
    case "WAITING_OWNER":
      return "the owner";
    default:
      return "an assignment and a worker run";
  }
}
/** An open task reduced to what Astra needs to plan around it. */
function indexEntry(e: Entry, questions: Question[]) {
  const review = e.reviews.at(-1) as any;
  return {
    indexed: true,
    task: {
      id: e.task.id,
      title: e.task.title,
      status: e.task.status,
      dependencies: e.task.dependencies,
    },
    specDigest: e.specDigest,
    holds: e.gate?.holds ?? [],
    completionCurrent: e.gate?.completionCurrent ?? false,
    latestReview: review
      ? { runId: review.runId ?? null, verdict: review.verdict ?? null }
      : null,
    artifact: e.artifact
      ? { runId: e.artifact.runId, path: e.artifact.path }
      : null,
    waitingFor: waitingFor(e, questions),
    ...(statusNote(e) ? { statusNote: statusNote(e) } : {}),
    fullRecord: archived(e.task.id),
  };
}

const preDesignOf = (context: ProjectContext, taskId: string) =>
  context.preDesign?.find((s) => s.taskId === taskId);
/** The slice for a worker, reviewer, assessor, advisor or moderator run. */
function taskView(
  context: ProjectContext,
  taskId: string,
  revoked?: Revoked,
  fixes?: Fixes,
  operational?: Operational,
  adaptive?: AdaptiveProjection,
): { view: View; steps: Step[] } {
  const snap = context.snapshot;
  const shown = (q: Question) =>
    !adaptive || !adaptive.hiddenQuestionProducers.has(questionProducer(q) ?? "");
  const own = snap.tasks.find((e) => e.task.id === taskId);
  const dependencies = own?.task.dependencies ?? [];
  const requestIds = new Set([
    context.requestId,
    ...snap.taskBindings
      .filter((b) => b.taskId === taskId)
      .map((b) => b.requestId),
  ]);
  const plan = context.previous?.plan;
  // The task's evidence, plus any envelope its source bindings name that is
  // filed under another task of the project, once each.
  const sourceIds = new Set((own?.task.sources ?? []).map((s) => s.evidenceId));
  const evidence = new Map<string, unknown>();
  for (const e of own?.evidence ?? []) evidence.set(e?.id, e);
  for (const other of snap.tasks)
    for (const e of other.evidence)
      if (sourceIds.has(e?.id) && !evidence.has(e.id)) evidence.set(e.id, e);
  const view: View = {
    projectId: snap.projectId,
    // The task's own records that its brief's task section does not carry,
    // whole: the sources it is bound to and their evidence envelopes, the
    // grants that authorize it, controller-run test receipts and its holds.
    thisTask: own
      ? {
          id: taskId,
          status: own.task.status,
          specDigest: own.specDigest,
          holds: own.gate?.holds ?? [],
          sources: own.task.sources,
          evidence: [...evidence.values()],
          // Reviews of the current specification: a proposal reply and its
          // follow-up review answer them, and their briefs carry a shortened
          // copy only.
          reviews: own.reviews.filter(
            (r: any) => r?.specDigest === own.specDigest,
          ),
          grants: own.grants.map((g: any) =>
            revoked?.grants ? { ...g, revoked: revoked.grants.has(g?.id) } : g,
          ),
          ...(!revoked?.grants && own.grantRevocations.length
            ? { grantRevocations: own.grantRevocations }
            : {}),
          controllerTests: own.tests,
        }
      : { id: taskId },
    ownerRequests: snap.requests
      .filter((r) => requestIds.has(r.id))
      .map((r) => ({ id: r.id, prompt: r.prompt, sourceRef: r.sourceRef })),
    // Questions that hold this task: on it, or on the whole project.
    ownerQuestions: snap.questions
      .filter(
        (q) =>
          questionScope(q).audience === "OWNER" && covers(q, taskId) && shown(q),
      )
      .map((q) => questionView(q, taskId, own?.specDigest)),
    operatorQuestions: snap.questions
      .filter(
        (q) =>
          questionScope(q).audience === "OPERATOR" &&
          covers(q, taskId) &&
          shown(q),
      )
      .map((q) => questionView(q, taskId, own?.specDigest)),
    // The owner's recorded decisions on this task, whole, with their limits.
    // `revoked` is filled in when the caller knows which were revoked;
    // otherwise the revocation records are listed as recorded.
    ownerDecisions: (own?.decisions ?? []).map((d: any) =>
      revoked?.decisions ? { ...d, revoked: revoked.decisions.has(d?.id) } : d,
    ),
    ...(!revoked?.decisions && own?.revocations.length
      ? { ownerDecisionRevocations: own.revocations }
      : {}),
    astraPlan: context.previous
      ? adaptive?.planHidden
        ? {
            revision: context.previous.revision,
            current: checkpointCurrent(snap, context.previous),
            mode: "COORDINATION_ONLY",
            assignment: plan!.assignments.some((a) => a.taskId === taskId)
              ? COORDINATION_INSTRUCTION
              : null,
            technicalDecisions: [],
          }
        : {
            revision: context.previous.revision,
            current: checkpointCurrent(snap, context.previous),
            assignment:
              plan!.assignments.find((a) => a.taskId === taskId)?.instruction ??
              null,
            technicalDecisions: plan!.technicalDecisions,
            summary: plan!.summary,
            milestones: plan!.milestones,
            risks: plan!.risks,
          }
      : null,
    dependencies: dependencies.map((id) => {
      const e = snap.tasks.find((x) => x.task.id === id);
      return e
        ? {
            id,
            title: e.task.title,
            status: e.task.status,
            deliverable: e.task.deliverable,
            summary: e.artifact ? cut(e.artifact.summary, 4_000) : null,
          }
        : { id, status: "NOT_IN_THIS_PROJECT" };
    }),
    // A task that fixes another task's failed work: that task and the review
    // the fix answers, as the worker's brief has it, so its reviewer can
    // check the fix against it.
    ...(fixes
      ? { fixes: { taskId: fixes.taskId, review: fixes.review ?? null } }
      : {}),
    // Pre-design discovery (proposal #17): this task's screening, with its
    // candidates, so the work follows the settled choices (the owner's
    // answers to the questions it raised are in ownerQuestions) and the
    // reviewer can check that no alternative was substituted.
    ...(preDesignOf(context, taskId)
      ? { preDesign: preDesignView(preDesignOf(context, taskId)!) }
      : {}),
    // This task's operational state only.
    ...(operational
      ? {
          operational: {
            ...operational,
            tasks: operational.tasks.filter((t) => t.taskId === taskId),
          },
        }
      : {}),
    otherTasks: snap.tasks
      .filter((e) => e.task.id !== taskId && !dependencies.includes(e.task.id))
      .map((e) => ({
        id: e.task.id,
        title: e.task.title,
        status: e.task.status,
      })),
    leftOut: [] as string[],
  };
  const steps: Step[] = [
    {
      leftOut: "Astra's project summary, milestones and risks",
      apply: (v) => {
        if (v.astraPlan) {
          delete v.astraPlan.summary;
          delete v.astraPlan.milestones;
          delete v.astraPlan.risks;
        }
      },
    },
    {
      leftOut: "the list of other tasks",
      apply: (v) => (v.otherTasks = []),
    },
    {
      leftOut:
        "operational explanations beyond each hold's command and authority (codes are listed)",
      apply: (v) => {
        if (v.operational) v.operational = briefOperational(v.operational);
      },
    },
    {
      leftOut: "dependency summaries beyond 500 characters",
      apply: (v) =>
        v.dependencies.forEach((d: View) => {
          if (typeof d.summary === "string") d.summary = cut(d.summary, 500);
        }),
    },
    {
      leftOut:
        "the reasons behind Astra's technical decisions beyond 300 characters",
      apply: (v) => {
        if (v.astraPlan)
          v.astraPlan.technicalDecisions = v.astraPlan.technicalDecisions.map(
            (d: View) => ({ ...d, reason: cut(d.reason, 300) }),
          );
      },
    },
    {
      leftOut: "dependency summaries",
      apply: (v) =>
        v.dependencies.forEach((d: View) => {
          if ("summary" in d) delete d.summary;
        }),
    },
    {
      leftOut:
        "pre-design candidates beyond key, type, choice, recommendation and what settled them",
      apply: (v) => {
        if (v.preDesign) v.preDesign = briefPreDesign(v.preDesign);
      },
    },
    {
      leftOut:
        "review findings beyond 500 characters each, proposals and audit assessments, for this task's reviews and the review a fix answers (must-fix items and residual holds are whole)",
      apply: (v) => {
        const brief = (r: View) => ({
          runId: r.runId,
          specDigest: r.specDigest,
          verdict: r.verdict,
          remediation: r.remediation,
          residualHolds: r.residualHolds,
          findings: (r.findings ?? []).map((f: View) => ({
            materiality: f?.materiality,
            description: cut(f?.description, 500),
          })),
        });
        if (v.thisTask.reviews)
          v.thisTask.reviews = v.thisTask.reviews.map(brief);
        if (v.fixes?.review) v.fixes.review = brief(v.fixes.review);
      },
    },
    {
      leftOut:
        "operational detail beyond each hold's code and command and each unsettled run (the request view has the rest)",
      apply: (v) => {
        if (v.operational) v.operational = minimalOperational(v.operational);
      },
    },
    {
      leftOut:
        "the owner's request text, moved whole to the owner-text files named in ownerTextFile",
      apply: (v) =>
        (v.ownerRequests = v.ownerRequests.map((r: View) =>
          typeof r.prompt === "string"
            ? {
                id: r.id,
                sourceRef: r.sourceRef,
                ...ownerTextPointer({ id: r.id, prompt: r.prompt }),
              }
            : r,
        )),
    },
  ];
  return { view, steps };
}

export type FittedView = {
  text: string;
  leftOut: string[];
  /** Requests whose text this rendering carries in owner-text files, not inline. */
  ownerTextRequests: string[];
};
/**
 * The project view for one run, as the fullest rendering that fits `room`
 * characters, or undefined when even the smallest does not. `smallest` is the
 * length of the smallest rendering, so a caller can keep that much room free.
 */
/** The task a fix task fixes, and the review of it the fix answers. */
export type Fixes = { taskId: string; review?: unknown };
/** Which of a task's decisions and grants the controller records as revoked. */
export type Revoked = {
  decisions?: ReadonlySet<string>;
  grants?: ReadonlySet<string>;
};
export function projectView(
  context: ProjectContext,
  role: string,
  taskId: string,
  options: {
    revoked?: Revoked;
    fixes?: Fixes;
    operational?: Operational;
    adaptive?: AdaptiveProjection;
  } = {},
) {
  const heading =
    role === "overseer" ? OVERSEER_VIEW_HEADING : TASK_VIEW_HEADING;
  const { view, steps } =
    role === "overseer"
      ? overseerView(context, taskId, options.operational)
      : taskView(
          context,
          taskId,
          options.revoked,
          options.fixes,
          options.operational,
          options.adaptive,
        );
  const leftOutOf = (v: View): string[] =>
    role === "overseer" ? v.view.leftOut : v.leftOut;
  const requestsOf = (v: View): View[] =>
    role === "overseer" ? v.snapshot.requests : v.ownerRequests;
  // The requests whose text the view carries: their text can move to files.
  const requests = requestsOf(view)
    .filter((r) => typeof r.prompt === "string")
    .map((r) => ({ id: r.id as string, prompt: r.prompt as string }));
  const render = (v: View): FittedView => {
    const moved = requestsOf(v)
      .filter((r) => typeof r.ownerTextFile === "string")
      .map((r) => r.id as string);
    return {
      text:
        (moved.length ? ownerTextInstruction(moved) : "") +
        heading +
        canonical(v),
      leftOut: [...leftOutOf(v)],
      ownerTextRequests: moved,
    };
  };
  // Each rendering applies one more step to the one before it; a step that
  // changes nothing adds no rendering and no note.
  const current: View = structuredClone(view);
  const renderings: FittedView[] = [render(current)];
  for (const step of steps) {
    const before = canonical(current);
    step.apply(current);
    if (canonical(current) === before) continue;
    leftOutOf(current).push(step.leftOut);
    renderings.push(render(current));
  }
  const smallest = Math.min(...renderings.map((r) => r.text.length));
  // The owner's words stay inline whenever that fits: the smallest rendering
  // that still carries them is what a run's optional context must leave room for.
  const smallestInline = Math.min(
    ...renderings
      .filter((r) => !r.ownerTextRequests.length)
      .map((r) => r.text.length),
  );
  return {
    smallest,
    smallestInline,
    full: renderings[0]!.text.length,
    /** Every request whose text this run's view carries (inline or in a file). */
    requests,
    fit(room: number): FittedView | undefined {
      return renderings.find((r) => r.text.length <= room);
    },
  };
}

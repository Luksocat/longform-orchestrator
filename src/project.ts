import { z } from "zod";
import { digest, specDigest, TaskSchema, type Task } from "./domain.js";
import type { Persistence } from "./store.js";
import {
  candidateQuestionKey,
  peerRelations,
  PRE_DESIGN_QUESTION_PREFIX,
  SCREENING_VERSION,
  ScreeningSchema,
  screeningEligibility,
  staleReasons,
  type Candidate,
  type Currency,
  type CurrencyInputs,
  type Disposition,
  type Eligibility,
} from "./screening.js";

const note = z.string().trim().min(1).max(4000);
/**
 * A question Astra asks, with the scope it declares :
 * the tasks that must wait for its answer, or the whole project, explicitly.
 */
const ScopedQuestionSchema = z
  .object({
    question: note,
    taskIds: z.array(z.string()).max(100),
    projectWide: z.boolean(),
  })
  .strict();
export type ScopedQuestion = z.infer<typeof ScopedQuestionSchema>;
/** Astra's technical plan is separate from owner decisions and controller evidence. */
export const ProjectPlanSchema = z
  .object({
    inputDigest: z.string(),
    summary: note,
    // ASK_OPERATOR: a factual question about the orchestrator's own state,
    // records or operation, for the operator (the driving chat), never an
    // owner decision.
    outcome: z.enum(["CONTINUE", "ASK_OWNER", "ASK_OPERATOR", "COMPLETE"]),
    assignments: z
      .array(z.object({ taskId: z.string(), instruction: note }).strict())
      .max(100),
    nextTaskIds: z.array(z.string()).max(100),
    milestones: z.array(note).max(40),
    technicalDecisions: z
      .array(
        z
          .object({
            decision: note,
            reason: note,
            sourceRefs: z.array(z.string()).max(20),
          })
          .strict(),
      )
      .max(40),
    risks: z.array(note).max(40),
    questionsForOwner: z.array(ScopedQuestionSchema).max(10),
    questionsForOperator: z.array(ScopedQuestionSchema).max(10),
    // Pre-design screenings of the tasks that need one (screening.ts). The
    // default keeps plans saved before screenings readable; the provider's
    // output schema lists the member as required, so a strict provider
    // always returns it (empty when no task needs a screening).
    screenings: z.array(ScreeningSchema).max(100).default([]),
  })
  .strict();
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;
/**
 * A stored plan's questions, as scoped questions. Plans saved before scopes
 * (questionsForOwner as plain strings, no operator questions) asked
 * request-wide owner questions, and are read that way.
 */
export function planQuestions(plan: Record<string, any>): {
  owner: ScopedQuestion[];
  operator: ScopedQuestion[];
} {
  const scoped = (list: unknown): ScopedQuestion[] =>
    (Array.isArray(list) ? list : []).map((q) =>
      typeof q === "string"
        ? { question: q, taskIds: [], projectWide: true }
        : (q as ScopedQuestion),
    );
  return {
    owner: scoped(plan.questionsForOwner),
    operator: scoped(plan.questionsForOperator),
  };
}
/** A recorded question's audience and scope, legacy records included. */
export type QuestionScope = {
  audience?: "OWNER" | "OPERATOR";
  taskId?: string;
  taskIds?: string[];
  projectWide?: boolean;
};
/** The tasks a question holds; an empty list with `projectWide`, everything. */
export function questionScope(q: QuestionScope): {
  audience: "OWNER" | "OPERATOR";
  taskIds: string[];
  projectWide: boolean;
} {
  const taskIds = q.taskIds?.length ? q.taskIds : q.taskId ? [q.taskId] : [];
  return {
    audience: q.audience === "OPERATOR" ? "OPERATOR" : "OWNER",
    taskIds,
    // A question with no task, recorded before scopes existed, held the whole request.
    projectWide: q.projectWide === true || !taskIds.length,
  };
}
/** Historical questions stay visible after the owner defers an optional one. */
export function questionResolved(q: { answers?: unknown[]; deferred?: unknown }): boolean {
  return !!q.answers?.length || !!q.deferred;
}
/**
 * The tasks a question's historical answers leave out: those revised after
 * it was asked. For the other tasks it covers, the answer is an ordinary one.
 */
export function historicalTasks(q: { answers?: unknown[] }): string[] {
  return [
    ...new Set(
      (q.answers ?? []).flatMap((a: any) =>
        a?.historicalOnly ? Object.keys(a.historicalForSpec ?? {}) : [],
      ),
    ),
  ].sort();
}
/**
 * Whether the owner has answered the question in a way that applies to
 * every one of these tasks: an owner question that covers each of them
 * (scoped to it, or project-wide: review round 5), with an answer the owner
 * gave (a reply recorded before audiences was the owner's; an operator's
 * answer is a fact, never a choice). An answer the owner closed as
 * historical applies only to a task it did not leave out (review round 3)
 * whose specification, given by `specOf`, is still the one the question was
 * asked on, not revised later either (review round 4), as the question view
 * reads it. Only such an answer settles a pre-design choice or can be cited
 * as settling one.
 */
export function ownerAnswerApplies(
  q: QuestionScope & {
    answers?: unknown[];
    specDigest?: string;
    specDigests?: Record<string, string>;
  },
  taskIds: string[],
  specOf: (taskId: string) => string | undefined,
): boolean {
  if (questionScope(q).audience !== "OWNER") return false;
  if (!taskIds.every((id) => covers(q, id))) return false;
  const askedOn = (id: string) =>
    q.specDigests?.[id] ?? (q.taskId === id ? q.specDigest : undefined);
  return (q.answers ?? []).some((a: any) => {
    if (!a || a.answeredAs === "OPERATOR") return false;
    if (!a.historicalOnly) return true;
    const historical = a.historicalForSpec ?? {};
    return taskIds.every(
      (id) =>
        !Object.hasOwn(historical, id) &&
        askedOn(id) !== undefined &&
        askedOn(id) === specOf(id),
    );
  });
}
/** Whether an open question holds this task: project-wide, or scoped to it. */
export function covers(q: QuestionScope, taskId: string): boolean {
  const scope = questionScope(q);
  return scope.projectWide || scope.taskIds.includes(taskId);
}

function bodies(db: Persistence, table: string, taskId: string) {
  // Table names are constants supplied only by this module.
  return db
    .all<{
      body: string;
    }>(`SELECT body FROM ${table} WHERE task_id=? ORDER BY rowid`, taskId)
    .map((r) => JSON.parse(r.body));
}
function journal(db: Persistence) {
  return db
    .all<{
      seq: number;
      kind: string;
      body: string;
    }>("SELECT seq,kind,body FROM events WHERE kind LIKE 'WORKFLOW_%' ORDER BY seq")
    .map((e) => ({ ...e, body: JSON.parse(e.body) }));
}
export function projectRequestForTask(
  db: Persistence,
  taskId: string,
): string | undefined {
  return journal(db)
    .filter(
      (e) =>
        ["WORKFLOW_TASKS_ATTACHED", "WORKFLOW_TASKS_REBOUND"].includes(
          e.kind,
        ) && e.body.bindings.some((b: any) => b.taskId === taskId),
    )
    .at(-1)?.body.requestId;
}

/** Explicit project membership; no cwd/programme guessing or cross-host export. */
export type ProjectGate = {
  holds: string[];
  completionCurrent: boolean;
  completionIssue: string | null;
};
export type ProjectGates = (taskId: string) => ProjectGate;
export function projectSnapshot(
  db: Persistence,
  requestId: string,
  gates?: ProjectGates,
) {
  const events = journal(db);
  const all = events
    .filter((e) => e.kind === "WORKFLOW_SUBMITTED")
    .map((e) => e.body.request);
  const request = all.find((r) => r.id === requestId);
  if (!request) throw new Error("REQUEST_NOT_FOUND:" + requestId);
  const projectId = request.context.projectKey
    ? "project:" + request.context.projectKey
    : "request:" + request.id;
  const requests = all.filter((r) =>
    request.context.projectKey
      ? r.context.projectKey === request.context.projectKey
      : r.id === request.id,
  );
  if (
    requests.some(
      (r) =>
        r.host &&
        request.host &&
        r.host !== request.host &&
        r.host !== "operator" &&
        request.host !== "operator",
    )
  )
    throw new Error("PROJECT_OWNED_BY_OTHER_HOST");
  const ids = new Set(requests.map((r) => r.id));
  const relevant = events.filter((e) => ids.has(e.body.requestId));
  const bound = new Map<string, string>();
  const taskBindings: Array<{
    requestId: string;
    taskId: string;
    specDigest: string;
  }> = [];
  for (const e of relevant.filter((e) =>
    ["WORKFLOW_TASKS_ATTACHED", "WORKFLOW_TASKS_REBOUND"].includes(e.kind),
  ))
    for (const binding of e.body.bindings) {
      bound.set(binding.taskId, binding.specDigest);
      taskBindings.push({
        requestId: e.body.requestId,
        taskId: binding.taskId,
        specDigest: binding.specDigest,
      });
    }
  const replies = relevant
    .filter((e) => e.kind === "WORKFLOW_REPLY")
    .map((e) => e.body.reply);
  const deferred = new Map(
    relevant
      .filter((e) => e.kind === "WORKFLOW_QUESTION_DEFERRED")
      .map((e) => [e.body.deferral.questionId as string, e.body.deferral]),
  );
  const questions = relevant
    .filter((e) => e.kind === "WORKFLOW_QUESTION")
    .map((e) => ({
      ...e.body.question,
      answers: replies.filter((r) => r.questionId === e.body.question.id),
      ...(deferred.has(e.body.question.id)
        ? { deferred: deferred.get(e.body.question.id) }
        : {}),
    }));
  // An owner choice a screening found is about the task, not about the
  // project that asked it, as the screening itself is chosen by the task's
  // specification whatever project recorded it (review round 7). The
  // pre-design questions another project recorded on one of this project's
  // tasks are therefore part of this project's record too, with their
  // answers: a choice open anywhere holds the task here whatever screening
  // follows, its answer reaches Astra here and stales the checkpoint, and
  // it is not asked twice. Only these questions cross projects, so a
  // project without opted-in work is unchanged.
  const externalReplies = events
    .filter((e) => e.kind === "WORKFLOW_REPLY" && !ids.has(e.body.requestId))
    .map((e) => e.body.reply);
  const externalDeferred = new Map(
    events
      .filter(
        (e) =>
          e.kind === "WORKFLOW_QUESTION_DEFERRED" && !ids.has(e.body.requestId),
      )
      .map((e) => [e.body.deferral.questionId as string, e.body.deferral]),
  );
  for (const e of events)
    if (
      e.kind === "WORKFLOW_QUESTION" &&
      !ids.has(e.body.requestId) &&
      String(e.body.question.key).startsWith(PRE_DESIGN_QUESTION_PREFIX) &&
      questionScope(e.body.question).taskIds.some((id) => bound.has(id))
    )
      questions.push({
        ...e.body.question,
        // Where it is answered: the request that recorded it (round 8).
        requestId: e.body.requestId,
        answers: externalReplies.filter(
          (r) => r.questionId === e.body.question.id,
        ),
        ...(externalDeferred.has(e.body.question.id)
          ? { deferred: externalDeferred.get(e.body.question.id) }
          : {}),
      });
  const tasks = [...bound]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, binding]) => {
      const row = db.get<{ body: string }>(
        "SELECT body FROM tasks WHERE id=?",
        id,
      );
      if (!row) throw new Error("PROJECT_TASK_MISSING:" + id);
      const task = TaskSchema.parse(JSON.parse(row.body));
      if (specDigest(task) !== binding)
        throw new Error("PROJECT_SPEC_CHANGED:" + id);
      const runs = bodies(db, "attempts", id).filter(
        (a) =>
          a.role === "worker" &&
          a.state === "SUCCEEDED" &&
          a.specDigest === binding,
      );
      const worker = runs.at(-1);
      const receipt = worker
        ? db.get<{ body: string }>(
            "SELECT body FROM receipts WHERE attempt_id=?",
            worker.id,
          )
        : undefined;
      return {
        task,
        specDigest: binding,
        gate: gates?.(id) ?? null,
        artifact: worker
          ? {
              runId: worker.id,
              digest: worker.workspaceDigest,
              path: "project-artifacts/" + digest(id).slice(0, 16),
              summary: receipt ? JSON.parse(receipt.body).output : "",
            }
          : null,
        assessments: bodies(db, "attempts", id)
          .filter(
            (a) =>
              a.role === "assessor" &&
              a.state === "SUCCEEDED" &&
              a.specDigest === binding,
          )
          .map((a) => ({
            runId: a.id,
            output: JSON.parse(
              db.get<{ body: string }>(
                "SELECT body FROM receipts WHERE attempt_id=?",
                a.id,
              )!.body,
            ).output,
          })),
        evidence: bodies(db, "evidence", id),
        tests: bodies(db, "command_receipts", id),
        reviews: bodies(db, "reviews", id),
        audits: bodies(db, "audits", id),
        decisions: bodies(db, "decisions", id),
        grants: bodies(db, "grants", id),
        // Include revocations in the fingerprint: a previous grant is never implied current.
        revocations: db
          .all<{
            body: string;
          }>("SELECT body FROM decision_revocations WHERE decision_id IN (SELECT id FROM decisions WHERE task_id=?)", id)
          .map((r) => JSON.parse(r.body)),
        grantRevocations: db
          .all<{
            body: string;
          }>("SELECT body FROM grant_revocations WHERE grant_id IN (SELECT id FROM grants WHERE task_id=?)", id)
          .map((r) => JSON.parse(r.body)),
      };
    });
  const snapshot = {
    projectId,
    requests: requests.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      sourceRef: r.sourceRef,
      context: r.context,
    })),
    tasks,
    taskBindings,
    questions,
  };
  return { ...snapshot, inputDigest: inputDigestOf(snapshot) };
}
type SnapshotInputs = {
  projectId: string;
  requests: unknown[];
  tasks: Array<{ task: { status: string } } & Record<string, unknown>>;
  taskBindings: unknown[];
  questions: Array<Record<string, any>>;
};
/**
 * The fingerprint of a project's inputs, optionally with only some of its
 * questions. Starting a run changes transient task status, not the inputs it
 * was given; verification/acceptance are milestones and DO invalidate a
 * previous final check.
 */
export function inputDigestOf(
  snapshot: SnapshotInputs,
  questions: SnapshotInputs["questions"] = snapshot.questions,
) {
  const { projectId, requests, tasks, taskBindings } = snapshot;
  return digest({
    projectId,
    requests,
    tasks: tasks.map((t) => ({
      ...t,
      task: {
        ...t.task,
        status: ["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(
          t.task.status,
        )
          ? t.task.status
          : "ACTIVE",
      },
    })),
    taskBindings,
    questions,
  });
}
export type ProjectSnapshot = ReturnType<typeof projectSnapshot>;
/**
 * What a run on one task was given : the project's
 * inputs, less operational exchanges about other tasks only — questions
 * scoped to other tasks that have no owner's answer (unanswered, or answered
 * by the operator). An owner's answer, to any question, a project-wide
 * question and every other record count. Astra's runs check the whole
 * fingerprint.
 */
export function runInputDigest(
  snapshot: ProjectSnapshot,
  role: string,
  taskId: string,
) {
  if (role === "overseer") return snapshot.inputDigest;
  return inputDigestOf(
    snapshot,
    snapshot.questions.filter((q: Record<string, any>) => {
      const scope = questionScope(q);
      if (scope.projectWide || scope.taskIds.includes(taskId)) return true;
      // An owner's answer always counts, whatever the question's audience (a
      // reply recorded before audiences was the owner's); operator answers
      // and unanswered questions about other tasks do not.
      return (q.answers ?? []).some(
        (a: Record<string, unknown>) => a?.answeredAs !== "OPERATOR",
      );
    }),
  );
}
/**
 * Whether Astra's checkpoint still describes the project. A CONTINUE plan
 * stays current while the only change is the questions it asked itself, still
 * unanswered (it assigned other work around them); an ASK plan's questions
 * make it stale once recorded, so Astra plans again with them in view.
 */
export function checkpointCurrent(
  snapshot: ProjectSnapshot,
  checkpoint: ProjectCheckpoint | undefined,
): boolean {
  if (!checkpoint) return false;
  if (checkpoint.inputDigest === snapshot.inputDigest) return true;
  if (checkpoint.plan.outcome !== "CONTINUE") return false;
  return (
    checkpoint.inputDigest ===
    inputDigestOf(
      snapshot,
      snapshot.questions.filter(
        (q: Record<string, any>) =>
          !(q.askedBy === checkpoint.runId && !questionResolved(q)),
      ),
    )
  );
}
export type ProjectCheckpoint = {
  projectId: string;
  requestId: string;
  runId: string;
  inputDigest: string;
  revision: number;
  plan: ProjectPlan;
};

/**
 * Pre-design decision discovery records (proposal #17). A screening is
 * recorded as an append-only PRE_DESIGN_SCREENING event: Astra's screenings
 * in the same transaction as the checkpoint that carried them, the
 * controller's exemptions when an exempt task's first worker run is
 * admitted. The latest record of a task's current specification governs
 * admission; earlier records stay as history.
 */
export type ScreeningRecord = {
  version: typeof SCREENING_VERSION;
  projectId: string | null;
  taskId: string;
  specDigest: string;
  disposition: Disposition;
  /** The controller records exemptions; Astra's screenings come through a checkpoint. */
  by: "controller" | "overseer";
  reason: string;
  sourceRefs: string[];
  candidates: Candidate[];
  /**
   * The owner question each OWNER_REQUIRED candidate becomes, by stable key,
   * with the specification of each task it holds at screening time: a
   * revision of any of them stales the screening.
   */
  questions: Array<{
    candidateKey: string;
    key: string;
    taskIds: string[];
    affected: Record<string, string>;
    /**
     * The digest of what the owner is asked (choice, options and
     * recommendation): a candidate that reuses the key with other content
     * is a different choice, and is rejected rather than folded into this
     * question (review P1).
     */
    substance: string;
  }>;
  /** The task-scoped inputs the screening rested on; null for an exemption. */
  currency: Currency | null;
  checkpointRunId: string | null;
  checkpointInputDigest: string | null;
  checkpointRevision: number | null;
  eligibility: Eligibility;
  recordedAt: string;
};
/**
 * The owner questions a screening derived that are recorded nowhere yet and
 * can still be (none of the tasks they hold revised since): a screening
 * recorded without its questions owes them. They are found through every
 * task they cover, not only the task screened, so a project or a worker
 * run on an affected task finds them too (review round 10). `covering`
 * selects the screenings of these tasks and the questions holding them.
 */
export function owedPreDesignQuestions(
  db: Persistence,
  covering: Set<string>,
): Array<{ screening: ScreeningRecord; question: ScreeningRecord["questions"][number] }> {
  const records = db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='PRE_DESIGN_SCREENING' ORDER BY seq",
    )
    .map((r) => JSON.parse(r.body) as ScreeningRecord);
  if (!records.length) return [];
  const tasks = new Map<string, Task | null>();
  const taskOf = (id: string) => {
    if (!tasks.has(id)) {
      const row = db.get<{ body: string }>(
        "SELECT body FROM tasks WHERE id=?",
        id,
      );
      tasks.set(id, row ? TaskSchema.parse(JSON.parse(row.body)) : null);
    }
    return tasks.get(id)!;
  };
  const specOf = (id: string) => {
    const t = taskOf(id);
    return t ? specDigest(t) : undefined;
  };
  // The screening a task's state rests on: its latest by Astra of its
  // current specification, while it still needs one (preDesignState).
  const latest = new Map<string, ScreeningRecord>();
  for (const r of records) {
    const t = taskOf(r.taskId);
    if (
      t &&
      r.by === "overseer" &&
      r.specDigest === specDigest(t) &&
      screeningEligibility(t).required
    )
      latest.set(r.taskId, r);
  }
  const recorded = new Set(
    db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'",
      )
      .map((r) => String(JSON.parse(r.body).question?.key)),
  );
  const owed: Array<{
    screening: ScreeningRecord;
    question: ScreeningRecord["questions"][number];
  }> = [];
  for (const screening of latest.values())
    for (const question of screening.questions)
      if (
        (covering.has(screening.taskId) ||
          question.taskIds.some((id) => covering.has(id))) &&
        !recorded.has(question.key) &&
        Object.entries(question.affected ?? {}).every(
          ([id, spec]) => specOf(id) === spec,
        )
      )
        owed.push({ screening, question });
  return owed;
}
/**
 * An owner choice a screening raised that is still open on the task, in any
 * project's record: its question's id, or undefined. A pre-design question
 * is the task's (round 7), so it holds the task's fresh worker run
 * wherever it was recorded (review round 12).
 */
export function openPreDesignQuestionOn(
  db: Persistence,
  taskId: string,
): string | undefined {
  const settled = new Set(
    db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind IN ('WORKFLOW_REPLY','WORKFLOW_QUESTION_DEFERRED')",
      )
      .map((r) => {
        const body = JSON.parse(r.body);
        return String(body.reply?.questionId ?? body.deferral?.questionId);
      }),
  );
  return db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
    )
    .map((r) => JSON.parse(r.body).question)
    .find(
      (q) =>
        q &&
        String(q.key).startsWith(PRE_DESIGN_QUESTION_PREFIX) &&
        !settled.has(String(q.id)) &&
        questionScope(q).taskIds.includes(taskId),
    )?.id;
}
export function screeningRecords(
  db: Persistence,
  taskId: string,
): ScreeningRecord[] {
  return db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='PRE_DESIGN_SCREENING' AND task_id=? ORDER BY seq",
      taskId,
    )
    .map((r) => JSON.parse(r.body) as ScreeningRecord);
}
function allTasks(db: Persistence): Task[] {
  return db
    .all<{ body: string }>("SELECT body FROM tasks ORDER BY id")
    .map((r) => TaskSchema.parse(JSON.parse(r.body)));
}
/**
 * What a task's screening rests on, and so what makes it stale: the task's
 * own specification, the specifications of its related tasks (dependencies,
 * the task it fixes, shared resources, shared repository paths; the same
 * relation the scoped macro audit uses) and the owner's decisions recorded
 * on it. Not the whole-project fingerprint: another task finishing, a
 * question being asked or answered, a grant or a status change stales no
 * screening, so independent work never forces a screening again.
 */
export function screenCurrency(
  db: Persistence,
  task: Task,
  all: Task[] = allTasks(db),
): Currency {
  const byId = new Map(all.map((t) => [t.id, t]));
  const revoked = new Set(
    db
      .all<{ decision_id: string }>(
        "SELECT decision_id FROM decision_revocations WHERE decision_id IN (SELECT id FROM decisions WHERE task_id=?)",
        task.id,
      )
      .map((r) => r.decision_id),
  );
  const inputs: CurrencyInputs = {
    version: 1,
    taskId: task.id,
    spec: specDigest(task),
    peers: peerRelations(task, all).map((p) => ({
      ...p,
      spec: specDigest(byId.get(p.id)!),
    })),
    decisions: db
      .all<{ id: string }>(
        "SELECT id FROM decisions WHERE task_id=? ORDER BY id",
        task.id,
      )
      .map((r) => ({ id: r.id, revoked: revoked.has(r.id) })),
  };
  return { digest: digest(inputs), inputs };
}
export type PreDesignQuestionState = {
  candidateKey: string;
  key: string;
  taskIds: string[];
  status: "OPEN" | "ANSWERED" | "NOT_RECORDED";
  questionId: string | null;
};
/**
 * The decisions a screening cites (as settling a candidate, or as what a
 * choice would change) that have since been revoked, on whichever affected
 * task they were recorded: a screening that rests on a withdrawn decision
 * is stale (review round 2). Question ids cited as decidedBy match nothing
 * here, as an answer is never withdrawn.
 */
function citedDecisionsRevoked(
  db: Persistence,
  record: ScreeningRecord,
): string[] {
  const cited = [
    ...new Set(
      record.candidates.flatMap((c) =>
        [c.decidedBy, c.revisesDecision].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    ),
  ].sort();
  if (!cited.length) return [];
  return db
    .all<{ decision_id: string }>(
      `SELECT decision_id FROM decision_revocations WHERE decision_id IN (${cited.map(() => "?").join(",")})`,
      ...cited,
    )
    .map((r) => "CITED_DECISION_REVOKED:" + r.decision_id)
    .sort();
}
/**
 * The answered questions a screening cites as settling a candidate
 * (`decidedBy`) that no longer apply to every task the candidate affects,
 * as they are now: a historical answer for a task revised since, say. A
 * screening that rests on such an answer is stale, like one resting on a
 * revoked decision (review round 5). A citation is read as checkpoint
 * validation reads it: a decision recorded on an affected task first (its
 * standing is citedDecisionsRevoked's to check), then a question (review
 * round 6). A question this project's records do not hold cannot be shown
 * to apply, so it makes the screening stale too: a screening reused from
 * another project, or read without a project record (when an owner
 * question counts as open anyway).
 */
function citedAnswersInapplicable(
  db: Persistence,
  record: ScreeningRecord,
  questions: QuestionLike[] | undefined,
  specOf: (taskId: string) => string | undefined,
): string[] {
  const stale = new Set<string>();
  for (const c of record.candidates) {
    if (c.type !== "ALREADY_DECIDED" || typeof c.decidedBy !== "string")
      continue;
    const affected = [...new Set(c.affectedTaskIds)];
    if (
      affected.length &&
      db.get(
        `SELECT id FROM decisions WHERE id=? AND task_id IN (${affected.map(() => "?").join(",")})`,
        c.decidedBy,
        ...affected,
      )
    )
      continue;
    const q = questions?.find((x) => x.id === c.decidedBy);
    if (
      !q ||
      !ownerAnswerApplies(q as QuestionScope, c.affectedTaskIds, specOf)
    )
      stale.add("CITED_ANSWER_NOT_APPLICABLE:" + c.decidedBy);
  }
  return [...stale].sort();
}
function affectedSpecs(
  records: ScreeningRecord["questions"],
  byId: Map<string, Task>,
): string[] {
  const changed = new Set<string>();
  for (const q of records)
    for (const [id, spec] of Object.entries(q.affected ?? {})) {
      const task = byId.get(id);
      if (!task || specDigest(task) !== spec)
        changed.add("AFFECTED_TASK_SPEC_CHANGED:" + id);
    }
  return [...changed].sort();
}
/** Where a task stands with pre-design discovery; computed, never stored. */
export type PreDesignTaskState = {
  taskId: string;
  specDigest: string;
  eligibility: Eligibility;
  /** The task-scoped currency now. */
  currency: Currency;
  /** Astra's latest screening of the current specification, if any. */
  latest: ScreeningRecord | null;
  /** Whether that screening still rests on the current inputs. */
  current: boolean;
  stale: string[];
  questions: PreDesignQuestionState[];
  /** The hold that refuses a fresh worker run, or null when one may be admitted. */
  hold: string | null;
};
type QuestionLike = {
  id: string;
  key: string;
  answers?: unknown[];
  deferred?: unknown;
};
/**
 * The pre-design state of one task. `questions` are the project's recorded
 * questions, which say whether a screening's owner questions are answered;
 * without them (no project record available) an owner question counts as
 * open, the conservative reading.
 */
export function preDesignState(
  db: Persistence,
  task: Task,
  questions: QuestionLike[] | undefined,
  options: { all?: Task[]; projectOversight?: boolean } = {},
): PreDesignTaskState {
  const eligibility = screeningEligibility(task);
  const spec = specDigest(task);
  const all = options.all ?? allTasks(db);
  const currency = screenCurrency(db, task, all);
  const base = { taskId: task.id, specDigest: spec, eligibility, currency };
  if (!eligibility.required)
    return {
      ...base,
      latest: null,
      current: true,
      stale: [],
      questions: [],
      hold: null,
    };
  const latest =
    screeningRecords(db, task.id)
      .filter((r) => r.by === "overseer" && r.specDigest === spec)
      .at(-1) ?? null;
  if (!latest)
    return {
      ...base,
      latest: null,
      current: false,
      stale: ["NO_SCREENING_FOR_SPECIFICATION"],
      questions: [],
      hold:
        "PRE_DESIGN_SCREEN_REQUIRED:" +
        task.id +
        (options.projectOversight === false ? ":NO_PROJECT_OVERSIGHT" : ""),
    };
  const byId = new Map(all.map((t) => [t.id, t]));
  const specOf = (id: string) => {
    const t = byId.get(id);
    return t ? specDigest(t) : undefined;
  };
  const stale = [
    ...(latest.currency
      ? staleReasons(latest.currency.inputs, currency.inputs)
      : ["NO_CURRENCY_RECORDED"]),
    ...affectedSpecs(latest.questions, byId),
    ...citedDecisionsRevoked(db, latest),
    ...citedAnswersInapplicable(db, latest, questions, specOf),
  ];
  const states: PreDesignQuestionState[] = latest.questions.map((q) => {
    const recorded = questions?.find((x) => x.key === q.key);
    const { affected: _affected, substance: _substance, ...rest } = q;
    // Answered means answered by the owner for every task the question
    // holds; a historical answer that does not apply to one of them, as
    // it is now, leaves it open.
    return {
      ...rest,
      status: !questions
        ? "OPEN"
        : !recorded
          ? "NOT_RECORDED"
          : ownerAnswerApplies(recorded as QuestionScope, q.taskIds, specOf)
            ? "ANSWERED"
            : "OPEN",
      questionId: recorded?.id ?? null,
    };
  });
  let hold: string | null = null;
  // A settled task gets no fresh worker run, so nothing holds it; its
  // screening stays as history (stale or not).
  if (SETTLED_STATUS.includes(task.status)) hold = null;
  else if (stale.length)
    hold = "PRE_DESIGN_SCREEN_STALE:" + task.id + ":" + stale.join(",");
  else if (latest.disposition === "BLOCKED_ON_EVIDENCE")
    hold = "PRE_DESIGN_EVIDENCE_REQUIRED:" + task.id;
  else {
    const unrecorded = states.find((q) => q.status === "NOT_RECORDED"),
      open = states.find((q) => q.status === "OPEN");
    if (unrecorded)
      hold = "PRE_DESIGN_QUESTION_NOT_RECORDED:" + unrecorded.key;
    else if (open)
      hold = "PRE_DESIGN_OWNER_CHOICE_OPEN:" + (open.questionId ?? open.key);
    else {
      // An owner choice still open on the task that this screening does not
      // list holds it all the same: one a later screening replaced, in this
      // project or in another one whose question is part of this record
      // (review round 7). A new screening never clears an owner choice.
      const elsewhere = questions?.find(
        (q) =>
          String(q.key).startsWith(PRE_DESIGN_QUESTION_PREFIX) &&
          !questionResolved(q) &&
          covers(q as QuestionScope, task.id),
      );
      if (elsewhere) hold = "PRE_DESIGN_OWNER_CHOICE_OPEN:" + elsewhere.id;
    }
  }
  return {
    ...base,
    latest,
    current: !stale.length,
    stale,
    questions: states,
    hold,
  };
}
/** The pre-design states of a project's opted-in tasks; undefined when none is. */
export function preDesignStates(
  db: Persistence,
  snapshot: ProjectSnapshot,
): PreDesignTaskState[] | undefined {
  const opted = snapshot.tasks.filter((e) => e.task.preDesignDiscovery);
  if (!opted.length) return undefined;
  const all = allTasks(db);
  return opted.map((e) =>
    preDesignState(db, e.task, snapshot.questions, { all }),
  );
}
/** Whether a task's hold is one only a new screening by Astra clears. */
export function needsScreening(state: PreDesignTaskState | undefined): boolean {
  return (
    !!state?.hold && /^PRE_DESIGN_SCREEN_(REQUIRED|STALE):/.test(state.hold)
  );
}
/**
 * A screening that went stale before its owner questions were recorded
 * (the advance stopped between the checkpoint and its questions, then an
 * input changed): the questions are not recorded for a stale screening and
 * cannot be answered, so only a new screening by Astra makes progress
 * (review P2).
 */
export function staleUnasked(state: PreDesignTaskState): boolean {
  return (
    !!state.hold &&
    !state.current &&
    state.questions.some((q) => q.status === "NOT_RECORDED")
  );
}
/**
 * Whether Astra's checkpoint still describes the project, screenings
 * included: a CONTINUE plan whose assigned task needs a screening Astra has
 * not given (none for its current specification, or one that is stale), or
 * any plan while a screening went stale with its questions unrecorded, is
 * stale too, so the next advance runs Astra again. A screening's currency
 * never includes the checkpoint itself, so screening the task settles this.
 */
export function oversightCurrent(context: ProjectContext): boolean {
  if (!checkpointCurrent(context.snapshot, context.previous)) return false;
  const states = context.preDesign ?? [];
  if (states.some(staleUnasked)) return false;
  const plan = context.previous!.plan;
  if (plan.outcome !== "CONTINUE") return true;
  return !plan.nextTaskIds.some((id) =>
    needsScreening(states.find((s) => s.taskId === id)),
  );
}
/**
 * The identity of Astra's input for one run, which bounds its attempts and
 * keys its reservations: the project's input digest and, for the opted-in
 * tasks, the task-scoped currency each screening would rest on. A change
 * that stales a screening without changing the project's inputs (a related
 * task outside the project) is then a new input with its own allowance,
 * not a repeat of an exhausted one (review P2). Without opted-in tasks it
 * is the input digest, as before.
 */
export function oversightInputDigest(context: ProjectContext): string {
  if (!context.preDesign) return context.snapshot.inputDigest;
  return digest({
    input: context.snapshot.inputDigest,
    // With the screening's stale reasons: a cited decision revoked, a
    // cited answer no longer applying or an affected task revised outside
    // the project stale it without changing the currency, and are a new
    // input too (review round 10).
    screening: context.preDesign
      .filter((s) => s.eligibility.required)
      .map((s) => ({
        taskId: s.taskId,
        currency: s.currency.digest,
        stale: s.stale,
      })),
  });
}
export function latestCheckpoint(
  db: Persistence,
  projectId: string,
): ProjectCheckpoint | undefined {
  return db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT' ORDER BY seq",
    )
    .map((r) => JSON.parse(r.body) as ProjectCheckpoint)
    .filter((c) => c.projectId === projectId)
    .at(-1);
}
export type ProjectContext = {
  requestId: string;
  snapshot: ProjectSnapshot;
  previous?: ProjectCheckpoint;
  decisionHistory: Array<{
    revision: number;
    runId: string;
    decisions: ProjectPlan["technicalDecisions"];
  }>;
  /**
   * Pre-design discovery state of the opted-in tasks, present only when
   * there are any (so the record of a project without them is unchanged).
   * Derived from the journal, never part of the snapshot's fingerprint.
   */
  preDesign?: PreDesignTaskState[];
};
export function projectContext(
  db: Persistence,
  requestId: string,
  gates?: ProjectGates,
): ProjectContext {
  const snapshot = projectSnapshot(db, requestId, gates);
  const preDesign = preDesignStates(db, snapshot);
  const previous = latestCheckpoint(db, snapshot.projectId);
  const decisionHistory = db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT' ORDER BY seq",
    )
    .map((r) => JSON.parse(r.body) as ProjectCheckpoint)
    .filter(
      (c) =>
        c.projectId === snapshot.projectId && c.plan.technicalDecisions.length,
    )
    .map((c) => ({
      revision: c.revision,
      runId: c.runId,
      decisions: c.plan.technicalDecisions,
    }));
  return {
    requestId,
    snapshot,
    ...(previous ? { previous } : {}),
    decisionHistory,
    ...(preDesign ? { preDesign } : {}),
  };
}
export function assertProjectCurrent(
  db: Persistence,
  context: ProjectContext,
  gates?: ProjectGates,
  /** The run being checked; without it (Astra's checkpoint) the whole fingerprint. */
  run?: { role: string; taskId: string },
) {
  const now = projectSnapshot(db, context.requestId, gates);
  if (
    run
      ? runInputDigest(now, run.role, run.taskId) !==
        runInputDigest(context.snapshot, run.role, run.taskId)
      : now.inputDigest !== context.snapshot.inputDigest
  )
    throw new Error("PROJECT_CONTEXT_CHANGED");
  if (
    latestCheckpoint(db, context.snapshot.projectId)?.runId !==
    context.previous?.runId
  )
    throw new Error("PROJECT_CHECKPOINT_CHANGED");
}
export function assertAssignment(context: ProjectContext, taskId: string) {
  const checkpoint = context.previous;
  if (!checkpoint || !checkpointCurrent(context.snapshot, checkpoint))
    throw new Error("PROJECT_OVERSIGHT_REQUIRED");
  if (
    checkpoint.plan.outcome !== "CONTINUE" ||
    !checkpoint.plan.nextTaskIds.includes(taskId) ||
    !checkpoint.plan.assignments.some((a) => a.taskId === taskId)
  )
    throw new Error("PROJECT_TASK_NOT_ASSIGNED:" + taskId);
  if (
    context.snapshot.questions.some(
      (q) => !questionResolved(q) && covers(q, taskId),
    )
  )
    throw new Error("PROJECT_OWNER_QUESTION_OPEN");
}
export function recordCheckpoint(
  db: Persistence,
  context: ProjectContext,
  runId: string,
  output: string,
  gates?: ProjectGates,
  /** The adaptive checkpoint's pinned mode and guided tasks (issue #12). */
  adaptive?: { mode: "COORDINATION_ONLY" | "SUBSTANTIVE"; guidedTaskIds: string[] },
) {
  return db.transaction(() => {
    assertProjectCurrent(db, context, gates);
    const plan = ProjectPlanSchema.parse(JSON.parse(output));
    if (plan.inputDigest !== context.snapshot.inputDigest)
      throw new Error("OVERSEER_INPUT_MISMATCH");
    // No substantive coordination plan is ever recorded (OVS-08), and a
    // substantive plan screens only the tasks it guides (contract 8.3).
    if (
      adaptive?.mode === "COORDINATION_ONLY" &&
      (plan.technicalDecisions.length ||
        plan.screenings.length ||
        plan.assignments.some((a) => a.instruction !== COORDINATION_INSTRUCTION))
    )
      throw new Error("OVERSEER_COORDINATION_SUBSTANTIVE");
    if (
      adaptive?.mode === "SUBSTANTIVE" &&
      plan.screenings.some((x) => !adaptive.guidedTaskIds.includes(x.taskId))
    )
      throw new Error("OVERSEER_SCREENING_UNGUIDED_TASK");
    const ids = new Set(context.snapshot.tasks.map((t) => t.task.id));
    if (
      [...plan.assignments.map((a) => a.taskId), ...plan.nextTaskIds].some(
        (id) => !ids.has(id),
      )
    )
      throw new Error("OVERSEER_UNKNOWN_TASK");
    if (
      new Set(plan.assignments.map((a) => a.taskId)).size !==
        plan.assignments.length ||
      new Set(plan.nextTaskIds).size !== plan.nextTaskIds.length
    )
      throw new Error("OVERSEER_DUPLICATE_TASK");
    if (
      plan.outcome === "CONTINUE" &&
      (!plan.nextTaskIds.length ||
        plan.nextTaskIds.some(
          (id) => !plan.assignments.some((a) => a.taskId === id),
        ))
    )
      throw new Error("OVERSEER_ASSIGNMENT_REQUIRED");
    // Every question declares its scope: some of the project's tasks, or
    // explicitly the whole project .
    const asked = [...plan.questionsForOwner, ...plan.questionsForOperator];
    for (const q of asked) {
      if (q.projectWide === q.taskIds.length > 0)
        throw new Error("OVERSEER_QUESTION_SCOPE_REQUIRED");
      if (q.taskIds.some((id) => !ids.has(id)))
        throw new Error("OVERSEER_UNKNOWN_TASK");
      if (new Set(q.taskIds).size !== q.taskIds.length)
        throw new Error("OVERSEER_DUPLICATE_TASK");
    }
    // Pre-design screenings: validated against the pinned specifications and
    // the project's records; each OWNER_REQUIRED candidate becomes an owner
    // question the controller derives (screening.ts).
    const screening = screeningPlan(db, context, plan, ids, asked);
    if (
      plan.outcome === "ASK_OWNER" &&
      !plan.questionsForOwner.length &&
      !screening.derivedOpen.length &&
      !screening.openPreDesign
    )
      throw new Error("OVERSEER_QUESTION_REQUIRED");
    if (
      plan.outcome === "ASK_OPERATOR" &&
      (!plan.questionsForOperator.length ||
        plan.questionsForOwner.length ||
        screening.derivedOpen.length)
    )
      throw new Error("OVERSEER_QUESTION_REQUIRED");
    if (plan.outcome === "COMPLETE" && asked.length)
      throw new Error("OVERSEER_UNSETTLED_QUESTIONS");
    if (plan.outcome === "COMPLETE" && plan.screenings.length)
      throw new Error("OVERSEER_SCREENING_IN_COMPLETE");
    // Work goes on around a task-scoped question, never through one.
    if (
      plan.outcome === "CONTINUE" &&
      asked.some(
        (q) =>
          q.projectWide || q.taskIds.some((id) => plan.nextTaskIds.includes(id)),
      )
    )
      throw new Error("OVERSEER_ASSIGNED_TASK_HAS_QUESTION");
    if (
      plan.outcome === "CONTINUE" &&
      screening.derivedOpen.some((q) =>
        q.taskIds.some((id) => plan.nextTaskIds.includes(id)),
      )
    )
      throw new Error("OVERSEER_ASSIGNED_TASK_HAS_QUESTION");
    // No assignment admits a task whose screening is missing, stale, held
    // on evidence or waiting on the owner: the reservation refuses it too.
    if (plan.outcome === "CONTINUE")
      for (const id of plan.nextTaskIds) {
        const refusal = screening.refuses(id);
        if (refusal) throw new Error(refusal);
      }
    if (
      plan.outcome === "COMPLETE" &&
      (context.snapshot.tasks.some(
        (t) =>
          !["VERIFIED", "ACCEPTED"].includes(t.task.status) ||
          !t.gate?.completionCurrent,
      ) ||
        context.snapshot.questions.some((q) => !questionResolved(q)))
    )
      throw new Error("PROJECT_NOT_COMPLETE");
    const checkpoint: ProjectCheckpoint = {
      projectId: context.snapshot.projectId,
      requestId: context.requestId,
      runId,
      inputDigest: plan.inputDigest,
      revision: (context.previous?.revision ?? 0) + 1,
      plan,
    };
    db.event("PROJECT_CHECKPOINT", null, checkpoint);
    // Astra's screenings, in the same transaction as the checkpoint that
    // carried them, each bound to the specification it screened and the
    // currency it rested on (as Astra saw them).
    const recordedAt = new Date().toISOString();
    for (const record of screening.records)
      db.event("PRE_DESIGN_SCREENING", record.taskId, {
        ...record,
        checkpointRunId: runId,
        checkpointRevision: checkpoint.revision,
        recordedAt,
      } satisfies ScreeningRecord);
    return checkpoint;
  });
}
const SETTLED_STATUS = ["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"];
/**
 * Check a plan's screenings against the project (strict: any fault rejects
 * the whole checkpoint, so no partial admission), derive the owner
 * questions they raise, and prepare their records.
 */
function screeningPlan(
  db: Persistence,
  context: ProjectContext,
  plan: ProjectPlan,
  ids: Set<string>,
  asked: ScopedQuestion[],
) {
  const states = context.preDesign ?? [];
  const byTask = new Map(states.map((s) => [s.taskId, s]));
  const entries = new Map(context.snapshot.tasks.map((e) => [e.task.id, e]));
  const specOfEntry = (id: string) => entries.get(id)?.specDigest;
  const recordedQuestion = (key: string) =>
    context.snapshot.questions.find((q) => q.key === key);
  // A revoked decision settles nothing (review P1): only the decisions
  // still standing on the affected tasks can be cited.
  const revoked = new Set(
    db
      .all<{ decision_id: string }>(
        "SELECT decision_id FROM decision_revocations",
      )
      .map((r) => r.decision_id),
  );
  const decisionsOf = (taskIds: string[]) =>
    new Set(
      context.snapshot.tasks
        .filter((e) => taskIds.includes(e.task.id))
        .flatMap((e) => e.decisions.map((d: any) => String(d?.id)))
        .filter((id) => !revoked.has(id)),
    );
  // An answered question settles a candidate only when the owner answered
  // it and the answer applies to every task the candidate affects, as it is
  // now (reviews round 3 and 4): an operator's answer, or a historical
  // answer that does not apply to one of them, settles nothing.
  const settledBy = (id: string, taskIds: string[]) => {
    const q = context.snapshot.questions.find((x) => String(x.id) === id);
    return !q
      ? "UNKNOWN"
      : ownerAnswerApplies(q, taskIds, specOfEntry)
        ? "SETTLED"
        : "NOT_APPLICABLE";
  };
  // What each derived question asks, by key, from every earlier screening
  // and from this plan: a candidate that reuses a key with another choice,
  // other options or another recommendation is a different choice the owner
  // has not seen, never folded into the first (review P1). Every project's
  // screenings count, as a screening and its questions are reused by the
  // task's specification across projects (review round 7).
  const substanceOf = (c: Candidate) =>
    digest({
      choice: c.choice,
      options: c.options,
      recommendation: c.recommendation,
    });
  const substance = new Map<string, string>();
  for (const record of db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='PRE_DESIGN_SCREENING' ORDER BY seq",
    )
    .map((r) => JSON.parse(r.body) as ScreeningRecord))
    for (const q of record.questions) substance.set(q.key, q.substance);
  const seen = new Set<string>();
  const derivedOpen: Array<{ key: string; taskIds: string[] }> = [];
  const records: Array<
    Omit<ScreeningRecord, "checkpointRunId" | "checkpointRevision" | "recordedAt">
  > = [];
  // A screening that went stale with its questions unrecorded is screened
  // again now, or nothing can make progress (review P2).
  for (const state of states)
    if (
      staleUnasked(state) &&
      !SETTLED_STATUS.includes(entries.get(state.taskId)?.task.status ?? "") &&
      !plan.screenings.some((s) => s.taskId === state.taskId)
    )
      throw new Error("OVERSEER_SCREEN_REQUIRED:" + state.taskId);
  for (const s of plan.screenings) {
    if (!ids.has(s.taskId)) throw new Error("OVERSEER_UNKNOWN_TASK");
    if (seen.has(s.taskId))
      throw new Error("OVERSEER_DUPLICATE_SCREENING:" + s.taskId);
    seen.add(s.taskId);
    const state = byTask.get(s.taskId);
    if (!state?.eligibility.required)
      throw new Error("OVERSEER_SCREENING_NOT_REQUIRED:" + s.taskId);
    const entry = entries.get(s.taskId)!;
    if (SETTLED_STATUS.includes(entry.task.status))
      throw new Error("OVERSEER_SCREENING_TASK_SETTLED:" + s.taskId);
    if (s.specDigest !== entry.specDigest)
      throw new Error("OVERSEER_SCREENING_SPEC_MISMATCH:" + s.taskId);
    const keys = new Set<string>();
    const questions: ScreeningRecord["questions"] = [];
    let owner = false,
      evidence = false;
    for (const c of s.candidates) {
      if (keys.has(c.key))
        throw new Error("OVERSEER_DUPLICATE_CANDIDATE:" + c.key);
      keys.add(c.key);
      if (new Set(c.affectedTaskIds).size !== c.affectedTaskIds.length)
        throw new Error("OVERSEER_DUPLICATE_TASK");
      if (c.affectedTaskIds.some((id) => !ids.has(id)))
        throw new Error("OVERSEER_UNKNOWN_TASK");
      if (!c.affectedTaskIds.includes(s.taskId))
        throw new Error("OVERSEER_CANDIDATE_SCOPE_EXCLUDES_TASK:" + c.key);
      const decisions = decisionsOf(c.affectedTaskIds);
      if (c.type === "OWNER_REQUIRED") {
        owner = true;
        // An owner choice is put with 2 to 4 viable answers, recommendation first.
        if (c.options.length < 2 || !c.recommendation)
          throw new Error("OVERSEER_CANDIDATE_OPTIONS_REQUIRED:" + c.key);
        if (c.decidedBy !== null)
          throw new Error("OVERSEER_CANDIDATE_DECIDED_BY_MISPLACED:" + c.key);
        // A choice that would change a recorded decision names a real one,
        // still standing.
        if (c.revisesDecision !== null && !decisions.has(c.revisesDecision))
          throw new Error(
            (revoked.has(c.revisesDecision)
              ? "OVERSEER_CANDIDATE_DECISION_REVOKED:"
              : "OVERSEER_CANDIDATE_DECISION_UNKNOWN:") + c.key,
          );
        const taskIds = [...new Set(c.affectedTaskIds)].sort();
        const affected = Object.fromEntries(
          taskIds.map((id) => [id, entries.get(id)!.specDigest]),
        );
        const key = candidateQuestionKey(c, affected);
        const content = substanceOf(c);
        const prior = substance.get(key);
        if (prior !== undefined && prior !== content)
          throw new Error("OVERSEER_CANDIDATE_KEY_CONFLICT:" + c.key);
        substance.set(key, content);
        questions.push({
          candidateKey: c.key,
          key,
          taskIds,
          affected,
          substance: content,
        });
        const recorded = recordedQuestion(key);
        if (!recorded || !ownerAnswerApplies(recorded, taskIds, specOfEntry))
          derivedOpen.push({ key, taskIds });
      } else {
        if (c.revisesDecision !== null)
          throw new Error("OVERSEER_CANDIDATE_REVISION_REQUIRES_OWNER:" + c.key);
        if (c.type === "ALREADY_DECIDED") {
          // Settled means settled on the record: a decision still standing
          // on an affected task, or a question the owner answered for every
          // affected task, never a model's say.
          if (c.decidedBy === null)
            throw new Error("OVERSEER_CANDIDATE_DECISION_UNKNOWN:" + c.key);
          if (!decisions.has(c.decidedBy)) {
            if (revoked.has(c.decidedBy))
              throw new Error(
                "OVERSEER_CANDIDATE_DECISION_REVOKED:" + c.key,
              );
            const settled = settledBy(c.decidedBy, c.affectedTaskIds);
            if (settled === "NOT_APPLICABLE")
              throw new Error(
                "OVERSEER_CANDIDATE_ANSWER_NOT_APPLICABLE:" + c.key,
              );
            if (settled === "UNKNOWN")
              throw new Error(
                "OVERSEER_CANDIDATE_DECISION_UNKNOWN:" + c.key,
              );
          }
        } else if (c.decidedBy !== null)
          throw new Error("OVERSEER_CANDIDATE_DECIDED_BY_MISPLACED:" + c.key);
        if (c.type === "EVIDENCE_BLOCKED") evidence = true;
      }
    }
    const expected = evidence
      ? "BLOCKED_ON_EVIDENCE"
      : owner
        ? "REQUIRES_OWNER"
        : "SCREENED_CLEAR";
    if (s.disposition !== expected)
      throw new Error(
        "OVERSEER_SCREENING_DISPOSITION_MISMATCH:" + s.taskId + ":" + expected,
      );
    // Missing evidence is asked for, of whoever can supply it, in the same
    // checkpoint; a hold nobody is asked to clear would stand forever.
    if (
      evidence &&
      !asked.some((q) => q.projectWide || q.taskIds.includes(s.taskId))
    )
      throw new Error("OVERSEER_EVIDENCE_HOLD_REQUIRES_QUESTION:" + s.taskId);
    records.push({
      version: SCREENING_VERSION,
      projectId: context.snapshot.projectId,
      taskId: s.taskId,
      specDigest: s.specDigest,
      disposition: s.disposition,
      by: "overseer",
      reason: s.reason,
      sourceRefs: s.sourceRefs,
      candidates: s.candidates,
      questions,
      currency: state.currency,
      checkpointInputDigest: plan.inputDigest,
      eligibility: state.eligibility,
    });
  }
  return {
    records,
    derivedOpen,
    /** An owner question from a screening is still open in the project. */
    openPreDesign: context.snapshot.questions.some(
      (q) =>
        String(q.key).startsWith(PRE_DESIGN_QUESTION_PREFIX) &&
        !questionResolved(q) &&
        questionScope(q).audience === "OWNER",
    ),
    /** Why an assignment of this task would not be admitted, after this plan. */
    refuses(id: string): string | null {
      const state = byTask.get(id);
      if (!state?.eligibility.required) return null;
      const fresh = plan.screenings.find((s) => s.taskId === id);
      if (fresh)
        return fresh.disposition === "BLOCKED_ON_EVIDENCE"
          ? "OVERSEER_ASSIGNED_TASK_BLOCKED_ON_EVIDENCE:" + id
          : null;
      if (!state.hold) return null;
      return needsScreening(state)
        ? "OVERSEER_SCREEN_REQUIRED:" + id
        : "OVERSEER_ASSIGNED_TASK_HELD_BY_SCREENING:" + id + ":" + state.hold;
    },
  };
}
/**
 * The only assignment text a coordination-only checkpoint may give
 * (issue #12, contract section 8.4): the controller's own words, so no
 * overseer prose reaches a worker through an assignment.
 */
export const COORDINATION_INSTRUCTION =
  "Carry out the current authorized task specification.";
export function projectOutputSchema(
  context: ProjectContext,
  mode: "COORDINATION_ONLY" | "SUBSTANTIVE" | "LEGACY" = "LEGACY",
) {
  const schema = z.toJSONSchema(ProjectPlanSchema) as Record<string, any>;
  delete schema.$schema;
  schema.properties.inputDigest = {
    type: "string",
    enum: [context.snapshot.inputDigest],
  };
  // A coordination-only checkpoint gives no technical decisions, no
  // screenings and only the controller's assignment text (contract 8.4).
  if (mode === "COORDINATION_ONLY") {
    schema.properties.technicalDecisions.maxItems = 0;
    schema.properties.screenings.maxItems = 0;
    schema.properties.assignments.items.properties.instruction = {
      type: "string",
      enum: [COORDINATION_INSTRUCTION],
    };
  }
  return schema;
}

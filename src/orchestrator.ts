import {
  COORDINATION_INSTRUCTION,
  covers,
  latestCheckpoint,
  oversightCurrent,
  oversightInputDigest,
  planQuestions,
  historicalTasks,
  owedPreDesignQuestions,
  questionScope,
  type ScopedQuestion,
} from "./project.js";
import { candidateQuestionText, PRE_DESIGN_QUESTION_PREFIX } from "./screening.js";
import {
  projectView,
  statusNote,
  type Operational,
} from "./project-view.js";
import { explainHold } from "./holds.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Controller,
  PROPOSAL_REPLY_PENDING_STAGES,
  WORKER_OPERATOR_QUESTIONS_HEADING,
  WORKER_QUESTIONS_HEADING,
  limitEnded,
  limitInterrupted,
  type ProposalRound,
} from "./controller.js";
import {
  canonical,
  digest,
  reviewPayload,
  specDigest,
  type Review,
  type Task,
} from "./domain.js";
import {
  MAX_BRIEF_CHARS,
  MockProvider,
  redact,
  type BusyRun,
  type ProviderAdapter,
  type ProviderReceipt,
} from "./providers.js";
import type { RoutingRole } from "./routing.js";
import { databaseBusy } from "./store.js";

const text = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0);
const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/)
  .refine(
    (value) => redact(value) === value,
    "Keys must not contain credentials",
  );
export const RequestInputSchema = z
  .object({
    requestKey: key,
    prompt: text,
    context: z
      .object({
        cwd: z.string().trim().min(1).max(4096),
        conversationRef: z.string().trim().min(1).max(4096).optional(),
        projectKey: key.optional(),
      })
      .strict(),
    sourceRef: z.string().trim().min(1).max(4096),
    taskIds: z.array(z.string().min(1).max(80)).max(100).default([]),
  })
  .strict();
export type RequestInput = z.input<typeof RequestInputSchema>;
/**
 * A question is for the owner (direction, mechanics, the user's experience,
 * pauses, permissions, scope, accepted decisions) or for the operator (facts
 * about the orchestrator's own state, records or operation). It declares the
 * tasks that wait for its answer, or explicitly the whole project (owner
 * the configured workflow).
 */
export const QuestionInputSchema = z
  .object({
    key,
    text,
    kind: z
      .enum(["INFORMATION", "SCOPE", "OWNER_DECISION", "ACCESS"])
      .default("INFORMATION"),
    audience: z.enum(["OWNER", "OPERATOR"]).default("OWNER"),
    taskId: z.string().min(1).max(80).optional(),
    taskIds: z.array(z.string().min(1).max(80)).min(1).max(100).optional(),
    projectWide: z.boolean().optional(),
  })
  .strict();
/** Question keys only the controller's own steps record. */
export const RESERVED_QUESTION_KEYS = [
  "adaptive-routing:",
  "proposal-question:",
  "worker-question:",
  "worker-operator-question:",
  "overseer-question:",
  "overseer-operator-question:",
  PRE_DESIGN_QUESTION_PREFIX,
];
/**
 * The owner question each owner-resolvable adaptive hold becomes under the
 * GUIDED preference (contract section 9): plain words, two to four options,
 * the recommendation first. Routine ties are never asked about.
 */
const ADAPTIVE_ROUTING_QUESTIONS: Record<string, (taskId: string) => string> = {
  ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED: (id) =>
    `Both providers have shaped task ${id}, so neither can review it independently.\nWhat should happen?\n1) Split the task (Recommended): separate tasks, each worked by one provider, each get an independent review.\n2) Change the review plan: record a decision on how this task is reviewed.\n3) Cancel the task: nothing more runs for it.`,
  ADAPTIVE_PINNED_PREFERENCE_REFUSED: (id) =>
    `The worker and reviewer you chose for task ${id} can't be used: they are not an eligible, qualified, independent pair.\nWhat should happen?\n1) Let the controller choose (Recommended): record that you have no preference for this task, and the best qualified pair is used.\n2) Choose another pair: record a preference naming a worker and reviewer that are eligible.`,
  ADAPTIVE_EVIDENCE_MISSING: (id) =>
    `No worker and reviewer pair has qualifying evaluation evidence for task ${id}'s kind of work, so it can't start under the adaptive workflow.\nWhat should happen?\n1) Wait for evidence (Recommended): a frozen evaluation plan and an evaluation you authorize can qualify a pair.\n2) Use the two-tier workflow for it: move the task before it is pinned.\n3) Cancel the task.`,
  ADAPTIVE_EVIDENCE_CONTRADICTORY: (id) =>
    `Two evaluation plans disagree about the best pair for task ${id}'s kind of work, so neither is trusted.\nWhat should happen?\n1) Keep one plan (Recommended): list only the plan you trust in the routing policy.\n2) Settle it with a new plan: freeze a new evaluation plan whose evidence decides.`,
  ADAPTIVE_LINEAGE_CONFLICT: (id) =>
    `The reviewer pinned for task ${id} would no longer be independent: its provider has shaped the work, or what the next run is given.\nWhat should happen?\n1) Split the task (Recommended): separate tasks, each worked by one provider, each get an independent review.\n2) Change the review plan: record a decision on how this task is reviewed.\n3) Cancel the task: nothing more runs for it.`,
  ADAPTIVE_PINNED_ROUTE_UNAVAILABLE: (id) =>
    `The worker and reviewer pinned for task ${id} no longer have qualifying evaluation evidence, and nothing is chosen in their place.\nWhat should happen?\n1) Wait for evidence (Recommended): an evaluation you authorize can qualify the pair again.\n2) Replace it with a new task: cancel this one and register a new task, which selects its pair afresh.\n3) Cancel the task.`,
  ADAPTIVE_ESCALATION_UNQUALIFIED: (id) =>
    `Task ${id}'s work failed review twice, and no stronger worker and reviewer pair has qualifying evaluation evidence, so it can't move up a level.\nWhat should happen?\n1) Wait for evidence (Recommended): an evaluation you authorize can qualify a stronger pair.\n2) Replace it with smaller tasks: cancel this one and register new tasks, which start without its failed reviews.\n3) Cancel the task.`,
  ADAPTIVE_CEILING_NO_CORRECTION: (id) =>
    `Task ${id}'s worker, already at the highest effort, didn't show a real correction for every must-fix item, so its work was not reviewed.\nWhat should happen?\n1) Replace it with smaller tasks (Recommended): cancel this one and register new tasks, which start without its failed reviews; revising this task keeps them.\n2) Cancel the task: nothing more runs for it.`,
  ADAPTIVE_CEILING_EXHAUSTED: (id) =>
    `Task ${id} is at the highest effort and has used the extra attempts allowed there.\nWhat should happen?\n1) Replace it with smaller tasks (Recommended): cancel this one and register new tasks, which start without its failed reviews; revising this task keeps them.\n2) Allow more attempts at the highest effort: raise that allowance in the routing policy.\n3) Cancel the task.`,
};
export const ReplyInputSchema = z
  .object({
    questionId: z.string().uuid(),
    replyKey: key,
    text,
    sourceRef: z.string().trim().min(1).max(4096),
    /**
     * Who answers: the owner, or the operator answering a factual question
     * about the orchestrator from its records. An operator answer names the
     * records it rests on and never carries the owner's authority.
     */
    answeredAs: z.enum(["OWNER", "OPERATOR"]).optional(),
    /** Owner's explicit historical answer when the task spec has changed.
     * It resolves the old question only; does not bind the new specification. */
    historicalOnly: z.literal(true).optional(),
    evidence: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(20)
      .optional(),
  })
  .strict();
/**
 * Owner-authorized deferral of an informational, task-scoped question.
 * Repeating the exact question text prevents accidentally deferring another
 * question because an ID was copied incorrectly. This is not an answer.
 */
export const DeferQuestionInputSchema = z
  .object({
    questionId: z.string().uuid(),
    questionText: text,
    ownerInstruction: text,
    reason: text,
    sourceRef: z.string().trim().min(1).max(4096),
  })
  .strict();
export type TaskBinding = { taskId: string; specDigest: string };
export type RequestRecord = {
  id: string;
  requestKey: string;
  prompt: string;
  context: { cwd: string; conversationRef?: string; projectKey?: string };
  sourceRef: string;
  inputDigest: string;
  actor: string;
  actorAuthentication: "LOCAL_PROCESS_UID_ONLY";
  conversationOwnerAuthenticated: false;
  createdAt: string;
  /** Host CLI that submitted the request; only that host may change or drive it. */
  host?: OrchestratorHost;
};
export type OrchestratorHost = "claude" | "codex" | "operator";
/**
 * Separation applies between the agent hosts (Claude Code and Codex). The
 * owner's own terminal ("operator") is neutral: it may act on either host's
 * work, and neither host's work is blocked by operator-owned requests.
 */
export function conflictingHosts(
  owner: OrchestratorHost | undefined,
  actor: OrchestratorHost,
) {
  return (
    !!owner && owner !== actor && owner !== "operator" && actor !== "operator"
  );
}
export type Question = {
  id: string;
  key: string;
  text: string;
  kind: "INFORMATION" | "SCOPE" | "OWNER_DECISION" | "ACCESS";
  /** Absent on questions recorded before audiences: those were the owner's. */
  audience?: "OWNER" | "OPERATOR";
  /** A question on one task (as before scopes). */
  taskId?: string;
  /** A question on several tasks; code predating scopes reads it as request-wide. */
  taskIds?: string[];
  /** Explicitly the whole project; also how taskless legacy questions are read. */
  projectWide?: boolean;
  specDigest?: string;
  /** Each scoped task's specification when the question was asked. */
  specDigests?: Record<string, string>;
  /** The Astra checkpoint run that asked it. */
  askedBy?: string;
  actor: string;
  createdAt: string;
};
type QuestionDeferral = {
  questionId: string;
  questionText: string;
  ownerInstruction: string;
  reason: string;
  sourceRef: string;
  inputDigest: string;
  actor: string;
  createdAt: string;
  grantsAuthority: false;
};
type Reply = {
  questionId: string;
  replyKey: string;
  text: string;
  sourceRef: string;
  answeredAs?: "OWNER" | "OPERATOR";
  historicalOnly?: true;
  /** Old question scope answered after replacement specification. */
  historicalForSpec?: Record<string, string>;
  evidence?: string[];
  inputDigest: string;
  actor: string;
  createdAt: string;
  grantsAuthority: false;
};
type Step = {
  taskId: string;
  key: string;
  stage: string;
  condition: string;
  outcome: "RECORDED" | "HELD";
  detail: string;
  runId?: string;
};
type WorkflowEvent = { seq: number; kind: string; body: Record<string, any> };

/** Round stages that advancing the request moves on. */
const ADVANCEABLE_ROUND_STAGES = [
  "AWAITING_REPLY",
  "AWAITING_MODERATOR",
  "AWAITING_OWNER_QUESTIONS",
];
/** What the host shows the owner about a task's proposal round. */
function proposalSummary(round: ProposalRound) {
  return {
    stage: round.stage,
    reviewRunId: round.reviewRunId,
    ...(round.reply ? { reply: round.reply } : {}),
    ...(round.moderator ? { moderator: round.moderator } : {}),
    items: round.items.map((item) => ({
      id: item.id,
      what: item.what,
      userImpact: item.userImpact,
      weight: item.weight,
      touchesDecision: item.touchesDecision,
      settlement: item.settlement,
      ...(item.reply ? { workerReply: item.reply } : {}),
      ...(item.moderator ? { moderator: item.moderator } : {}),
      ...(item.question
        ? {
            ownerQuestion: {
              key: item.question.key,
              asked: item.question.asked,
              answers: item.question.answers,
            },
          }
        : {}),
    })),
  };
}

/** Whether a recorded question is the same question: audience, text and scope. */
function sameQuestion(
  recorded: Record<string, any>,
  wanted: {
    audience: "OWNER" | "OPERATOR";
    text: string;
    taskIds: string[];
    projectWide: boolean;
  },
): boolean {
  const scope = questionScope(recorded);
  return (
    scope.audience === wanted.audience &&
    recorded.text === wanted.text &&
    scope.projectWide === wanted.projectWide &&
    (scope.projectWide ||
      canonical([...scope.taskIds].sort()) ===
        canonical([...wanted.taskIds].sort()))
  );
}
const headingLine = (heading: string) =>
  new RegExp(
    "^[\\s#>*_]*" + heading.replace(/:$/, "") + "[\\s*_]*(?::[\\s*_]*(.*))?$",
    "i",
  );
const WORKER_QUESTIONS_LINE = headingLine(WORKER_QUESTIONS_HEADING),
  WORKER_OPERATOR_QUESTIONS_LINE = headingLine(WORKER_OPERATOR_QUESTIONS_HEADING);
/**
 * One of a worker summary's question sections: from its last heading line to
 * the next question heading (either kind) or the end; undefined if empty.
 */
function questionSection(output: string, line: RegExp): string | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findLastIndex((l) => line.test(l));
  if (start < 0) return undefined;
  const first = line.exec(lines[start]!)![1] ?? "";
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex(
    (l) => WORKER_QUESTIONS_LINE.test(l) || WORKER_OPERATOR_QUESTIONS_LINE.test(l),
  );
  const body = [first, ...(stop < 0 ? rest : rest.slice(0, stop))]
    .join("\n")
    .trim();
  if (!body || /^(none|n\/a|no questions?)\.?$/i.test(body)) return undefined;
  return body.length > 16_000 ? body.slice(0, 16_000) + "\n[truncated]" : body;
}
/** The questions an unsure worker left for the owner, or undefined if it asked none. */
export function workerQuestions(output: string): string | undefined {
  return questionSection(output, WORKER_QUESTIONS_LINE);
}
/**
 * The factual questions a worker left for the operator (provenance, a
 * gateway-log checksum, where a file is), or undefined if it asked none.
 */
export function workerOperatorQuestions(output: string): string | undefined {
  return questionSection(output, WORKER_OPERATOR_QUESTIONS_LINE);
}

/** Live adapters are trusted operator configuration (see live.ts), never request input. */
export type LiveAdapters = Partial<Record<"codex" | "claude", ProviderAdapter>>;

/** Durable request journal; the controller remains the sole task state machine.
 * Prompts/replies confer no grants. Live execution runs only through adapters
 * the operator configured, and only for non-simulation tasks.
 */
/**
 * Astra's project view uses at least this share of a brief, even with settled
 * and older detail left out, before the request view warns that the project
 * is nearly too large for one phase.
 */
export const PROJECT_VIEW_WARNING_SHARE = 0.75;
/**
 * The request view's project section: where the project stands, without the
 * whole record (Orchestrator.project and `--project-full` give that), so that
 * reading a request's status stays small.
 */
export function projectSummary(
  p: ReturnType<Orchestrator["project"]>,
  requestId: string,
  operational?: Operational,
) {
  // Astra's runs are anchored on a task whose entry is never shortened, so the
  // view is sized for the open task with the largest entry, the worst case.
  const anchor = p.snapshot.tasks
    .filter(
      (e) =>
        !["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(
          e.task.status,
        ),
    )
    .map((e) => ({ id: e.task.id, size: canonical(e).length }))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id))[0]?.id;
  const view = projectView(p, "overseer", anchor ?? "", { operational });
  const plan = p.previous?.plan;
  const short = (text: string, limit: number) =>
    text.length <= limit ? text : text.slice(0, limit) + " [shortened]";
  return {
    projectId: p.snapshot.projectId,
    inputDigest: p.snapshot.inputDigest,
    current: p.current,
    astraPlan: p.previous
      ? {
          revision: p.previous.revision,
          runId: p.previous.runId,
          outcome: plan!.outcome,
          summary: plan!.summary,
          nextTaskIds: plan!.nextTaskIds,
          assignments: plan!.assignments,
          milestones: plan!.milestones,
          risks: plan!.risks,
          technicalDecisions: plan!.technicalDecisions.map((d) => d.decision),
          questionsForOwner: planQuestions(plan!).owner,
          questionsForOperator: planQuestions(plan!).operator,
        }
      : null,
    tasks: p.snapshot.tasks.map((e) => {
      const note = statusNote(e);
      const review = e.reviews.at(-1) as Review | undefined;
      const screening = p.preDesign?.find((s) => s.taskId === e.task.id);
      return {
        id: e.task.id,
        title: e.task.title,
        status: e.task.status,
        specDigest: e.specDigest,
        holds: e.gate?.holds ?? [],
        completionCurrent: e.gate?.completionCurrent ?? false,
        ...(note ? { statusNote: note } : {}),
        // Pre-design discovery (proposal #17), for opted-in tasks.
        ...(screening
          ? {
              preDesign: {
                required: screening.eligibility.required,
                reasons: screening.eligibility.reasons,
                disposition: screening.latest?.disposition ?? null,
                current: screening.current,
                hold: screening.hold,
                questions: screening.questions.map((q) => ({
                  key: q.key,
                  status: q.status,
                  questionId: q.questionId,
                })),
              },
            }
          : {}),
        artifact: e.artifact
          ? { runId: e.artifact.runId, path: e.artifact.path }
          : null,
        latestReview: review
          ? { runId: review.runId, verdict: review.verdict }
          : null,
      };
    }),
    questions: p.snapshot.questions.map((q) => ({
      id: q.id,
      ...questionScope(q),
      // A pre-design question another project recorded on a task here is
      // answered in its own request (review round 8).
      ...(q.requestId ? { requestId: q.requestId } : {}),
      kind: q.kind,
      status: q.answers.length ? "ANSWERED" : q.deferred ? "DEFERRED" : "OPEN",
      ...(q.answers.some((a: any) => a?.historicalOnly)
        ? { historicalForTasks: historicalTasks(q) }
        : {}),
      text: short(q.text, 500),
    })),
    briefSize: {
      limit: MAX_BRIEF_CHARS,
      astraView: view.full,
      astraSmallestView: view.smallest,
      nearLimit: view.smallest > MAX_BRIEF_CHARS * PROJECT_VIEW_WARNING_SHARE,
    },
    fullRecord: `orchestrate --request-id ${requestId} --project-full prints the whole project record`,
  };
}

export class Orchestrator {
  constructor(
    readonly controller: Controller,
    private readonly live: LiveAdapters = {},
    readonly host: OrchestratorHost = "operator",
    /**
     * Live hooks. `attest(routeId)` re-proves a route whose proof has aged
     * out, called just before a reservation that needs it.
     */
    private readonly hooks: {
      attest?: (routeId: string) => Promise<void>;
    } = {},
  ) {
    // A run reserved before its request was paused does not launch: the
    // controller asks this at its start transaction and just before the
    // process is spawned (S5). A run already going is never stopped.
    controller.setLaunchGuard("request-pause", (a) => {
      const requestId = this.linkedRequest(a.id);
      return requestId && this.requestPause(requestId)
        ? "REQUEST_PAUSED: the owner paused request " + requestId
        : undefined;
    });
  }
  /** The request whose advance reserved this run, if any. */
  private linkedRequest(runId: string): string | undefined {
    const row = this.controller.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_RUN_LINKED' ORDER BY seq DESC",
      )
      .map((r) => JSON.parse(r.body))
      .find((b) => b.runId === runId);
    return row?.requestId;
  }
  /**
   * Re-attests the routes a reservation is about to need when their proof has
   * aged out : a review recorded
   * earlier in this advance can send the next run to a tier that preflight
   * could not foresee, so the proof is renewed where it is needed. A route
   * that still fails to attest leaves the reservation to report its hold.
   */
  private async ensureAttested(
    taskId: string,
    role: RoutingRole,
    options: {
      provider?: "codex" | "claude" | "mock";
      excludeProviders?: Array<"codex" | "claude" | "mock">;
    } = {},
  ) {
    if (!this.hooks.attest) return;
    let route: ReturnType<Controller["route"]>;
    try {
      route = this.controller.route(taskId, role, options);
    } catch {
      return;
    }
    if (route.ok) return;
    let adaptiveRoutes: string[] = [];
    try {
      adaptiveRoutes = this.controller.adaptiveAttestationRoutes(taskId, role, options);
    } catch {
      // A permanent project/lineage hold must still be reported by reservation;
      // inability to project refreshable capabilities does not replace it.
    }
    const stale = new Set(
      [...adaptiveRoutes, ...route.reasons
        .map(
          (r) =>
            /^LIVE_CAPABILITY_(?:STALE_OR_FUTURE|UNAUTHENTICATED|MISSING): (\S+)$/.exec(
              r,
            )?.[1],
        )
        .filter((id): id is string => !!id)],
    );
    for (const routeId of stale)
      try {
        await this.hooks.attest(routeId);
      } catch {
        /* the reservation then reports the hold */
      }
  }
  /** Requests from before host tagging have no owner and stay usable by any host. */
  assertHost(requestId: string) {
    const owner = this.record(requestId).host;
    if (conflictingHosts(owner, this.host))
      throw new Error(
        "REQUEST_OWNED_BY_OTHER_HOST:" +
          owner +
          " (this host: " +
          this.host +
          ")",
      );
  }
  /** The host whose request launched a run, if the run belongs to a request. */
  runHost(runId: string): OrchestratorHost | undefined {
    const linked = this.events().find(
      (e) => e.kind === "WORKFLOW_RUN_LINKED" && e.body.runId === runId,
    );
    return linked ? this.record(linked.body.requestId).host : undefined;
  }
  /** Hosts of every tagged request the task is attached to. */
  private taskHosts(taskId: string): OrchestratorHost[] {
    const hosts = new Set<OrchestratorHost>();
    for (const e of this.events())
      if (
        e.kind === "WORKFLOW_TASKS_ATTACHED" &&
        (e.body.bindings as TaskBinding[]).some((b) => b.taskId === taskId)
      ) {
        const owner = this.record(e.body.requestId).host;
        if (owner) hosts.add(owner);
      }
    return [...hosts];
  }
  /** The agent host (Claude Code or Codex) owning the task, if any. */
  taskHost(taskId: string): OrchestratorHost | undefined {
    const hosts = this.taskHosts(taskId);
    return hosts.find((h) => h !== "operator") ?? hosts[0];
  }
  /** Every binding counts: a neutral operator attachment never hides an agent's. */
  assertTaskHost(taskId: string) {
    const owner = this.taskHosts(taskId).find((h) =>
      conflictingHosts(h, this.host),
    );
    if (owner)
      throw new Error(
        "TASK_BOUND_TO_OTHER_HOST_REQUEST:" +
          owner +
          " (this host: " +
          this.host +
          ")",
      );
  }
  assertRunHost(runId: string) {
    const owner = this.runHost(runId);
    if (conflictingHosts(owner, this.host))
      throw new Error(
        "RUN_OWNED_BY_OTHER_HOST:" + owner + " (this host: " + this.host + ")",
      );
  }
  /** What advice the worker has (or will run without) for the current spec. */
  private adviceStatus(taskId: string, steps: Step[]) {
    const obtained = this.controller.advice(taskId).find((x) => x.advice);
    if (obtained)
      return {
        status: "OBTAINED" as const,
        runId: obtained.runId,
        provider: obtained.provider,
        model: obtained.model,
        effort: obtained.effort,
        questionsForOwner: obtained.advice!.questionsForOwner,
      };
    const spec = specDigest(this.controller.task(taskId));
    const missed = steps
      .filter(
        (step) =>
          step.stage === "ADVICE_NOT_OBTAINED" && step.condition === spec,
      )
      .at(-1);
    return missed
      ? { status: "NOT_OBTAINED" as const, reason: missed.detail }
      : { status: "PENDING" as const };
  }
  private reviewerRuns(taskId: string) {
    return this.controller
      .inspect(taskId)
      .attempts.filter((a: { role: string }) => a.role === "reviewer");
  }
  /** Reviewer runs on the task's current artifact that ended without a review and may be retried. */
  private endedReviewRuns(taskId: string) {
    try {
      return this.controller.artifactReviews(this.controller.task(taskId))
        .ended;
    } catch {
      return new Set<string>();
    }
  }
  private liveConfigured() {
    return Object.values(this.live).some(Boolean);
  }
  private liveFor(t: Task) {
    return t.providers.some(
      (p) => (p === "codex" || p === "claude") && !!this.live[p],
    );
  }
  /** The provider of the task's current sealed work, which a reply or rework stays with. */
  private artifactProvider(taskId: string) {
    const spec = specDigest(this.controller.task(taskId));
    const worker = this.controller
      .inspect(taskId)
      .attempts.filter(
        (a: { role: string; state: string; specDigest: string }) =>
          a.role === "worker" &&
          a.state === "SUCCEEDED" &&
          a.specDigest === spec,
      )
      .at(-1) as { provider: "codex" | "claude" | "mock" } | undefined;
    return worker?.provider;
  }
  private liveAdapter(provider: string): ProviderAdapter {
    const adapter =
      provider === "codex" || provider === "claude"
        ? this.live[provider]
        : undefined;
    if (!adapter) throw new Error("LIVE_PROVIDER_NOT_CONFIGURED:" + provider);
    return adapter;
  }
  /** The owner's request text as a specification source for a real task. */
  ownerSource(requestId: string) {
    const request = this.record(requestId);
    return {
      evidenceId: "owner-request-" + request.id,
      revision: request.inputDigest,
      digest: digest(request.prompt),
    };
  }
  private recordOwnerSources(requestId: string, taskIds: string[]) {
    const c = this.controller,
      source = this.ownerSource(requestId),
      request = this.record(requestId);
    for (const taskId of taskIds) {
      const t = c.task(taskId);
      if (
        t.simulation ||
        !t.sources.some((s) => s.evidenceId.startsWith(source.evidenceId))
      )
        continue;
      const id = source.evidenceId + "-" + taskId;
      if (!t.sources.some((s) => s.evidenceId === id)) continue;
      if (c.evidenceFor(taskId).some((e) => e.id === id)) continue;
      c.addEvidence(
        {
          id,
          taskId,
          kind: "LOCAL",
          uri: "orchestrator-request:" + request.id,
          revision: source.revision,
          digest: source.digest,
          retrievedAt: request.createdAt,
          authorityTier: "PLANNING",
          authentication: "LOCAL_OWNER_REQUEST",
          currentness: "CURRENT_AT_RETRIEVAL",
          claims: [
            "Owner's literal request text captured by local UID-authenticated intake; grants no operation by itself",
          ],
          metadata: { requestId: request.id, sourceRef: request.sourceRef },
        },
        c.localActor(),
      );
    }
  }

  private events(requestId?: string): WorkflowEvent[] {
    return this.controller.db
      .all<{ seq: number; kind: string; body: string }>(
        "SELECT seq,kind,body FROM events WHERE kind LIKE 'WORKFLOW_%' ORDER BY seq",
      )
      .map((e) => ({ ...e, body: JSON.parse(e.body) }))
      .filter((e) => requestId === undefined || e.body.requestId === requestId);
  }
  /**
   * A request at a glance : status, progress, open
   * questions, explained holds, provider pauses, the request's own pause,
   * runs in progress and what may be done next, so routine operation needs
   * no reading of the database or the code.
   */
  compact(requestId: string) {
    const view = this.inspect(requestId) as ReturnType<Orchestrator["inspect"]> & {
      pause?: unknown;
      otherRequestQuestions?: unknown[];
    };
    const progress: Record<string, number> = {};
    for (const t of view.tasks) progress[t.status] = (progress[t.status] ?? 0) + 1;
    const short = (text: string) =>
      text.length <= 400 ? text : text.slice(0, 400) + " [shortened]";
    return {
      requestId,
      status: view.status,
      ...(view.pause ? { pause: view.pause } : {}),
      progress,
      openQuestions: view.questions
        .filter((q) => q.status === "OPEN")
        .map((q) => ({
          id: q.id,
          audience: q.audience,
          ...(q.projectWide ? { projectWide: true } : { taskIds: q.taskIds }),
          text: short(q.text),
        })),
      ...(view.otherRequestQuestions?.length
        ? { otherRequestQuestions: view.otherRequestQuestions }
        : {}),
      holds: view.tasks
        .filter((t) => t.holds.length)
        .map((t) => ({
          taskId: t.taskId,
          status: t.status,
          holds: t.holdsExplained,
        })),
      providerPauses: view.providerPauses,
      activeRuns: view.tasks.flatMap((t) =>
        t.unresolvedRuns.map((r) => ({ taskId: t.taskId, ...r })),
      ),
      nextSteps: view.nextSteps,
      note: "A command shown here grants nothing: it needs the evidence or authority named, and the controller re-checks everything.",
    };
  }
  /** Every request with the host that owns it, oldest first (for the driver). */
  requests(): Array<{ id: string; host?: string; projectKey: string }> {
    return this.events()
      .filter((e) => e.kind === "WORKFLOW_SUBMITTED")
      .map((e) => {
        const r = e.body.request as RequestRecord;
        return {
          id: r.id,
          ...(r.host ? { host: r.host } : {}),
          projectKey: r.context.projectKey ?? r.id,
        };
      });
  }
  /**
   * The owner's pause of a request, if it is paused : nothing new starts for it; a run already going finishes and
   * is recorded. Not a project input, so no run is invalidated by it.
   */
  requestPause(
    requestId: string,
  ): { text: string; sourceRef: string; at: string } | undefined {
    const last = this.events(requestId)
      .filter(
        (e) =>
          e.kind === "WORKFLOW_REQUEST_PAUSED" ||
          e.kind === "WORKFLOW_REQUEST_RESUMED",
      )
      .at(-1);
    return last?.kind === "WORKFLOW_REQUEST_PAUSED"
      ? { text: last.body.text, sourceRef: last.body.sourceRef, at: last.body.at }
      : undefined;
  }
  /** Pause a request (the owner's words); resume lifts only the pause. */
  pauseRequest(requestId: string, value: unknown, resume = false) {
    const actor = this.controller.localActor();
    this.assertHost(requestId);
    const input = z
      .object({ text, sourceRef: z.string().trim().min(1).max(4096) })
      .strict()
      .parse(value);
    this.controller.warmLineage();
    return this.controller.db.transaction(() => {
      const paused = !!this.requestPause(requestId);
      if (paused === !resume)
        throw new Error(resume ? "REQUEST_NOT_PAUSED" : "REQUEST_ALREADY_PAUSED");
      this.append(
        requestId,
        resume ? "WORKFLOW_REQUEST_RESUMED" : "WORKFLOW_REQUEST_PAUSED",
        {
          text: redact(input.text),
          sourceRef: redact(input.sourceRef),
          actor: actor.id,
          at: new Date().toISOString(),
        },
      );
      return this.inspect(requestId);
    });
  }
  private record(requestId: string): RequestRecord {
    const row = this.events(requestId).find(
      (e) => e.kind === "WORKFLOW_SUBMITTED",
    );
    if (!row) throw new Error("REQUEST_NOT_FOUND:" + requestId);
    return row.body.request as RequestRecord;
  }
  private bindings(requestId: string): TaskBinding[] {
    this.record(requestId);
    // An explicit rebind replaces a task's bound specification in place.
    const bound = new Map<string, TaskBinding>();
    for (const e of this.events(requestId))
      if (
        e.kind === "WORKFLOW_TASKS_ATTACHED" ||
        e.kind === "WORKFLOW_TASKS_REBOUND"
      )
        for (const b of e.body.bindings as TaskBinding[])
          bound.set(b.taskId, { taskId: b.taskId, specDigest: b.specDigest });
    return [...bound.values()];
  }
  /** Own-request questions are open only until a reply or explicit deferral. */
  private ownOpenQuestions(requestId: string): Question[] {
    const events = this.events(requestId),
      settled = new Set(
        events.flatMap((e) =>
          e.kind === "WORKFLOW_REPLY"
            ? [e.body.reply.questionId]
            : e.kind === "WORKFLOW_QUESTION_DEFERRED"
              ? [e.body.deferral.questionId]
              : [],
        ),
      );
    return events
      .filter((e) => e.kind === "WORKFLOW_QUESTION" && !settled.has(e.body.question.id))
      .map((e) => e.body.question as Question);
  }
  private append(requestId: string, kind: string, data: unknown) {
    this.controller.db.event(kind, null, { requestId, ...(data as object) });
  }

  submit(value: RequestInput) {
    const actor = this.controller.localActor(),
      input = RequestInputSchema.parse(value);
    input.taskIds = [...new Set(input.taskIds)].sort();
    const inputDigest = digest(input);
    this.controller.warmLineage();
    return this.controller.db.transaction(() => {
      const existing = this.events().find(
        (e) =>
          e.kind === "WORKFLOW_SUBMITTED" &&
          e.body.request.requestKey === input.requestKey,
      );
      if (existing) {
        const owner = existing.body.request.host;
        if (conflictingHosts(owner, this.host))
          throw new Error("REQUEST_OWNED_BY_OTHER_HOST:" + owner);
        if (existing.body.request.inputDigest !== inputDigest)
          throw new Error("REQUEST_KEY_REPLAY_MISMATCH");
        return this.inspect(existing.body.request.id);
      }
      if (
        input.context.projectKey &&
        this.events().some(
          (e) =>
            e.kind === "WORKFLOW_SUBMITTED" &&
            e.body.request.context.projectKey === input.context.projectKey &&
            conflictingHosts(e.body.request.host, this.host),
        )
      )
        throw new Error("PROJECT_OWNED_BY_OTHER_HOST");
      // Explicit IDs only; no prompt-derived scope, grants, or specifications.
      input.taskIds.forEach((id) => this.assertTaskHost(id));
      const bindings = input.taskIds.map((id) => ({
        taskId: id,
        specDigest: specDigest(this.controller.task(id)),
      }));
      const request: RequestRecord = {
        id: randomUUID(),
        requestKey: input.requestKey,
        prompt: redact(input.prompt),
        context: {
          cwd: redact(input.context.cwd),
          ...(input.context.projectKey
            ? { projectKey: input.context.projectKey }
            : {}),
          ...(input.context.conversationRef
            ? { conversationRef: redact(input.context.conversationRef) }
            : {}),
        },
        sourceRef: redact(input.sourceRef),
        inputDigest,
        actor: actor.id,
        actorAuthentication: "LOCAL_PROCESS_UID_ONLY",
        conversationOwnerAuthenticated: false,
        host: this.host,
        createdAt: new Date().toISOString(),
      };
      this.append(request.id, "WORKFLOW_SUBMITTED", { request });
      if (bindings.length)
        this.append(request.id, "WORKFLOW_TASKS_ATTACHED", {
          bindings,
          actor: actor.id,
        });
      return this.inspect(request.id);
    });
  }

  attach(requestId: string, taskIds: string[]) {
    const actor = this.controller.localActor();
    this.assertHost(requestId);
    this.controller.warmLineage();
    const ids = z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(100)
      .parse(taskIds);
    return this.controller.db.transaction(() => {
      const previous = this.bindings(requestId),
        next: TaskBinding[] = [];
      for (const taskId of [...new Set(ids)].sort()) {
        this.assertTaskHost(taskId);
        const current = specDigest(this.controller.task(taskId));
        const old = previous.find((b) => b.taskId === taskId);
        if (old && old.specDigest !== current)
          throw new Error("REQUEST_TASK_SPEC_CHANGED:" + taskId);
        if (!old) next.push({ taskId, specDigest: current });
      }
      if (next.length)
        this.append(requestId, "WORKFLOW_TASKS_ATTACHED", {
          bindings: next,
          actor: actor.id,
        });
      this.recordOwnerSources(
        requestId,
        next.map((b) => b.taskId),
      );
      return this.inspect(requestId);
    });
  }

  /**
   * An open question on the same task belongs to the task's work, even when
   * another request attached it without using a two-tier project key. No
   * question text is imported into this request: this is an admission guard.
   * It is only called while the request's host and task ownership have been
   * established. Settled (answered/deferred) questions remain in history.
   */
  private openQuestionOnTaskElsewhere(requestId: string, taskId: string) {
    const events = this.events();
    const owners = new Set(
      events
        .filter(
          (e) =>
            ["WORKFLOW_TASKS_ATTACHED", "WORKFLOW_TASKS_REBOUND"].includes(e.kind) &&
            (e.body.bindings ?? []).some((b: TaskBinding) => b.taskId === taskId),
        )
        .map((e) => e.body.requestId as string),
    );
    const closed = new Set(
      events.flatMap((e) =>
        e.kind === "WORKFLOW_REPLY"
          ? [e.body.reply.questionId as string]
          : e.kind === "WORKFLOW_QUESTION_DEFERRED"
            ? [e.body.deferral.questionId as string]
            : [],
      ),
    );
    return events.find(
      (e) =>
        e.kind === "WORKFLOW_QUESTION" &&
        e.body.requestId !== requestId &&
        owners.has(e.body.requestId) &&
        !closed.has(e.body.question.id) &&
        covers(e.body.question as Question, taskId),
    )?.body.requestId as string | undefined;
  }

  /** Read-only rebind checks, also used before a preview's hypothetical writes. */
  private rebindBindings(requestId: string, taskIds: string[]) {
    const bindings = this.bindings(requestId),
      projectQuestions = this.projectOpenQuestions(requestId),
      ownQuestions = this.ownOpenQuestions(requestId),
      rebound: (TaskBinding & { previousSpecDigest: string })[] = [];
    for (const taskId of [...new Set(taskIds)].sort()) {
      this.assertTaskHost(taskId);
      const bound = bindings.find((t) => t.taskId === taskId);
      if (!bound) throw new Error("TASK_NOT_IN_REQUEST:" + taskId);
      const currentSpec = specDigest(this.controller.task(taskId));
      if (bound.specDigest === currentSpec)
        throw new Error("REBIND_NOT_NEEDED:" + taskId);
      const otherQuestion = this.openQuestionOnTaskElsewhere(requestId, taskId);
      if (
        ownQuestions.some((q) => covers(q, taskId)) ||
        projectQuestions.some((q) => covers(q, taskId)) ||
        otherQuestion
      )
        throw new Error(
          "REBIND_HAS_OPEN_QUESTIONS:" + taskId +
          (otherQuestion ? ":OTHER_REQUEST:" + otherQuestion : ""),
        );
      const unresolved = this.controller.db
        .all<{ body: string }>("SELECT body FROM attempts WHERE task_id=?", taskId)
        .some((row) => ["RESERVED", "STARTED", "UNKNOWN"].includes(JSON.parse(row.body).state));
      if (unresolved) throw new Error("REBIND_HAS_UNRESOLVED_RUNS:" + taskId);
      rebound.push({ taskId, specDigest: currentSpec, previousSpecDigest: bound.specDigest });
    }
    return rebound;
  }
  /**
   * Explicitly bind revised tasks to this request, for example after folding in
   * the owner's answer, so the request runs the revised work. Never implicit.
   */
  rebind(requestId: string, taskIds: string[]) {
    const actor = this.controller.localActor();
    this.assertHost(requestId);
    this.controller.warmLineage();
    const ids = z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(100)
      .parse(taskIds);
    return this.controller.db.transaction(() => {
      const rebound = this.rebindBindings(requestId, ids);
      this.append(requestId, "WORKFLOW_TASKS_REBOUND", {
        bindings: rebound,
        actor: actor.id,
      });
      this.recordOwnerSources(
        requestId,
        rebound.map((b) => b.taskId),
      );
      return this.inspect(requestId);
    });
  }

  ask(requestId: string, value: z.input<typeof QuestionInputSchema>): Question {
    return this.askScoped(requestId, value, {});
  }
  /**
   * Record a question. Keys in RESERVED_QUESTION_KEYS are the controller's
   * own (proposal, worker and Astra questions) and only its steps may use
   * them, so no caller can seed a question a step will treat as its own.
   */
  private askScoped(
    requestId: string,
    value: z.input<typeof QuestionInputSchema>,
    internal: {
      reserved?: boolean;
      askedBy?: string;
      /**
       * A question a screening owes, recorded in a request of another
       * project: bound to these specifications of its own tasks (checked
       * current) instead of that project's whole record, and recorded once
       * in the whole journal (review round 11).
       */
      specs?: Record<string, string>;
    },
  ): Question {
    const actor = this.controller.localActor(),
      input = QuestionInputSchema.parse(value);
    this.assertHost(requestId);
    if (
      !internal.reserved &&
      RESERVED_QUESTION_KEYS.some((prefix) => input.key.startsWith(prefix))
    )
      throw new Error("QUESTION_KEY_RESERVED");
    const scoped = [
      ...new Set([
        ...(input.taskId ? [input.taskId] : []),
        ...(input.taskIds ?? []),
      ]),
    ].sort();
    return this.controller.db.transaction(() => {
      // Astra plans the whole project, so its questions may name any of the
      // project's tasks, bound by this request or another; every other
      // question names this request's own tasks.
      const bound = new Map<string, string>(
        internal.specs
          ? Object.entries(internal.specs)
          : internal.askedBy
            ? this.controller
                .projectContextFor(requestId)
                .snapshot.tasks.map((e) => [e.task.id, e.specDigest])
            : this.bindings(requestId).map((b) => [b.taskId, b.specDigest]),
      );
      const specDigests: Record<string, string> = {};
      for (const taskId of scoped) {
        const spec = bound.get(taskId);
        if (!spec)
          throw new Error(
            internal.askedBy
              ? "QUESTION_TASK_OUTSIDE_PROJECT"
              : "QUESTION_TASK_OUTSIDE_REQUEST",
          );
        if (spec !== specDigest(this.controller.task(taskId)))
          throw new Error("QUESTION_TASK_SPEC_CHANGED");
        specDigests[taskId] = spec;
      }
      if (internal.specs) {
        const same = this.events().find(
          (e) =>
            e.kind === "WORKFLOW_QUESTION" && e.body.question.key === input.key,
        );
        if (same) return same.body.question as Question;
      }
      // Astra's questions are the project's: under the same write lock as
      // the insert, one already recorded by key in any of the project's
      // requests, or equal to one still open there, is not recorded again.
      if (internal.askedBy && !internal.specs) {
        const project = this.controller.projectContextFor(requestId).snapshot
          .questions as Array<Record<string, any>>;
        const same =
          project.find((q) => q.key === input.key) ??
          project.find(
            (q) =>
              !(q.answers ?? []).length &&
              !q.deferred &&
              sameQuestion(q, {
                audience: input.audience,
                text: redact(input.text),
                taskIds: scoped,
                projectWide: !scoped.length,
              }),
          );
        if (same) {
          const { answers: _answers, ...question } = same;
          return question as Question;
        }
      }
      const existing = this.events(requestId).find(
        (e) =>
          e.kind === "WORKFLOW_QUESTION" && e.body.question.key === input.key,
      );
      const inputDigest = digest(input);
      if (existing) {
        // A question asked before audiences and scopes existed was recorded
        // with the digest of its input without them (a taskless one may now
        // say projectWide, as it must when asked anew); the controller's own
        // steps re-ask their questions by key.
        const { audience, projectWide, ...legacy } = input;
        if (
          !internal.reserved &&
          existing.body.inputDigest !== inputDigest &&
          !(
            audience === "OWNER" &&
            !input.taskIds &&
            (projectWide !== true || !scoped.length) &&
            existing.body.inputDigest === digest(legacy)
          )
        )
          throw new Error("QUESTION_KEY_REPLAY_MISMATCH");
        return existing.body.question as Question;
      }
      // Every question says whom it holds: its tasks, or explicitly the project.
      if (!scoped.length && input.projectWide !== true)
        throw new Error("QUESTION_SCOPE_REQUIRED");
      if (scoped.length && input.projectWide === true)
        throw new Error("QUESTION_SCOPE_AMBIGUOUS");
      const { taskId: _single, taskIds: _many, projectWide, ...rest } = input;
      const question: Question = {
        id: randomUUID(),
        ...rest,
        text: redact(input.text),
        // One task keeps the field earlier code reads; several are read as
        // request-wide by such code, the conservative reading.
        ...(scoped.length === 1
          ? { taskId: scoped[0]!, specDigest: specDigests[scoped[0]!]! }
          : {}),
        ...(scoped.length > 1 ? { taskIds: scoped, specDigests } : {}),
        ...(projectWide ? { projectWide: true } : {}),
        ...(internal.askedBy ? { askedBy: internal.askedBy } : {}),
        actor: actor.id,
        createdAt: new Date().toISOString(),
      };
      this.append(requestId, "WORKFLOW_QUESTION", { question, inputDigest });
      return question;
    });
  }
  /**
   * The open questions of the request's whole project (two-tier), from any
   * of its requests: they hold the tasks they cover wherever those tasks are
   * advanced. Empty without a project.
   */
  private projectOpenQuestions(
    requestId: string,
  ): Array<Question & { requestId: string }> {
    if (!this.controller.projectGoverned()) return [];
    // Do not require a current Astra snapshot here. The task may already
    // have been revised, making that snapshot temporarily fail
    // PROJECT_SPEC_CHANGED exactly when rebinding needs the other requests'
    // questions. The submitted request records give stable membership.
    const request = this.record(requestId);
    const allEvents = this.events();
    const peers = allEvents
      .filter((e) => e.kind === "WORKFLOW_SUBMITTED")
      .map((e) => e.body.request as RequestRecord)
      .filter((r) =>
        request.context.projectKey
          ? r.context.projectKey === request.context.projectKey
          : r.id === requestId,
      );
    // The project's requests must not mix agent hosts (submit refuses that),
    // as projectSnapshot() checks. Compare them with the request's own host,
    // not the caller's: the other host may still read the request (inspect,
    // list), and every mutating caller has already passed assertHost().
    if (
      request.host &&
      peers.some((r) => conflictingHosts(r.host, request.host!))
    )
      throw new Error("PROJECT_OWNED_BY_OTHER_HOST");
    const ids = new Set(peers.map((r) => r.id));
    const events = allEvents.filter((e) => ids.has(e.body.requestId));
    const answered = new Set(
      events.flatMap((e) =>
        e.kind === "WORKFLOW_REPLY"
          ? [e.body.reply.questionId]
          : e.kind === "WORKFLOW_QUESTION_DEFERRED"
            ? [e.body.deferral.questionId]
            : [],
      ),
    );
    const own = events
      .filter(
        (e) =>
          e.kind === "WORKFLOW_QUESTION" && !answered.has(e.body.question.id),
      )
      .map((e) => ({
        ...(e.body.question as Question),
        requestId: e.body.requestId as string,
      }));
    // The pre-design questions another project recorded on one of this
    // project's tasks are part of this project's record (project.ts) and
    // hold those tasks here: while open they are listed with the request
    // that recorded them, where they are answered (review round 8).
    const tasks = new Set(
      events
        .filter((e) =>
          ["WORKFLOW_TASKS_ATTACHED", "WORKFLOW_TASKS_REBOUND"].includes(e.kind),
        )
        .flatMap((e) =>
          (e.body.bindings ?? []).map((b: TaskBinding) => b.taskId),
        ),
    );
    const settledAnywhere = new Set(
      allEvents.flatMap((e) =>
        e.kind === "WORKFLOW_REPLY"
          ? [e.body.reply.questionId]
          : e.kind === "WORKFLOW_QUESTION_DEFERRED"
            ? [e.body.deferral.questionId]
            : [],
      ),
    );
    const shared = allEvents
      .filter(
        (e) =>
          e.kind === "WORKFLOW_QUESTION" &&
          !ids.has(e.body.requestId) &&
          String(e.body.question.key).startsWith(PRE_DESIGN_QUESTION_PREFIX) &&
          questionScope(e.body.question).taskIds.some((id) => tasks.has(id)) &&
          !settledAnywhere.has(e.body.question.id),
      )
      .map((e) => ({
        ...(e.body.question as Question),
        requestId: e.body.requestId as string,
      }));
    return [...own, ...shared];
  }
  /**
   * Whether a task an owed question holds was revised since its screening:
   * the question's own affected specifications against the tasks' current
   * ones (review round 9). A task that cannot be read counts as revised.
   */
  private affectedRevised(
    screening: { questions: Array<{ key: string; affected?: Record<string, string> }> },
    key: string,
  ): boolean {
    const owed = screening.questions.find((x) => x.key === key);
    return Object.entries(owed?.affected ?? {}).some(([id, spec]) => {
      try {
        return specDigest(this.controller.task(id)) !== spec;
      } catch {
        return true;
      }
    });
  }
  /**
   * A request of the project that recorded a screening: the owed questions
   * of a screening are recorded there when the project now advancing does
   * not hold every task they cover (review round 8).
   */
  private projectRequest(projectId: string | null): string | undefined {
    if (!projectId) return undefined;
    if (projectId.startsWith("request:"))
      return projectId.slice("request:".length);
    const key = projectId.slice("project:".length);
    return this.events()
      .filter((e) => e.kind === "WORKFLOW_SUBMITTED")
      .map((e) => e.body.request as RequestRecord)
      .find((r) => r.context.projectKey === key)?.id;
  }
  /**
   * Astra's questions from its checkpoint, each once, with its declared
   * scope: a checkpoint replayed through another of the project's requests
   * records nothing again (its keys are the project's), and a question equal
   * to one already open anywhere in the project, or earlier in the same
   * checkpoint, is not asked twice.
   */
  /**
   * Under the adaptive workflow with a GUIDED preference, a hold only the
   * owner can resolve becomes one owner question scoped to its task
   * (contract section 9). The controller writes the question, so no model
   * contributes to it; it is asked once per task, specification and hold.
   * The answer records the owner's word: no routing change is inferred from
   * it, and the hold clears only when the chosen action is taken.
   */
  private askAdaptiveRouting(requestId: string, taskId: string, error: unknown) {
    const c = this.controller;
    if (!c.adaptive()) return;
    const message = String(error);
    const code = Object.keys(ADAPTIVE_ROUTING_QUESTIONS).find((h) => message.includes(h));
    if (!code || c.adaptivePreferenceMode(taskId) !== "GUIDED") return;
    // A pinned route can also be unavailable for a pause, which clears by
    // itself, or a route change; only lapsed evidence is the owner's call.
    if (code === "ADAPTIVE_PINNED_ROUTE_UNAVAILABLE" && !/no longer has qualifying/.test(message)) return;
    const t = c.task(taskId);
    const key = "adaptive-routing:" + digest({ taskId, specDigest: specDigest(t), holdCode: code });
    // Checked and asked in one write transaction, so two controllers
    // advancing different requests ask it once (E5 review V3).
    c.db.transaction(() => {
      if (this.events().some((e) => e.kind === "WORKFLOW_QUESTION" && e.body.question.key === key)) return;
      this.askScoped(
        requestId,
        {
          key,
          // The contract keeps the hold and specification in the text; the
          // owner's rules for questions say what they are (E5 review V9).
          text:
            ADAPTIVE_ROUTING_QUESTIONS[code]!(taskId) +
            "\nFor the records only, so you don't need them to answer: the controller's name for this hold is " +
            code +
            ", and the version of the task it applies to is " +
            specDigest(t).slice(0, 12) +
            ".",
          kind: "OWNER_DECISION",
          audience: "OWNER",
          taskIds: [taskId],
        },
        { reserved: true },
      );
    });
  }
  private recordAstraQuestions(
    requestId: string,
    checkpoint: { runId: string; plan: Record<string, any> } | undefined,
  ) {
    const asked = checkpoint
      ? planQuestions(checkpoint.plan)
      : { owner: [], operator: [] };
    this.controller.db.transaction(() => {
      const recorded: Array<Record<string, any>> = [
        ...this.controller.projectContextFor(requestId).snapshot.questions,
      ];
      for (const [audience, list, prefix] of [
        ["OWNER", asked.owner, "overseer-question:"],
        ["OPERATOR", asked.operator, "overseer-operator-question:"],
      ] as const)
        for (const [index, q] of list.entries()) {
          const key = prefix + checkpoint!.runId + ":" + index;
          if (recorded.some((o) => o.key === key)) continue;
          // The same question still open is not asked again, so asking
          // changes nothing that would loop.
          // A coordination-only checkpoint's questions never reach a run
          // (issue #12, contract 8.4): the owner is told so when asked.
          const hidden =
            this.controller.checkpointPinOfRun(checkpoint!.runId)?.mode ===
            "COORDINATION_ONLY";
          const text =
            q.question +
            (hidden
              ? "\n\nWorkers will not see this question or your answer. If your answer should change the work, record it as a decision or a revision of the task."
              : "");
          const wanted = {
            audience,
            text: redact(text),
            taskIds: q.projectWide ? [] : q.taskIds,
            projectWide: q.projectWide || !q.taskIds.length,
          };
          if (
            recorded.some(
              (o) =>
                !(o.answers ?? []).length && !o.deferred &&
                sameQuestion(o, wanted),
            )
          )
            continue;
          const question = this.askScoped(
            requestId,
            {
              key,
              text,
              kind: audience === "OWNER" ? "OWNER_DECISION" : "INFORMATION",
              audience,
              ...(q.taskIds.length && !q.projectWide
                ? { taskIds: q.taskIds }
                : { projectWide: true }),
            },
            { reserved: true, askedBy: checkpoint!.runId },
          );
          recorded.push({ ...question, answers: [] });
        }
      // The owner questions screenings derive (proposal #17): each
      // OWNER_REQUIRED candidate of a task's latest screening whose
      // question is not recorded yet, by its stable key, so a choice
      // screened again (another checkpoint, another request) asks nothing
      // twice. The checkpoint and its questions are recorded in one
      // transaction (oversee); should a record still be found with its
      // questions unrecorded, they are recorded here before anything else
      // is decided, stale screening or not, each unless a task it holds was
      // revised (then it cannot bind that task, and a new screening asks
      // anew): a choice the owner was found to have is never dropped by a
      // later screening (review round 3). Whether a task was revised is
      // checked for each question, against the specifications it was
      // screened on: another question's revised task does not stop it
      // (review round 9). The text is the controller's, from the
      // candidate: recommendation first, 2 to 4 answers, scope.
      const context = this.controller.projectContextFor(requestId);
      const members = new Set(context.snapshot.tasks.map((e) => e.task.id));
      for (const state of context.preDesign ?? [])
        for (const q of state.questions) {
          if (
            q.status !== "NOT_RECORDED" ||
            !state.latest ||
            this.affectedRevised(state.latest, q.key)
          )
            continue;
          const candidate = state.latest.candidates.find(
            (c) => c.key === q.candidateKey,
          );
          const askedBy = state.latest.checkpointRunId ?? checkpoint?.runId;
          // Recorded here when this project holds every task the question
          // covers; otherwise in the project that recorded the screening,
          // which holds them all (its candidates were checked against it),
          // and shared from there: its identity is never narrowed to this
          // project's tasks (review round 8).
          const target = q.taskIds.every((id) => members.has(id))
            ? requestId
            : this.projectRequest(state.latest.projectId);
          if (!candidate || !askedBy || !target) continue;
          const affected = state.latest.questions.find(
            (x) => x.key === q.key,
          )?.affected;
          this.askScoped(
            target,
            {
              key: q.key,
              text: candidateQuestionText(state.taskId, candidate),
              kind: "OWNER_DECISION",
              audience: "OWNER",
              taskIds: q.taskIds,
            },
            {
              reserved: true,
              askedBy,
              ...(target !== requestId && affected ? { specs: affected } : {}),
            },
          );
        }
      // Questions owed by a screening of a task this project does not hold,
      // when they cover one of its tasks: found through those tasks and
      // recorded where all their tasks are, so an affected task here is
      // held by them too (review round 10).
      for (const { screening, question: q } of owedPreDesignQuestions(
        this.controller.db,
        members,
      )) {
        if (members.has(screening.taskId)) continue;
        const candidate = screening.candidates.find(
          (c) => c.key === q.candidateKey,
        );
        const target = q.taskIds.every((id) => members.has(id))
          ? requestId
          : this.projectRequest(screening.projectId);
        if (!candidate || !screening.checkpointRunId || !target) continue;
        this.askScoped(
          target,
          {
            key: q.key,
            text: candidateQuestionText(screening.taskId, candidate),
            kind: "OWNER_DECISION",
            audience: "OWNER",
            taskIds: q.taskIds,
          },
          {
            reserved: true,
            askedBy: screening.checkpointRunId,
            ...(target !== requestId && q.affected ? { specs: q.affected } : {}),
          },
        );
      }
    });
  }

  reply(requestId: string, value: z.input<typeof ReplyInputSchema>) {
    const actor = this.controller.localActor(),
      input = ReplyInputSchema.parse(value);
    this.assertHost(requestId);
    this.controller.warmLineage();
    return this.controller.db.transaction(() => {
      this.record(requestId);
      const events = this.events(requestId);
      const question = events.find(
        (e) =>
          e.kind === "WORKFLOW_QUESTION" &&
          e.body.question.id === input.questionId,
      );
      if (!question) throw new Error("QUESTION_NOT_IN_REQUEST");
      const inputDigest = digest(input);
      const existing = events.find(
        (e) =>
          e.kind === "WORKFLOW_REPLY" &&
          e.body.reply.replyKey === input.replyKey,
      );
      if (existing) {
        if (existing.body.reply.inputDigest !== inputDigest)
          throw new Error("REPLY_KEY_REPLAY_MISMATCH");
        return this.inspect(requestId);
      }
      const asked = question.body.question as Question;
      if (
        events.some(
          (e) =>
            e.kind === "WORKFLOW_QUESTION_DEFERRED" &&
            e.body.deferral.questionId === asked.id,
        )
      )
        throw new Error("QUESTION_DEFERRED_CANNOT_BE_ANSWERED");
      const originalSpecs = {
        ...(asked.taskId && asked.specDigest
          ? { [asked.taskId]: asked.specDigest }
          : {}),
        ...(asked.specDigests ?? {}),
      };
      const mismatched = Object.entries(originalSpecs).filter(
        ([taskId, spec]) => spec !== specDigest(this.controller.task(taskId)),
      );
      if (mismatched.length && !input.historicalOnly)
        throw new Error("QUESTION_TASK_SPEC_CHANGED");
      if (input.historicalOnly && !mismatched.length)
        throw new Error("HISTORICAL_ANSWER_REQUIRES_CHANGED_SPEC");
      // The operator answers only factual questions about the orchestrator,
      // from its records; an owner question needs the owner . An answer never carries authority either way.
      const audience = questionScope(asked).audience;
      const answeredAs = input.answeredAs ?? audience;
      if (audience === "OWNER" && answeredAs === "OPERATOR")
        throw new Error("OPERATOR_CANNOT_ANSWER_OWNER_QUESTION");
      // A historical answer names who gives it: the owner for an owner
      // question; for an operator question (Astra's or a worker's, as in the
      // task revision) the operator, citing evidence as always, or the owner.
      if (input.historicalOnly && !input.answeredAs)
        throw new Error("HISTORICAL_ANSWER_REQUIRES_EXPLICIT_" + audience);
      if (answeredAs === "OPERATOR" && !input.evidence?.length)
        throw new Error("OPERATOR_ANSWER_REQUIRES_EVIDENCE");
      const reply: Reply = {
        ...input,
        text: redact(input.text),
        sourceRef: redact(input.sourceRef),
        answeredAs,
        // Only the revised tasks: for a covered task whose specification
        // is unchanged, the answer is an ordinary answer (review M2).
        ...(input.historicalOnly
          ? {
              historicalOnly: true as const,
              historicalForSpec: Object.fromEntries(mismatched),
            }
          : {}),
        ...(input.evidence
          ? { evidence: input.evidence.map((e) => redact(e)) }
          : {}),
        inputDigest,
        actor: actor.id,
        createdAt: new Date().toISOString(),
        grantsAuthority: false,
      };
      this.append(requestId, "WORKFLOW_REPLY", { reply });
      return this.inspect(requestId);
    });
  }

  /**
   * The owner can explicitly defer a *task-scoped informational* question
   * that is not needed for the current revision. Decision, scope, access,
   * worker, proposal and Astra questions cannot be deferred here. Original
   * text and decision remain in the append-only journal and project context.
   * This grants no authority and does not rebind the task.
   */
  deferQuestion(
    requestId: string,
    value: z.input<typeof DeferQuestionInputSchema>,
  ) {
    const actor = this.controller.localActor(),
      input = DeferQuestionInputSchema.parse(value);
    this.assertHost(requestId);
    this.controller.warmLineage();
    return this.controller.db.transaction(() => {
      this.record(requestId);
      const events = this.events(requestId);
      const found = events.find(
        (e) =>
          e.kind === "WORKFLOW_QUESTION" &&
          e.body.question.id === input.questionId,
      );
      if (!found) throw new Error("QUESTION_NOT_IN_REQUEST");
      const q = found.body.question as Question;
      if (q.text !== redact(input.questionText))
        throw new Error("QUESTION_TEXT_CHANGED_OR_MISMATCHED");
      const scope = questionScope(q);
      if (
        q.kind !== "INFORMATION" ||
        scope.audience !== "OWNER" ||
        scope.projectWide ||
        !scope.taskIds.length ||
        RESERVED_QUESTION_KEYS.some((prefix) => q.key.startsWith(prefix))
      )
        throw new Error("QUESTION_DEFERRAL_NOT_OPTIONAL_INFORMATION");
      const inputDigest = digest(input);
      const already = events.find(
        (e) =>
          e.kind === "WORKFLOW_QUESTION_DEFERRED" &&
          e.body.deferral.questionId === q.id,
      );
      if (already) {
        if (already.body.deferral.inputDigest !== inputDigest)
          throw new Error("QUESTION_ALREADY_DEFERRED");
        return this.inspect(requestId);
      }
      if (
        events.some(
          (e) =>
            e.kind === "WORKFLOW_REPLY" &&
            e.body.reply.questionId === q.id,
        )
      )
        throw new Error("QUESTION_ALREADY_ANSWERED");
      const deferral: QuestionDeferral = {
        questionId: q.id,
        questionText: redact(input.questionText),
        ownerInstruction: redact(input.ownerInstruction),
        reason: redact(input.reason),
        sourceRef: redact(input.sourceRef),
        inputDigest,
        actor: actor.id,
        createdAt: new Date().toISOString(),
        grantsAuthority: false,
      };
      this.append(requestId, "WORKFLOW_QUESTION_DEFERRED", { deferral });
      return this.inspect(requestId);
    });
  }

  list() {
    return this.events()
      .filter((e) => e.kind === "WORKFLOW_SUBMITTED")
      .reverse()
      .map((e) => this.inspect(e.body.request.id));
  }

  inspect(requestId: string) {
    const request = this.record(requestId),
      events = this.events(requestId);
    const own = new Set(
      events
        .filter((e) => e.kind === "WORKFLOW_QUESTION")
        .map((e) => e.body.question.id as string),
    );
    const elsewhere = this.projectOpenQuestions(requestId).filter(
      (q) => !own.has(q.id),
    );
    // A view is synchronous and read-only, including when an owner command
    // returns it after a write. Its callers mutate only after this scope ends.
    return this.controller.withLineageRead(() =>
      this.inspectInScope(requestId, request, events, elsewhere),
    );
  }
  private inspectInScope(
    requestId: string,
    request: RequestRecord,
    events: WorkflowEvent[],
    elsewhere: Array<Question & { requestId: string }>,
  ) {
    // Every bound task and the final summary use the same project reading.
    // Retain a failure too so each projection reports the same current error.
    let projectRead:
      | { context: ReturnType<Controller["projectContextFor"]> }
      | { error: unknown }
      | undefined;
    const inspectionProject = () => {
      if (!projectRead) {
        try {
          projectRead = { context: this.controller.projectContextFor(requestId) };
        } catch (error) {
          projectRead = { error };
        }
      }
      if ("error" in projectRead) throw projectRead.error;
      return projectRead.context;
    };
    // Drive writes whose outcome is unknown, and filings that stopped while
    // holding their claims: they hold their files until reconciled (S4).
    const uncertain = this.controller.unresolvedClaims().filter((h) => {
      if (h.kind === "INTENT")
        return (
          h.state === "UNCERTAIN" ||
          (h.holderKind === "run"
            ? this.controller.inspect(h.taskId).attempts.find((a: any) => a.id === h.holderId)?.state !== "STARTED"
            : false)
        );
      return "leaseExpired" in h;
    });
    const tasks = this.bindings(requestId).map((bound) => {
      const inspected = this.controller.inspect(bound.taskId);
      const holds = [...inspected.blockers];
      for (const h of uncertain)
        if (h.taskId === bound.taskId)
          holds.push(
            h.kind === "INTENT"
              ? "DRIVE_WRITE_UNCERTAIN:" + h.id
              : "FILING_CLAIMS_UNCERTAIN:" + h.holderId,
          );
      // An open question another of the project's requests recorded on this
      // task holds it here too; it is answered in that request.
      for (const q of elsewhere)
        if (covers(q, bound.taskId))
          holds.push("PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST:" + q.id);
      if (bound.specDigest !== inspected.specDigest)
        holds.unshift("REQUEST_TASK_SPEC_CHANGED");
      if (!inspected.task.simulation && !this.liveFor(inspected.task))
        holds.push("LIVE_EXECUTION_HELD_NO_ISOLATED_RUNNER");
      holds.push(...this.workerQuestionHolds(requestId, bound.taskId));
      // Pre-design discovery (proposal #17): the hold on a fresh worker run.
      const screening = this.controller.screeningHold(bound.taskId);
      if (screening) holds.push(screening);
      const budget = this.controller.budgetHold(bound.taskId);
      if (budget) holds.push(budget);
      const unresolved = inspected.attempts.filter((a) =>
        ["RESERVED", "STARTED", "UNKNOWN"].includes(a.state),
      );
      const steps = events
        .filter(
          (e) =>
            e.kind === "WORKFLOW_STEP" && e.body.step.taskId === bound.taskId,
        )
        .map((e) => e.body.step as Step);
      const round = inspected.proposalRound as ProposalRound | null;
      holds.push(...this.proposalHolds(requestId, round, steps));
      const lastWorker = inspected.attempts
        .filter((a) => a.role === "worker")
        .at(-1);
      const refused =
        lastWorker?.state === "NOT_STARTED"
          ? steps.find(
              (s) =>
                s.stage === "WORKER_NOT_LAUNCHED" &&
                s.condition === lastWorker.id,
            )
          : undefined;
      if (refused) holds.push("WORKER_NOT_LAUNCHED:" + refused.detail);
      // A step the provider's limit cut off as often as allowed waits for the
      // owner's retry-extend (S3).
      const retry = this.controller.retryHold(bound.taskId);
      if (retry) holds.push(retry);
      // The provider the task's next run would use is paused for its usage
      // limit (S3). A provider being rechecked is not a hold: one run may
      // test it.
      const next = inspected.routing as { ok?: boolean; provider?: string };
      if (next?.ok && next.provider) {
        const pause = this.controller.providerPause(
          next.provider as "codex" | "claude" | "mock",
        );
        if (pause.state === "PAUSED" || pause.state === "HELD")
          holds.push(
            `PROVIDER_PAUSED:${pause.provider}:` +
              (pause.state === "HELD" ? "held" : "until=" + pause.until),
          );
      }
      const interrupted = inspected.attempts
        .filter((a) => a.interruption !== undefined)
        .at(-1);
      // A real task held for want of a difficulty assessment says so: once an
      // advance has stopped on it, or when no assessor may still run. Before
      // that, the next advance runs the assessor; an untried assessment is
      // more to advance, not a hold.
      const assessmentHold =
        inspected.task.simulation ||
        (inspected.assessmentPending &&
          !steps.some(
            (s) =>
              s.stage === "ASSESSMENT_REQUIRED" &&
              s.outcome === "HELD" &&
              s.condition === inspected.specDigest,
          ))
          ? undefined
          : (inspected.assessmentHold ?? undefined);
      if (assessmentHold) holds.push(assessmentHold);
      const difficulty = inspected.task.simulation
        ? undefined
        : this.difficultyStatus(bound.taskId, steps, assessmentHold);
      if (inspected.task.status === "WAITING_REVIEW") {
        const latest = new Map<string, Step>();
        steps.forEach((step) => latest.set(step.stage, step));
        for (const stage of [
          "VERIFY",
          "RECORD_REVIEW",
          "AUDIT",
          "REQUIRED_TEST",
          "REVIEW_EXECUTION",
        ])
          if (latest.get(stage)?.outcome === "HELD")
            holds.push(
              "WORKFLOW_" + stage + "_HELD:" + latest.get(stage)!.detail,
            );
        // A check run that could not complete holds only the work it was run on.
        const checks = latest.get("CHECKS");
        if (
          checks?.outcome === "HELD" &&
          checks.condition ===
            inspected.attempts
              .filter((a) => a.role === "worker" && a.state === "SUCCEEDED")
              .at(-1)?.id
        )
          holds.push("WORKFLOW_CHECKS_HELD:" + checks.detail);
        const audits = new Map<string, any>();
        inspected.audits.forEach((audit) => audits.set(audit.kind, audit));
        for (const audit of audits.values())
          if (audit.result !== "PASS")
            holds.push("AUDIT_NOT_PASS:" + audit.kind);
      }
      if (this.controller.projectGoverned()) {
        try {
          const context = inspectionProject();
          const last = steps
            .filter(
              (s) =>
                s.stage === "PROJECT_OVERSIGHT" &&
                s.condition === context.snapshot.inputDigest,
            )
            .at(-1);
          if (last?.outcome === "HELD" && !oversightCurrent(context))
            holds.push("PROJECT_OVERSIGHT_HELD:" + last.detail);
        } catch (error) {
          holds.push(String(error));
        }
      }
      // A timed pause is projected only when the same planner, with pauses
      // alone removed, can admit a qualified independent next pair. This
      // includes tasks before their first pin without hiding permanent holds.
      const adaptiveNext = this.controller.adaptive() ? this.controller.adaptiveNextStep(bound.taskId) : undefined;
      if (
        inspected.routing &&
        !inspected.routing.ok &&
        (!adaptiveNext || adaptiveNext.selection) &&
        !["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(inspected.task.status)
      ) {
        const pauses = this.controller.adaptivePauseProviders(bound.taskId);
        for (const reason of inspected.routing.reasons)
          if (/^ADAPTIVE_[A-Z_]+:/.test(reason)) {
            holds.push(...(pauses.length ? pauses.map((provider) => "PROVIDER_PAUSED:" + provider)
              : [reason.slice(0, reason.indexOf(":"))]));
          }
      }
      // A failed review, or failed checks, that the next worker run fixes in place.
      const rework:
        | {
            reviewId?: string;
            reviewRunId?: string;
            checksId?: string;
            verdict: string;
            mustFix: string[];
          }
        | undefined = inspected.rework
        ? {
            reviewId: inspected.rework.reviewId,
            reviewRunId: inspected.rework.reviewRunId,
            verdict: inspected.rework.verdict,
            mustFix: inspected.rework.mustFix,
          }
        : inspected.checkRework
          ? {
              checksId: inspected.checkRework.checksId,
              verdict: "CHECKS_FAILED",
              mustFix: inspected.checkRework.problems.slice(0, 30),
            }
          : undefined;
      return {
        taskId: bound.taskId,
        boundSpecDigest: bound.specDigest,
        currentSpecDigest: inspected.specDigest,
        status: inspected.task.status,
        simulation: inspected.task.simulation,
        acceptanceCurrent: inspected.acceptanceCurrent,
        holds: [...new Set(holds)],
        // What each hold means and what clears it (a command shown here
        // grants nothing: it needs the evidence or authority named).
        holdsExplained: [...new Set(holds)].map((h) => explainHold(h)),
        routing: inspected.routing,
        ...(inspected.task.advice
          ? { advice: this.adviceStatus(bound.taskId, steps) }
          : {}),
        ...(difficulty ? { difficulty } : {}),
        ...(round ? { proposals: proposalSummary(round) } : {}),
        ...(rework ? { rework } : {}),
        // The latest run a provider limit or a busy database cut off: not
        // failed work.
        ...(interrupted
          ? {
              interrupted: {
                runId: interrupted.id,
                role: interrupted.role,
                state: interrupted.state,
                cause: interrupted.interruption.cause,
                ...(interrupted.interruption.cause === "PROVIDER_LIMIT"
                  ? {
                      kind: interrupted.interruption.kind,
                      provider: interrupted.interruption.provider,
                    }
                  : { reason: interrupted.interruption.reason }),
                resumable: interrupted.interruption.snapshot?.resumable ?? false,
              },
            }
          : {}),
        unresolvedRuns: unresolved.map((a) => ({
          runId: a.id,
          state: a.state,
        })),
        steps,
      };
    });
    const replies = events
      .filter((e) => e.kind === "WORKFLOW_REPLY")
      .map((e) => e.body.reply as Reply);
    const deferred = new Map<string, QuestionDeferral>(
      events
        .filter((e) => e.kind === "WORKFLOW_QUESTION_DEFERRED")
        .map((e) => {
          const d = e.body.deferral as QuestionDeferral;
          return [d.questionId, d];
        }),
    );
    const questions = events
      .filter((e) => e.kind === "WORKFLOW_QUESTION")
      .map((e) => {
        const question = e.body.question as Question;
        const answers = replies.filter((r) => r.questionId === question.id);
        const deferral = deferred.get(question.id);
        return {
          ...question,
          // Whom it is for and whom it holds, legacy records included.
          ...questionScope(question),
          status: answers.length
            ? ("ANSWERED" as const)
            : deferral
              ? ("DEFERRED" as const)
              : ("OPEN" as const),
          replies: answers,
          ...(deferral ? { deferred: deferral } : {}),
        };
      });
    // Open questions another of the project's requests recorded on this
    // request's tasks: they are answered there.
    const elsewhereHere = elsewhere.filter((q) =>
      tasks.some((t) => covers(q, t.taskId)),
    );
    let status: string;
    if (!tasks.length) status = "NEEDS_SCOPING";
    else if (tasks.some((t) => t.boundSpecDigest !== t.currentSpecDigest))
      status = "HELD_SPEC_CHANGED";
    // A project-wide question stops the request; questions on some tasks
    // stop it only when every task still open waits on one of them. The
    // questions are this request's and those another of the project's
    // requests recorded on its tasks, which hold them here too.
    else if (
      [...questions.filter((q) => q.status === "OPEN"), ...elsewhereHere].some(
        (q) =>
          questionScope(q).projectWide ||
          tasks
            .filter(
              (t) =>
                !["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(
                  t.status,
                ),
            )
            .every(
              (t) =>
                questions.some(
                  (o) => o.status === "OPEN" && covers(o, t.taskId),
                ) || elsewhereHere.some((o) => covers(o, t.taskId)),
            ),
      )
    )
      status = "WAITING_INPUT";
    else if (
      tasks.some((t) => t.unresolvedRuns.some((r) => r.state === "UNKNOWN"))
    )
      status = "HELD_RECONCILIATION";
    else if (tasks.some((t) => t.unresolvedRuns.length))
      status = "RUNNING_OR_RECOVERY_REQUIRED";
    else if (tasks.every((t) => t.status === "ACCEPTED" && t.acceptanceCurrent))
      status = "ACCEPTED_BY_CONTROLLER";
    else if (
      tasks.every(
        (t) =>
          (t.status === "VERIFIED" &&
            !t.holds.some(
              (h) =>
                ![
                  "ATTEMPT_BUDGET_EXHAUSTED",
                  "EXECUTION_BUDGET_EXHAUSTED",
                  "ACTIVE_OR_UNKNOWN_ATTEMPT",
                ].includes(h),
            )) ||
          (t.status === "ACCEPTED" && t.acceptanceCurrent),
      )
    )
      status = "VERIFIED_AWAITING_ACCEPTANCE";
    else if (
      tasks.some(
        (t) =>
          !t.holds.length &&
          ADVANCEABLE_ROUND_STAGES.includes(t.proposals?.stage ?? ""),
      )
    )
      status = "READY_FOR_PROPOSAL_ROUND";
    else if (
      tasks.some(
        (t) =>
          t.holds.length ||
          // A failed review with a rework pending is more to advance, not a hold.
          (t.status === "REMEDIATION_REQUIRED"
            ? !t.rework
            : ["CANCELLED", "SUPERSEDED", "ACCEPTED"].includes(t.status)),
      )
    )
      status = "HELD";
    else status = "READY_TO_ADVANCE";
    let oversight:
      | ReturnType<Orchestrator["project"]>
      | { error: string }
      | undefined;
    let summary: ReturnType<typeof projectSummary> | { error: string } | undefined;
    if (this.controller.projectGoverned()) {
      try {
        const context = inspectionProject();
        oversight = { ...context, current: oversightCurrent(context) };
        summary = projectSummary(
          oversight,
          requestId,
          this.controller.operationalState(
            oversight.snapshot.tasks.map((e) => e.task.id),
          ),
        );
      } catch (error) {
        oversight = { error: String(error) };
        summary = oversight;
      }
      if (
        ["VERIFIED_AWAITING_ACCEPTANCE", "ACCEPTED_BY_CONTROLLER"].includes(
          status,
        ) &&
        (!("current" in oversight) ||
          !oversight.current ||
          oversight.previous?.plan.outcome !== "COMPLETE")
      )
        status = "WAITING_PROJECT_OVERSIGHT";
    }
    // The owner's pause (S5): a run already going finishes; nothing new starts.
    const pause = this.requestPause(requestId);
    if (pause && tasks.length) status = "PAUSED";
    const nextSteps =
      status === "WAITING_PROJECT_OVERSIGHT"
        ? [
            "Advance again for Astra to check the current whole-project result. Technical sign-off does not grant owner acceptance or release.",
          ]
        : !tasks.length
          ? [
              "Inspect the supplied project context, prepare a bounded specification within the owner's request, register it through the controller, and attach its explicit ID. Ask only for genuinely missing scope or decisions.",
            ]
          : status === "VERIFIED_AWAITING_ACCEPTANCE"
            ? [
                "Synthetic work is verified. Final acceptance remains a separate exact-version controller action by an authorized actor; this request never accepts automatically.",
              ]
            : status === "WAITING_INPUT"
              ? [
                  "Resolve open scoped questions. Owner questions (audience OWNER): ask the owner each one in plain words with 2 to 4 answers, recommended first, and record the owner's reply. Operator questions (audience OPERATOR) are factual questions about the orchestrator's own state or records: answer them yourself from the controller's records with answeredAs OPERATOR and the evidence you relied on (run IDs, event numbers, file paths with hashes); never answer an owner question that way. Replies preserve context only; decisions and grants still require the existing controller records. When a worker asked and the answer changes the work, revise the task with the answer, record the grant for the revised task, then rebind it to this request (--rebind <taskId>) so the worker reruns; otherwise advance to review. The same goes for a proposal question: when the owner chooses the reviewer's change, revise the task to include it, record its grant and rebind; when the owner keeps the work, advance.",
                ]
              : status === "READY_FOR_PROPOSAL_ROUND"
                ? [
                    "A review made proposals. Advance again: the worker answers each proposal, the moderator sorts what is still open, and anything that needs the owner becomes a question. The reply is then reviewed.",
                  ]
                : status === "READY_TO_ADVANCE"
                  ? tasks.some((t) => t.rework)
                    ? [
                        ...(tasks.some(
                          (t) => t.rework && t.rework.verdict !== "CHECKS_FAILED",
                        )
                          ? [
                              "A review found changes that must be made. Advance again: the worker fixes them in place, with the review in hand, and a fresh review checks the result. After two failed reviews at one tier, the next run moves up a tier.",
                            ]
                          : []),
                        ...(tasks.some((t) => t.rework?.verdict === "CHECKS_FAILED")
                          ? [
                              "The controller's checks found problems before review. Advance again: the worker fixes them in place, the checks run again, and only then is the work reviewed.",
                            ]
                          : []),
                      ]
                    : [
                        ...(tasks.some((t) => !t.simulation)
                          ? [
                              `Advance the real tasks on the isolated live runner: orchestrate --request-id ${requestId} --advance --live --execute.`,
                            ]
                          : []),
                        ...(tasks.some((t) => t.simulation)
                          ? [
                              `Advance the synthetic tasks in mock mode: orchestrate --request-id ${requestId} --advance --mock --execute.`,
                            ]
                          : []),
                      ]
                  : [
                      "Inspect task holds and recorded steps; resolve the applicable source, evidence, authorization or reconciliation blocker. Never replay unknown work or silently rebind changed specifications; when a revision is intended, such as one that folds in the owner's answer, record its grant and rebind it explicitly with --rebind <taskId>. A reviewer report the controller threw out is retried once, and only when it was a clean pass; if review stays held on one, show the owner that report, and a fresh review then needs a revised task, its grant and a rebind so the worker reruns.",
                      ...(tasks.some((t) =>
                        t.holds.includes("EXECUTION_BUDGET_EXHAUSTED"),
                      )
                        ? [
                            "A task has used up its budget. Its finished work is kept and still counts; only new model runs wait. Ask the owner whether to raise the budget (budget-extend, which keeps the task's specification); then advance again and the task carries on from where it stopped.",
                          ]
                        : []),
                    ];
    if (elsewhereHere.length)
      nextSteps.push(
        "Some of this request's tasks wait on questions recorded in another request (see otherRequestQuestions): another request of the same project, or, for a pre-design owner choice, a request of another project that shares the task. Answer each in its own request with orchestrate --request-id <that request> --answer-file <JSON-file> --execute, then advance here.",
      );
    if (tasks.some((t) => t.holds.some((h) => h.startsWith("PRE_DESIGN_"))))
      nextSteps.push(
        "Pre-design decision discovery holds some tasks (holds starting PRE_DESIGN_, explained in holdsExplained): an owner choice is open (relay the question to the owner, recommendation first, and record the reply; an answer that changes the specification needs a revision, its grant and a rebind, after which Astra screens the task again), evidence is missing (answer the question that names it), or the screening is missing or stale (advance again for Astra to screen the task).",
      );
    if (
      status !== "WAITING_INPUT" &&
      questions.some((q) => q.status === "OPEN")
    )
      nextSteps.push(
        "Some tasks wait on open questions (see questions: each names its audience and the tasks it holds); the other tasks can advance meanwhile. Relay owner questions to the owner; answer operator questions from the controller's records with answeredAs OPERATOR and evidence.",
      );
    if (pause)
      nextSteps.unshift(
        `The owner paused this request (${pause.at}): "${pause.text.slice(0, 300)}". A run already going finishes and is recorded; nothing new starts. Resume only when the owner says so: orchestrate --request-id ${requestId} --resume --file <JSON-file> --execute with {"text","sourceRef"} (every other gate still applies).`,
      );
    for (const pause of this.controller.providerPauses())
      nextSteps.push(
        pause.state === "HELD"
          ? `${pause.provider} hit its usage limit ${pause.untimed} times without a reset time it could trust, so it is held: nothing new runs on it until the operator records that the limit is lifted (provider-pause --clear with the evidence) or asks for one test run (provider-pause --recheck). Work on the other provider continues.`
          : pause.state === "PAUSED"
            ? `${pause.provider} is paused for its ${pause.kind === "RATE_LIMIT" ? "rate" : "usage"} limit until ${pause.until}${pause.resetBasis && pause.resetBasis !== "NONE" ? " (its stated reset)" : " (no reset time given; then one test run)"}; work on it waits and work on the other provider continues. Nothing here is failed work.`
            : `${pause.provider}'s pause has run out: the next run on it tests it alone${"recheckHeldBy" in pause ? ` (now: ${pause.recheckHeldBy})` : ""}, and success clears the pause.`,
      );
    if (summary && "briefSize" in summary && summary.briefSize.nearLimit)
      nextSteps.push(
        `Astra's project view is nearly too large for one phase: even with settled and older detail left out it takes ${summary.briefSize.astraSmallestView} of the ${summary.briefSize.limit} characters a brief can hold. Once it no longer fits, runs stop before they start and nothing is spent. Tell the owner in plain words and suggest finishing this phase, then continuing the remaining work as a new request under a new project key.`,
      );
    return {
      request,
      status,
      tasks,
      questions,
      ...(pause ? { pause } : {}),
      ...(elsewhereHere.length
        ? {
            otherRequestQuestions: elsewhereHere.map((q) => ({
              id: q.id,
              requestId: q.requestId,
              ...questionScope(q),
              kind: q.kind,
              text: q.text.slice(0, 2_000),
            })),
          }
        : {}),
      nextSteps,
      // Providers paused for their usage or rate limit, and until when (S3).
      providerPauses: this.controller.providerPauses(),
      simulationOnly: !this.liveConfigured(),
      liveExecutionHeld: !this.liveConfigured(),
      finalAcceptanceAutomatic: false,
      ...(summary ? { project: summary } : {}),
      resume: `To continue this request in a new chat, say: /longform-orchestrator continue request ${requestId}${request.context.projectKey ? ` (project key ${request.context.projectKey})` : ""}. The controller keeps the request's whole state, so nothing else needs carrying over.`,
      authorityDisclosure:
        "Local process UID authenticates the operator process. Prompt, sourceRef, conversationRef and replies are caller-supplied context, never authenticated owner grants.",
    };
  }

  private assertBinding(requestId: string, taskId: string): Task {
    // A paused request starts nothing new; this runs inside every
    // reservation transaction, so it is atomic with admission (S5).
    if (this.requestPause(requestId)) throw new Error("REQUEST_PAUSED");
    // Preserve the project-host check formerly performed by inspect(), but
    // admission needs only this binding and its own request's open questions.
    // Other requests' question holds remain in the project/advance gates.
    this.projectOpenQuestions(requestId);
    const bound = this.bindings(requestId).find((t) => t.taskId === taskId);
    if (!bound) throw new Error("TASK_NOT_IN_REQUEST");
    const t = this.controller.task(taskId);
    if (bound.specDigest !== specDigest(t))
      throw new Error("REQUEST_TASK_SPEC_CHANGED");
    if (this.ownOpenQuestions(requestId).some((q) => covers(q, taskId)))
      throw new Error("REQUEST_HAS_OPEN_QUESTIONS");
    if (!t.simulation && !this.liveFor(t))
      throw new Error("LIVE_EXECUTION_HELD_NO_ISOLATED_RUNNER");
    return t;
  }
  private step(requestId: string, value: Step) {
    this.append(requestId, "WORKFLOW_STEP", { step: value });
  }
  private once(
    requestId: string,
    taskId: string,
    stage: string,
    condition: unknown,
    action: () => void,
  ) {
    const key = digest({ taskId, stage, condition });
    this.controller.warmLineage();
    return this.controller.db.transaction(() => {
      const previous = this.events(requestId).find(
        (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === key,
      );
      if (previous) return previous.body.step.outcome === "RECORDED";
      try {
        this.assertBinding(requestId, taskId);
        action();
        this.step(requestId, {
          taskId,
          key,
          stage,
          condition: digest(condition),
          outcome: "RECORDED",
          detail: "Controller action recorded; no acceptance conferred.",
        });
        return true;
      } catch (error) {
        this.step(requestId, {
          taskId,
          key,
          stage,
          condition: digest(condition),
          outcome: "HELD",
          detail: redact(String(error)),
        });
        return false;
      }
    });
  }
  /** Record a HELD step once per task, stage, specification and reason. */
  private heldOnce(
    requestId: string,
    taskId: string,
    stage: string,
    spec: string,
    reason: string,
  ) {
    const detail = redact(reason).slice(0, 2_000);
    const key = digest({ taskId, stage, spec, detail });
    this.controller.db.transaction(() => {
      if (
        this.events(requestId).some(
          (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === key,
        )
      )
        return;
      this.step(requestId, {
        taskId,
        key,
        stage,
        condition: spec,
        outcome: "HELD",
        detail,
      });
    });
  }

  /**
   * Each applicable role's complete brief for a task as it would be after
   * registering, revising or rebinding it in this request . See previewBatch.
   */
  previewBriefs(
    requestId: string,
    input: { candidate?: unknown; taskId?: string },
  ) {
    let batch: { register?: unknown[]; revise?: unknown[]; taskIds?: string[] };
    if (input.candidate !== undefined) {
      const id = (input.candidate as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new Error("PREVIEW_TASK_ID_REQUIRED");
      batch = this.controller.tasks().some((t) => t.id === id)
        ? { revise: [input.candidate] }
        : { register: [input.candidate] };
    } else if (input.taskId) batch = { taskIds: [input.taskId] };
    else throw new Error("PREVIEW_TASK_ID_REQUIRED");
    const [only] = this.previewBatch(requestId, batch);
    return only!;
  }
  /**
   * Each applicable role's complete brief for every task in a batch, as it
   * would be once the whole batch is registered, revised or rebound in this
   * request together, so tasks that depend on each other, or several revised
   * at once, are sized against the project the commands would leave. The
   * controller does the real registration, revision, attachment and binding,
   * with a stand-in grant for each task's own operations (so a Drive scope's
   * tooling is counted), in one scope that is always rolled back, nested
   * transactions included: nothing is recorded and no run is reserved.
   */
  previewBatch(
    requestId: string,
    batch: { register?: unknown[]; revise?: unknown[]; taskIds?: string[] },
  ) {
    this.assertHost(requestId);
    const c = this.controller,
      actor = c.localActor();
    c.warmLineage();
    return c.db.rollbackOnly(() => {
      const actions = new Map<
        string,
        "register" | "revise" | "rebind" | "current"
      >();
      const idOf = (candidate: unknown) => {
        const id = (candidate as { id?: unknown } | null)?.id;
        if (typeof id !== "string") throw new Error("PREVIEW_TASK_ID_REQUIRED");
        if (actions.has(id)) throw new Error("PREVIEW_DUPLICATE_TASK:" + id);
        return id;
      };
      for (const candidate of batch.revise ?? []) {
        const id = idOf(candidate);
        c.revise(id, candidate, actor);
        actions.set(id, "revise");
      }
      // Registered together, as the register command does, so a new task may
      // depend on another new one.
      if (batch.register?.length) {
        const ids = batch.register.map(idOf);
        c.importTasks(batch.register, actor);
        for (const id of ids) actions.set(id, "register");
      }
      for (const id of batch.taskIds ?? [])
        if (!actions.has(id)) actions.set(id, "current");
      if (!actions.size) throw new Error("PREVIEW_TASK_ID_REQUIRED");
      const bindings = this.bindings(requestId);
      const unbound = [...actions.keys()].filter(
        (id) => !bindings.some((b) => b.taskId === id),
      );
      const changed = [...actions.keys()].filter((id) =>
        bindings.some(
          (b) => b.taskId === id && b.specDigest !== specDigest(c.task(id)),
        ),
      );
      // attach takes at most 100 tasks a call; register takes up to 256.
      for (let i = 0; i < unbound.length; i += 100)
        this.attach(requestId, unbound.slice(i, i + 100));
      // An explicit rebind is previewed as the command runs it, refusals
      // included. A revision is previewed as it would be once rebound, and
      // what would stop that rebind today (an open question, a run not yet
      // settled) is reported beside the sizes, not instead of them.
      const rebindHolds = new Map<string, string>();
      const explicit = changed.filter((id) => actions.get(id) === "current");
      if (explicit.length) {
        this.rebind(requestId, explicit);
        for (const id of explicit) actions.set(id, "rebind");
      }
      const revised = changed.filter((id) => actions.get(id) !== "rebind");
      for (const id of revised) {
        try {
          this.rebindBindings(requestId, [id]);
        } catch (error) {
          rebindHolds.set(id, redact(String(error)).slice(0, 500));
        }
      }
      if (revised.length) {
        this.append(requestId, "WORKFLOW_TASKS_REBOUND", {
          bindings: revised.map((taskId) => ({
            taskId,
            specDigest: specDigest(c.task(taskId)),
            previousSpecDigest: bindings.find((b) => b.taskId === taskId)!
              .specDigest,
          })),
          actor: actor.id,
        });
        this.recordOwnerSources(requestId, revised);
      }
      for (const taskId of actions.keys()) {
        const t = c.task(taskId);
        c.grant(
          taskId,
          {
            id: "brief-preview-" + randomUUID(),
            operations: t.operations.filter(
              (op) =>
                ![
                  "SOURCE_LAW",
                  "COMMIT",
                  "PUSH",
                  "CREATE_PR",
                  "MERGE",
                  "HOSTED_DATABASE",
                  "PROVISION_CREDENTIAL",
                  "DEPLOY",
                  "COHORT_LAUNCH",
                ].includes(op),
            ),
            paths: [...t.writePaths],
            decisionText: "Brief preview only; rolled back, never recorded",
            sourceRef: "brief-preview",
          },
          actor,
        );
      }
      // All preview writes are complete. The remaining brief reads share
      // lineage work, and the scope ends before the transaction rolls back.
      return c.withLineageRead(() => [...actions].map(([taskId, action]) => ({
        action,
        recorded: false,
        ...(rebindHolds.has(taskId)
          ? { rebindHeld: rebindHolds.get(taskId)! }
          : {}),
        ...c.previewBriefs(requestId, taskId),
      })));
    });
  }

  /** Durable project state is rebuilt from current records, not a conversational summary. */
  project(requestId: string) {
    const context = this.controller.projectContextFor(requestId);
    return {
      ...context,
      current: oversightCurrent(context),
    };
  }
  private async oversee(
    requestId: string,
    taskId: string,
    live: boolean,
  ): Promise<boolean> {
    const c = this.controller;
    if (!c.projectGoverned()) return true;
    try {
      this.assertHost(requestId);
      let context = c.projectContextFor(requestId);
      // Questions a recorded checkpoint or screening still owes (an advance
      // that stopped between them) are recorded before anything else is
      // decided, so that no owner choice already found is lost to a later
      // screening (review round 3). A question that can no longer bind its
      // task (an affected task revised since) is skipped there, and a new
      // screening asks anew; any other failure holds the project here, so
      // a later screening cannot replace the choice (review round 4). This
      // runs before a project's first checkpoint too: a screening another
      // project recorded on one of its tasks can owe questions (review
      // round 7).
      if (context.previous || context.preDesign) {
        this.recordAstraQuestions(requestId, context.previous);
        context = c.projectContextFor(requestId);
      }
      // Under the adaptive workflow only a checkpoint made under a
      // checkpoint pin admits adaptive work (issue #12, contract 10.1).
      if (
        !oversightCurrent(context) ||
        (c.adaptive() && !c.adaptiveCheckpointInForce(context))
      ) {
        if (live) await this.ensureAttested(taskId, "overseer");
        // Runs on the same input: the project's, with the screening
        // currency of its opted-in tasks (project.ts).
        const input = oversightInputDigest(context);
        const prior = c.db
          .all<{ body: string }>(
            "SELECT body FROM attempts WHERE role='overseer' ORDER BY rowid",
          )
          .map((r) => JSON.parse(r.body))
          .filter(
            (a) =>
              a.projectContext?.snapshot.projectId ===
                context.snapshot.projectId &&
              oversightInputDigest(a.projectContext) === input,
          );
        if (
          prior.some((a) =>
            ["RESERVED", "STARTED", "UNKNOWN"].includes(a.state),
          )
        )
          throw new Error("PROJECT_OVERSIGHT_RUN_UNRESOLVED");
        const rejected = new Set(
          c.db
            .all<{
              body: string;
            }>("SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT_REJECTED'")
            .map((r) => JSON.parse(r.body).runId),
        );
        // A receipt whose checkpoint is already recorded is not recorded
        // again: a checkpoint can be stale with its inputs unchanged (an
        // assigned task's screening went stale), and then Astra runs anew.
        const recorded = new Set(
          c.db
            .all<{ body: string }>(
              "SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT'",
            )
            .map((r) => JSON.parse(r.body).runId),
        );
        const saved = prior
          .filter(
            (a) =>
              a.state === "SUCCEEDED" &&
              !rejected.has(a.id) &&
              !recorded.has(a.id),
          )
          .at(-1);
        let runId: string, output: string;
        if (saved) {
          // Recover the gap after receipt commit and before checkpoint commit.
          runId = saved.id;
          context = saved.projectContext;
          output = JSON.parse(
            c.db.get<{ body: string }>(
              "SELECT body FROM receipts WHERE attempt_id=?",
              runId,
            )!.body,
          ).output;
        } else {
          c.warmLineage();
          const attempt = c.db.transaction(() => {
            this.assertBinding(requestId, taskId);
            const a = c.reserve(
              taskId,
              {
                role: "overseer",
                projectRequestId: requestId,
                requestKey:
                  "oversight:" +
                  digest({
                    project: context.snapshot.projectId,
                    input,
                    attempt: prior.length,
                  }),
              },
              c.localActor(),
            );
            this.append(requestId, "WORKFLOW_RUN_LINKED", {
              taskId,
              role: "overseer",
              runId: a.id,
            });
            return a;
          });
          context = attempt.projectContext!;
          const receipt = await c.execute(
            attempt,
            live
              ? this.liveAdapter(attempt.provider)
              : new MockProvider({
                  output: canonical({
                    inputDigest: context.snapshot.inputDigest,
                    summary:
                      "SIMULATION: durable project checkpoint; no live oversight claimed.",
                    outcome: context.snapshot.tasks.every((t) =>
                      ["VERIFIED", "ACCEPTED"].includes(t.task.status),
                    )
                      ? "COMPLETE"
                      : "CONTINUE",
                    assignments: context.snapshot.tasks.map((t) => ({
                      taskId: t.task.id,
                      instruction:
                        c.checkpointPinOfRun(attempt.id)?.mode ===
                        "COORDINATION_ONLY"
                          ? COORDINATION_INSTRUCTION
                          : "Complete the authorized specification and preserve project constraints.",
                    })),
                    nextTaskIds: context.snapshot.tasks
                      .filter(
                        (t) =>
                          !["VERIFIED", "ACCEPTED"].includes(t.task.status),
                      )
                      .map((t) => t.task.id),
                    milestones: [],
                    technicalDecisions: [],
                    risks: [],
                    questionsForOwner: [],
                    questionsForOperator: [],
                  }),
                }),
            c.localActor(),
          );
          if (receipt.status !== "SUCCEEDED")
            throw new Error("PROJECT_OVERSIGHT_" + receipt.status);
          runId = attempt.id;
          output = receipt.output;
        }
        try {
          // The checkpoint, its screenings and the questions they raise
          // are one record: all committed, or none (review round 3).
          c.warmLineage();
          c.db.transaction(() => {
            const recorded = c.recordProjectCheckpoint(context, runId, output);
            this.recordAstraQuestions(requestId, recorded);
          });
        } catch (error) {
          c.db.event("PROJECT_CHECKPOINT_REJECTED", taskId, {
            runId,
            inputDigest: context.snapshot.inputDigest,
            reason: redact(String(error)).slice(0, 2000),
          });
          throw error;
        }
        this.step(requestId, {
          taskId,
          key: "oversight-success:" + runId,
          stage: "PROJECT_OVERSIGHT",
          condition: context.snapshot.inputDigest,
          runId,
          outcome: "RECORDED",
          detail: "Astra project checkpoint recorded.",
        });
      }
      const checkpoint = latestCheckpoint(c.db, context.snapshot.projectId)!;
      // A CONTINUE plan may ask about some tasks and assign others; an ASK
      // plan assigns nothing until Astra plans again with its questions in view.
      this.recordAstraQuestions(requestId, checkpoint);
      return !["ASK_OWNER", "ASK_OPERATOR"].includes(checkpoint.plan.outcome);
    } catch (error) {
      let condition = specDigest(c.task(taskId));
      try {
        condition = c.projectContextFor(requestId).snapshot.inputDigest;
      } catch {}
      this.heldOnce(
        requestId,
        taskId,
        "PROJECT_OVERSIGHT",
        condition,
        String(error),
      );
      return false;
    }
  }

  private async worker(requestId: string, taskId: string, live = false) {
    const c = this.controller,
      actor = c.localActor(),
      t = this.assertBinding(requestId, taskId);
    if (
      [
        "WAITING_REVIEW",
        "VERIFIED",
        "ACCEPTED",
        "CANCELLED",
        "SUPERSEDED",
      ].includes(t.status)
    )
      return;
    // A review's proposals are answered by the reply run (answerProposals), in
    // whichever request advances first; no ordinary rerun goes ahead of it.
    if (
      PROPOSAL_REPLY_PENDING_STAGES.includes(
        c.proposalRound(taskId)?.stage ?? "",
      )
    )
      return;
    // After a failed review the worker fixes its work in place, once per
    // failed review; otherwise one worker run per
    // request and specification.
    const rework = c.reworkPending(taskId);
    // Failed checks are fixed in place the same way.
    const checks = rework ? undefined : c.checkReworkPending(taskId);
    const baseKey =
      "workflow:" +
      digest({
        requestId,
        taskId,
        spec: specDigest(t),
        role: "worker",
        ...(rework ? { rework: rework.reviewRunId } : {}),
        ...(checks ? { checkRework: checks.checksId } : {}),
      });
    const earlier = c
      .inspect(taskId)
      .attempts.filter(
        (a) =>
          a.requestKey === baseKey ||
          a.requestKey?.startsWith(baseKey + ":retry:"),
      );
    // A reservation that definitely never started did nothing, so it may be
    // made again under a fresh key .
    // So may one the provider's limit cut off (S3); the controller bounds
    // those per step and still counts each toward the task's attempts.
    if (earlier.some((a) => a.state !== "NOT_STARTED" && !limitEnded(a)))
      return;
    const requestKey = earlier.length
      ? baseKey + ":retry:" + earlier.length
      : baseKey;
    if (!rework && !checks) {
      if (live) await this.assess(requestId, taskId);
      // With `assessmentRequired` in the routing policy, first work on a
      // specification waits for an assessment or the owner's word; the hold is shown and recorded once per reason.
      const hold = c.assessmentHold(taskId);
      if (hold) {
        this.heldOnce(
          requestId,
          taskId,
          "ASSESSMENT_REQUIRED",
          specDigest(t),
          hold,
        );
        return;
      }
      // Requested advice whose provider is paused for its usage limit is
      // waited for, not skipped .
      if (t.advice) {
        const waiting = await this.advise(requestId, taskId, live);
        if (waiting) {
          this.heldOnce(
            requestId,
            taskId,
            "ADVICE_WAITING_PROVIDER",
            specDigest(t),
            "ADVICE_WAITING_PROVIDER: " + waiting,
          );
          return;
        }
      }
    }
    if (!(await this.oversee(requestId, taskId, live))) return;
    if (live)
      await this.ensureAttested(
        taskId,
        "worker",
        rework || checks ? { provider: this.artifactProvider(taskId) } : {},
      );
    let attempt: ReturnType<Controller["reserve"]>;
    try {
      c.warmLineage();
      attempt = c.db.transaction(() => {
        // Bind the reservation to this request under the same SQLite write lock.
        // Another process may have revised the task after the planning read.
        this.assertBinding(requestId, taskId);
        const reserved = c.reserve(
          taskId,
          {
            requestKey,
            projectRequestId: requestId,
            ...(rework ? { rework: rework.reviewRunId } : {}),
            ...(checks ? { checkRework: checks.checksId } : {}),
          },
          actor,
        );
        this.append(requestId, "WORKFLOW_RUN_LINKED", {
          taskId,
          role: "worker",
          runId: reserved.id,
          ...(rework ? { rework: rework.reviewRunId } : {}),
          ...(checks ? { checkRework: checks.checksId } : {}),
        });
        return reserved;
      });
    } catch (error) {
      this.askAdaptiveRouting(requestId, taskId, error);
      this.once(
        requestId,
        taskId,
        "WORKER_RESERVATION",
        {
          spec: specDigest(t),
          reasons: c.reasons(taskId),
          route: c.route(taskId),
        },
        () => {
          throw error;
        },
      );
      return;
    }
    let receipt: ProviderReceipt | undefined;
    try {
      receipt = await c.execute(
        attempt,
        live
          ? this.liveAdapter(attempt.provider)
          : new MockProvider({
              delayMs: 15,
              output:
                "SIMULATION: request " +
                requestId +
                ", task " +
                taskId +
                "; bounded synthetic output only. No real model, implementation, tests, owner acceptance or external changes are claimed.",
            }),
        actor,
      );
    } catch (error) {
      this.step(requestId, {
        taskId,
        key: "execution-" + attempt.id,
        stage: "WORKER_EXECUTION",
        condition: attempt.id,
        runId: attempt.id,
        outcome: "HELD",
        detail: redact(String(error)),
      });
    }
    if (receipt?.status === "SUCCEEDED")
      this.recordWorkerQuestions(requestId, taskId, attempt.id, receipt.output);
    this.recordNotLaunched(requestId, taskId, attempt.id, receipt);
  }
  /**
   * A worker run refused before launch (a source pack that could not be
   * fetched, say): nothing ran and no attempt was used. The reason shows
   * until a worker run of the task launches; the next advance tries again.
   */
  private recordNotLaunched(
    requestId: string,
    taskId: string,
    runId: string,
    receipt: ProviderReceipt | undefined,
  ) {
    if (!receipt?.notLaunched) return;
    this.step(requestId, {
      taskId,
      key: "not-launched-" + runId,
      stage: "WORKER_NOT_LAUNCHED",
      condition: runId,
      runId,
      outcome: "HELD",
      detail: redact(receipt.output.trim().slice(0, 2_000)),
    });
  }

  /**
   * An unsure worker's questions become questions on its task, so review waits
   * for the answers: those for the owner as an owner question, factual ones for
   * the operator as an operator question.
   */
  private recordWorkerQuestions(
    requestId: string,
    taskId: string,
    runId: string,
    output: string,
  ) {
    const sections = [
      {
        key: "worker-question:" + runId,
        audience: "OWNER" as const,
        text: workerQuestions(output),
        lead: " left part of the work undone and asks:\n\n",
      },
      {
        key: "worker-operator-question:" + runId,
        audience: "OPERATOR" as const,
        text: workerOperatorQuestions(output),
        lead: " asks the operator, about the orchestrator's records:\n\n",
      },
    ];
    for (const section of sections) {
      if (!section.text) continue;
      try {
        // Check and record under one write lock, so two requests recovering the
        // same run can't both record its question.
        this.controller.db.transaction(() => {
          if (this.questionKeyRecorded(section.key)) return;
          this.askScoped(
            requestId,
            {
              key: section.key,
              text: "The worker on task " + taskId + section.lead + section.text,
              kind: section.audience === "OWNER" ? "OWNER_DECISION" : "INFORMATION",
              audience: section.audience,
              taskId,
            },
            { reserved: true },
          );
        });
      } catch (error) {
        this.step(requestId, {
          taskId,
          key: "worker-question-" + section.key,
          stage: "WORKER_QUESTION",
          condition: runId,
          runId,
          outcome: "HELD",
          detail: redact(String(error)),
        });
      }
    }
  }

  /** The question sections in the latest successful worker summary for the task's current spec. */
  private pendingWorkerQuestion(taskId: string) {
    const spec = specDigest(this.controller.task(taskId));
    const worker = this.controller
      .inspect(taskId)
      .attempts.filter(
        (a: { role: string; state: string; specDigest: string }) =>
          a.role === "worker" &&
          a.state === "SUCCEEDED" &&
          a.specDigest === spec,
      )
      .at(-1) as { id: string } | undefined;
    if (!worker) return undefined;
    const receipt = this.controller.db.get<{ body: string }>(
      "SELECT body FROM receipts WHERE attempt_id=?",
      worker.id,
    );
    const output = receipt ? String(JSON.parse(receipt.body).output ?? "") : "";
    const keys = [
      ...(workerQuestions(output) ? ["worker-question:" + worker.id] : []),
      ...(workerOperatorQuestions(output)
        ? ["worker-operator-question:" + worker.id]
        : []),
    ];
    return keys.length ? { runId: worker.id, output, keys } : undefined;
  }

  private questionKeyRecorded(key: string) {
    return this.events().some(
      (e) => e.kind === "WORKFLOW_QUESTION" && e.body.question.key === key,
    );
  }
  /**
   * A worker question is about the task, so it holds the task's review in every
   * request. This request's own open questions already show as WAITING_INPUT.
   */
  private workerQuestionHolds(requestId: string, taskId: string): string[] {
    const spec = specDigest(this.controller.task(taskId)),
      events = this.events(),
      answered = new Set(
        events
          .filter((e) => e.kind === "WORKFLOW_REPLY")
          .map((e) => e.body.reply.questionId),
      ),
      asked = events
        .filter(
          (e) =>
            e.kind === "WORKFLOW_QUESTION" &&
            e.body.question.taskId === taskId &&
            e.body.question.specDigest === spec &&
            (String(e.body.question.key).startsWith("worker-question:") ||
              String(e.body.question.key).startsWith(
                "worker-operator-question:",
              )),
        )
        .map((e) => ({
          requestId: e.body.requestId as string,
          question: e.body.question as Question,
        }));
    const holds: string[] = [];
    if (
      asked.some(
        (q) => q.requestId !== requestId && !answered.has(q.question.id),
      )
    )
      holds.push("WORKER_QUESTION_OPEN_IN_OTHER_REQUEST");
    const pending = this.pendingWorkerQuestion(taskId);
    if (
      pending &&
      pending.keys.some((key) => !asked.some((q) => q.question.key === key))
    )
      holds.push("WORKER_QUESTION_NOT_RECORDED");
    return holds;
  }

  /**
   * Ask the configured advisor once per specification before the worker runs.
   * Advice never gates work: when no advisor is usable, or the run fails, the
   * reason is recorded and the worker proceeds without it.
   */
  /**
   * Run the task's advisor once per specification. Returns why the worker
   * should wait for it (the advisor's provider is paused for its usage
   * limit), or undefined: advice obtained, or unobtainable for another
   * reason, in which case the worker proceeds without it, as before.
   */
  private async advise(
    requestId: string,
    taskId: string,
    live: boolean,
  ): Promise<string | undefined> {
    const c = this.controller,
      actor = c.localActor(),
      t = c.task(taskId),
      spec = specDigest(t);
    const attempts = c.inspect(taskId).attempts as Array<{
      role: string;
      state: string;
      specDigest: string;
      requestKey: string;
    }>;
    if (
      attempts.some(
        (a) =>
          a.specDigest === spec &&
          (a.role === "worker" ||
            (a.role === "advisor" &&
              a.state !== "NOT_STARTED" &&
              !limitEnded(a))),
      )
    )
      return undefined;
    // Recorded once per spec and reason; the stage is informational and never
    // becomes a task hold.
    const notObtained = (reason: string) => {
      const detail = redact(reason).slice(0, 2_000);
      const key = digest({
        taskId,
        stage: "ADVICE_NOT_OBTAINED",
        spec,
        detail,
      });
      c.db.transaction(() => {
        if (
          this.events(requestId).some(
            (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === key,
          )
        )
          return;
        this.step(requestId, {
          taskId,
          key,
          stage: "ADVICE_NOT_OBTAINED",
          condition: spec,
          outcome: "HELD",
          detail,
        });
      });
    };
    if (live) await this.ensureAttested(taskId, "advisor");
    const route = c.route(taskId, "advisor");
    if (!route.ok) {
      notObtained("ADVISOR_UNAVAILABLE:" + route.reasons.join("|"));
      return undefined;
    }
    const pause = c.providerPause(route.provider);
    if (pause.state === "PAUSED" || pause.state === "HELD")
      return `PROVIDER_PAUSED:${route.provider}:${pause.state === "HELD" ? "held" : "until=" + pause.until}`;
    // Keys stay unique across retries of runs that never started.
    const baseKey =
      "workflow:" + digest({ requestId, taskId, spec, role: "advisor" });
    const used = new Set(attempts.map((a) => a.requestKey));
    let retry = 0;
    while (used.has(baseKey + (retry ? ":retry:" + retry : ""))) retry++;
    const requestKey = baseKey + (retry ? ":retry:" + retry : "");
    let attempt: ReturnType<Controller["reserve"]>;
    try {
      c.warmLineage();
      attempt = c.db.transaction(() => {
        this.assertBinding(requestId, taskId);
        const reserved = c.reserve(
          taskId,
          { role: "advisor", requestKey },
          actor,
        );
        this.append(requestId, "WORKFLOW_RUN_LINKED", {
          taskId,
          role: "advisor",
          runId: reserved.id,
        });
        return reserved;
      });
    } catch (error) {
      const why = redact(String((error as Error)?.message ?? error));
      if (/^PROVIDER_(PAUSED|RECHECK_IN_PROGRESS|RETRIES_EXHAUSTED)/.test(why))
        return why;
      // A busy database passes: the worker waits for the advice, which the
      // next advance asks for again .
      if (databaseBusy(error)) return "ADVISOR_RESERVATION: " + why;
      notObtained("ADVISOR_RESERVATION:" + why);
      return undefined;
    }
    try {
      const receipt = await c.execute(
        attempt,
        live
          ? this.liveAdapter(attempt.provider)
          : new MockProvider({
              delayMs: 15,
              output:
                "SIMULATION: advisor for task " +
                taskId +
                "; synthetic output only, no advice is claimed.",
            }),
        actor,
      );
      const ended = (
        c.inspect(taskId).attempts as Array<{
          id: string;
          state: string;
          interruption?: { cause?: string };
        }>
      ).find((a) => a.id === attempt.id);
      if (ended && limitEnded(ended))
        // A busy database stopped the advice: the worker waits for it to be
        // asked again (the driver retries this condition), as for a limit.
        return limitInterrupted(ended)
          ? "ADVISOR_PROVIDER_LIMIT:" + attempt.provider
          : "ADVISOR_INTERRUPTED: database is locked";
      if (receipt.status !== "SUCCEEDED")
        notObtained("ADVISOR_RUN_" + receipt.status);
      else if (!c.advice(taskId).some((x) => x.advice))
        notObtained(
          "ADVICE_UNUSABLE: response did not match the advice schema",
        );
    } catch (error) {
      const why = redact(String((error as Error)?.message ?? error));
      if (/^PROVIDER_(PAUSED|RECHECK_IN_PROGRESS)/.test(why)) return why;
      notObtained("ADVISOR_EXECUTION:" + why);
    }
    return undefined;
  }

  /**
   * A model reads a real task before its first worker run and reports what it
   * touches and how demanding it is (the model
   * assesses, the engine decides). The routing rules apply on top of its
   * answer, which can only raise the tier. Each provider with an assessor
   * route is tried once per specification, in the policy's order; when every one has failed, the policy's
   * `assessmentRequired` decides whether the task waits for the owner (the
   * worker reports the hold) or proceeds on the stakes rules.
   */
  private async assess(requestId: string, taskId: string) {
    const c = this.controller,
      actor = c.localActor(),
      t = c.task(taskId),
      spec = specDigest(t);
    if (t.simulation) return;
    // Recorded once per spec and reason; informational in itself.
    const notObtained = (reason: string) =>
      this.heldOnce(requestId, taskId, "ASSESSMENT_NOT_OBTAINED", spec, reason);
    // A policy with no assessor route for the task runs without assessments;
    // that is a configuration, not a miss worth a step (a policy requiring
    // assessments names it in the hold).
    const providers = c.assessorProviders(taskId);
    // Providers whose assessor was refused before launch in this advance (a
    // pending credential recovery, say): not tried, so a later advance may ask
    // them again, but not asked again now.
    const refused: Array<"codex" | "claude" | "mock"> = [];
    for (let round = 0; round < providers.length; round++) {
      // Obtained, waived, work started, or every provider tried: nothing to do.
      if (!c.assessmentPending(taskId)) return;
      await this.ensureAttested(taskId, "assessor", {
        excludeProviders: refused,
      });
      // The first untried provider's route; a failure moves on to the next.
      const route = c.route(taskId, "assessor", { excludeProviders: refused });
      if (!route.ok) {
        // Only refused or tried providers left: their steps are recorded.
        if (route.reasons.every((r) => r.startsWith("ASSESSOR_ALREADY_RUN")))
          return;
        notObtained("ASSESSOR_UNAVAILABLE:" + route.reasons.join("|"));
        return;
      }
      const provider = route.provider;
      const attempts = c.inspect(taskId).attempts as Array<{
        requestKey: string;
      }>;
      const baseKey =
        "workflow:" +
        digest({ requestId, taskId, spec, role: "assessor", provider });
      const used = new Set(attempts.map((a) => a.requestKey));
      let retry = 0;
      while (used.has(baseKey + (retry ? ":retry:" + retry : ""))) retry++;
      const requestKey = baseKey + (retry ? ":retry:" + retry : "");
      let attempt: ReturnType<Controller["reserve"]>;
      try {
        c.warmLineage();
        attempt = c.db.transaction(() => {
          this.assertBinding(requestId, taskId);
          const reserved = c.reserve(
            taskId,
            {
              role: "assessor",
              requestKey,
              ...(refused.length ? { excludeProviders: [...refused] } : {}),
            },
            actor,
          );
          this.append(requestId, "WORKFLOW_RUN_LINKED", {
            taskId,
            role: "assessor",
            runId: reserved.id,
          });
          return reserved;
        });
      } catch (error) {
        notObtained(
          "ASSESSOR_RESERVATION[" + provider + "]:" + redact(String(error)),
        );
        // A provider paused for its usage limit (or being rechecked by
        // another run) is skipped for the rest of this advance, without
        // counting as tried, so another provider's assessor may run.
        if (
          /PROVIDER_(PAUSED|RECHECK_IN_PROGRESS|RETRIES_EXHAUSTED)/.test(
            String((error as Error)?.message ?? error),
          ) &&
          !refused.includes(provider)
        ) {
          refused.push(provider);
          continue;
        }
        return;
      }
      try {
        const receipt = await c.execute(
          attempt,
          this.liveAdapter(attempt.provider),
          actor,
        );
        const ended = (
          c.inspect(taskId).attempts as Array<{
          id: string;
          state: string;
          interruption?: { cause?: string };
        }>
        ).find((a) => a.id === attempt.id);
        // A provider limit or a busy database, like a refusal before
        // launch, assessed nothing: skip that provider for the rest of this
        // advance (S3).
        if (ended && limitEnded(ended)) {
          refused.push(attempt.provider);
          notObtained(
            (limitInterrupted(ended)
              ? "ASSESSOR_PROVIDER_LIMIT["
              : "ASSESSOR_INTERRUPTED_DATABASE_BUSY[") +
              attempt.provider +
              "]",
          );
          continue;
        }
        if (ended?.state === "NOT_STARTED") {
          // Refused before launch: nothing was assessed; try the next provider.
          refused.push(attempt.provider);
          notObtained(
            "ASSESSOR_NOT_LAUNCHED[" +
              attempt.provider +
              "]:" +
              redact(receipt.output).slice(0, 500),
          );
          continue;
        }
        if (receipt.status !== "SUCCEEDED")
          notObtained(
            "ASSESSOR_RUN_" + receipt.status + "[" + attempt.provider + "]",
          );
        else if (c.difficulty(taskId).some((x) => x.assessment)) return;
        else
          notObtained(
            "ASSESSMENT_UNUSABLE[" +
              attempt.provider +
              "]: response did not match the assessment schema",
          );
      } catch (error) {
        notObtained(
          "ASSESSOR_EXECUTION[" +
            attempt.provider +
            "]:" +
            redact(String(error)),
        );
      }
    }
  }
  /** What the difficulty assessment of the current spec found, or why there is none. */
  private difficultyStatus(taskId: string, steps: Step[], hold?: string) {
    const obtained = this.controller
      .difficulty(taskId)
      .find((x) => x.assessment);
    if (obtained) {
      const a = obtained.assessment!;
      return {
        status: "OBTAINED" as const,
        runId: obtained.runId,
        provider: obtained.provider,
        model: obtained.model,
        effort: obtained.effort,
        tierHint: a.tierHint,
        reason: a.reason,
        breaksIfWrong: a.breaksIfWrong,
        touches: a.touches,
      };
    }
    const spec = specDigest(this.controller.task(taskId));
    const misses = steps
      .filter(
        (step) =>
          step.stage === "ASSESSMENT_NOT_OBTAINED" && step.condition === spec,
      )
      .map((step) => step.detail);
    // Held until a model assesses the work or the owner decides; the owner's waiver shows as such.
    if (hold) return { status: "HELD" as const, reason: hold, misses };
    const waiver = this.controller.assessmentWaiver(taskId);
    if (waiver)
      return {
        status: "WAIVED" as const,
        reason: waiver.text,
        sourceRef: waiver.sourceRef,
        at: waiver.at,
        misses,
      };
    const missed = misses.at(-1);
    return missed !== undefined
      ? { status: "NOT_OBTAINED" as const, reason: missed }
      : undefined;
  }

  private async reviewAndVerify(
    requestId: string,
    taskId: string,
    live = false,
  ) {
    const c = this.controller,
      actor = c.localActor(),
      t = this.assertBinding(requestId, taskId);
    if (t.status !== "WAITING_REVIEW") return;
    if (this.workerQuestionHolds(requestId, taskId).length)
      throw new Error("WORKER_QUESTION_UNANSWERED:" + taskId);
    // A reply to proposals is reviewed once the moderator and the owner have
    // had their say: the owner's answers can change the work.
    const pending = c.proposalRound(taskId);
    if (pending?.reply?.state === "SUCCEEDED" && pending.stage !== "SETTLED")
      return;
    // A reservation that definitely never started did nothing.
    const worker = c
      .inspect(taskId)
      .attempts.filter(
        (a) => a.role === "worker" && a.state !== "NOT_STARTED" && !limitEnded(a),
      )
      .at(-1);
    if (!worker || worker.state !== "SUCCEEDED") return;
    // Only operator-configured immutable argv. No commands from model/prompt text.
    // A test runs once per sealed work. One the sandbox never started, one
    // that could not be run at all, and a failure whose receipt predates
    // launch records, is tried again on the next advance, so a repaired setup
    // clears the hold; earlier receipts stay (reviews K11, K17).
    for (const name of t.requiredTests) {
      const latest = c.db
        .all<{ body: string }>(
          "SELECT body FROM command_receipts WHERE task_id=?",
          taskId,
        )
        .map((r) => JSON.parse(r.body))
        .filter(
          (r) =>
            r.name === name &&
            r.workerAttemptId === worker.id &&
            r.attemptId === worker.id,
        )
        .at(-1);
      if (
        latest &&
        (latest.launched === true ||
          (latest.launched === undefined && latest.passed === true))
      )
        continue;
      const record = (key: string, step: Omit<Step, "key">) => {
        if (
          !this.events(requestId).some(
            (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === key,
          )
        )
          this.step(requestId, { ...step, key });
      };
      try {
        this.assertBinding(requestId, taskId);
        const result = await c.command(taskId, name, actor);
        record("command-" + digest({ worker: worker.id, name, receipt: result.id }), {
          taskId,
          stage: "REQUIRED_TEST",
          condition: worker.id,
          outcome: result.passed ? "RECORDED" : "HELD",
          detail:
            name +
            (result.launched === false
              ? ": the sandbox did not start the command; it is tried again on the next advance"
              : result.passed
                ? ": native command passed"
                : ": native command failed") +
            ". A controller receipt records actual execution.",
        });
      } catch (error) {
        record(
          "command-" + digest({ worker: worker.id, name, error: String(error) }),
          {
            taskId,
            stage: "REQUIRED_TEST",
            condition: worker.id,
            outcome: "HELD",
            detail: redact(name + ": " + String(error)),
          },
        );
      }
    }
    // The task's checks run on the work before any review. Work that fails one goes back to its worker to fix in
    // place; the review waits until every check passes.
    if ((t.checks || t.requiredTests.length) && !t.simulation) {
      const checksKey = "checks-" + worker.id;
      let record: ReturnType<Controller["recordChecks"]>;
      try {
        record = c.recordChecks(taskId, actor);
      } catch (error) {
        // Shown as a hold while this work is current; recorded once per error.
        const key = checksKey + ":error:" + digest(String(error));
        if (
          !this.events(requestId).some(
            (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === key,
          )
        )
          this.step(requestId, {
            taskId,
            key,
            stage: "CHECKS",
            condition: worker.id,
            outcome: "HELD",
            detail: redact(String(error)),
          });
        return;
      }
      // One step per record: the first's ID is checksKey.
      if (
        record &&
        !this.events(requestId).some(
          (e) => e.kind === "WORKFLOW_STEP" && e.body.step.key === record!.id,
        )
      )
        this.step(requestId, {
          taskId,
          key: record.id,
          stage: record.passed ? "CHECKS" : "CHECKS_FAILED",
          condition: worker.id,
          outcome: record.passed ? "RECORDED" : "HELD",
          detail: record.passed
            ? "all checks passed"
            : redact(
                "checks failed; the worker fixes them in place before review: " +
                  record.results
                    .flatMap((r) => r.problems.map((p) => r.kind + ": " + p))
                    .join("; ")
                    .slice(0, 2_000),
              ),
        });
      if (!record?.passed) return;
    }
    // Exact built-in fixture mapping only. Arbitrary criteria require explicit bindings.
    for (const criterion of t.acceptance) {
      if (
        criterion.id !== "receipt" ||
        criterion.evidenceKind !== "LOCAL" ||
        criterion.description !== "Controller verified synthetic output"
      )
        continue;
      this.once(
        requestId,
        taskId,
        "BIND_SYNTHETIC_RECEIPT",
        { worker: worker.id, criterion },
        () => {
          c.bindAcceptance(taskId, criterion.id, "output-" + worker.id, actor);
        },
      );
    }
    const evidenceIds = c.evidenceFor(taskId).map((e) => e.id);
    const baseKey =
      "workflow:" +
      digest({
        requestId,
        taskId,
        spec: specDigest(t),
        worker: worker.id,
        role: "reviewer",
      });
    // The controller allows one review per sealed artifact across all requests;
    // a run that ended without a review may be retried up to its cap.
    const artifact = c.artifactReviews(t),
      prior = artifact.reviewers;
    let reviewer: (typeof prior)[number] | undefined = prior.at(-1);
    if (reviewer && artifact.ended.has(reviewer.id)) reviewer = undefined;
    // Keys stay unique across every reservation ever made for this artifact,
    // including NOT_STARTED ones that no longer count toward the review cap.
    const usedKeys = new Set(
      c.db
        .all<{
          body: string;
        }>("SELECT body FROM attempts WHERE task_id=?", taskId)
        .map(
          (row) => (JSON.parse(row.body) as { requestKey?: string }).requestKey,
        ),
    );
    let retry = prior.length;
    while (usedKeys.has(baseKey + (retry ? ":retry:" + retry : ""))) retry++;
    const reviewKey = baseKey + (retry ? ":retry:" + retry : "");
    if (!reviewer) {
      if (live) await this.ensureAttested(taskId, "reviewer");
      try {
        c.warmLineage();
        reviewer = c.db.transaction(() => {
          this.assertBinding(requestId, taskId);
          const reserved = c.reserve(
            taskId,
            {
              role: "reviewer",
              projectRequestId: requestId,
              requestKey: reviewKey,
            },
            actor,
          );
          this.append(requestId, "WORKFLOW_RUN_LINKED", {
            taskId,
            role: "reviewer",
            runId: reserved.id,
          });
          return reserved;
        });
      } catch (error) {
        this.askAdaptiveRouting(requestId, taskId, error);
        this.once(
          requestId,
          taskId,
          "REVIEW_RESERVATION",
          {
            worker: worker.id,
            evidenceIds,
            route: c.route(taskId, "reviewer"),
          },
          () => {
            throw error;
          },
        );
        return;
      }
      const report: Review = {
        id: "workflow-review-" + reviewer.id,
        taskId,
        runId: reviewer.id,
        artifactRevision: t.artifactRevision,
        specDigest: specDigest(t),
        reviewerSession: "pending-harness-session",
        provider: reviewer.provider,
        authorshipDisclosure:
          "Separate synthetic provider/session fixture. No real model or independent human reviewed this work; mock separation is not authenticated real-world reviewer independence.",
        availableEvidence: evidenceIds,
        findings: [],
        testsExecuted: [],
        testsNotExecuted: [
          "Synthetic reviewer executed no tests. Controller command receipts are separate native execution evidence; no model executed them.",
        ],
        conflictingEvidence: [],
        remediation: [],
        residualHolds: [],
        verdict: "PASS",
        scope:
          "Synthetic workflow fixture only: " +
          taskId +
          " at " +
          t.artifactRevision +
          "; real task correctness not assessed.",
        nextAuthorizedStep:
          "Run deterministic audits and verification; retain all actual source, evidence, authorization and final acceptance gates.",
        auditAssessments: [
          "ACCURACY",
          "LOCAL_ANTI_DRIFT",
          "MACRO_ANTI_DRIFT",
        ].map((kind) => ({
          kind: kind as Review["auditAssessments"][number]["kind"],
          result: "PASS",
          evidenceIds,
          assessment:
            "Simulated separate-session assessment for an orchestration fixture only; deterministic checks remain mandatory.",
          limitations: [],
        })),
      };
      try {
        const receipt = await c.execute(
          reviewer,
          live
            ? this.liveAdapter(reviewer.provider)
            : new MockProvider({ output: canonical(reviewPayload(report)) }),
          actor,
        );
        if (receipt.status !== "SUCCEEDED") return;
      } catch (error) {
        this.step(requestId, {
          taskId,
          key: "review-execution-" + reviewer.id,
          stage: "REVIEW_EXECUTION",
          condition: reviewer.id,
          runId: reviewer.id,
          outcome: "HELD",
          detail: redact(String(error)),
        });
        return;
      }
    }
    const receiptRow = c.db.get<{ body: string }>(
      "SELECT body FROM receipts WHERE attempt_id=?",
      reviewer.id,
    );
    if (!receiptRow) return;
    const receipt = JSON.parse(receiptRow.body);
    if (receipt.status !== "SUCCEEDED") return;
    const recorded = this.once(
      requestId,
      taskId,
      "RECORD_REVIEW",
      { reviewer: reviewer.id, evidenceIds },
      () => {
        if (
          c.db.get(
            "SELECT id FROM reviews WHERE id=?",
            "workflow-review-" + reviewer.id,
          )
        )
          return;
        c.review(
          {
            ...JSON.parse(receipt.output),
            id: "workflow-review-" + reviewer.id,
            runId: reviewer.id,
            reviewerSession: receipt.sessionId,
          },
          actor,
        );
      },
    );
    if (
      !recorded &&
      !c.db
        .all<{
          body: string;
        }>("SELECT body FROM reviews WHERE task_id=?", taskId)
        .some((row) => JSON.parse(row.body).runId === reviewer.id)
    ) {
      // The controller threw out the reviewer's report. Have it record that
      // (idempotent), so it can decide whether one more reviewer may run. This
      // run has no review to audit or verify. (A review recorded for the run
      // another way, such as through the CLI, goes on to audit as before.)
      try {
        c.rejectReview(reviewer.id, actor);
      } catch (error) {
        this.once(
          requestId,
          taskId,
          "REJECT_REVIEW",
          { reviewer: reviewer.id },
          () => {
            throw error;
          },
        );
      }
      return;
    }
    // While a proposal round is open the work is not verified: the worker
    // replies, and the reply's own review verifies it once the round settles.
    const round = c.proposalRound(taskId);
    if (round && round.stage !== "SETTLED") return;
    // A scoped audit is taken again when its drift changes or is
    // acknowledged (issue #20); older runs keep their key.
    const macro = c.macroState(taskId);
    this.once(
      requestId,
      taskId,
      "AUDIT",
      {
        worker: worker.id,
        reviewer: reviewer.id,
        evidenceIds,
        ...(macro ? { macro } : {}),
      },
      () => {
        c.audit(taskId, actor, reviewer.id);
      },
    );
    const current = c.inspect(taskId);
    this.once(
      requestId,
      taskId,
      "VERIFY",
      {
        worker: worker.id,
        evidence: current.evidence.map((e) => ({ id: e.id, digest: e.digest })),
        reviews: current.reviews.map((r) => r.id),
        audits: current.audits.map((a) => a.id),
        bindings: c.db.all(
          "SELECT body FROM acceptance_bindings WHERE task_id=?",
          taskId,
        ),
        decisions: current.decisions,
        blockers: current.blockers,
      },
      () => {
        if (c.task(taskId).status === "WAITING_REVIEW") c.verify(taskId, actor);
      },
    );
  }

  /** A run key unique across every reservation ever made for the task. */
  private freshKey(taskId: string, base: string) {
    const used = new Set(
      (
        this.controller.inspect(taskId).attempts as { requestKey: string }[]
      ).map((a) => a.requestKey),
    );
    let retry = 0;
    while (used.has(base + (retry ? ":retry:" + retry : ""))) retry++;
    return base + (retry ? ":retry:" + retry : "");
  }

  /**
   * The worker answers the proposals of the specification's first review in
   * one more run, starting from its sealed work. When the task's budget is
   * used up, the round goes on without a reply.
   */
  private async answerProposals(
    requestId: string,
    taskId: string,
    live: boolean,
  ) {
    const c = this.controller,
      actor = c.localActor(),
      round = c.proposalRound(taskId);
    if (!round || round.stage !== "AWAITING_REPLY") return;
    const t = this.assertBinding(requestId, taskId);
    const requestKey = this.freshKey(
      taskId,
      "workflow:" +
        digest({
          requestId,
          taskId,
          spec: specDigest(t),
          role: "worker",
          proposalRound: round.reviewRunId,
        }),
    );
    if (!(await this.oversee(requestId, taskId, live))) return;
    if (live)
      await this.ensureAttested(taskId, "worker", {
        provider: this.artifactProvider(taskId),
      });
    let attempt: ReturnType<Controller["reserve"]>;
    try {
      c.warmLineage();
      attempt = c.db.transaction(() => {
        this.assertBinding(requestId, taskId);
        const reserved = c.reserve(
          taskId,
          {
            requestKey,
            projectRequestId: requestId,
            proposalRound: round.reviewRunId,
          },
          actor,
        );
        this.append(requestId, "WORKFLOW_RUN_LINKED", {
          taskId,
          role: "worker",
          runId: reserved.id,
          proposalRound: round.reviewRunId,
        });
        return reserved;
      });
    } catch (error) {
      try {
        // Only a used-up budget lets the round go on without a reply.
        c.skipProposalReply(taskId, actor);
        return;
      } catch {
        /* the reply can still run: record why it did not */
      }
      this.askAdaptiveRouting(requestId, taskId, error);
      this.once(
        requestId,
        taskId,
        "PROPOSAL_REPLY_RESERVATION",
        {
          round: round.reviewRunId,
          reasons: c.reasons(taskId),
          route: c.route(taskId),
        },
        () => {
          throw error;
        },
      );
      return;
    }
    try {
      const receipt = await c.execute(
        attempt,
        live
          ? this.liveAdapter(attempt.provider)
          : new MockProvider({
              delayMs: 15,
              output: canonical({
                taskId,
                summary:
                  "SIMULATION: synthetic reply to the review's proposals; nothing was changed.",
                replies: round.items.map((item) => ({
                  id: item.id,
                  reply: "ADOPT",
                  reason: "SIMULATION: synthetic reply",
                })),
              }),
            }),
        actor,
      );
      this.recordNotLaunched(requestId, taskId, attempt.id, receipt);
    } catch (error) {
      this.step(requestId, {
        taskId,
        key: "proposal-reply-" + attempt.id,
        stage: "PROPOSAL_REPLY_EXECUTION",
        condition: attempt.id,
        runId: attempt.id,
        outcome: "HELD",
        detail: redact(String(error)),
      });
    }
  }

  /**
   * The moderator sorts the proposals still open after the worker's reply. Its
   * answer is advice for the owner. When no moderator can run, the open items
   * go to the owner without a recommendation; momentary capacity limits are
   * retried on the next advance.
   */
  private async moderate(requestId: string, taskId: string, live: boolean) {
    const c = this.controller,
      actor = c.localActor(),
      round = c.proposalRound(taskId);
    if (!round || round.stage !== "AWAITING_MODERATOR") return;
    const t = this.assertBinding(requestId, taskId);
    const unavailable = (reason: string) => {
      try {
        c.recordModeratorUnavailable(taskId, reason, actor);
      } catch (error) {
        this.once(
          requestId,
          taskId,
          "MODERATOR_NOT_OBTAINED",
          { round: round.reviewRunId, reason },
          () => {
            throw error;
          },
        );
      }
    };
    if (live) await this.ensureAttested(taskId, "moderator");
    const route = c.route(taskId, "moderator");
    if (!route.ok) {
      unavailable("MODERATOR_UNAVAILABLE:" + route.reasons.join("|"));
      return;
    }
    const requestKey = this.freshKey(
      taskId,
      "workflow:" +
        digest({
          requestId,
          taskId,
          spec: specDigest(t),
          role: "moderator",
          proposalRound: round.reviewRunId,
        }),
    );
    let attempt: ReturnType<Controller["reserve"]>;
    try {
      c.warmLineage();
      attempt = c.db.transaction(() => {
        this.assertBinding(requestId, taskId);
        const reserved = c.reserve(
          taskId,
          {
            role: "moderator",
            requestKey,
            proposalRound: round.reviewRunId,
          },
          actor,
        );
        this.append(requestId, "WORKFLOW_RUN_LINKED", {
          taskId,
          role: "moderator",
          runId: reserved.id,
          proposalRound: round.reviewRunId,
        });
        return reserved;
      });
    } catch (error) {
      const reason = redact(String(error));
      if (
        /ROUTING_HELD|EXECUTION_BUDGET_EXHAUSTED|TASK_NOT_AWAITING_REVIEW|PROVIDER_NOT_ELIGIBLE/.test(
          reason,
        )
      )
        unavailable("MODERATOR_RESERVATION:" + reason);
      else
        this.once(
          requestId,
          taskId,
          "MODERATOR_RESERVATION",
          { round: round.reviewRunId, reason },
          () => {
            throw error;
          },
        );
      return;
    }
    const open = round.items.filter((item) => item.settlement === "OPEN");
    try {
      await c.execute(
        attempt,
        live
          ? this.liveAdapter(attempt.provider)
          : new MockProvider({
              delayMs: 15,
              output: canonical({
                taskId,
                specDigest: specDigest(t),
                items: open.map((item) => ({
                  id: item.id,
                  decision: "ASK_OWNER",
                  reason:
                    "SIMULATION: synthetic moderator; no advice is claimed.",
                  question:
                    "SIMULATION: keep the work or take up the proposal?",
                  options: [
                    { answer: "Keep the work", effect: "nothing changes" },
                    { answer: "Take it up", effect: "the task is revised" },
                  ],
                  recommended: "Keep the work",
                })),
              }),
            }),
        actor,
      );
    } catch (error) {
      this.step(requestId, {
        taskId,
        key: "moderator-execution-" + attempt.id,
        stage: "MODERATOR_EXECUTION",
        condition: attempt.id,
        runId: attempt.id,
        outcome: "HELD",
        detail: redact(String(error)),
      });
    }
  }

  /** Each proposal left for the owner becomes one owner question on the task. */
  private askAboutProposals(requestId: string, taskId: string) {
    const round = this.controller.proposalRound(taskId);
    if (!round || round.stage !== "AWAITING_OWNER_QUESTIONS") return;
    for (const item of round.items) {
      const question = item.question;
      if (!question || question.asked) continue;
      try {
        // Check and record under one write lock, so the same question is
        // never asked twice, in this request or another.
        this.controller.db.transaction(() => {
          if (
            this.events().some(
              (e) =>
                e.kind === "WORKFLOW_QUESTION" &&
                e.body.question.key === question.key &&
                e.body.question.taskId === taskId,
            )
          )
            return;
          this.askScoped(
            requestId,
            {
              key: question.key,
              text: question.text,
              kind: "OWNER_DECISION",
              audience: "OWNER",
              taskId,
            },
            { reserved: true },
          );
        });
      } catch (error) {
        this.once(
          requestId,
          taskId,
          "PROPOSAL_QUESTION",
          { key: question.key, error: redact(String(error)) },
          () => {
            throw error;
          },
        );
      }
    }
  }

  /**
   * Holds on a task's proposal round that advancing this request alone won't
   * clear: a failed reply, a question open elsewhere, or a step still held at
   * the stage the round is at.
   */
  private proposalHolds(
    requestId: string,
    round: ProposalRound | null,
    steps: Step[],
  ): string[] {
    if (!round) return [];
    const holds: string[] = [];
    if (round.stage === "REPLY_FAILED") holds.push("PROPOSAL_REPLY_FAILED");
    const held = (stage: string) => {
      const last = steps.filter((step) => step.stage === stage).at(-1);
      return last?.outcome === "HELD" ? last.detail : undefined;
    };
    for (const [at, stage] of [
      ["AWAITING_REPLY", "PROPOSAL_REPLY_RESERVATION"],
      ["AWAITING_MODERATOR", "MODERATOR_RESERVATION"],
      ["AWAITING_OWNER_QUESTIONS", "PROPOSAL_QUESTION"],
    ] as const) {
      const detail = round.stage === at ? held(stage) : undefined;
      if (detail) holds.push("WORKFLOW_" + stage + "_HELD:" + detail);
    }
    if (round.stage === "AWAITING_OWNER") {
      const mine = new Set(
        this.events(requestId)
          .filter((e) => e.kind === "WORKFLOW_QUESTION")
          .map((e) => e.body.question.key),
      );
      if (
        round.items.some(
          (item) =>
            item.question?.asked &&
            !item.question.answers.length &&
            !mine.has(item.question.key),
        )
      )
        holds.push("PROPOSAL_QUESTION_OPEN_IN_OTHER_REQUEST");
    }
    return holds;
  }

  /** Review, audit and verify the given tasks, a batch at a time. */
  private async reviewPhase(
    requestId: string,
    tasks: { taskId: string; currentSpecDigest: string; holds: string[] }[],
    live: boolean,
  ) {
    for (
      let offset = 0;
      offset < tasks.length;
      offset += this.controller.projectGoverned() ? 1 : this.controller.workerLimit
    ) {
      await Promise.all(
        tasks
          .slice(
            offset,
            offset +
              (this.controller.projectGoverned() ? 1 : this.controller.workerLimit),
          )
          .map(async (t) => {
            try {
              // Each pass makes at most one reviewer attempt; retry a run that
              // ended without a review, within the per-artifact key limit. A
              // pass can also just mark an earlier run's report as thrown out.
              for (let pass = 0; pass < 3; pass++) {
                const before = this.reviewerRuns(t.taskId),
                  endedBefore = this.endedReviewRuns(t.taskId);
                await this.reviewAndVerify(requestId, t.taskId, live);
                const after = this.reviewerRuns(t.taskId);
                const last = after.at(-1);
                if (
                  !last ||
                  !this.endedReviewRuns(t.taskId).has(last.id) ||
                  (after.length === before.length && endedBefore.has(last.id))
                )
                  break;
              }
            } catch (error) {
              this.once(
                requestId,
                t.taskId,
                "REVIEW_GATE",
                { spec: t.currentSpecDigest, holds: t.holds },
                () => {
                  throw error;
                },
              );
            }
          }),
      );
    }
  }

  /**
   * What of this process's live runs may still be going, whether or not
   * their advance has ended: a sandbox process alive or preflight probes
   * running (each adapter's word), and Drive writes begun here and not ended
   * (their end needs the database). The host must not let its lock and
   * database go while any is listed .
   */
  hostActivity(): {
    busy: BusyRun[];
    openDriveWrites: Array<{ runId: string; intentId: string; resource: string }>;
  } {
    return {
      busy: Object.values(this.live).flatMap(
        (adapter) => adapter?.busy?.() ?? [],
      ),
      openDriveWrites: this.controller.openDriveWritesHere(),
    };
  }
  async drive(
    requestId: string,
    options: { mock?: boolean; live?: boolean } = {},
  ) {
    this.controller.localActor();
    options = z
      .object({ mock: z.boolean().optional(), live: z.boolean().optional() })
      .strict()
      .parse(options);
    if (options.mock && options.live)
      throw new Error("DRIVE_MODE_AMBIGUOUS_MOCK_AND_LIVE");
    this.assertHost(requestId);
    const live = options.live === true;
    const view = this.inspect(requestId);
    if (
      (!options.mock && !live) ||
      this.requestPause(requestId) ||
      !view.tasks.length ||
      // A project-wide question stops the request; a scoped one, its tasks.
      view.questions.some(
        (q) => q.status === "OPEN" && questionScope(q).projectWide,
      )
    )
      return view;
    const projectOpen = this.projectOpenQuestions(requestId);
    const eligible = view.tasks.filter(
      (t) =>
        t.simulation === !live &&
        t.boundSpecDigest === t.currentSpecDigest &&
        !view.questions.some(
          (q) => q.status === "OPEN" && covers(q, t.taskId),
        ) &&
        !projectOpen.some((q) => covers(q, t.taskId)),
    );
    // Each attached task is considered once per phase. Controller reservations
    // enforce global leases/capacity/overlap across processes; no unknown replay.
    for (
      let offset = 0;
      offset < eligible.length;
      offset += this.controller.projectGoverned() ? 1 : this.controller.workerLimit
    ) {
      await Promise.all(
        eligible
          .slice(
            offset,
            offset +
              (this.controller.projectGoverned() ? 1 : this.controller.workerLimit),
          )
          .map(async (t) => {
            try {
              await this.worker(requestId, t.taskId, live);
            } catch (error) {
              this.once(
                requestId,
                t.taskId,
                "WORKER_GATE",
                { spec: t.currentSpecDigest, holds: t.holds },
                () => {
                  throw error;
                },
              );
            }
          }),
      );
    }
    // A worker summary can hold questions that an interrupted run never recorded;
    // record them now (idempotent per run). Then review only tasks that aren't
    // waiting on the owner, in this request or any other.
    for (const t of eligible) {
      const pending = this.pendingWorkerQuestion(t.taskId);
      if (pending && pending.keys.some((key) => !this.questionKeyRecorded(key)))
        this.recordWorkerQuestions(
          requestId,
          t.taskId,
          pending.runId,
          pending.output,
        );
    }
    // Tasks waiting on the owner, in this request or another, are not reviewed.
    const reviewable = () => {
      const view = this.inspect(requestId);
      const open = [
        ...view.questions.filter((q) => q.status === "OPEN"),
        ...this.projectOpenQuestions(requestId),
      ];
      return eligible.filter(
        (t) =>
          !open.some((q) => covers(q, t.taskId)) &&
          !this.workerQuestionHolds(requestId, t.taskId).length &&
          !view.tasks
            .find((x) => x.taskId === t.taskId)
            ?.holds.includes("PROPOSAL_QUESTION_OPEN_IN_OTHER_REQUEST"),
      );
    };
    await this.reviewPhase(requestId, reviewable(), live);
    // A review's proposals: the worker replies, the moderator sorts what is
    // still open, and the rest becomes owner questions. A reply that needs
    // nothing from the owner is then reviewed.
    const rounds = reviewable().filter((t) =>
      this.controller.proposalRound(t.taskId),
    );
    for (
      let offset = 0;
      offset < rounds.length;
      offset += this.controller.projectGoverned() ? 1 : this.controller.workerLimit
    ) {
      await Promise.all(
        rounds
          .slice(
            offset,
            offset +
              (this.controller.projectGoverned() ? 1 : this.controller.workerLimit),
          )
          .map(async (t) => {
            try {
              await this.answerProposals(requestId, t.taskId, live);
              await this.moderate(requestId, t.taskId, live);
              this.askAboutProposals(requestId, t.taskId);
            } catch (error) {
              this.once(
                requestId,
                t.taskId,
                "PROPOSAL_GATE",
                { spec: t.currentSpecDigest, holds: t.holds },
                () => {
                  throw error;
                },
              );
            }
          }),
      );
    }
    const inRound = new Set(rounds.map((t) => t.taskId));
    await this.reviewPhase(
      requestId,
      reviewable().filter((t) => inRound.has(t.taskId)),
      live,
    );
    // The closing checkpoint runs unless a project-wide question is open or
    // every task it could look at waits on a question.
    if (this.controller.projectGoverned() && eligible.length) {
      const open = this.inspect(requestId).questions.filter(
        (q) => q.status === "OPEN",
      );
      const anchor = open.some((q) => questionScope(q).projectWide)
        ? undefined
        : eligible.find(
            (t) =>
              !["CANCELLED", "SUPERSEDED"].includes(
                this.controller.task(t.taskId).status,
              ) && !open.some((q) => covers(q, t.taskId)),
          );
      if (anchor) await this.oversee(requestId, anchor.taskId, live);
    }
    return this.inspect(requestId);
  }
}

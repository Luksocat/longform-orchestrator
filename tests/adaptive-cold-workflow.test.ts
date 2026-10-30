/** N2: cold public workflow actions preserve durable adaptive review state. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonical, digest, reviewPayload, specDigest, type Review } from "../src/domain.js";
import { MockProvider } from "../src/providers.js";
import { defaultRoutingPolicy } from "../src/routing.js";
import {
  acceptTask, checkpoint, project, put, review, workWith, type Project,
} from "./fixtures/adaptive/remediation-project.js";

/** Real work, a recorded independent review, and a reply changing no bytes. */
async function settledProposal() {
  const f = project();
  try {
    await checkpoint(f);
    const worker = await workWith(f, "A", (a) => put(a, "output/A/result.txt", "Keep this greeting.\n"));
    assert.equal(worker.receipt.status, "SUCCEEDED");
    const opening = f.c.reserve("A", {
      role: "reviewer", projectRequestId: f.id, requestKey: randomUUID(),
    }, f.c.localActor());
    const task = f.c.task("A");
    const evidenceIds = f.c.evidenceFor("A").map((e) => e.id);
    const report: Review = {
      id: "review-" + opening.id, taskId: "A", runId: opening.id,
      artifactRevision: task.artifactRevision, specDigest: specDigest(task),
      reviewerSession: "pending", provider: opening.provider,
      authorshipDisclosure: "Independent synthetic review", availableEvidence: evidenceIds,
      findings: [], testsExecuted: [], testsNotExecuted: ["Synthetic fixture"],
      conflictingEvidence: [], remediation: [], residualHolds: [], verdict: "PASS",
      scope: "The greeting", nextAuthorizedStep: "Answer the optional proposal",
      auditAssessments: (["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"] as const).map((kind) => ({
        kind, result: "PASS" as const, evidenceIds, assessment: "Synthetic independent assessment", limitations: [],
      })),
      proposals: [{ what: "Add a second greeting", why: "Optional tone", userImpact: "A warmer opening", weight: "IDEA", touchesDecision: false }],
    };
    const receipt = await f.c.execute(opening, new MockProvider({ output: canonical(reviewPayload(report)) }), f.c.localActor());
    assert.equal(receipt.status, "SUCCEEDED");
    f.c.review({ ...JSON.parse(receipt.output), id: report.id, runId: opening.id, reviewerSession: receipt.sessionId }, f.c.localActor());
    assert.equal(f.c.proposalRound("A")?.stage, "AWAITING_REPLY");
    await checkpoint(f);
    const reply = f.c.reserve("A", {
      projectRequestId: f.id, requestKey: randomUUID(), proposalRound: opening.id,
    }, f.c.localActor());
    const answered = await f.c.execute(reply, new MockProvider({ output: canonical({
      taskId: "A", summary: "Kept the reviewed greeting unchanged.",
      replies: [{ id: "P1", reply: "DECLINE", reason: "The original greeting is sufficient." }],
    }) }), f.c.localActor());
    assert.equal(answered.status, "SUCCEEDED");
    const round = f.c.proposalRound("A")!;
    assert.equal(round.stage, "SETTLED");
    assert.equal(round.reply?.standsOnReview, opening.id);
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM reviews WHERE task_id='A'")!.n, 1);
    return { f, opening };
  } catch (error) { f.close(); throw error; }
}

type View = ReturnType<Project["o"]["inspect"]>;
function retained(view: View, reviewRunId: string) {
  const task = view.tasks.find((t) => t.taskId === "A")!;
  assert.equal(task.proposals?.stage, "SETTLED");
  assert.equal(task.proposals?.reply?.standsOnReview, reviewRunId);
  assert.ok(!task.holds.some((h) => h.includes("NOT_PREWARMED")), canonical(task.holds));
}
function count(f: Project, kind: string) {
  return f.db.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind=?", kind)!.n;
}
function originalRequest(f: Project) {
  const request = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_SUBMITTED' ORDER BY seq LIMIT 1")!.body).request;
  return { requestKey: request.requestKey, prompt: request.prompt, context: request.context, sourceRef: request.sourceRef, taskIds: [] };
}

test("N2: cold owner pause and resume retain an unchanged adaptive proposal reply's review", async () => {
  const { f, opening } = await settledProposal();
  try {
    f.restart();
    retained(f.o.pauseRequest(f.id, { text: "Pause this request", sourceRef: "test:owner" }), opening.id);
    assert.equal(count(f, "WORKFLOW_REQUEST_PAUSED"), 1);
    assert.equal(f.o.requestPause(f.id)?.text, "Pause this request");
    f.restart();
    retained(f.o.pauseRequest(f.id, { text: "Resume this request", sourceRef: "test:owner" }, true), opening.id);
    assert.equal(count(f, "WORKFLOW_REQUEST_RESUMED"), 1);
    assert.equal(f.o.requestPause(f.id), undefined);
  } finally { f.close(); }
});

test("N2: cold idempotent submit preserves the existing request and retained adaptive review", async () => {
  const { f, opening } = await settledProposal();
  try {
    const input = originalRequest(f);
    f.restart();
    const replayed = f.o.submit(input);
    assert.equal(replayed.request.id, f.id);
    retained(replayed, opening.id);
    assert.equal(count(f, "WORKFLOW_SUBMITTED"), 1);
  } finally { f.close(); }
});

test("N2: cold owner reply and its replay commit once with a retained adaptive review", async () => {
  const { f, opening } = await settledProposal();
  try {
    const question = f.o.ask(f.id, { key: "owner-note", text: "Which audience is this for?", kind: "INFORMATION", taskIds: ["A"] });
    const input = { questionId: question.id, replyKey: "audience", text: "New players", sourceRef: "test:owner" };
    for (let attempt = 0; attempt < 2; attempt++) {
      f.restart();
      const view = f.o.reply(f.id, input);
      retained(view, opening.id);
      assert.equal(view.questions.find((q) => q.id === question.id)?.status, "ANSWERED");
      assert.equal(count(f, "WORKFLOW_REPLY"), 1);
    }
  } finally { f.close(); }
});

test("N2: cold owner deferral and its replay commit once with a retained adaptive review", async () => {
  const { f, opening } = await settledProposal();
  try {
    const question = f.o.ask(f.id, { key: "optional-tone", text: "Should a later version be warmer?", kind: "INFORMATION", taskIds: ["A"] });
    const input = { questionId: question.id, questionText: question.text, ownerInstruction: "Defer this optional question", reason: "No change to this revision", sourceRef: "test:owner" };
    for (let attempt = 0; attempt < 2; attempt++) {
      f.restart();
      const view = f.o.deferQuestion(f.id, input);
      retained(view, opening.id);
      assert.equal(view.questions.find((q) => q.id === question.id)?.status, "DEFERRED");
      assert.equal(count(f, "WORKFLOW_QUESTION_DEFERRED"), 1);
    }
  } finally { f.close(); }
});

test("N2: cold owner actions after leaving adaptive routing keep pinned work held", async () => {
  const { f, opening } = await settledProposal();
  try {
    const input = originalRequest(f);
    const attempts = f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n;
    f.restart(defaultRoutingPolicy());
    const paused = f.o.pauseRequest(f.id, { text: "Keep this work paused", sourceRef: "test:owner" });
    retained(paused, opening.id);
    assert.ok(paused.tasks[0]!.holds.includes("ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW"), canonical(paused.tasks[0]!.holds));
    f.restart(defaultRoutingPolicy());
    const replayed = f.o.submit(input);
    retained(replayed, opening.id);
    assert.ok(replayed.tasks[0]!.holds.includes("ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW"), canonical(replayed.tasks[0]!.holds));
    assert.equal(count(f, "WORKFLOW_REQUEST_PAUSED"), 1);
    assert.equal(count(f, "WORKFLOW_SUBMITTED"), 1);
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n, attempts);
  } finally { f.close(); }
});

for (const tamper of [false, true]) test("N2: cold READY transition " + (tamper ? "rejects a changed accepted dependency" : "accepts a current accepted dependency"), async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(f);
    const worker = await workWith(f, "A", (a) => put(a, "output/A/result.txt", "Accepted dependency.\n"));
    f.c.bindAcceptance("A", "receipt", "output-" + worker.attempt.id, f.c.localActor());
    const reviewer = await review(f, "PASS");
    acceptTask(f, "A", reviewer.id);
    const task = f.c.task("B");
    f.c.revise("B", { ...task, specVersion: task.specVersion + 1, dependencies: ["A"] }, f.c.localActor());
    f.c.grant("B", { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/B"], decisionText: "Work after the accepted dependency", sourceRef: "test:owner" }, f.c.localActor());
    if (tamper) put(worker.attempt, "output/A/result.txt", "Changed after acceptance.\n");
    f.restart();
    if (tamper) {
      assert.throws(() => f.c.transition("B", "READY", f.c.localActor()), /DEPENDENCY_NOT_CURRENT_ACCEPTED:A/);
      assert.notEqual(f.c.task("B").status, "READY");
    } else {
      f.c.transition("B", "READY", f.c.localActor());
      assert.equal(f.c.task("B").status, "READY");
    }
  } finally { f.close(); }
});

for (const tamper of [false, true]) test("N2: cold reviewer reconciliation " + (tamper ? "does not restore changed work" : "restores unchanged blocked work to review"), async () => {
  const f = project();
  try {
    await checkpoint(f);
    const worker = await workWith(f, "A", (a) => put(a, "output/A/result.txt", "Awaiting independent review.\n"));
    const reviewer = f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const crashed = await f.c.execute(reviewer, new MockProvider({ outcome: "crash" }), f.c.localActor());
    assert.equal(crashed.status, "UNKNOWN");
    // The supported legacy recovery state, reached through public APIs:
    // an unresolved reviewer stopped work that was waiting for review.
    f.c.transition("A", "BLOCKED", f.c.localActor());
    const evidenceId = "reconciled-" + reviewer.id;
    f.c.addEvidence({
      id: evidenceId, taskId: "A", kind: "LOCAL", uri: "local-assessment:" + reviewer.id,
      revision: f.c.task("A").artifactRevision, digest: digest("Reviewer stopped with no effects"),
      retrievedAt: new Date().toISOString(), authorityTier: "UNVERIFIED", authentication: "LOCAL_IMPORT",
      currentness: "CURRENT_AT_RETRIEVAL", claims: ["Reviewer stopped"],
      metadata: { runId: reviewer.id, reconciliation: {
        processStopped: true, externalEffects: "NONE", assessment: "Read-only reviewer stopped; no external effects", usage: { costUsd: 0, tokens: 0 },
      } },
    }, f.c.localActor());
    if (tamper) put(worker.attempt, "output/A/result.txt", "Changed before reconciliation.\n");
    f.restart();
    f.c.reconcile(reviewer.id, "FAILED", evidenceId, f.c.localActor());
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", reviewer.id)!.state, "FAILED");
    assert.equal(f.c.task("A").status, tamper ? "BLOCKED" : "WAITING_REVIEW");
    assert.equal(count(f, "UNKNOWN_RECONCILED"), 1);
  } finally { f.close(); }
});

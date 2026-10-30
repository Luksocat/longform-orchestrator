import test from "node:test";
import assert from "node:assert/strict";
import {
  projectView,
  OVERSEER_VIEW_HEADING,
  TASK_VIEW_HEADING,
  PROJECT_ARCHIVE_PATH,
} from "../src/project-view.js";
import type { ProjectContext } from "../src/project.js";

const review = (runId: string, finding: string, verdict = "FAIL") => ({
  id: "review-" + runId,
  runId,
  verdict,
  findings: [{ materiality: "MAJOR", evidenceIds: [], description: finding }],
  remediation: verdict === "FAIL" ? ["Fix " + finding] : [],
  residualHolds: [],
  authorshipDisclosure: "Independent session",
  auditAssessments: [],
});
const entry = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  task: {
    id,
    title: "Title " + id,
    status,
    scope: "SCOPE-" + id,
    deliverable: "out/" + id,
    dependencies: [] as string[],
    specVersion: 1,
    artifactRevision: "r1",
  },
  specDigest: "spec-" + id,
  gate: { holds: [], completionCurrent: false, completionIssue: null },
  artifact: null,
  assessments: [],
  evidence: [],
  tests: [],
  reviews: [],
  audits: [],
  decisions: [],
  grants: [],
  revocations: [],
  grantRevocations: [],
  ...extra,
});
const plan = {
  inputDigest: "digest-now",
  summary: "PLAN-SUMMARY",
  outcome: "CONTINUE",
  assignments: [
    { taskId: "A", instruction: "DO-A" },
    { taskId: "C", instruction: "DO-C" },
  ],
  nextTaskIds: ["A", "C"],
  milestones: ["MILESTONE-1"],
  technicalDecisions: [
    { decision: "DEC-LATEST", reason: "WHY-LATEST", sourceRefs: [] },
  ],
  risks: ["RISK-1"],
  questionsForOwner: [],
};
function context(): ProjectContext {
  const a = entry("A", "BLOCKED", {
    task: {
      ...entry("A", "BLOCKED").task,
      dependencies: ["B"],
    },
    reviews: [review("r-old", "OLD-FINDING"), review("r-new", "NEW-FINDING")],
    assessments: [
      { runId: "as-1", output: "ASSESS-OLD" },
      { runId: "as-2", output: "ASSESS-NEW" },
    ],
  });
  const b = entry("B", "VERIFIED", {
    artifact: {
      runId: "w-b",
      digest: "d-b",
      path: "project-artifacts/b",
      summary: "B made the map",
    },
    reviews: [review("r-b", "B-FINDING", "PASS")],
  });
  const c = entry("C", "WAITING_REVIEW", {
    reviews: [review("r-c", "C-REVIEW-FINDING")],
    gate: {
      holds: ["SOME_HOLD"],
      completionCurrent: false,
      completionIssue: null,
    },
  });
  const question = (
    id: string,
    text: string,
    answer: string,
    taskId?: string,
  ) => ({
    id,
    key: "k-" + id,
    kind: "OWNER_DECISION",
    text,
    ...(taskId ? { taskId } : {}),
    answers: [{ questionId: id, text: answer, sourceRef: "owner" }],
  });
  return {
    requestId: "req-now",
    snapshot: {
      projectId: "project:p",
      inputDigest: "digest-now",
      requests: [
        { id: "req-old", prompt: "OLD-PROMPT", sourceRef: "s0", context: {} },
        { id: "req-now", prompt: "OWNER-PROMPT", sourceRef: "s1", context: {} },
      ],
      tasks: [a, b, c],
      taskBindings: [
        { requestId: "req-old", taskId: "B", specDigest: "spec-B" },
        { requestId: "req-now", taskId: "A", specDigest: "spec-A" },
        { requestId: "req-now", taskId: "C", specDigest: "spec-C" },
      ],
      questions: [
        question("q-all", "QUESTION-ALL", "ANSWER-ALL"),
        question("q-a", "QUESTION-A", "ANSWER-A", "A"),
        question("q-c", "QUESTION-C", "ANSWER-C", "C"),
      ],
    },
    previous: {
      projectId: "project:p",
      requestId: "req-now",
      runId: "plan-run-2",
      inputDigest: "digest-now",
      revision: 2,
      plan,
    },
    decisionHistory: [
      {
        revision: 1,
        runId: "plan-run-1",
        decisions: [{ decision: "OLD-DECISION", reason: "x", sourceRefs: [] }],
      },
      { revision: 2, runId: "plan-run-2", decisions: plan.technicalDecisions },
    ],
  } as unknown as ProjectContext;
}

test("a task's slice carries the owner's request, its answers and Astra's plan for it, and none of the other tasks' history", () => {
  for (const role of [
    "worker",
    "reviewer",
    "assessor",
    "advisor",
    "moderator",
  ]) {
    const fitted = projectView(context(), role, "A").fit(128_000)!;
    const text = fitted.text;
    assert.ok(text.startsWith(TASK_VIEW_HEADING), role);
    for (const present of [
      "OWNER-PROMPT",
      "ANSWER-ALL",
      "ANSWER-A",
      "DO-A",
      "DEC-LATEST",
      "B made the map",
      "Title C",
    ])
      assert.ok(text.includes(present), `${role} should see ${present}`);
    for (const absent of [
      "OLD-PROMPT",
      "SCOPE-A",
      "SCOPE-C",
      "C-REVIEW-FINDING",
      "OLD-FINDING",
      "ANSWER-C",
      "DO-C",
      "OLD-DECISION",
    ])
      assert.ok(!text.includes(absent), `${role} should not see ${absent}`);
    assert.deepEqual(fitted.leftOut, []);
  }
});

test("Astra's view summarizes settled work and superseded detail, explains a revised task's BLOCKED status, and points to the full record", () => {
  const text = projectView(context(), "overseer", "").fit(128_000)!.text;
  assert.ok(text.startsWith(OVERSEER_VIEW_HEADING));
  const view = JSON.parse(text.slice(OVERSEER_VIEW_HEADING.length));
  assert.equal(view.snapshot.inputDigest, "digest-now");
  assert.equal(view.view.fullRecord, PROJECT_ARCHIVE_PATH);
  // Open tasks stay whole; a settled task keeps its outcome, not its history.
  for (const present of [
    "SCOPE-A",
    "SCOPE-C",
    "NEW-FINDING",
    "C-REVIEW-FINDING",
    "OWNER-PROMPT",
    "ANSWER-C",
    "OLD-DECISION",
    "ASSESS-NEW",
  ])
    assert.ok(text.includes(present), present);
  for (const absent of [
    "SCOPE-B",
    "B made the map",
    "B-FINDING",
    "OLD-PROMPT",
    "ASSESS-OLD",
  ])
    assert.ok(!text.includes(absent), absent);
  const [a, b] = view.snapshot.tasks;
  // A superseded review keeps its verdict and must-fix items, not its findings.
  assert.deepEqual(a.reviews[0].findings, {
    CRITICAL: 0,
    MAJOR: 1,
    MINOR: 0,
    INFO: 0,
  });
  assert.deepEqual(a.reviews[0].remediation, ["Fix OLD-FINDING"]);
  assert.equal(a.reviews[1].findings[0].description, "NEW-FINDING");
  assert.equal(b.task.status, "VERIFIED");
  assert.equal(b.artifact.path, "project-artifacts/b");
  assert.equal(b.reviews[0].verdict, "PASS");
  assert.match(b.archived, /project-archive\/context\.json/);
  // The latest plan is in `previous`; its copy is not repeated.
  assert.deepEqual(
    view.decisionHistory.map((d: any) => d.runId),
    ["plan-run-1"],
  );
  assert.match(a.statusNote, /no hold/);
  assert.equal(view.snapshot.tasks[2].statusNote, undefined);
  assert.match(view.snapshot.requests[0].archived, /10 characters/);
});

test("a view too long for its room leaves out the least important detail first, says so, and is refused when even the smallest does not fit", () => {
  for (const [role, taskId] of [
    ["reviewer", "A"],
    ["overseer", ""],
  ] as const) {
    const ctx = context() as any;
    const big = "x".repeat(20_000);
    ctx.snapshot.tasks[1].artifact.summary = "B made the map " + big;
    ctx.snapshot.tasks[0].artifact = {
      runId: "w-a",
      digest: "d-a",
      path: "project-artifacts/a",
      summary: "A did " + big,
    };
    ctx.previous.plan.summary = "PLAN-SUMMARY " + "y".repeat(3_900);
    ctx.decisionHistory[0].decisions[0].reason = "z".repeat(3_900);
    const view = projectView(ctx, role, taskId);
    assert.ok(view.smallest < view.full, role);
    const whole = view.fit(view.full)!;
    assert.deepEqual(whole.leftOut, []);
    const smaller = view.fit(view.full - 1)!;
    assert.ok(smaller.text.length < view.full);
    assert.ok(smaller.leftOut.length >= 1, role);
    const smallest = view.fit(view.smallest)!;
    assert.equal(smallest.text.length, view.smallest);
    assert.ok(smallest.leftOut.length >= smaller.leftOut.length);
    // What the run must have is never left out.
    for (const kept of ["OWNER-PROMPT", "QUESTION-ALL", "ANSWER-A"])
      assert.ok(smallest.text.includes(kept), `${role} keeps ${kept}`);
    if (role === "reviewer") assert.ok(smallest.text.includes("DO-A"));
    assert.equal(view.fit(view.smallest - 1), undefined);
  }
});

test("a task's slice carries the owner's recorded decisions and their limits, marks revoked ones, and leaves out other tasks' decisions", () => {
  const ctx = context() as any;
  const decision = (id: string, text: string, limits: string[] = []) => ({
    id,
    text,
    sourceRef: "owner",
    alternatives: [],
    limits,
    operations: ["WRITE_LOCAL"],
    artifactRevision: "r1",
  });
  ctx.snapshot.tasks[0].decisions = [
    decision("dec-a0", "REVOKED-A-TEXT"),
    decision("dec-a1", "DECISION-A-TEXT", ["LIMIT-A"]),
  ];
  ctx.snapshot.tasks[0].revocations = [{ reason: "superseded by dec-a1" }];
  ctx.snapshot.tasks[2].decisions = [decision("dec-c", "DECISION-C-TEXT")];
  const marked = projectView(ctx, "worker", "A", {
    revoked: { decisions: new Set(["dec-a0"]) },
  });
  const view = JSON.parse(
    marked.fit(marked.smallest)!.text.slice(TASK_VIEW_HEADING.length),
  );
  assert.deepEqual(
    view.ownerDecisions.map((d: any) => [d.id, d.revoked, d.limits]),
    [
      ["dec-a0", true, []],
      ["dec-a1", false, ["LIMIT-A"]],
    ],
  );
  assert.equal(view.ownerDecisionRevocations, undefined);
  assert.ok(!JSON.stringify(view).includes("DECISION-C-TEXT"));
  // Without the controller's revocation list, the records are shown as recorded.
  const plain = projectView(ctx, "reviewer", "A").fit(128_000)!.text;
  assert.match(plain, /superseded by dec-a1/);
});

test("the owner's answers reach a task's runs whole, however long, even in the smallest view", () => {
  const ctx = context() as any;
  ctx.snapshot.questions[1].answers[0].text =
    "ANSWER-A " + "a".repeat(5_000) + " CLARIFICATION-AT-THE-END";
  ctx.snapshot.tasks[1].artifact.summary = "B " + "x".repeat(20_000);
  const view = projectView(ctx, "worker", "A");
  assert.ok(view.smallest < view.full);
  for (const room of [view.full, view.smallest])
    assert.match(view.fit(room)!.text, /CLARIFICATION-AT-THE-END/);
});

test("a request whose task was revised and rebound by a later request keeps its prompt in Astra's view", () => {
  const ctx = context() as any;
  // req-old bound B at an earlier specification; req-now rebound B's revision.
  ctx.snapshot.taskBindings = [
    { requestId: "req-old", taskId: "B", specDigest: "spec-B-old" },
    { requestId: "req-now", taskId: "B", specDigest: "spec-B" },
    ...ctx.snapshot.taskBindings.filter((b: any) => b.taskId !== "B"),
  ];
  const text = projectView(ctx, "overseer", "").fit(128_000)!.text;
  assert.match(text, /OLD-PROMPT/);
  // Rebound by the same request to the current specification: settled.
  ctx.snapshot.taskBindings[0] = {
    requestId: "req-old",
    taskId: "B",
    specDigest: "spec-B-old",
  };
  ctx.snapshot.taskBindings.splice(1, 0, {
    requestId: "req-old",
    taskId: "B",
    specDigest: "spec-B",
  });
  assert.doesNotMatch(
    projectView(ctx, "overseer", "").fit(128_000)!.text,
    /OLD-PROMPT/,
  );
});

test("a task's slice carries the task's own sources, evidence, grants and controller test receipts whole, and no other task's", () => {
  const ctx = context() as any;
  const a = ctx.snapshot.tasks[0];
  a.task.sources = [{ evidenceId: "ev-a", uri: "drive://SOURCE-A-DOC" }];
  a.evidence = [
    {
      id: "ev-a",
      kind: "DRIVE",
      uri: "drive://SOURCE-A-DOC",
      revision: "rev-7",
      digest: "d".repeat(64),
      authorityTier: "GOVERNING",
      notes: "CONSTRAINT-A " + "c".repeat(6_000),
    },
  ];
  a.grants = [
    { id: "g-old", operations: ["WRITE_LOCAL"], decisionText: "OLD-GRANT" },
    { id: "g-new", operations: ["WRITE_LOCAL"], decisionText: "GRANT-A-TEXT" },
  ];
  a.grantRevocations = [{ reason: "replaced" }];
  a.tests = [{ id: "t-1", command: "npm test", passed: true }];
  ctx.snapshot.tasks[2].evidence = [
    { id: "ev-c", uri: "drive://SOURCE-C-DOC" },
  ];
  ctx.snapshot.tasks[1].artifact.summary = "B " + "x".repeat(20_000);
  const view = projectView(ctx, "reviewer", "A", {
    revoked: { grants: new Set(["g-old"]) },
  });
  assert.ok(view.smallest < view.full);
  const smallest = JSON.parse(
    view.fit(view.smallest)!.text.slice(TASK_VIEW_HEADING.length),
  );
  const own = smallest.thisTask;
  assert.equal(own.sources[0].uri, "drive://SOURCE-A-DOC");
  assert.match(own.evidence[0].notes, /^CONSTRAINT-A c{6000}$/);
  assert.equal(own.evidence[0].revision, "rev-7");
  assert.deepEqual(
    own.grants.map((g: any) => [g.id, g.revoked]),
    [
      ["g-old", true],
      ["g-new", false],
    ],
  );
  assert.equal(own.grantRevocations, undefined);
  assert.deepEqual(own.controllerTests, a.tests);
  assert.ok(!JSON.stringify(smallest).includes("SOURCE-C-DOC"));
});

test("a task's slice carries source evidence filed under another task, and the current specification's reviews with must-fix items and holds whole", () => {
  const ctx = context() as any;
  const a = ctx.snapshot.tasks[0];
  a.task.sources = [
    { evidenceId: "ev-b", revision: "1", digest: "e".repeat(64) },
  ];
  ctx.snapshot.tasks[1].evidence = [
    { id: "ev-b", uri: "drive://SHARED-SOURCE", notes: "SHARED-CONSTRAINT" },
    { id: "ev-b2", uri: "drive://UNRELATED-B" },
  ];
  const mustFix = "FIX-START " + "f".repeat(2_300) + " FIX-END";
  a.reviews = [
    { ...review("r-prev", "PREVIOUS-SPEC-FINDING"), specDigest: "spec-A-old" },
    {
      ...review("r-cur", "CURRENT-FINDING " + "g".repeat(3_000)),
      specDigest: "spec-A",
      remediation: [mustFix],
      residualHolds: ["HOLD-X"],
      proposals: [{ id: "p1", what: "PROPOSAL-TEXT" }],
    },
  ];
  ctx.snapshot.tasks[1].artifact.summary = "B " + "x".repeat(20_000);
  const view = projectView(ctx, "worker", "A");
  for (const room of [view.full, view.smallest]) {
    const text = view.fit(room)!.text;
    for (const kept of [
      "SHARED-SOURCE",
      "SHARED-CONSTRAINT",
      "FIX-END",
      "HOLD-X",
      "CURRENT-FINDING",
    ])
      assert.ok(text.includes(kept), `${room}: ${kept}`);
    for (const absent of ["UNRELATED-B", "PREVIOUS-SPEC-FINDING"])
      assert.ok(!text.includes(absent), `${room}: ${absent}`);
  }
  assert.match(view.fit(view.full)!.text, /PROPOSAL-TEXT/);
  const smallest = view.fit(view.smallest)!;
  assert.doesNotMatch(smallest.text, /PROPOSAL-TEXT/);
  assert.ok(smallest.leftOut.some((l) => /review findings/.test(l)));
});

test("a fix task's slice carries the review the fix answers, with must-fix items and holds whole", () => {
  const ctx = context() as any;
  ctx.snapshot.tasks[1].artifact.summary = "B " + "x".repeat(20_000);
  const answered = {
    ...review("r-c", "FIXED-FINDING " + "h".repeat(3_000)),
    remediation: ["FIX-MUST " + "m".repeat(2_500) + " MUST-END"],
    residualHolds: ["FIX-HOLD"],
  };
  const view = projectView(ctx, "reviewer", "A", {
    fixes: { taskId: "C", review: answered },
  });
  for (const room of [view.full, view.smallest]) {
    const fixes = JSON.parse(
      view.fit(room)!.text.slice(TASK_VIEW_HEADING.length),
    ).fixes;
    assert.equal(fixes.taskId, "C");
    assert.match(fixes.review.remediation[0], /MUST-END$/);
    assert.deepEqual(fixes.review.residualHolds, ["FIX-HOLD"]);
  }
  assert.equal(
    JSON.parse(view.fit(view.full)!.text.slice(TASK_VIEW_HEADING.length)).fixes
      .review.findings[0].description.length,
    "FIXED-FINDING ".length + 3_000,
  );
  assert.equal(
    JSON.parse(
      projectView(ctx, "reviewer", "A")
        .fit(128_000)!
        .text.slice(TASK_VIEW_HEADING.length),
    ).fixes,
    undefined,
  );
});

test("a historical answer to a question on two tasks is labelled per task: only the revised one is left out", () => {
  const ctx = context() as any;
  ctx.snapshot.questions.push({
    id: "q-ab",
    key: "k-q-ab",
    kind: "OWNER_DECISION",
    text: "QUESTION-AB",
    taskIds: ["A", "C"],
    specDigests: { A: "spec-A-old", C: "spec-C" },
    answers: [
      {
        questionId: "q-ab",
        text: "ANSWER-AB",
        sourceRef: "owner",
        answeredAs: "OWNER",
        historicalOnly: true,
        historicalForSpec: { A: "spec-A-old" },
      },
    ],
  });
  const answerFor = (taskId: string) => {
    const fitted = projectView(ctx, "worker", taskId);
    const view = JSON.parse(
      fitted.fit(fitted.full)!.text.slice(TASK_VIEW_HEADING.length),
    );
    return view.ownerQuestions.find((q: any) => q.id === "q-ab").answers[0];
  };
  assert.equal(answerFor("A").appliesToCurrentSpecification, false);
  assert.deepEqual(answerFor("A").historicalForTasks, ["A"]);
  assert.equal(answerFor("C").appliesToCurrentSpecification, true);
  // C revised after the answer: no longer said to apply.
  ctx.snapshot.tasks.find((e: any) => e.task.id === "C").specDigest = "spec-C-new";
  assert.equal(answerFor("C").appliesToCurrentSpecification, false);
});

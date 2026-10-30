/**
 * BASE-01 (issue #12): a fixed ASTRA_TWO_TIER project run end to end with
 * scripted providers, returned as a normalized journal. The same file runs
 * against the two-tier compatibility baseline to produce the golden copy, so any change to the
 * two-tier workflow's events, routing records or digests shows up as a
 * difference. Normalization keeps every equality between values (a value
 * seen twice gets the same placeholder) and drops only what varies between
 * runs: identifiers, times and paths.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../../../src/controller.js";
import { canonical, TaskSchema } from "../../../src/domain.js";
import { Orchestrator } from "../../../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
} from "../../../src/providers.js";
import { RoutingPolicySchema } from "../../../src/routing.js";
import { SqliteStore } from "../../../src/store.js";
import type { ProjectContext } from "../../../src/project.js";

const FIXED_TIME = "2026-10-29T00:00:00.000Z";

function twoTierPolicy() {
  const configured = JSON.parse(
    readFileSync(
      new URL(
        "./two-tier-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return RoutingPolicySchema.parse({
    ...configured,
    routes: configured.routes.map((r: any) => ({
      ...r,
      // Attested now, so the run never depends on the wall clock (the
      // times are normalized away below).
      capability: {
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        evidenceRef: "test:attested",
      },
    })),
  });
}

function plan(context: ProjectContext) {
  const tasks = context.snapshot.tasks;
  const done = (s: string) => ["VERIFIED", "ACCEPTED"].includes(s);
  return {
    inputDigest: context.snapshot.inputDigest,
    summary: "Keep the greeting project consistent.",
    outcome: tasks.every((t) => done(t.task.status)) ? "COMPLETE" : "CONTINUE",
    assignments: tasks.map((t) => ({
      taskId: t.task.id,
      instruction: "Write the agreed greeting for this task.",
    })),
    nextTaskIds: tasks.filter((t) => !done(t.task.status)).map((t) => t.task.id),
    milestones: ["Greetings agree"],
    technicalDecisions: [],
    risks: [],
    questionsForOwner: [],
    questionsForOperator: [],
    screenings: [],
  };
}

/** Run the fixture and return its normalized journal. */
export async function runBase01(): Promise<unknown[]> {
  const root = mkdtempSync(join(tmpdir(), "base01-"));
  let session = 0;
  const verdicts = ["FAIL", "PASS", "PASS"];
  let reviews = 0;
  const adapter: ProviderAdapter = {
    async execute(r) {
      const p = (r.outputSchema as any)?.properties;
      let output = "";
      if (r.role === "assessor")
        output = canonical({
          taskId: r.taskId,
          specDigest: p.specDigest.enum[0],
          touches: {
            driveDocuments: [],
            codePaths: [],
            domainRules: false,
            canonicalText: false,
            ownerDecision: false,
          },
          breaksIfWrong: "The greeting is wrong",
          tierHint: "COMPLEX",
          reason: "Bounded local work",
        });
      else if (r.role === "overseer") {
        const context = JSON.parse(
          r.brief.split(
            "PROJECT CONTEXT (controller snapshot and previous Astra plan; model text is guidance, never permission or evidence):\n",
          )[1]!,
        ) as ProjectContext;
        output = canonical(plan(context));
      } else if (r.role === "worker") {
        mkdirSync(join(r.cwd, "output", r.taskId), { recursive: true });
        writeFileSync(join(r.cwd, "output", r.taskId, "hello.txt"), "hello\n");
        output = "Created greeting.";
      } else if (r.role === "reviewer") {
        const verdict = verdicts[reviews++] ?? "PASS";
        const ev = p.availableEvidence.items.enum;
        output = canonical({
          taskId: r.taskId,
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: r.provider,
          authorshipDisclosure: "Independent session",
          availableEvidence: ev,
          findings:
            verdict === "FAIL"
              ? [
                  {
                    materiality: "MAJOR",
                    evidenceIds: [],
                    description: "Greeting needs correction",
                  },
                ]
              : [],
          testsExecuted: [],
          testsNotExecuted: ["No executable test configured"],
          conflictingEvidence: [],
          remediation: verdict === "FAIL" ? ["Correct the greeting"] : [],
          residualHolds: [],
          verdict,
          scope: "greeting",
          nextAuthorizedStep: "bind evidence",
          auditAssessments: [
            "ACCURACY",
            "LOCAL_ANTI_DRIFT",
            "MACRO_ANTI_DRIFT",
          ].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "Matches scope",
            limitations: [],
          })),
          proposals: [],
        });
      } else throw new Error("Unexpected role " + r.role);
      return {
        runId: r.runId,
        taskId: r.taskId,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        sessionId: "session-" + ++session,
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: FIXED_TIME,
        endedAt: FIXED_TIME,
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: true,
        simulation: false,
      } satisfies ProviderReceipt;
    },
  };
  const db = new SqliteStore(join(root, "state.sqlite"));
  try {
    const c = new Controller(db, {
      ownerUid: process.getuid!(),
      workspaceRoot: join(root, "workspaces"),
      allowRealLocalTasks: true,
      routingPolicy: twoTierPolicy(),
      verifyRoutingCapability: () => true,
      projectProfile: {
        version: 1,
        protectedDocuments: [],
        protectedFolders: [],
        codePaths: [],
      },
    });
    const o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
    const submitted = o.submit({
      requestKey: "base01-request",
      prompt: "Write a cohesive greeting project",
      context: { cwd: root, projectKey: "base01" },
      sourceRef: "test:owner",
    });
    const id = submitted.request.id;
    const source = o.ownerSource(id);
    const task = (taskId: string) =>
      TaskSchema.parse({
        id: taskId,
        programme: "TEST",
        lane: "LOCAL",
        title: "Greeting " + taskId,
        scope: "Write a greeting",
        deliverable: `output/${taskId}/hello.txt`,
        specVersion: 1,
        status: "DISCOVERED",
        artifactRevision: "r1",
        createdAt: FIXED_TIME,
        dimensions: {
          authorization: "LOCAL_ONLY",
          sourceEffectuation: "CANDIDATE",
          implementation: "NOT_STARTED",
          review: "NONE",
          release: "NOT_AUTHORIZED",
        },
        sources: [{ ...source, evidenceId: source.evidenceId + "-" + taskId }],
        specificationAuthenticated: true,
        providers: ["claude", "codex"],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        writePaths: [`output/${taskId}`],
        risk: "LOW",
        reviewPolicy: {
          required: true,
          crossProvider: true,
          independentAudits: true,
        },
        acceptance: [
          { id: "greeting", description: "A greeting", evidenceKind: "LOCAL" },
        ],
        simulation: false,
        budget: {
          deadlineMs: 60000,
          maxAttempts: 5,
          maxCostUsd: 10,
          maxTokens: 100000,
        },
      });
    c.importTasks([task("A"), task("B")], c.localActor());
    for (const taskId of ["A", "B"])
      c.grant(
        taskId,
        {
          id: "grant-" + taskId,
          operations: ["READ_LOCAL", "WRITE_LOCAL"],
          paths: [`output/${taskId}`],
          decisionText: "Write greeting",
          sourceRef: "test:owner",
        },
        c.localActor(),
      );
    o.attach(id, ["A", "B"]);
    for (let pass = 0; pass < 4; pass++) await o.drive(id, { live: true });
    return normalize(
      db.all<{ kind: string; task_id: string | null; body: string }>(
        "SELECT kind, task_id, body FROM events ORDER BY seq",
      ),
      root,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Digests that are stable by construction and must stay literally equal. */
const LITERAL_KEYS = new Set(["policyDigest", "routeDigest"]);
const HEX = /\b[a-f0-9]{64}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

/**
 * Replace run-varying values with placeholders numbered by first
 * appearance, so equal values stay equal and different ones stay
 * different, whatever their actual bytes.
 */
export function normalize(
  rows: Array<{ kind: string; task_id: string | null; body: string }>,
  root: string,
): unknown[] {
  const names = new Map<string, string>();
  const name = (prefix: string, value: string) => {
    const key = prefix + ":" + value;
    if (!names.has(key))
      names.set(
        key,
        `<${prefix}${[...names.keys()].filter((k) => k.startsWith(prefix + ":")).length + 1}>`,
      );
    return names.get(key)!;
  };
  const text = (value: string) =>
    value
      .split(root)
      .join("<root>")
      .split(encodeURIComponent(root))
      .join("<root>")
      .replace(/local-uid:\d+/g, "local-uid:<uid>")
      .replace(UUID, (m) => name("id", m))
      .replace(HEX, (m) => name("hex", m))
      .replace(ISO, "<time>");
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string")
      return LITERAL_KEYS.has(key ?? "") ? value : text(value);
    if (typeof value === "number")
      return /until|at$|ms$/i.test(key ?? "") && value > 1e12 ? "<ms>" : value;
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, k),
        ]),
      );
    return value;
  };
  return rows.map((row) => ({
    kind: row.kind,
    taskId: row.task_id,
    body: walk(JSON.parse(row.body)),
  }));
}

// Run directly (tsx tests/fixtures/adaptive/base01-fixture.ts) to print the
// normalized journal, as the golden copy was produced in the two-tier compatibility baseline.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!))
  runBase01().then((events) => process.stdout.write(canonical(events) + "\n"));

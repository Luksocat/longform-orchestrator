#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openReadOnlyRuntime,
  openRuntime,
  seedSnapshot,
  defaultSnapshot,
  defaultLiveConfigPath,
} from "./runtime.js";
import { limitEnded } from "./controller.js";
import { scanProviderLimitsAt } from "./limit-scan.js";
import { driveRequests, hostQuiescence } from "./driver.js";
import { ProgressLog } from "./progress-log.js";
import {
  acquireLiveHostLock,
  codexRecoveryPending,
  resolveHost,
  BubblewrapRunner,
  liveDoctor,
  liveProvider,
  readAttestations,
  refreshAttestations,
  recheckProviders,
} from "./live.js";
import { z } from "zod";
import { ReviewSchema, reviewPayload, specDigest, TaskSchema } from "./domain.js";
import { Orchestrator } from "./orchestrator.js";
import { HintLevel, isFableModel } from "./routing.js";
import {
  MockProvider,
  probeCli,
  probeIsolation,
  probeAuthentication,
  redact,
} from "./providers.js";
import {
  DriveReadOnlyAdapter,
  GitHubReadOnlyAdapter,
  importLocalEvidence,
  EvidenceEnvelopeSchema,
} from "./evidence.js";
import { deterministicAdvice } from "./reasoning.js";
import { GitHubGhReadOnlyAdapter } from "./github-cli.js";
import { checkFilingPlan, fileToDrive, FilingPlanSchema } from "./filing.js";
import {
  buildBundle,
  EvaluationPlanSchema,
  freezePlan,
  frozenPlans,
  importedEvidence,
  importEvidence,
  initEvaluationJournal,
  recordCaseFixture,
} from "./evaluation.js";

const help = `LONGFORM_ORCHESTRATOR_v0.1 — local controller (scoped Drive writes; Git and production mutations disabled)
Usage: longform-orchestrator COMMAND [TASK_ID] [options]
Commands: orchestrate init status next plan route dispatch inspect reviews decisions resume audit report doctor attest export-patch brief-preview
Operator: grant decision revoke bind verify accept revise evidence cancel reconcile reconcile-helper advice drift-ack drive-evidence resolve-hold budget-extend assessment provider-pause retry-extend provider-limits claims claims-reconcile
assessment TASK --file {action:PROCEED|AGAIN,text,sourceRef}  the owner's word on a task held for want of a difficulty assessment: PROCEED on the stakes rules alone, or let every assessor run AGAIN; without --execute, shows the hold
drift-ack TASK --run-id ID --file {reason,sourceRef}  record that other tasks changed without affecting this worker's run
drive-file TASK --file {create:[{folderId,name,path,doc?}],update:[{fileId,path}],reason,sourceRef}  file exact local bytes to Drive within the task's granted Drive scope, through the gateway, and read them back; no model runs
export-patch TASK [--out FILE]  the current sealed work's changes against its task's pinned commit, as a unified diff (apply on a branch with git apply); read-only
brief-preview [TASK] --request-id R [--file TASK.json]  each role's complete brief size for the task (or the candidate record in --file, as it would be once registered or revised) in R's project; read-only, records nothing
drive-evidence TASK [--run-id RUN]  record a worker run's Drive gateway log as DRIVE evidence (then bind it); default the current worker, or an earlier run of the same spec whose record the current work still carries (e.g. before a proposal reply)
resolve-hold TASK --run-id REVIEW_RUN --file {hold,resolution,evidence,sourceRef}  record a verified review residual hold
budget-extend TASK --file {maxCostUsd?,maxTokens?,maxAttempts?,reason,sourceRef}  raise a task's caps without changing its spec
provider-pause [--provider P] [--clear --file {reason,evidence:[...],sourceRef} | --recheck]  show providers paused for their usage limit; --clear records the operator's evidence that the limit is lifted; --recheck (live) makes one test call, also when held
retry-extend TASK --file {step,reason,sourceRef}  the owner's word that a step the provider's limit cut off three times may run three more times; changes no spec or budget
provider-limits --scan  read-only: earlier receipts whose harness output shows a provider limit, for the owner to consider; changes nothing
claims  read-only: every write claim and Drive write intent still held (who holds what)
reconcile-helper --run-id RUN  read-only: a draft reconciliation for an unknown run from its records, with what you must check yourself (process, Drive effects, usage); it asserts nothing
orchestrate --drive --live|--mock [--request-id R] [--max-minutes N] [--log-file PATH] --execute  the built-in driver: advances this host's requests (or R) until nothing more can run, waiting for known resets; returns what each waits for. Appends progress lines to driver.log beside the database (or PATH) for the owner to watch
orchestrate --request-id R --pause|--resume --file {text,sourceRef} --execute  the owner's pause: a run already going finishes; nothing new starts until resumed
orchestrate --request-id R --compact  status, progress, open questions, explained holds, pauses, active runs and next actions
claims-reconcile (--intent ID | --filing ID) --file {evidenceId}  resolve an uncertain Drive write, or a filing that stopped holding its claims, from an envelope bound to it (metadata.intentId or filingId and metadata.claimsReconciliation {operationStopped,effectsSettled,remoteChecked:[{what,at}],effects,fileId?,assessment}) whose checks come at least ten minutes after the last send and the stop
--db PATH                 SQLite state (default .longform/state.sqlite)
--fixture PATH            init snapshot JSON
--execute                 required for state-changing commands; otherwise dry-run
--mock                    dispatch or advance synthetic tasks only
--routing-policy PATH     trusted versioned complexity/model policy (default synthetic)
--provider --model --effort  supply all three to explicitly override automatic routing
--override-reason TEXT    recorded explanation for an explicit selection
--request-key KEY         unique idempotency key; never reused
--review                  dispatch isolated mock reviewer
--file PATH               schema-validated operator JSON / review report / envelope
--envelope                evidence: explicitly import a local UNVERIFIED envelope
--run-id ID               selected attempt for audit, cancellation or reconciliation
--criterion ID --evidence-id ID  owner/operator evidence binding
--live-read               doctor reads only explicitly selected connector targets
--drive-file-id ID         doctor: Drive file to read (requires --live-read)
--github-repository OWNER/NAME  doctor: repository to read (requires --live-read)
--github-branch NAME       doctor: optional branch of --github-repository
--prompt-file PATH        orchestrate: literal UTF-8 task request (never shell-evaluated)
--request-id ID           inspect/resume one durable orchestration request
--project-full            orchestrate: print the whole project record instead of its summary
--task ID                 bind an existing task to a request (repeatable)
--rebind ID               explicitly bind a revised task's new specification (repeatable)
--context-cwd PATH        request working directory, recorded as context only
--project-key KEY         explicitly share durable Astra context across related requests
--source-ref TEXT         conversation/evidence reference; local UID authenticates caller
--advance                 drive already-authorized tasks (with --mock or --live)
--live                    with --advance: run real tasks through the isolated live runner
--live-config PATH        trusted live runner config (default: live-config.json beside --db)
--host claude|codex|operator  invoking host CLI (bridge supplies it; else detected from env).
                          Hosts never change or drive each other's requests or runs, and a
                          live run refuses to start while the other host has one active
attest --execute          re-attest live routes through the isolated runner (one tiny call each)
--question-file PATH      record a question {key,text,kind?,audience?:OWNER|OPERATOR,taskId?|taskIds?|projectWide:true}; it must name its tasks or say projectWide
--answer-file PATH        reply {questionId,replyKey,text,sourceRef,answeredAs?,evidence?,historicalOnly?}; historicalOnly:true requires an explicit answeredAs (OWNER for an owner question) and a superseded task spec, answers only the old question for the revised tasks and grants no current-spec authority
--defer-question-file PATH  owner-directed optional information deferral {questionId,questionText,ownerInstruction,reason,sourceRef}; never a grant or substitute for a decision
register --file PATH      import validated task array; no grants/acceptance imported
adaptive freeze-plan --file PLAN.json --execute  the owner freezes an evaluation plan (classes, ordered case pools, finalists, thresholds, stages) before any result exists; issue #12
adaptive harness-init --file PLAN.json --journal NEW.sqlite --execute  start an isolated evaluation journal bound to that plan; runs no provider
adaptive record-fixture --db JOURNAL.sqlite --file {caseId,classKey,arrangementId,taskIds,requestIds,scriptedAnswers?} --execute  record a case execution's normalized fixture before its runs
adaptive build-bundle --journal JOURNAL.sqlite --file {planId,results,limitations?} [--out FILE]  read-only: a bundle of graded results with the journal's runs and receipt digests
adaptive import-evidence --file BUNDLE.json [--journal JOURNAL.sqlite] --execute  the owner imports graded evidence; it is checked against the journal and recorded with a decision per class and arrangement (synthetic without a journal)
adaptive evidence  read-only: frozen plans and imported evidence with their decisions
adaptive scorecard --task TASK | --request-id REQUEST  read-only: a task's worker, reviewer and overseer with why, independence, owner choice, holds, evidence, floors, ceiling and lineage; or a project's checkpoint demand and overseers
adaptive rollback-check  read-only: pins, checkpoint pins and in-flight adaptive runs, and whether a binary rollback is safe
adaptive prefer --task TASK --mode AUTO|GUIDED|PINNED [--worker ROUTE --reviewer ROUTE] --reason TEXT --execute (or --file {mode, workerRouteId?, reviewerRouteId?, reason})  the owner's routing preference for the task's current specification; PINNED names a worker route, waives no requirement and never rewrites a pin
The bundled example programme is held. Mock acceptance never advances real work.
`;
/**
 * What a bound real task still needs a model for, judged on its current
 * specification: a revised task needs a fresh worker, review and (when marked)
 * advice even if an earlier revision already had them. A review's proposals
 * need the worker's reply and its review, and may need the moderator.
 */
/**
 * The tiers to attest for a reviewer at the routed tier: that tier, plus every
 * tier a pending difficulty assessment could move it to, so the first advance
 * does not stall on an unattested route the assessment then selects. Workers
 * use Controller.reachableWorkerTiers, which adds escalation.
 */
export function attestTiers(
  routed: string,
  reachableAfterAssessment: readonly string[],
): string[] {
  return [...new Set([routed, ...reachableAfterAssessment])];
}
export function preflightNeeds(
  t: { status: string; advice?: unknown; simulation?: boolean },
  inspected: {
    specDigest: string;
    attempts: { role: string; state: string; specDigest: string }[];
    reviews: { specDigest?: string }[];
    proposalRound?: {
      stage: string;
      reply?: { state?: string; reviewed?: boolean };
    } | null;
    /** A failed review the next worker run answers in place. */
    rework?: unknown;
    /** Failed checks the next worker run answers in place. */
    checkRework?: unknown;
    /** Whether the current sealed work has a recorded review (null: no work). */
    artifactReviewed?: boolean | null;
    /**
     * Whether some provider's assessor may still run for the current
     * specification (the controller's view); without it, the attempts decide.
     */
    assessmentPending?: boolean;
  },
) {
  const spec = inspected.specDigest,
    current = inspected.attempts.filter((a) => a.specDigest === spec),
    finished = ["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"].includes(
      t.status,
    );
  const round = inspected.proposalRound,
    firstReview = !inspected.reviews.some((r) => r.specDigest === spec),
    rework = !!inspected.rework || !!inspected.checkRework,
    // Finished work (a rework, say) that no review has judged yet.
    unreviewed =
      inspected.artifactReviewed === false &&
      current.some((a) => a.role === "worker" && a.state === "SUCCEEDED");
  // One advance can run a first review, the worker's reply to its proposals
  // and the reply's review, so each needs its route attested up front. So
  // can a rework after a failed review and the rework's own review.
  const replyPending = ["AWAITING_REPLY", "REPLY_RUNNING"].includes(
    round?.stage ?? "",
  );
  const needsWorker =
    !finished &&
    (!current.some((a) => a.role === "worker" && a.state === "SUCCEEDED") ||
      firstReview ||
      rework ||
      round?.stage === "AWAITING_REPLY");
  const needsReviewer =
    !finished &&
    (firstReview ||
      replyPending ||
      rework ||
      unreviewed ||
      (round?.reply?.state === "SUCCEEDED" && !round.reply.reviewed));
  // A first review may open a round whose moderator runs in the same advance.
  const needsModerator =
    !finished &&
    (firstReview || replyPending || round?.stage === "AWAITING_MODERATOR");
  const needsAdvice =
    !!t.advice &&
    needsWorker &&
    !current.some(
      (a) =>
        a.role === "worker" ||
        (a.role === "advisor" &&
          a.state !== "NOT_STARTED" &&
          !limitEnded(a)),
    );
  // A real task's first worker run is preceded by a difficulty assessment.
  const needsAssessment =
    !t.simulation &&
    needsWorker &&
    (inspected.assessmentPending ??
      !current.some(
        (a) =>
          a.role === "worker" ||
          (a.role === "assessor" &&
          a.state !== "NOT_STARTED" &&
          !limitEnded(a)),
      ));
  return {
    needsWorker,
    needsReviewer,
    needsAdvice,
    needsModerator,
    needsAssessment,
  };
}
const required = (v: string | undefined, name: string) => {
  if (!v) throw new Error("MISSING_OPTION:" + name);
  return v;
};
const executable = (name: string) =>
  (process.env.PATH ?? "/usr/bin:/bin")
    .split(":")
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path)) ?? "/unavailable/" + name;
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      fixture: { type: "string" },
      execute: { type: "boolean" },
      mock: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "routing-policy": { type: "string" },
      "override-reason": { type: "string" },
      "request-key": { type: "string" },
      review: { type: "boolean" },
      file: { type: "string" },
      envelope: { type: "boolean" },
      "run-id": { type: "string" },
      out: { type: "string" },
      criterion: { type: "string" },
      "evidence-id": { type: "string" },
      "live-read": { type: "boolean" },
      "drive-file-id": { type: "string" },
      "github-repository": { type: "string" },
      "github-branch": { type: "string" },
      "prompt-file": { type: "string" },
      "request-id": { type: "string" },
      task: { type: "string", multiple: true },
      rebind: { type: "string", multiple: true },
      "context-cwd": { type: "string" },
      "project-key": { type: "string" },
      "source-ref": { type: "string" },
      advance: { type: "boolean" },
      live: { type: "boolean" },
      "live-config": { type: "string" },
      host: { type: "string" },
      "question-file": { type: "string" },
      "answer-file": { type: "string" },
      "defer-question-file": { type: "string" },
      "project-full": { type: "boolean" },
      clear: { type: "boolean" },
      drive: { type: "boolean" },
      pause: { type: "boolean" },
      resume: { type: "boolean" },
      compact: { type: "boolean" },
      "max-minutes": { type: "string" },
      "log-file": { type: "string" },
      intent: { type: "string" },
      filing: { type: "string" },
      recheck: { type: "boolean" },
      scan: { type: "boolean" },
      help: { type: "boolean" },
      journal: { type: "string" },
      // adaptive prefer (issue #12, contract section 9).
      mode: { type: "string" },
      worker: { type: "string" },
      reviewer: { type: "string" },
      reason: { type: "string" },
    },
  });
  const command = p[0] ?? "help",
    id = p[1];
  if (command === "help" || v.help) {
    process.stdout.write(help);
    return;
  }
  if (command === "doctor") {
    const driveId = v["drive-file-id"],
      repository = v["github-repository"],
      branch = v["github-branch"];
    if (!v["live-read"] && (driveId || repository || branch))
      throw new Error("DOCTOR_TARGET_REQUIRES_LIVE_READ");
    if (v["live-read"] && !driveId && !repository)
      throw new Error(
        "DOCTOR_TARGET_REQUIRED: supply --drive-file-id or --github-repository",
      );
    // Validate the whole selection before opening state or probing any service.
    if (driveId && !/^[A-Za-z0-9_-]{10,128}$/.test(driveId))
      throw new Error("INVALID_DRIVE_FILE_ID");
    if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("INVALID_GITHUB_REPOSITORY");
    if (branch && !repository)
      throw new Error("GITHUB_BRANCH_REQUIRES_REPOSITORY");
    if (
      branch &&
      (branch.length > 200 ||
        branch.includes("..") ||
        /[?#\\{}\x00-\x20]/.test(branch))
    )
      throw new Error("INVALID_GITHUB_BRANCH");
  }
  const path = resolve(v.db ?? ".longform/state.sqlite");
  // Read-only end to end: the database opened read-only, nothing set up.
  if (command === "provider-limits") {
    if (!v.scan) throw new Error("PROVIDER_LIMITS_REQUIRES_--scan");
    process.stdout.write(
      JSON.stringify({ readOnly: true, found: scanProviderLimitsAt(path) }, null, 2) + "\n",
    );
    return;
  }
  const liveConfigPath =
    v["live-config"] ??
    (existsSync(defaultLiveConfigPath(path))
      ? defaultLiveConfigPath(path)
      : undefined);
  // Read-only end to end too (issue #12 review E5 V1): the adaptive
  // scorecards and rollback check open the database read-only.
  if (command === "adaptive" && (id === "scorecard" || id === "rollback-check")) {
    const ro = openReadOnlyRuntime(path, { routingPolicyPath: v["routing-policy"], liveConfigPath });
    try {
      let card: unknown;
      if (id === "rollback-check") card = ro.c.adaptiveRollbackCheck();
      else if (v["request-id"]) card = ro.c.checkpointScorecard(v["request-id"]);
      else if (v.task?.length === 1) card = ro.c.adaptiveScorecard(v.task[0]!);
      else throw new Error("ADAPTIVE_SCORECARD_NEEDS_ONE_TASK_OR_REQUEST");
      process.stdout.write(JSON.stringify(card, null, 2) + "\n");
    } finally {
      ro.db.close();
    }
    return;
  }
  const { db, c, actor, live, workspaceRoot } = openRuntime(path, {
    routingPolicyPath: v["routing-policy"],
    liveConfigPath,
  });
  const liveRuntime = live;
  const liveAdapters = () => {
    if (!live)
      throw new Error("LIVE_CONFIG_REQUIRED: " + defaultLiveConfigPath(path));
    const runner = new BubblewrapRunner(live);
    return Object.fromEntries(
      (["claude", "codex"] as const)
        .filter((p) => live.providers[p])
        .map((p) => [p, liveProvider(live, p, workspaceRoot, runner)]),
    );
  };
  const readJson = () =>
    JSON.parse(readFileSync(required(v.file, "--file"), "utf8"));
  const task = () => required(id, "TASK_ID");
  const host = resolveHost(v.host);
  let releaseLive: (() => void) | undefined;
  /** The orchestrator whose live runs this process launched, if any. */
  let liveWorkflow: Orchestrator | undefined;
  let result: unknown;
  try {
    // Task-level owner/operator commands respect the host that owns the task's
    // request, like request and run commands do.
    if (
      v.execute &&
      id &&
      [
        "grant",
        "revoke",
        "revise",
        "drift-ack",
        "drive-evidence",
        "drive-file",
        "resolve-hold",
        "budget-extend",
        "retry-extend",
        "assessment",
        "bind",
        "verify",
        "accept",
        "decision",
        "evidence",
        "audit",
        "dispatch",
      ].includes(command)
    )
      new Orchestrator(c, {}, host).assertTaskHost(id);
    switch (command) {
      case "orchestrate": {
        if (
          v.provider ||
          v.model ||
          v.effort ||
          v.review ||
          v["override-reason"]
        )
          throw new Error(
            "ORCHESTRATE_USES_AUTOMATIC_ROUTING_USE_DISPATCH_FOR_EXPLICIT_OVERRIDE",
          );
        if (v.live && v.mock)
          throw new Error("DRIVE_MODE_AMBIGUOUS_MOCK_AND_LIVE");
        // Reject an ambiguous disposition *before* the drive, pause, or
        // compact early returns. Otherwise the CLI could launch work while
        // silently ignoring the owner's deferral file (review P2).
        if (
          v["defer-question-file"] &&
          (v.drive ||
            v.pause ||
            v.resume ||
            v.compact ||
            v.advance ||
            !!v.task?.length ||
            !!v.rebind?.length ||
            !!v["question-file"] ||
            !!v["answer-file"] ||
            !!v["prompt-file"] ||
            p.length > 1)
        )
          throw new Error("QUESTION_DEFERRAL_MUST_BE_SEPARATE_ACTION");
        if (v.live && !v.advance && !v.drive)
          throw new Error("LIVE_REQUIRES_ADVANCE");
        let attestations: unknown;
        if (v.live && v.execute) {
          if (!live)
            throw new Error(
              "LIVE_CONFIG_REQUIRED: " + defaultLiveConfigPath(path),
            );
          // Refuse another host's request before spending any provider calls.
          if (v["request-id"])
            new Orchestrator(c, {}, host).assertHost(v["request-id"]);
          releaseLive = acquireLiveHostLock(live, host);
          // Attest only the (role, tier) pairs a real task still needs a model for
          // on its current specification (see preflightNeeds). Verification-only
          // passes make no provider calls.
          const bound = v["request-id"]
            ? new Orchestrator(c, {}, host)
                .inspect(v["request-id"])
                .tasks.filter((t) => !t.simulation)
                .map((t) => c.task(t.taskId))
            : [];
          const levels = new Set<string>();
          // Providers of tasks that still need a model run; finished work does
          // not gate (or attest for) anything.
          const providers = new Set<string>();
          // Providers whose advisor routes a marked task may still consult.
          const advisorProviders = new Set<string>();
          // Providers whose moderator routes a proposal round may still use.
          const moderatorProviders = new Set<string>();
          // Providers whose assessor routes a task's first run may still use.
          const assessorProviders = new Set<string>();
          // Whether a task Claude already worked on still needs a run, and so
          // the legacy-pairing routes (Claude works, Sol reviews).
          let legacyPairing = false;
          for (const t of bound) {
            const {
              needsWorker,
              needsReviewer,
              needsAdvice,
              needsModerator,
              needsAssessment,
            } = preflightNeeds(t, c.inspect(t.id));
            // The controller's route includes any escalation after failed reviews.
            // Every tier the next worker run could reach in this advance: a
            // review recorded here may send a reply or rework up a tier.
            if (needsWorker || needsReviewer)
              for (const level of c.reachableWorkerTiers(t.id, {
                assessmentPending: needsAssessment,
                reviewPending: needsReviewer,
              }))
                levels.add(level);
            if (needsReviewer)
              for (const level of attestTiers(
                c.route(t.id, "reviewer").assessment.level,
                needsAssessment ? HintLevel.options : [],
              ))
                levels.add(level);
            if (needsWorker || needsReviewer)
              for (const provider of t.providers) providers.add(provider);
            if ((needsWorker || needsReviewer) && c.legacyClaudeAuthorship(t))
              legacyPairing = true;
            if (needsAdvice)
              for (const provider of t.providers)
                advisorProviders.add(provider);
            if (needsModerator)
              for (const provider of t.providers)
                moderatorProviders.add(provider);
            if (needsAssessment)
              for (const provider of t.providers)
                assessorProviders.add(provider);
          }
          // Refuse before reserving anything: a pending Codex login recovery
          // would otherwise turn each queued Codex run into a refused attempt.
          const recovery = providers.has("codex")
            ? codexRecoveryPending(live)
            : undefined;
          if (recovery)
            throw new Error("CODEX_CREDENTIAL_RECOVERY_PENDING: " + recovery);
          // A provider whose usage-limit pause has run out is tested by one
          // probe before any task run uses it .
          const rechecked = (["codex", "claude"] as const).filter(
            (p) => c.providerPause(p).state === "RECHECK",
          );
          if (rechecked.length)
            await recheckProviders(
              live,
              workspaceRoot,
              c.probeGate(actor),
              rechecked,
            );
          attestations = await refreshAttestations(
            live,
            workspaceRoot,
            (route) =>
              // Fable is never attested for adaptive use (issue #12).
              !(c.adaptive() && isFableModel(route.model)) &&
              ((levels.has(route.level) &&
                providers.has(route.provider) &&
                (!route.legacyPairing || legacyPairing) &&
                route.roles.some(
                  (role) => role === "worker" || role === "reviewer",
                )) ||
              (route.roles.includes("advisor") &&
                advisorProviders.has(route.provider)) ||
              (route.roles.includes("moderator") &&
                moderatorProviders.has(route.provider)) ||
              (route.roles.includes("assessor") &&
                assessorProviders.has(route.provider)) ||
              (c.projectGoverned() && route.roles.includes("overseer"))),
            c.probeGate(actor),
          );
        }
        // A route whose proof aged out is re-attested just before the run that
        // needs it, where preflight could not foresee the need.
        const workflow = new Orchestrator(
          c,
          live ? liveAdapters() : {},
          host,
          live
            ? {
                attest: async (routeId: string) => {
                  await refreshAttestations(
                    live,
                    workspaceRoot,
                    (route) => route.id === routeId,
                    c.probeGate(actor),
                  );
                },
              }
            : {},
        );
        if (live && v.execute) liveWorkflow = workflow;
        // The built-in driver (S5): serves this host's requests through the
        // normal advance until nothing more can run, within its time budget.
        if (v.drive) {
          if (!v.live === !v.mock)
            throw new Error("DRIVE_MODE_REQUIRED_ONE_OF_--live_--mock");
          if (
            v["max-minutes"] !== undefined &&
            !/^[1-9][0-9]{0,2}$/.test(v["max-minutes"])
          )
            throw new Error("MAX_MINUTES_INVALID: a whole number from 1 to 600");
          // Progress lines for the owner to watch (tail -f), beside the
          // database unless --log-file says otherwise; nothing reads them.
          const logFile = resolve(
            v["log-file"] ?? join(dirname(path), "driver.log"),
          );
          const progress = ProgressLog.toFile(logFile);
          result = v.execute
            ? {
                ...(await driveRequests(workflow, {
                  live: !!v.live,
                  mock: !!v.mock,
                  ...(v["request-id"] ? { requestIds: [v["request-id"]] } : {}),
                  ...(v["max-minutes"] !== undefined
                    ? { maxMinutes: Number(v["max-minutes"]) }
                    : {}),
                  // The watchdog's notices as they happen: an expired lease,
                  // the stop asked of its run and what that established, even
                  // while the advance has not ended and the host lock is held.
                  // The driver puts them in the progress log too.
                  notify: (message: string) =>
                    process.stderr.write("ORCHESTRATOR WATCHDOG: " + message + "\n"),
                  progress,
                })),
                logFile,
                ...(progress.failure ? { logError: progress.failure } : {}),
              }
            : {
                dryRun: true,
                action: "drive",
                logFile,
                serves: v["request-id"]
                  ? [v["request-id"]]
                  : workflow
                      .requests()
                      .filter((r) => r.host === host)
                      .map((r) => r.id),
              };
          break;
        }
        // The owner's pause of a request, and its resumption (S5).
        if (v.pause || v.resume) {
          if (v.pause && v.resume)
            throw new Error("ORCHESTRATE_ONE_OF_--pause_--resume");
          const id = required(v["request-id"], "--request-id");
          result = v.execute
            ? workflow.pauseRequest(id, readJson(), !!v.resume)
            : { dryRun: true, action: v.pause ? "pause" : "resume", requestId: id };
          break;
        }
        if (v.compact) {
          result = workflow.compact(required(v["request-id"], "--request-id"));
          break;
        }
        const requestId = v["request-id"];
        const suppliedPrompt = v["prompt-file"] !== undefined || p.length > 1;
        if (v["prompt-file"] && p.length > 1)
          throw new Error("ORCHESTRATE_AMBIGUOUS_PROMPT");
        if (requestId && suppliedPrompt)
          throw new Error("ORCHESTRATE_RESUME_DOES_NOT_REPLACE_PROMPT");
        const questionActions = [
          v["question-file"],
          v["answer-file"],
          v["defer-question-file"],
        ].filter(Boolean);
        if (questionActions.length > 1)
          throw new Error("ORCHESTRATE_ONE_QUESTION_ACTION_PER_CALL");
        if (suppliedPrompt && questionActions.length)
          throw new Error("ORCHESTRATE_QUESTION_REQUIRES_EXISTING_REQUEST");
        if (v["defer-question-file"] && (v.rebind?.length || v.advance || v.task?.length))
          throw new Error("QUESTION_DEFERRAL_MUST_BE_SEPARATE_ACTION");
        if (suppliedPrompt && v.rebind?.length)
          throw new Error("ORCHESTRATE_REBIND_REQUIRES_EXISTING_REQUEST");
        const mutates =
          suppliedPrompt ||
          !!v.task?.length ||
          !!v.rebind?.length ||
          !!v.advance ||
          !!v["question-file"] ||
          !!v["answer-file"] ||
          !!v["defer-question-file"];
        if (!v.execute && mutates) {
          result = {
            dryRun: true,
            action: "orchestrate",
            requestId: requestId ?? null,
            taskIds: v.task ?? [],
            rebind: v.rebind ?? [],
            advance: !!v.advance,
            liveExecutionHeld: true,
            nextStep:
              "Use --execute to persist the request; execution still requires controller authorization",
            // What each rebound task's runs would be given, all rebound together.
            ...(requestId && v.rebind?.length
              ? {
                  briefPreview: workflow.previewBatch(requestId, {
                    taskIds: v.rebind,
                  }),
                }
              : {}),
          };
          break;
        }
        let view;
        if (suppliedPrompt) {
          view = workflow.submit({
            requestKey: required(v["request-key"], "--request-key"),
            prompt: v["prompt-file"]
              ? readFileSync(v["prompt-file"], "utf8")
              : p.slice(1).join(" "),
            context: {
              cwd: resolve(v["context-cwd"] ?? process.cwd()),
              ...(v["project-key"] ? { projectKey: v["project-key"] } : {}),
            },
            sourceRef: required(v["source-ref"], "--source-ref"),
            taskIds: v.task,
          });
        } else if (requestId) {
          view = v.task?.length
            ? workflow.attach(requestId, v.task)
            : workflow.inspect(requestId);
          if (v.rebind?.length) view = workflow.rebind(requestId, v.rebind);
        } else if (!mutates) {
          result = workflow.list();
          break;
        } else throw new Error("MISSING_OPTION:--request-id");
        const selectedId = view.request.id;
        if (v["question-file"])
          workflow.ask(
            selectedId,
            JSON.parse(readFileSync(v["question-file"], "utf8")),
          );
        if (v["answer-file"])
          view = workflow.reply(
            selectedId,
            JSON.parse(readFileSync(v["answer-file"], "utf8")),
          );
        if (v["defer-question-file"])
          view = workflow.deferQuestion(
            selectedId,
            JSON.parse(readFileSync(v["defer-question-file"], "utf8")),
          );
        if (v.advance)
          view = await workflow.drive(
            selectedId,
            v.live ? { live: true } : { mock: !!v.mock },
          );
        result = {
          ...workflow.inspect(selectedId),
          ...(v["project-full"] && workflow.controller.projectGoverned()
            ? { project: workflow.project(selectedId) }
            : {}),
          ownerSource: workflow.ownerSource(selectedId),
          ...(attestations ? { attestations } : {}),
        };
        break;
      }
      case "attest": {
        if (!live)
          throw new Error(
            "LIVE_CONFIG_REQUIRED: " + defaultLiveConfigPath(path),
          );
        if (v.execute) releaseLive = acquireLiveHostLock(live, host);
        result = v.execute
          ? {
              refreshed: await refreshAttestations(
                live,
                workspaceRoot,
                undefined,
                c.probeGate(actor),
              ),
              current: readAttestations(live).map(
                ({ provider, model, effort, verifiedAt }) => ({
                  provider,
                  model,
                  effort,
                  verifiedAt,
                }),
              ),
            }
          : {
              dryRun: true,
              action:
                "one minimal isolated call per enabled live route whose attestation is older than 20 minutes",
              current: readAttestations(live).map(
                ({ provider, model, effort, verifiedAt }) => ({
                  provider,
                  model,
                  effort,
                  verifiedAt,
                }),
              ),
            };
        break;
      }
      case "register": {
        if (!v.execute) {
          result = {
            dryRun: true,
            action: "import task specifications without grants",
            // With --request-id, each task's briefs as they would be once
            // all of them are registered and attached there.
            ...(v["request-id"]
              ? {
                  briefPreview: new Orchestrator(c, {}, host).previewBatch(
                    v["request-id"],
                    {
                      register: z
                        .array(z.unknown())
                        .min(1)
                        .max(256)
                        .parse(readJson()),
                    },
                  ),
                }
              : {}),
          };
          break;
        }
        // The controller parses the records itself, so a real task without a
        // stated risk is refused before the schema can default it.
        const raw = z.array(z.unknown()).min(1).max(256).parse(readJson());
        c.importTasks(raw, actor);
        result = {
          registered: raw.map((t) => TaskSchema.parse(t).id),
          grantsCreated: 0,
          acceptanceAwarded: false,
        };
        break;
      }
      case "init": {
        const actual = v.fixture ?? defaultSnapshot;
        result = v.execute
          ? seedSnapshot(c, actual, actor)
          : {
              dryRun: true,
              action: "import held planning fixtures",
              fixture: actual,
            };
        break;
      }
      case "status":
        result = { ...c.report().programme, externalMutations: "SCOPED_DRIVE_ONLY" };
        break;
      case "next":
      case "plan":
        result = c.plan();
        break;
      case "route":
        result = {
          taskId: task(),
          role: v.review ? "reviewer" : "worker",
          routing: c.route(task(), v.review ? "reviewer" : "worker"),
          taskBlockers: c.reasons(task()),
          routingDoesNotAuthorizeDispatch: true,
        };
        break;
      case "inspect":
        result = c.inspect(task());
        break;
      case "report":
        result = c.report();
        break;
      case "reviews":
        result = c
          .tasks()
          .filter((t) => t.status === "WAITING_REVIEW")
          .map((t) => ({
            taskId: t.id,
            revision: t.artifactRevision,
            policy: t.reviewPolicy,
            // The record's policy raised by the stakes a model found, if any.
            policyInForce: c.reviewPolicyInForce(t.id),
          }));
        break;
      case "decisions":
        result = c
          .tasks()
          .filter(
            (t) =>
              t.status === "WAITING_OWNER" ||
              c.reasons(t.id).includes("OWNER_DECISION_REQUIRED"),
          )
          .map((t) => ({
            taskId: t.id,
            holds: t.blockers,
            revision: t.artifactRevision,
          }));
        break;
      case "dispatch": {
        if (!v.execute) {
          result = { dryRun: true, taskId: id ?? null, plan: c.plan() };
          break;
        }
        if (!v.mock || !c.task(task()).simulation)
          throw new Error("LIVE_DISPATCH_HELD_USE_APPROVED_ISOLATED_RUNNER");
        const provider = v.provider;
        if (
          provider !== undefined &&
          !["codex", "claude", "mock"].includes(provider)
        )
          throw new Error("INVALID_PROVIDER");
        const output =
          v.review && v.file
            ? JSON.stringify(reviewPayload(ReviewSchema.parse(readJson())))
            : undefined;
        if (v.review && !output)
          throw new Error("MOCK_REVIEW_REQUIRES_STRUCTURED_REPORT_FILE");
        const a = c.reserve(
          task(),
          {
            provider: provider as "codex" | "claude" | "mock" | undefined,
            model: v.model,
            effort: v.effort,
            overrideReason: v["override-reason"],
            requestKey: required(v["request-key"], "--request-key"),
            role: v.review ? "reviewer" : "worker",
          },
          actor,
        );
        result = await c.execute(a, new MockProvider({ output }), actor);
        break;
      }
      case "resume":
        result = v.execute
          ? c.recover(actor)
          : {
              dryRun: true,
              action: "recover expired leases; unknown outcomes stay held",
            };
        break;
      case "audit":
        result = v.execute
          ? c.audit(task(), actor, v["run-id"])
          : id
            ? c.inspect(id).audits
            : { dryRun: true, action: "audit requires TASK_ID --execute" };
        break;
      case "grant":
        result = v.execute
          ? c.grant(task(), readJson(), actor)
          : { dryRun: true, action: command };
        break;
      case "decision":
        result = v.execute
          ? c.decide(task(), readJson(), actor)
          : { dryRun: true, action: command };
        break;
      case "revoke": {
        const value = v.execute ? readJson() : null;
        result = v.execute
          ? value.kind === "grant"
            ? c.revokeGrant(value.id, value.reason, actor)
            : value.kind === undefined || value.kind === "decision"
              ? c.revoke(value.id, value.reason, actor)
              : (() => {
                  throw new Error("INVALID_REVOCATION_KIND");
                })()
          : { dryRun: true, action: command };
        break;
      }
      case "bind":
        result = v.execute
          ? c.bindAcceptance(
              task(),
              required(v.criterion, "--criterion"),
              required(v["evidence-id"], "--evidence-id"),
              actor,
            )
          : { dryRun: true, action: command };
        break;
      case "verify":
        result = v.execute
          ? c.verify(task(), actor)
          : { dryRun: true, action: command };
        break;
      case "accept":
        result = v.execute
          ? c.accept(task(), actor)
          : { dryRun: true, action: command };
        break;
      case "budget-extend": {
        const r = v.execute ? readJson() : null;
        result = v.execute
          ? c.extendBudget(
              task(),
              {
                maxCostUsd: r?.maxCostUsd,
                maxTokens: r?.maxTokens,
                maxAttempts: r?.maxAttempts,
                reason: String(r?.reason ?? ""),
                sourceRef: String(r?.sourceRef ?? ""),
              },
              actor,
            )
          : { dryRun: true, action: command };
        break;
      }
      case "provider-pause": {
        const provider = z
          .enum(["codex", "claude"])
          .optional()
          .parse(v.provider);
        if (v.clear) {
          if (!provider) throw new Error("PROVIDER_REQUIRED: --provider");
          result = v.execute
            ? c.clearProviderPause(provider, readJson(), actor)
            : { dryRun: true, action: "clear", pause: c.providerPause(provider) };
        } else if (v.recheck) {
          if (!provider) throw new Error("PROVIDER_REQUIRED: --provider");
          if (!live)
            throw new Error(
              "LIVE_CONFIG_REQUIRED: " + defaultLiveConfigPath(path),
            );
          if (v.execute) releaseLive = acquireLiveHostLock(live, host);
          result = v.execute
            ? {
                probe: await recheckProviders(
                  live,
                  workspaceRoot,
                  c.probeGate(actor, { operator: true }),
                  [provider],
                ),
                pause: c.providerPause(provider),
              }
            : {
                dryRun: true,
                action: "one minimal test call to the provider, with its recheck token",
                pause: c.providerPause(provider),
              };
        } else
          result = {
            paused: c.providerPauses(),
            providers: (provider ? [provider] : (["codex", "claude"] as const)).map(
              (p) => c.providerPause(p),
            ),
          };
        break;
      }
      case "retry-extend":
        result = v.execute
          ? c.extendRetryAllowance(task(), readJson(), actor)
          : { dryRun: true, action: command };
        break;
      case "reconcile-helper":
        // Read-only: a draft for the operator; it asserts nothing.
        result = c.reconciliationDraft(required(v["run-id"], "--run-id"));
        break;
      case "claims":
        result = { readOnly: true, held: c.unresolvedClaims() };
        break;
      case "claims-reconcile": {
        if (!!v.intent === !!v.filing)
          throw new Error("CLAIMS_RECONCILE_NEEDS_ONE_OF_--intent_--filing");
        const target = v.intent ? { intent: v.intent } : { filing: v.filing! };
        result = v.execute
          ? c.reconcileClaims(
              target,
              String(
                z.object({ evidenceId: z.string().min(1) }).strict().parse(readJson())
                  .evidenceId,
              ),
              actor,
            )
          : { dryRun: true, action: command, ...target };
        break;
      }
      case "assessment": {
        const r = v.execute ? readJson() : null;
        result = v.execute
          ? c.assessmentDecision(
              task(),
              {
                action: String(r?.action ?? ""),
                text: String(r?.text ?? ""),
                sourceRef: String(r?.sourceRef ?? ""),
              },
              actor,
            )
          : {
              dryRun: true,
              action: command,
              hold: c.assessmentHold(task()) ?? null,
              pending: c.assessmentPending(task()),
              providers: c.assessorProviders(task()),
              waiver: c.assessmentWaiver(task()) ?? null,
            };
        break;
      }
      case "resolve-hold": {
        const r = v.execute ? readJson() : null;
        result = v.execute
          ? c.resolveReviewHold(
              task(),
              {
                reviewRunId: required(v["run-id"], "--run-id"),
                hold: String(r?.hold ?? ""),
                resolution: String(r?.resolution ?? ""),
                evidence: String(r?.evidence ?? ""),
                sourceRef: String(r?.sourceRef ?? ""),
              },
              actor,
            )
          : { dryRun: true, action: command };
        break;
      }
      case "drive-file": {
        // Filing by a tool, not a model: exact bytes within the task's
        // granted Drive scope, read back.
        const plan = FilingPlanSchema.parse(readJson());
        const spec = specDigest(c.task(task()));
        const scope = c.filingScope(task(), actor, spec);
        const problems = checkFilingPlan(plan, scope);
        if (problems.length)
          throw new Error("FILING_PLAN_REFUSED: " + problems.join("; "));
        if (!v.execute) {
          result = { dryRun: true, action: command, plan, scope };
          break;
        }
        if (!live?.drive) throw new Error("DRIVE_NOT_CONFIGURED");
        // Under the claim registry: no other writer of the same files at once.
        result = await c.fileTask(task(), plan, actor, {
          credentials: live.drive,
          stateDir: live.stateDir,
        });
        break;
      }
      case "export-patch": {
        // Read-only: the patch is written only where --out names, as its
        // exact bytes; printed, it is text, or base64 when it is not UTF-8.
        const { patch, diff, ...rest } = c.exportPatch(task());
        if (v.out) {
          writeFileSync(v.out, patch, { mode: 0o600, flag: "wx" });
          result = { ...rest, out: v.out };
        } else
          result = {
            ...rest,
            ...(diff !== undefined ? { diff } : { diffBase64: patch.toString("base64") }),
          };
        break;
      }
      case "drive-evidence":
        result = v.execute
          ? c.recordDriveEvidence(task(), actor, v["run-id"] || undefined)
          : { dryRun: true, action: command };
        break;
      case "drift-ack": {
        const r = v.execute ? readJson() : null;
        result = v.execute
          ? c.acknowledgeDrift(
              task(),
              {
                runId: required(v["run-id"], "--run-id"),
                reason: String(r?.reason ?? ""),
                sourceRef: String(r?.sourceRef ?? ""),
              },
              actor,
            )
          : { dryRun: true, action: command };
        break;
      }
      case "revise":
        result = v.execute
          ? c.revise(task(), readJson(), actor)
          : {
              dryRun: true,
              action: command,
              ...(v["request-id"]
                ? {
                    briefPreview: new Orchestrator(c, {}, host).previewBriefs(
                      v["request-id"],
                      { candidate: readJson() },
                    ),
                  }
                : {}),
            };
        break;
      case "brief-preview":
        result = new Orchestrator(c, {}, host).previewBriefs(
          required(v["request-id"], "--request-id"),
          v.file ? { candidate: readJson() } : { taskId: task() },
        );
        break;
      case "review-import":
        result = v.execute
          ? c.review(readJson(), actor)
          : { dryRun: true, action: command };
        break;
      case "evidence": {
        if (!v.execute) {
          result = { dryRun: true, action: command };
          break;
        }
        if (v.envelope) {
          const envelope = EvidenceEnvelopeSchema.parse(readJson());
          if (envelope.taskId !== task())
            throw new Error("EVIDENCE_TASK_MISMATCH");
          if (
            envelope.authentication !== "LOCAL_IMPORT" ||
            envelope.authorityTier !== "UNVERIFIED" ||
            envelope.kind === "DRIVE" ||
            envelope.kind === "GITHUB"
          )
            throw new Error("CLI_ENVELOPE_REQUIRES_UNVERIFIED_LOCAL_IMPORT");
          c.addEvidence(envelope, actor);
          result = envelope;
          break;
        }
        const filename = resolve(required(v.file, "--file"));
        const imported = await importLocalEvidence({
          taskId: task(),
          path: filename,
          allowedRoot: resolve(filename, ".."),
        });
        if (!imported.ok) {
          result = imported;
          break;
        }
        c.addEvidence(imported.envelope, actor);
        result = imported.envelope;
        break;
      }
      case "cancel":
        if (v.execute)
          new Orchestrator(c, {}, host).assertRunHost(
            required(v["run-id"], "--run-id"),
          );
        result = v.execute
          ? c.cancel(required(v["run-id"], "--run-id"), actor)
          : { dryRun: true, action: command };
        break;
      case "reconcile": {
        if (v.execute)
          new Orchestrator(c, {}, host).assertRunHost(
            required(v["run-id"], "--run-id"),
          );
        const r = v.execute ? readJson() : null;
        result = v.execute
          ? c.reconcile(
              required(v["run-id"], "--run-id"),
              r.outcome,
              r.evidenceId,
              actor,
            )
          : { dryRun: true, action: command };
        break;
      }
      case "advice":
        result = {
          advisory: true,
          network: false,
          ...deterministicAdvice(c.tasks()),
        };
        break;
      case "doctor": {
        const probes = await Promise.allSettled([
          probeCli("codex", executable("codex")),
          probeCli("claude", executable("claude")),
          probeIsolation(),
          probeAuthentication("codex", executable("codex")),
          probeAuthentication("claude", executable("claude")),
        ]);
        let live: unknown = {
          status: "NOT_EXECUTED",
          reason: "--live-read not selected",
        };
        if (v["live-read"]) {
          const summarize = (r: any) =>
            r.ok ? { ok: true, envelope: r.envelope } : r;
          const driveId = v["drive-file-id"],
            repository = v["github-repository"],
            resource = v["github-branch"]
              ? { kind: "branch" as const, branch: v["github-branch"] }
              : { kind: "repository" as const };
          const notSelected = (option: string) =>
            Promise.resolve({
              status: "NOT_EXECUTED",
              reason: option + " not selected",
            });
          const [drive, github, githubCli] = await Promise.allSettled([
            driveId
              ? new DriveReadOnlyAdapter({
                  token: process.env.LONGFORM_DRIVE_READ_TOKEN,
                })
                  .read(driveId, { taskId: "DOCTOR" })
                  .then(summarize)
              : notSelected("--drive-file-id"),
            repository
              ? new GitHubReadOnlyAdapter({
                  token: process.env.LONGFORM_GITHUB_READ_TOKEN,
                })
                  .read(repository, resource, { taskId: "DOCTOR" })
                  .then(summarize)
              : notSelected("--github-repository"),
            repository
              ? new GitHubGhReadOnlyAdapter()
                  .read(repository, resource, { taskId: "DOCTOR" })
                  .then(summarize)
              : notSelected("--github-repository"),
          ]);
          live = { drive, github, githubCli };
        }
        result = {
          node: process.version,
          sqlite: {
            path,
            migrations: db.all("SELECT * FROM schema_migrations"),
            eventChainValid: db.verifyEvents(),
          },
          probes: probes.map((r) =>
            r.status === "fulfilled"
              ? r.value
              : { error: redact(String(r.reason)) },
          ),
          live,
          capabilities: {
            mock: "AVAILABLE",
            routing:
              "AUTOMATIC_COMPLEXITY_POLICY; explicit full-selection override recorded",
            routingPolicy: v["routing-policy"] ?? "BUILTIN_SYNTHETIC_ONLY",
            liveProvider: liveRuntime
              ? "CONFIGURED: Bubblewrap runner, allowlisted egress broker, harness identity proof"
              : "HELD: no live-config.json beside the database",
            liveRunner: liveRuntime ? liveDoctor(liveRuntime) : null,
            sdk: "ADVISORY_ONLY_NETWORK_DISABLED_BY_DEFAULT",
          },
          credentials: {
            driveReadToken: !!process.env.LONGFORM_DRIVE_READ_TOKEN,
            githubReadToken: !!process.env.LONGFORM_GITHUB_READ_TOKEN,
          },
          externalMutations: "SCOPED_DRIVE_ONLY",
        };
        break;
      }
      case "adaptive": {
        // The adaptive workflow's evaluation registry and harness (issue #12,
        // contract section 5), and the owner's routing preference (section
        // 9). Freezing a plan, importing evidence and recording a preference
        // are the owner's acts (local UID); building a bundle and listing are
        // read-only. None of these runs a provider.
        const sub = id;
        if (sub === "freeze-plan")
          result = v.execute
            ? freezePlan(db, readJson(), actor.id)
            : { dryRun: true, action: "adaptive freeze-plan" };
        else if (sub === "import-evidence")
          result = v.execute
            ? importEvidence(db, readJson(), {
                ...(v.journal ? { journalPath: resolve(v.journal) } : {}),
                actor: actor.id,
              })
            : { dryRun: true, action: "adaptive import-evidence" };
        else if (sub === "harness-init") {
          const plan = EvaluationPlanSchema.parse(readJson());
          const journal = resolve(required(v.journal, "--journal"));
          if (v.execute) initEvaluationJournal(journal, plan);
          result = v.execute
            ? { journal, planId: plan.id }
            : { dryRun: true, action: "adaptive harness-init", journal };
        } else if (sub === "record-fixture")
          // Run with --db pointing at the evaluation journal itself.
          result = v.execute
            ? recordCaseFixture(db, readJson())
            : { dryRun: true, action: "adaptive record-fixture" };
        else if (sub === "build-bundle") {
          const input = readJson();
          const frozen = frozenPlans(db).get(String(input.planId));
          if (!frozen) throw new Error("EVALUATION_PLAN_NOT_FROZEN:" + input.planId);
          const bundle = buildBundle(
            resolve(required(v.journal, "--journal")),
            frozen.plan,
            input.results,
            input.limitations ?? [],
          );
          if (v.out) writeFileSync(resolve(v.out), JSON.stringify(bundle, null, 2) + "\n");
          result = v.out ? { written: resolve(v.out), results: bundle.results.length } : bundle;
        } else if (sub === "evidence")
          result = {
            readOnly: true,
            plans: [...frozenPlans(db).values()].map((p) => ({
              planId: p.planId,
              planDigest: p.planDigest,
              purpose: p.plan.purpose,
              frozenAt: p.at,
            })),
            imports: importedEvidence(db).map((e) => ({
              evidenceId: e.evidenceId,
              planId: e.planId,
              phase: e.phase,
              synthetic: e.synthetic,
              importedAt: e.at,
              aggregates: e.aggregates.map((a) => ({
                classKey: a.classKey,
                arrangementId: a.arrangementId,
                n: a.n,
                decision: a.decision,
              })),
            })),
          };
        else if (sub === "prefer") {
          if (v.task?.length !== 1) throw new Error("ADAPTIVE_PREFER_NEEDS_ONE_TASK");
          const value = v.file
            ? readJson()
            : {
                mode: v.mode,
                ...(v.worker ? { workerRouteId: v.worker } : {}),
                ...(v.reviewer ? { reviewerRouteId: v.reviewer } : {}),
                reason: v.reason,
              };
          result = v.execute
            ? c.recordAdaptivePreference(v.task[0]!, value, actor)
            : { dryRun: true, action: "adaptive prefer", taskId: v.task[0] };
        } else throw new Error("UNKNOWN_ADAPTIVE_COMMAND:" + sub);
        break;
      }
      default:
        throw new Error("UNKNOWN_COMMAND:" + command);
    }
    process.stdout.write(
      JSON.stringify(result ?? { ok: true, action: command }, null, 2) + "\n",
    );
  } finally {
    // Nothing of this process's live runs may still be going when its host
    // lock goes and its database closes .
    if (liveWorkflow)
      await hostQuiescence(liveWorkflow, {
        notify: (message) =>
          process.stderr.write("ORCHESTRATOR WATCHDOG: " + message + "\n"),
      });
    releaseLive?.();
    db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    process.stderr.write(
      JSON.stringify({
        error: redact(e instanceof Error ? e.message : String(e)),
      }) + "\n",
    );
    process.exitCode = 1;
  });
